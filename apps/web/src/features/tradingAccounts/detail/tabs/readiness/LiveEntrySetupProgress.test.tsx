// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';
import { LiveEntrySetupProgress } from './LiveEntrySetupProgress';
import { deriveLiveEntrySetupState } from './liveEntrySetupState';

const account = { id: 1, status: 'ACTIVE', tradingEnabled: false, killSwitchEnabled: true, activeLiveEntryArmingId: null, credential: { verifiedAt: '2026-08-18T19:00:00Z' } } as unknown as TradingAccount;
const passedGate = { code: 'ARMING_CREDENTIAL_VERIFICATION_CURRENT', outcome: 'PASSED', message: 'Credential verification is current.' } as const;
const staleCredentialGate = { code: 'ARMING_CREDENTIAL_VERIFICATION_CURRENT', outcome: 'BLOCKED', message: 'Credential verification must be less than 15 minutes old.' } as const;
const approvalBlockers = [
  { code: 'ARMING_RISK_REDUCING_APPROVAL', outcome: 'BLOCKED', message: 'RISK_REDUCING approval is REVOKED.' },
  { code: 'ARMING_ENTRY_APPROVAL_CURRENT', outcome: 'BLOCKED', message: 'ENTRY approval is REVOKED.' },
] as const;
const readiness = { purpose: 'LIVE_ENTRY_ARMING', result: 'PASSED', validity: 'CURRENT', credentialVerifiedAt: '2026-08-18T19:00:00Z', stages: [{ key: 'LIVE_ENTRY_ARMING_READY', gates: [passedGate] }], evidence: { liveWriteApprovalRevisions: { riskReducing: 1, entry: 2 } } } as TradingAccountReadinessAssessment;
const consumedArming = { id: 4, entryApprovalRevision: 1, tradingAccountSubscriptionId: 2, entryApprovalExpiresAt: '2026-08-18T20:00:00Z', armedAt: '2026-08-18T19:00:00Z', terminations: [{ type: 'CONSUMED', occurredAt: '2026-08-18T19:10:00Z' }] } as TradingAccount['latestLiveEntryArming'];

function show(overrides: { account?: TradingAccount; assessment?: TradingAccountReadinessAssessment | null; staged?: boolean; risk?: boolean; entry?: boolean; riskRevision?: number; entryRevision?: number } = {}) {
  const risk = overrides.risk ?? true;
  const entry = overrides.entry ?? true;
  render(<MantineProvider><LiveEntrySetupProgress account={overrides.account ?? account} assessment={overrides.assessment === undefined ? readiness : overrides.assessment} canaryPresent canaryStaged={overrides.staged ?? true} riskApproval={{ effective: risk, approval: risk ? { revision: overrides.riskRevision ?? 1 } : null }} entryApproval={{ effective: entry, approval: entry ? { revision: overrides.entryRevision ?? 2 } : null }} /></MantineProvider>);
  return screen.getByTestId('live-entry-next-action').textContent;
}

