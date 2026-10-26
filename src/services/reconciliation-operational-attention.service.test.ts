import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ assessLifecycleAuthority: vi.fn(), assessPaperAuthority: vi.fn(), findMany: vi.fn(), open: vi.fn(), resolve: vi.fn() }));

vi.mock('../db/prisma.js', () => ({ prisma: { operationalAttention: { findMany: mocks.findMany } } }));
vi.mock('./lifecycle-authority.service.js', () => ({ assessLifecycleAuthority: mocks.assessLifecycleAuthority }));
vi.mock('./paper-broker-write-authority.service.js', () => ({ assessPaperBrokerWriteAuthorityForAccount: mocks.assessPaperAuthority }));
vi.mock('./operational-attention.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./operational-attention.service.js')>();
  return { ...actual, openOrObserveOperationalAttention: mocks.open, resolveOperationalAttentionAuthoritatively: mocks.resolve };
});
vi.mock('./historical-entry-lifecycle-workbench.service.js', () => ({ verifyAppliedHistoricalLifecycleActions: vi.fn() }));

import { projectReconciliationOperationalAttention } from './reconciliation-operational-attention.service.js';
import type { ReconciliationFinding } from './reconciliation.service.js';

const ownershipFinding: ReconciliationFinding = {
  code: 'entry_exposure_claim_unresolved', severity: 'critical', entityType: 'trackedPosition', entityId: '7', symbol: 'DIA',
  message: 'DIA entry exposure ownership requires review.', attentionCode: 'LIFECYCLE_REVIEW_REQUIRED', details: { trackedPositionId: 7 },
};
const quantityFinding: ReconciliationFinding = {
  code: 'position_quantity_mismatch', severity: 'critical', entityType: 'trackedPosition', entityId: '8', symbol: 'SPY',
  message: 'SPY broker exposure differs from tracked quantity.', attentionCode: 'EXIT_QUANTITY_MISMATCH', details: { trackedPositionId: 8 },
};
const genuineOperationalFindings: ReconciliationFinding[] = [
  quantityFinding,
  { code: 'position_side_mismatch', severity: 'critical', entityType: 'trackedPosition', entityId: '10', symbol: 'DIA',
    message: 'DIA broker exposure side differs.', attentionCode: 'BROKER_EXCESS_EXPOSURE', details: { trackedPositionId: 10 } },
  { code: 'trail_order_missing_after_unlock', severity: 'critical', entityType: 'trackedPosition', entityId: '11', symbol: 'IWM',
    message: 'IWM protective exit is unavailable.', attentionCode: 'PROTECTIVE_EXIT_UNAVAILABLE', details: { trackedPositionId: 11 } },
  { code: 'tracked_position_missing_at_broker', severity: 'critical', entityType: 'trackedPosition', entityId: '12', symbol: 'SPY',
    message: 'SPY tracked exposure is missing at broker.', attentionCode: 'BROKER_EXPOSURE_UNVERIFIABLE', details: { trackedPositionId: 12 } },
];
const observerInapplicableFindings: ReconciliationFinding[] = [
  { code: 'position_attribution_missing', severity: 'critical', entityType: 'trackedPosition', entityId: '6', symbol: 'QQQ',
    message: 'QQQ lifecycle attribution is incomplete.', attentionCode: 'LIFECYCLE_REVIEW_REQUIRED', details: { trackedPositionId: 6 } },
  ownershipFinding,
  { code: 'entry_exposure_claim_missing', severity: 'critical', entityType: 'trackedPosition', entityId: '9', symbol: 'IWM',
    message: 'IWM durable entry exposure ownership is missing.', attentionCode: 'LIFECYCLE_REVIEW_REQUIRED', details: { trackedPositionId: 9 } },
];
const observerAssessment = {
  tradingAccountId: 1, environment: 'PAPER', outcome: 'OBSERVER', reasonCode: 'VERIFIED_OBSERVER', reason: 'verified',
  expectedBrokerAccountId: 'PA-BOBBY', storedBrokerAccountId: 'PA-BOBBY', observedBrokerAccountId: 'PA-BOBBY',
  credentialFingerprint: 'sha256:fixture', configurationRevision: 'sha256:config',
  verifiedAt: '2026-10-26T12:00:00.000Z', expiresAt: '2026-10-26T12:05:00.000Z',
  allowedOperations: ['OBSERVE'], deniedOperations: [], provenanceRequiredForStrategyOperations: [],
  policyDelegation: 'PAPER_LIFECYCLE_AUTHORITY',
} as const;
const observerPaperWriteAssessment = {
  tradingAccountId: 1, displayName: 'Paper', ownershipRole: 'OBSERVER', expectedBrokerAccountId: 'PA-BOBBY',
  openLifecycleExposure: true, exposure: { activePositions: 1, nonterminalBrokerOrders: 0, activeOrderIntents: 0, activeEntryClaims: 0 },
  credentialUsable: null, brokerAccountIdVerified: null, credentialFingerprintConsistent: null, intendedExecutor: false,
  outcome: 'INTENTIONAL_OBSERVATION_ONLY', ready: true, reason: 'Explicit observer.',
} as const;

