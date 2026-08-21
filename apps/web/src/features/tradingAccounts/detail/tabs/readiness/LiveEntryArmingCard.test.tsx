// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';

const mutation = { mutate: vi.fn(), isPending: false, isError: false, error: null };
vi.mock('../../../hooks', () => ({
  useTradingAccountSubscriptions: () => ({ data: { accountSubscriptions: [{ id: 8, enabled: true, entriesEnabled: true, subscription: { key: 'rsp_dip_core' } }] } }),
  useLiveWriteApprovals: () => ({ data: { capabilities: [{ capability: 'ENTRY', effective: true, approval: { id: 4, revision: 2 } }, { capability: 'RISK_REDUCING', effective: true, approval: { id: 3, revision: 1 } }] } }),
  useStageLiveEntryCanary: () => mutation, useArmLiveEntries: () => mutation, useDisarmLiveEntries: () => mutation,
  useCurrentLiveEntryAcceptance: () => ({ data: { run: null } }),
}));
vi.mock('./LiveEntryAcceptanceWorkflow', () => ({ LiveEntryAcceptanceWorkflow: () => <div>Acceptance workflow</div> }));
import { LiveEntryArmingCard } from './LiveEntryArmingCard';

const account = { id: 1, status: 'ACTIVE', environment: 'LIVE', tradingEnabled: false, killSwitchEnabled: true, activeLiveEntryArmingId: null, updatedAt: '2026-08-18T19:00:00Z', credential: { verifiedAt: '2026-08-18T19:00:00Z' } } as TradingAccount;
const assessment = { id: 5, purpose: 'LIVE_ENTRY_ARMING', result: 'PASSED', validity: 'CURRENT', credentialVerifiedAt: '2026-08-18T19:00:00Z', evidence: { liveWriteApprovalRevisions: { riskReducing: 1, entry: 2 } } } as TradingAccountReadinessAssessment;

describe('LiveEntryArmingCard requirements', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it('keeps ARM predicates while replacing the duplicate checklist with concise guidance', async () => {
    render(<MantineProvider><LiveEntryArmingCard account={account} assessment={assessment} token="token" /></MantineProvider>);
    const arm = screen.getByRole('button', { name: 'ARM LIVE ENTRIES' });
    expect(arm.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Requirements to ARM')).toBeNull();
    expect(screen.getByTestId('arm-disabled-guidance').textContent).toBe('Enter an operator reason to continue.');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Arming reason'), 'Arm canary');
    await user.type(screen.getByLabelText('Type ARM LIVE ENTRIES'), 'ARM LIVE ENTRIES');
    expect(arm.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByTestId('arm-disabled-guidance')).toBeNull();
  });

  it('clears only the successful action reason and preserves failed input', async () => {
    render(<MantineProvider><LiveEntryArmingCard account={account} assessment={assessment} token="token" /></MantineProvider>);
    const stageReason = screen.getByLabelText('Canary staging reason') as HTMLInputElement;
    const armReason = screen.getByLabelText('Arming reason') as HTMLInputElement;
    const confirmation = screen.getByLabelText('Type ARM LIVE ENTRIES') as HTMLInputElement;
    const disarmReason = screen.getByLabelText('Disarm reason') as HTMLInputElement;

    fireEvent.change(stageReason, { target: { value: 'Stage once' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stage RSP canary' }));
    expect(stageReason.value).toBe('Stage once');
    const stageOptions = mutation.mutate.mock.calls.at(-1)?.[1] as { onSuccess: () => void };
    act(() => stageOptions.onSuccess());
    expect(stageReason.value).toBe('');

    fireEvent.change(armReason, { target: { value: 'Arm once' } });
    fireEvent.change(confirmation, { target: { value: 'ARM LIVE ENTRIES' } });
    fireEvent.click(screen.getByRole('button', { name: 'ARM LIVE ENTRIES' }));
    const armOptions = mutation.mutate.mock.calls.at(-1)?.[1] as { onSuccess: () => void };
    act(() => armOptions.onSuccess());
    expect(armReason.value).toBe('');
    expect(confirmation.value).toBe('');

    fireEvent.change(disarmReason, { target: { value: 'Do not reuse staging reason' } });
    fireEvent.click(screen.getByRole('button', { name: 'DISARM LIVE ENTRIES' }));
    expect(disarmReason.value).toBe('Do not reuse staging reason');
  });

  it('shows paused Live setup guidance while keeping ARM unavailable', () => {
    const pausedAccount = { ...account, status: 'PAUSED' as const };
    render(<MantineProvider><LiveEntryArmingCard account={pausedAccount} assessment={assessment} token="token" /></MantineProvider>);

    expect(screen.getByText('Acceptance workflow')).toBeTruthy();
    expect(screen.queryByText('Live Entry Setup Progress')).toBeNull();
    expect(screen.getByText('PAUSED · ENTRY STAGED')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stage RSP canary' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'ARM LIVE ENTRIES' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('arm-disabled-guidance').textContent).toContain(
      'Run a fresh Live Activation assessment with RISK_REDUCING authorization effective.',
    );
  });

  it('distinguishes missing assessment evidence from disabled deployment permission', () => {
    render(<MantineProvider><LiveEntryArmingCard account={account} assessment={null} token="token" /></MantineProvider>);

    expect(screen.getByText('Deployment entry permission: not yet assessed')).toBeTruthy();
    expect(screen.queryByText('Deployment entry permission: disabled')).toBeNull();
  });
});
