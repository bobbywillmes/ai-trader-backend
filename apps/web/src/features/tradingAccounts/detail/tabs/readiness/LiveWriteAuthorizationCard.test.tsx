// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';

const mocks = vi.hoisted(() => ({
  grant: vi.fn(), revoke: vi.fn(), grantReset: vi.fn(), revokeReset: vi.fn(),
  grantPending: false, revokePending: false,
  grantError: null as Error | null, revokeError: null as Error | null,
  deploymentCanWrite: true,
}));

vi.mock('../../../hooks', () => ({
  useGrantLiveWriteApproval: () => ({ mutate: mocks.grant, reset: mocks.grantReset, isPending: mocks.grantPending, isError: Boolean(mocks.grantError), error: mocks.grantError }),
  useRevokeLiveWriteApproval: () => ({ mutate: mocks.revoke, reset: mocks.revokeReset, isPending: mocks.revokePending, isError: Boolean(mocks.revokeError), error: mocks.revokeError }),
  useLiveWriteApprovals: () => ({ data: {
    deploymentCanWrite: mocks.deploymentCanWrite, deploymentRole: 'PRODUCTION_EXECUTOR', history: [],
    capabilities: [
      { capability: 'RISK_REDUCING', effective: false, reason: 'INVALIDATED', approval: { revision: 2, status: 'INVALIDATED', grantedAt: null, expiresAt: null, invalidationReason: 'Credential changed.' }, fingerprints: { configurationFingerprint: 'a'.repeat(64), credentialFingerprint: 'b'.repeat(64) } },
      { capability: 'ENTRY', effective: false, reason: 'MISSING', approval: null, fingerprints: { configurationFingerprint: 'c'.repeat(64), credentialFingerprint: 'd'.repeat(64) } },
    ],
  } }),
}));

import { LiveWriteAuthorizationCard } from './LiveWriteAuthorizationCard';

const activeAccount = { id: 2, status: 'ACTIVE', tradingEnabled: false, killSwitchEnabled: true } as Pick<TradingAccount, 'id' | 'status' | 'tradingEnabled' | 'killSwitchEnabled'>;

function assessment(overrides: Partial<TradingAccountReadinessAssessment> = {}) {
  return { id: 91, purpose: 'LIVE_ENTRY_ARMING', validity: 'CURRENT', evidence: { prerequisitesForEntryGrantPassed: true, prerequisitesForRiskReducingGrantPassed: true }, ...overrides } as TradingAccountReadinessAssessment;
}

function renderCard(latest: TradingAccountReadinessAssessment | null = assessment(), account = activeAccount) {
  return render(<MantineProvider><LiveWriteAuthorizationCard account={account} token="token" latest={latest} /></MantineProvider>);
}

const grantButtons = () => screen.getAllByRole('button', { name: 'Grant' });

function futureLocalDate() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

async function completeEntryCeremony() {
  const user = userEvent.setup();
  await user.type(screen.getAllByLabelText('Reason')[1]!, 'Authorize entry');
  await user.type(screen.getByLabelText('Type APPROVE LIVE ENTRY'), 'APPROVE LIVE ENTRY');
  fireEvent.change(screen.getByLabelText('Expiration'), { target: { value: futureLocalDate() } });
  return user;
}

describe('LiveWriteAuthorizationCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.grantPending = false; mocks.revokePending = false;
    mocks.grantError = null; mocks.revokeError = null; mocks.deploymentCanWrite = true;
  });
  afterEach(cleanup);

  it('enables ENTRY Grant only after every client-side ceremony requirement passes', async () => {
    renderCard();
    expect(grantButtons()[1]!.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText('○ Reason is entered')).toHaveLength(2);
    expect(screen.getByText('○ Expiration is valid and in the future')).toBeTruthy();
    await completeEntryCeremony();
    expect(grantButtons()[1]!.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('✓ Exact APPROVE LIVE ENTRY confirmation is entered')).toBeTruthy();
  });

  it.each([
    ['not current', assessment({ validity: 'STALE' })],
    ['wrong purpose', assessment({ purpose: 'LIVE_ACTIVATION' })],
    ['failed prerequisites', assessment({ evidence: { prerequisitesForEntryGrantPassed: false } })],
  ])('keeps ENTRY Grant disabled when readiness is %s', async (_label, latest) => {
    renderCard(latest); await completeEntryCeremony(); expect(grantButtons()[1]!.hasAttribute('disabled')).toBe(true);
  });

  it('keeps ENTRY Grant unavailable without deployment write permission', () => {
    mocks.deploymentCanWrite = false; renderCard();
    expect(screen.queryByLabelText('Type APPROVE LIVE ENTRY')).toBeNull();
  });

  it('requires a trimmed reason and exact ENTRY confirmation', async () => {
    renderCard(); const user = userEvent.setup();
    await user.type(screen.getAllByLabelText('Reason')[1]!, '   ');
    await user.type(screen.getByLabelText('Type APPROVE LIVE ENTRY'), 'approve live entry');
    fireEvent.change(screen.getByLabelText('Expiration'), { target: { value: futureLocalDate() } });
    expect(grantButtons()[1]!.hasAttribute('disabled')).toBe(true);
    await user.clear(screen.getAllByLabelText('Reason')[1]!); await user.type(screen.getAllByLabelText('Reason')[1]!, 'Authorize entry');
    await user.clear(screen.getByLabelText('Type APPROVE LIVE ENTRY')); await user.type(screen.getByLabelText('Type APPROVE LIVE ENTRY'), ' APPROVE LIVE ENTRY ');
    expect(grantButtons()[1]!.hasAttribute('disabled')).toBe(true);
  });

  it.each([['missing', ''], ['invalid', 'not-a-date'], ['past', '2020-01-01T12:00']])('keeps ENTRY Grant disabled when expiration is %s', async (_label, value) => {
    renderCard(); const user = userEvent.setup();
    await user.type(screen.getAllByLabelText('Reason')[1]!, 'Authorize entry');
    await user.type(screen.getByLabelText('Type APPROVE LIVE ENTRY'), 'APPROVE LIVE ENTRY');
    if (value) fireEvent.change(screen.getByLabelText('Expiration'), { target: { value } });
    expect(grantButtons()[1]!.hasAttribute('disabled')).toBe(true);
  });

  it('keeps ENTRY Grant disabled while a mutation is pending', async () => {
    mocks.revokePending = true; renderCard(); await completeEntryCeremony(); expect(grantButtons()[1]!.hasAttribute('disabled')).toBe(true);
  });

  it('allows lifecycle-appropriate ACTIVE risk-reducing reauthorization with exact ceremony', async () => {
    renderCard(); const user = userEvent.setup();
    await user.type(screen.getAllByLabelText('Reason')[0]!, 'Reauthorize risk reduction');
    await user.type(screen.getByLabelText('Type APPROVE LIVE RISK_REDUCING'), 'APPROVE LIVE RISK_REDUCING');
    expect(grantButtons()[0]!.hasAttribute('disabled')).toBe(false); await user.click(grantButtons()[0]!);
    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ capability: 'RISK_REDUCING', payload: expect.objectContaining({ readinessAssessmentId: 91 }) }), expect.any(Object));
  });

  it('requires reason, exact confirmation, and lifecycle-appropriate readiness for RISK_REDUCING', async () => {
    renderCard(assessment({ purpose: 'LIVE_ACTIVATION' })); const user = userEvent.setup();
    await user.type(screen.getAllByLabelText('Reason')[0]!, 'Reason');
    await user.type(screen.getByLabelText('Type APPROVE LIVE RISK_REDUCING'), 'approve live risk_reducing');
    expect(grantButtons()[0]!.hasAttribute('disabled')).toBe(true);
  });

  it('allows the PAUSED disarmed LIVE_ACTIVATION path without duplicating backend evidence', async () => {
    renderCard(assessment({ purpose: 'LIVE_ACTIVATION', evidence: {} }), { ...activeAccount, status: 'PAUSED' }); const user = userEvent.setup();
    await user.type(screen.getAllByLabelText('Reason')[0]!, 'Authorize exits');
    await user.type(screen.getByLabelText('Type APPROVE LIVE RISK_REDUCING'), 'APPROVE LIVE RISK_REDUCING');
    expect(grantButtons()[0]!.hasAttribute('disabled')).toBe(false);
  });

  it.each([{ tradingEnabled: true, killSwitchEnabled: false }, { tradingEnabled: true, killSwitchEnabled: true }, { tradingEnabled: false, killSwitchEnabled: false }])('does not present malformed or armed latches as grant-ready: %j', async (latches) => {
    renderCard(assessment(), { ...activeAccount, ...latches }); const user = userEvent.setup();
    await user.type(screen.getAllByLabelText('Reason')[0]!, 'Authorize exits');
    await user.type(screen.getByLabelText('Type APPROVE LIVE RISK_REDUCING'), 'APPROVE LIVE RISK_REDUCING');
    expect(grantButtons()[0]!.hasAttribute('disabled')).toBe(true);
  });

  it('clears every ceremony field only after a successful Grant', async () => {
    renderCard(); const user = await completeEntryCeremony(); await user.click(grantButtons()[1]!);
    await act(() => mocks.grant.mock.calls[0]![1].onSuccess());
    expect((screen.getAllByLabelText('Reason')[1] as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Type APPROVE LIVE ENTRY') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Expiration') as HTMLInputElement).value).toBe('');
  });

  it('clears stale ceremony fields only after a successful Revoke', async () => {
    renderCard(); const user = userEvent.setup();
    await user.type(screen.getAllByLabelText('Reason')[0]!, 'Revoke approval');
    await user.type(screen.getByLabelText('Type APPROVE LIVE RISK_REDUCING'), 'stale confirmation');
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    await act(() => mocks.revoke.mock.calls[0]![1].onSuccess());
    expect((screen.getAllByLabelText('Reason')[0] as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Type APPROVE LIVE RISK_REDUCING') as HTMLInputElement).value).toBe('');
  });

  it('preserves form fields after failed Grant and failed Revoke', async () => {
    renderCard(); const user = await completeEntryCeremony(); await user.click(grantButtons()[1]!);
    expect((screen.getAllByLabelText('Reason')[1] as HTMLInputElement).value).toBe('Authorize entry');
    await user.type(screen.getAllByLabelText('Reason')[0]!, 'Revoke approval'); await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!);
    expect((screen.getAllByLabelText('Reason')[0] as HTMLInputElement).value).toBe('Revoke approval');
  });

  it('keeps a failure visible until editing a ceremony field resets stale errors', async () => {
    mocks.grantError = new Error('Session close changed.'); const view = renderCard();
    expect(screen.getAllByText('Session close changed.')).toHaveLength(2);
    await userEvent.setup().type(screen.getAllByLabelText('Reason')[1]!, 'Correction'); expect(mocks.grantReset).toHaveBeenCalled();
    mocks.grantError = null;
    view.rerender(<MantineProvider><LiveWriteAuthorizationCard account={activeAccount} token="token" latest={assessment()} /></MantineProvider>);
    expect(screen.queryByText('Session close changed.')).toBeNull();
  });
});