describe('reconciliation Operational Attention authority projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assessLifecycleAuthority.mockResolvedValue(observerAssessment);
    mocks.assessPaperAuthority.mockResolvedValue(observerPaperWriteAssessment);
    mocks.findMany.mockResolvedValue([]);
    mocks.open.mockResolvedValue({ attention: { id: 1 } });
    mocks.resolve.mockResolvedValue({ id: 1, status: 'RESOLVED' });
  });

  it('suppresses only the three approved findings for consistent development observer authority with exposure', async () => {
    await expect(projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: observerInapplicableFindings,
      eventIds: new Map(), runIdentifier: 'run-1' })).resolves.toEqual({ updated: 0, resolved: 0 });
    expect(mocks.assessLifecycleAuthority).toHaveBeenCalledWith(1, { forceRefresh: true });
    expect(mocks.assessPaperAuthority).toHaveBeenCalledWith(1);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('resolves an existing observer-inapplicable episode without claiming the condition disappeared', async () => {
    mocks.findMany.mockResolvedValue([{ id: 41, revision: 6,
      fingerprint: 'account:1|reconciliation:entry_exposure_claim_unresolved|trackedPosition:7', code: 'LIFECYCLE_REVIEW_REQUIRED' }]);
    await expect(projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: [ownershipFinding],
      eventIds: new Map(), runIdentifier: 'run-2' })).resolves.toEqual({ updated: 0, resolved: 1 });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 41, reason: expect.stringContaining('observer-inapplicable'),
      evidence: expect.objectContaining({ conditionAbsent: false, conditionStillObserved: true, executorAuthorityRestored: false,
        lifecycleOwnershipRestored: false, lifecycleAuthorityOutcome: 'OBSERVER', lifecycleAuthorityReasonCode: 'VERIFIED_OBSERVER',
        paperBrokerWriteAuthorityOutcome: 'INTENTIONAL_OBSERVATION_ONLY', paperBrokerWriteOwnershipRole: 'OBSERVER' }) }));
  });

  it('continues opening genuine quantity, side, protective-exit, and broker-exposure problems for an observer', async () => {
    await projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: genuineOperationalFindings,
      eventIds: new Map(), runIdentifier: 'run-3' });
    expect(mocks.open).toHaveBeenCalledTimes(4);
    expect(mocks.open.mock.calls.map(([call]) => call.code)).toEqual([
      'EXIT_QUANTITY_MISMATCH', 'BROKER_EXCESS_EXPOSURE', 'PROTECTIVE_EXIT_UNAVAILABLE', 'BROKER_EXPOSURE_UNVERIFIABLE',
    ]);
  });

  it('fails safe and projects ownership attention when authority is not verified', async () => {
    mocks.assessLifecycleAuthority.mockRejectedValue(new Error('broker read failed'));
    await projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: [ownershipFinding],
      eventIds: new Map(), runIdentifier: 'run-4' });
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it.each([
    ['production observer with exposure and denied PAPER write authority', observerAssessment, { ...observerPaperWriteAssessment, outcome: 'DENIED', ready: false }],
    ['contradictory lifecycle and PAPER write assessments', observerAssessment, { ...observerPaperWriteAssessment, ownershipRole: 'EXECUTOR', outcome: 'AUTHORIZED' }],
    ['unknown PAPER write authority evidence', observerAssessment, { ...observerPaperWriteAssessment, ownershipRole: 'UNKNOWN', outcome: 'UNKNOWN', ready: false }],
    ['production executor authority', { ...observerAssessment, outcome: 'EXECUTOR', reasonCode: 'VERIFIED_EXECUTOR' }, { ...observerPaperWriteAssessment, ownershipRole: 'EXECUTOR', outcome: 'AUTHORIZED' }],
  ])('keeps legacy ownership attention actionable for %s', async (_name, lifecycle, paperWrite) => {
    mocks.assessLifecycleAuthority.mockResolvedValue(lifecycle);
    mocks.assessPaperAuthority.mockResolvedValue(paperWrite);
    mocks.findMany.mockResolvedValue([{ id: 42, revision: 1,
      fingerprint: 'account:1|reconciliation:entry_exposure_claim_unresolved|trackedPosition:7', code: 'LIFECYCLE_REVIEW_REQUIRED' }]);
    await projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: [ownershipFinding],
      eventIds: new Map(), runIdentifier: 'run-5' });
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('fails closed when PAPER write authority evidence is unavailable', async () => {
    mocks.assessPaperAuthority.mockRejectedValue(new Error('authority database unavailable'));
    await projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: [ownershipFinding],
      eventIds: new Map(), runIdentifier: 'run-6' });
    expect(mocks.open).toHaveBeenCalledOnce();
  });
});
