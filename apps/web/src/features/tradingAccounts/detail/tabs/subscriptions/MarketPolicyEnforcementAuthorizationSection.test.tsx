// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketPolicyEnforcementAuthorizationPreview, MarketPolicyEnforcementAuthorizationStateResponse } from '../../../types';

const mocks = vi.hoisted(() => ({
  owner: true,
  preview: vi.fn(),
  history: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  resolveLapse: vi.fn(),
}));
vi.mock('../../../../auth/useAuth', () => ({ useIsSystemOwner: () => mocks.owner }));
vi.mock('../../../api', () => ({
  previewMarketPolicyEnforcementAuthorization: mocks.preview,
  getMarketPolicyEnforcementAuthorizationHistory: mocks.history,
  grantMarketPolicyEnforcementAuthorization: mocks.grant,
  revokeMarketPolicyEnforcementAuthorization: mocks.revoke,
  resolveMarketPolicyEnforcementLapse: mocks.resolveLapse,
}));
import { MarketPolicyEnforcementAuthorizationSection } from './MarketPolicyEnforcementAuthorizationSection';

const fingerprint = 'a'.repeat(64);
const runtimeEnforcement = { environment: 'PAPER', active: false, status: 'NOT_ACTIVATED', version: 0, changedAt: null, changedBy: null, changeReason: null, tradingEffect: 'NONE', liveAuthority: 'NONE', brokerTimeEnforcement: 'NOT_IMPLEMENTED' } as const;
const activeRuntime = { ...runtimeEnforcement, active: true, status: 'ACTIVE', version: 1, tradingEffect: 'PAPER_PRE_INTENT_ENFORCEMENT' } as const;
const neverAuthorized = { disposition: 'NEVER_AUTHORIZED', behaviorWhenRuntimeActive: 'EXISTING_ENTRY_BEHAVIOR', currentEntryBehavior: 'EXISTING_ENTRY_BEHAVIOR', ownerResolutionAvailable: false, latestAuthorizationId: null } as const;
function state(overrides: Partial<MarketPolicyEnforcementAuthorizationStateResponse> = {}): MarketPolicyEnforcementAuthorizationStateResponse {
  return { authorizationScope: 'PAPER_ONLY', authorityVersion: 'PAPER_MARKET_POLICY_ENFORCEMENT_V1', runtimeEnforcement, enrollmentGeneration: { id: 11, generation: 2, status: 'ACTIVE' }, state: 'NOT_AUTHORIZED', effective: false, ineffectiveReasons: [], enforcement: neverAuthorized, authorization: null, ...overrides };
}
function preview(overrides: Partial<MarketPolicyEnforcementAuthorizationPreview> = {}): MarketPolicyEnforcementAuthorizationPreview {
  return {
    authorizationScope: 'PAPER_ONLY', authorityVersion: 'PAPER_MARKET_POLICY_ENFORCEMENT_V1', runtimeEnforcement,
    identity: {
      tradingAccount: { id: 7, displayName: 'Bobby Paper', environment: 'PAPER' }, assignment: { id: 9 }, subscription: { id: 3, key: 'spy', name: 'SPY Entry' },
      security: { id: 1, symbol: 'SPY' }, strategy: { id: 4, key: 'dip', name: 'Dip Buyer' },
      enrollmentGeneration: { id: 11, enrollmentId: 2, generation: 2, status: 'ACTIVE' }, boundPolicyRevision: { id: 5, revision: 3, status: 'ACTIVE' },
      activePolicyRevision: { id: 5, revision: 3 }, configurationFingerprint: fingerprint, expectedConfigurationFingerprint: fingerprint,
    },
    configurationValidity: { valid: true, errors: [] }, eligibleToAuthorize: true, blockingReasons: [], viewerCanAuthorize: true,
    currentAuthorization: state(),
    currentMarketEligibility: { outcome: 'BLOCKED', reasonCode: 'TREND_NOT_ALLOWED', evaluatorTechnicalStatus: 'AVAILABLE', requiredForAuthorization: false },
    operationalPosture: { strategyEnabled: true, assignmentEnabled: true, entriesEnabled: false, accountStatus: 'PAUSED', accountTradingEnabled: false, killSwitchEnabled: true, affectsAuthorizationValidity: false },
    ...overrides,
  };
}
const authorized = { id: 40, enrollmentGenerationId: 11, authorizationSequence: 1, authorityVersion: 'PAPER_MARKET_POLICY_ENFORCEMENT_V1', status: 'AUTHORIZED' as const, environment: 'PAPER' as const, policyRevisionId: 5, authorizedAt: '2026-10-18T12:00:00Z', revokedAt: null, invalidatedAt: null, invalidationReasonCode: null, securityId: 1, securitySymbol: 'SPY', invalidationSource: null, lapseResolution: null };

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={client}><MarketPolicyEnforcementAuthorizationSection accountId={7} assignmentId={9} token="token" enrollmentQueryKey={['enrollment', 7, 9]} /></QueryClientProvider></MantineProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner = true;
  mocks.preview.mockResolvedValue({ preview: preview() });
  mocks.history.mockResolvedValue({ authorizationScope: 'PAPER_ONLY', runtimeEnforcement, authorizations: [] });
  mocks.grant.mockResolvedValue({ authorization: authorized });
  mocks.revoke.mockResolvedValue({ authorization: { ...authorized, status: 'REVOKED' } });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(cleanup);