describe('LiveEntrySetupProgress', () => {
  afterEach(cleanup);
  it('directs an operator to grant ENTRY when current readiness exposes the backend grant prerequisite', () => expect(show({ entry: false, assessment: { ...readiness, result: 'BLOCKED', evidence: { ...readiness.evidence, prerequisitesForEntryGrantPassed: true } } })).toContain('Grant ENTRY authorization'));
  it('does not treat historical verifiedAt as current when the authoritative credential gate is blocked', () => {
    const next = show({ risk: false, entry: false, assessment: { ...readiness, result: 'BLOCKED', stages: [{ key: 'LIVE_ENTRY_ARMING_READY', gates: [staleCredentialGate, ...approvalBlockers] }], evidence: { ...readiness.evidence, prerequisitesForRiskReducingGrantPassed: false } } as TradingAccountReadinessAssessment });
    expect(screen.getByText('Broker credential verification stale for arming').closest('li')?.textContent).not.toContain('DONE');
    expect(next).toContain('Verify credentials and run a fresh Live Entry Arming assessment');
    expect(next).not.toContain('Grant RISK_REDUCING');
  });
  it('only treats the two approval blockers as compatible with an immediately executable RISK_REDUCING grant', () => {
    expect(show({ risk: false, entry: false, assessment: { ...readiness, result: 'BLOCKED', stages: [{ key: 'LIVE_ENTRY_ARMING_READY', gates: [passedGate, ...approvalBlockers] }], evidence: { ...readiness.evidence, prerequisitesForRiskReducingGrantPassed: true } } as TradingAccountReadinessAssessment })).toContain('Grant RISK_REDUCING authorization');
  });
  it('advances from effective RISK_REDUCING to fresh ENTRY readiness when ENTRY is ineffective', () => {
    expect(show({ entry: false, assessment: { ...readiness, result: 'BLOCKED', evidence: { ...readiness.evidence, prerequisitesForEntryGrantPassed: false } } })).toContain('Run a fresh Live Entry Arming assessment');
  });
  it('keeps ordinary incomplete setup directed to canary staging', () => {
    expect(show({ staged: false })).toContain('Stage the RSP canary');
  });
  it('projects the real paused activation dependency graph', () => {
    const paused = { ...account, status: 'PAUSED' as const };
    const activation = {
      ...readiness,
      purpose: 'LIVE_ACTIVATION' as const,
      result: 'BLOCKED' as const,
      validity: 'CURRENT' as const,
    };

    expect(show({ account: paused, risk: false, entry: false, assessment: null }))
      .toContain('Run a fresh Live Activation assessment to establish current RISK_REDUCING authorization evidence');
    cleanup();
    expect(show({ account: paused, risk: false, entry: false, assessment: activation }))
      .toContain('Grant RISK_REDUCING authorization from the current Live Activation assessment');
    cleanup();
    expect(show({ account: paused, risk: true, entry: false, assessment: activation }))
      .toContain('Run a fresh Live Activation assessment with RISK_REDUCING authorization effective');
    cleanup();
    expect(show({ account: paused, risk: true, entry: false, assessment: { ...activation, result: 'PASSED' } }))
      .toContain('Activate the Live account with entries disarmed');
  });
  it('directs an operator to run readiness when ENTRY is effective but readiness is stale', () => expect(show({ assessment: { ...readiness, validity: 'STALE' } })).toContain('Run a fresh Live Entry Arming assessment'));
  it('labels PASSED/CURRENT readiness as ready to arm', () => { show(); expect(screen.getByText('READY TO ARM')).toBeTruthy(); expect(screen.getByTestId('live-entry-next-action').textContent).toContain('ARM LIVE ENTRIES'); });
  it('does not present current ENTRY as effective when the approval query says INVALIDATED', () => {
    show({ entry: false });
    expect(screen.getByText('ENTRY effective').closest('li')?.textContent).toContain('PENDING');
    expect(screen.queryByText('READY TO ARM')).toBeNull();
  });
  it('rejects current-looking readiness bound to stale approval revisions', () => {
    expect(show({ riskRevision: 3, entryRevision: 4 })).toContain('Run a fresh Live Entry Arming assessment');
    expect(screen.getByText('Live Entry Arming assessment passed and current').closest('li')?.textContent).toContain('NEXT');
    expect(screen.queryByText('READY TO ARM')).toBeNull();
  });
  it('requires fresh post-approval readiness when both approvals are current', () => {
    expect(show({ assessment: null })).toContain('Run a fresh Live Entry Arming assessment');
  });
  it('derives matching readiness milestone and next action from one canonical state', () => {
    const state = deriveLiveEntrySetupState({ account, assessment: readiness, canaryPresent: true, canaryStaged: true, riskApproval: { effective: true, approval: { revision: 1 } }, entryApproval: { effective: true, approval: { revision: 2 } } });
    expect(state.milestones.find((item) => item.key === 'readiness')?.status).toBe('DONE');
    expect(state.nextAction).toBe('ARM LIVE ENTRIES.');
    expect(state.readyToArm).toBe(true);
  });
  it('directs an armed pre-consumption operator to execute the one-shot canary', () => expect(show({ account: { ...account, activeLiveEntryArmingId: 4, tradingEnabled: true, killSwitchEnabled: false } })).toContain('Execute the one-shot RSP canary'));
  it('shows terminal completion when consumed authority has complete safe cleanup', () => {
    const next = show({ staged: false, risk: false, entry: false, assessment: { ...readiness, validity: 'EXPIRED' }, account: { ...account, latestLiveEntryArming: consumedArming } });
    expect(screen.getByText('CANARY COMPLETE')).toBeTruthy();
    expect(next).toContain('Acceptance canary completed successfully');
    expect(next).toContain('account is safely disarmed');
    expect(next).not.toContain('Next step:');
    expect(screen.getByText('RSP canary was staged for consumed ceremony').closest('li')?.textContent).toContain('DONE');
    expect(screen.getByText('ENTRY was effective for consumed ceremony').closest('li')?.textContent).toContain('DONE');
    expect(screen.getByText('Live Entry Arming assessment passed for consumed ceremony').closest('li')?.textContent).toContain('DONE');
    expect(screen.getByText('Live entries were armed for consumed ceremony').closest('li')?.textContent).toContain('DONE');
    expect(screen.getByText('Account safely disarmed after canary').closest('li')?.textContent).toContain('DONE');
  });
  it('requires cleanup when consumption exists but the account remains armed', () => {
    const next = show({ account: { ...account, activeLiveEntryArmingId: 4, tradingEnabled: true, killSwitchEnabled: false, latestLiveEntryArming: consumedArming } });
    expect(screen.getByText('ACTION REQUIRED')).toBeTruthy();
    expect(next).toContain('DISARM and restore');
    expect(screen.getByText('Account safely disarmed after canary').closest('li')?.textContent).toContain('NEXT');
  });
  it('keeps canonical safety requirements in a theme-aware, readable next-step panel', () => {
    show();
    expect(screen.getByText('ENTRY approval alone does not authorize a broker entry.')).toBeTruthy();
    expect(screen.getByText('No broker order has been sent.')).toBeTruthy();
    expect(screen.getByText('What happens next').textContent).toBe('What happens next');
    const style = screen.getByTestId('live-entry-next-panel').getAttribute('style') ?? '';
    expect(style).toContain('var(--mantine-color-default)');
    expect(style).toContain('var(--mantine-color-default-color)');
    expect(style).not.toContain('gray.0');
  });
});