describe('MarketPolicyEnforcementAuthorizationSection', () => {
  it('distinguishes authorization from inactive runtime enforcement and treats market outcome as informational', async () => {
    renderSection();
    expect(await screen.findByText('NOT AUTHORIZED')).toBeTruthy();
    expect(screen.getByText('RUNTIME ENFORCEMENT NOT ACTIVE')).toBeTruthy();
    expect(screen.getByText('EXISTING ENTRY BEHAVIOR')).toBeTruthy();
    expect(screen.getByText(/PAPER runtime enforcement is not active, so entries keep their existing behavior/)).toBeTruthy();
    expect(screen.getByText('Market observation: BLOCKED (informational)')).toBeTruthy();
    expect(screen.getByText('Eligible to authorize')).toBeTruthy();
  });

  it('requires a reason and explicit confirmation, then grants the exact previewed identity', async () => {
    renderSection();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Authorize enforcement…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(fingerprint)).toBeTruthy();
    expect(within(dialog).getByText('3 (#5) · ACTIVE')).toBeTruthy();
    const submit = within(dialog).getByRole('button', { name: 'Grant authorization' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    await user.type(within(dialog).getByLabelText('Authorization reason'), 'Ready for PAPER enforcement');
    expect(submit.hasAttribute('disabled')).toBe(true);
    await user.click(within(dialog).getByLabelText(/I confirm this exact account/));
    await user.click(submit);
    await waitFor(() => expect(mocks.grant).toHaveBeenCalledWith(7, 9, { generationId: 11, expectedConfigurationFingerprint: fingerprint, expectedPolicyRevisionId: 5, reason: 'Ready for PAPER enforcement' }, 'token'));
  });

  it('shows precise blocking reasons and disables granting when ineligible', async () => {
    mocks.preview.mockResolvedValue({ preview: preview({ eligibleToAuthorize: false, blockingReasons: [{ code: 'POLICY_REVISION_SUPERSEDED', message: 'The bound policy revision is no longer the Strategy\'s ACTIVE revision.' }] }) });
    renderSection();
    expect(await screen.findByText(/POLICY_REVISION_SUPERSEDED/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Authorize enforcement…' }).hasAttribute('disabled')).toBe(true);
  });

  it('revokes the current authorization with a reason and shows immutable history', async () => {
    mocks.preview.mockResolvedValue({ preview: preview({ eligibleToAuthorize: false, blockingReasons: [{ code: 'AUTHORIZATION_ALREADY_EFFECTIVE', message: 'exists' }], currentAuthorization: state({ state: 'AUTHORIZED', effective: true, authorization: authorized }) }) });
    mocks.history.mockResolvedValue({ authorizationScope: 'PAPER_ONLY', runtimeEnforcement, authorizations: [{ ...authorized, generation: 2, policyRevision: 3, events: [{ id: 1, sequence: 1, action: 'GRANT', fromStatus: null, toStatus: 'AUTHORIZED', reason: 'Initial grant', actor: { id: 1, email: 'owner@example.com', name: null }, occurredAt: '2026-10-18T12:00:00Z' }] }] });
    renderSection();
    expect(await screen.findByText('AUTHORIZED')).toBeTruthy();
    expect(await screen.findByText(/GRANT · owner@example.com · Initial grant/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Revoke authorization…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/deliberate return to non-enforced entry behavior/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Revocation reason'), 'Pause eligibility');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke authorization' }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith(7, 9, { authorizationId: 40, reason: 'Pause eligibility' }, 'token'));
  });

  it('shows active PAPER runtime enforcement and the enforced entry behavior', async () => {
    mocks.preview.mockResolvedValue({ preview: preview({ runtimeEnforcement: activeRuntime, eligibleToAuthorize: false, currentAuthorization: state({ runtimeEnforcement: activeRuntime, state: 'AUTHORIZED', effective: true, authorization: authorized, enforcement: { disposition: 'ENFORCED', behaviorWhenRuntimeActive: 'MARKET_POLICY_ENFORCED', currentEntryBehavior: 'MARKET_POLICY_ENFORCED', ownerResolutionAvailable: false, latestAuthorizationId: 40 } }) }) });
    renderSection();
    expect(await screen.findByText('PAPER RUNTIME ENFORCEMENT ACTIVE (v1)')).toBeTruthy();
    expect(screen.getByText('MARKET POLICY ENFORCED')).toBeTruthy();
    expect(screen.getByText(/SELL, protective, and lifecycle orders are never gated/)).toBeTruthy();
  });

  it('surfaces an automatic invalidation as fail-closed and offers an explicit, confirmed owner opt-out', async () => {
    const invalidated = { ...authorized, status: 'INVALIDATED' as const, invalidatedAt: '2026-10-18T13:00:00Z', invalidationReasonCode: 'POLICY_REVISION_SUPERSEDED', invalidationSource: 'POLICY_REVISION_TRIGGER' };
    mocks.preview.mockResolvedValue({ preview: preview({ runtimeEnforcement: activeRuntime, currentAuthorization: state({ runtimeEnforcement: activeRuntime, state: 'INVALIDATED', authorization: invalidated, enforcement: { disposition: 'LAPSED', behaviorWhenRuntimeActive: 'FAIL_CLOSED', currentEntryBehavior: 'FAIL_CLOSED', ownerResolutionAvailable: true, latestAuthorizationId: 40 } }) }) });
    mocks.resolveLapse.mockResolvedValue({ lapseResolution: { id: 1, authorizationId: 40, resolution: 'RESTORE_NON_ENFORCED', resolvedAt: '2026-10-18T14:00:00Z' } });
    renderSection();
    expect(await screen.findByText('NEW ENTRIES FAIL CLOSED')).toBeTruthy();
    expect(screen.getByText('Authorization automatically invalidated')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Restore non-enforced behavior…' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Restore non-enforced behavior' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Intentionally opt out');
    expect(submit.hasAttribute('disabled')).toBe(true);
    await user.click(within(dialog).getByLabelText(/return to non-enforced entry behavior/));
    await user.click(submit);
    await waitFor(() => expect(mocks.resolveLapse).toHaveBeenCalledWith(7, 9, { authorizationId: 40, reason: 'Intentionally opt out', confirmNonEnforced: true }, 'token'));
  });

  it('keeps non-owner views read-only without history requests', async () => {
    mocks.owner = false;
    mocks.preview.mockResolvedValue({ preview: preview({ viewerCanAuthorize: false, currentAuthorization: state({ state: 'AUTHORIZED', effective: true, authorization: authorized }) }) });
    renderSection();
    expect(await screen.findByText('AUTHORIZED')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Authorize enforcement…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke authorization…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore non-enforced behavior…' })).toBeNull();
    expect(mocks.history).not.toHaveBeenCalled();
  });
});
