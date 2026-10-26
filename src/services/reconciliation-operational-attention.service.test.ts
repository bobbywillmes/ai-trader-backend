import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ assessLifecycleAuthority: vi.fn(), findMany: vi.fn(), open: vi.fn(), resolve: vi.fn() }));

vi.mock('../db/prisma.js', () => ({ prisma: { operationalAttention: { findMany: mocks.findMany } } }));
vi.mock('./lifecycle-authority.service.js', () => ({ assessLifecycleAuthority: mocks.assessLifecycleAuthority }));
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
const observerAssessment = {
  tradingAccountId: 1, environment: 'PAPER', outcome: 'OBSERVER', reasonCode: 'VERIFIED_OBSERVER', reason: 'verified',
  expectedBrokerAccountId: 'PA-BOBBY', storedBrokerAccountId: 'PA-BOBBY', observedBrokerAccountId: 'PA-BOBBY',
  credentialFingerprint: 'sha256:fixture', configurationRevision: 'sha256:config',
  verifiedAt: '2026-10-26T12:00:00.000Z', expiresAt: '2026-10-26T12:05:00.000Z',
  allowedOperations: ['OBSERVE'], deniedOperations: [], provenanceRequiredForStrategyOperations: [],
  policyDelegation: 'PAPER_LIFECYCLE_AUTHORITY',
} as const;

describe('reconciliation Operational Attention authority projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assessLifecycleAuthority.mockResolvedValue(observerAssessment);
    mocks.findMany.mockResolvedValue([]);
    mocks.open.mockResolvedValue({ attention: { id: 1 } });
    mocks.resolve.mockResolvedValue({ id: 1, status: 'RESOLVED' });
  });

  it('does not create action-required ownership attention for a freshly verified PAPER observer', async () => {
    await expect(projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: [ownershipFinding],
      eventIds: new Map(), runIdentifier: 'run-1' })).resolves.toEqual({ updated: 0, resolved: 0 });
    expect(mocks.assessLifecycleAuthority).toHaveBeenCalledWith(1, { forceRefresh: true });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('resolves an existing observer-inapplicable episode without claiming the condition disappeared', async () => {
    mocks.findMany.mockResolvedValue([{ id: 41, revision: 6,
      fingerprint: 'account:1|reconciliation:entry_exposure_claim_unresolved|trackedPosition:7', code: 'LIFECYCLE_REVIEW_REQUIRED' }]);
    await expect(projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: [ownershipFinding],
      eventIds: new Map(), runIdentifier: 'run-2' })).resolves.toEqual({ updated: 0, resolved: 1 });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 41, reason: expect.stringContaining('observer-inapplicable'),
      evidence: expect.objectContaining({ conditionAbsent: false, conditionStillObserved: true, executorAuthorityRestored: false,
        lifecycleOwnershipRestored: false, lifecycleAuthorityOutcome: 'OBSERVER', lifecycleAuthorityReasonCode: 'VERIFIED_OBSERVER' }) }));
  });

  it('continues opening genuine non-ownership inconsistencies for an observer', async () => {
    await projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: [quantityFinding],
      eventIds: new Map(), runIdentifier: 'run-3' });
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ code: 'EXIT_QUANTITY_MISMATCH' }));
  });

  it('fails safe and projects ownership attention when authority is not verified', async () => {
    mocks.assessLifecycleAuthority.mockRejectedValue(new Error('broker read failed'));
    await projectReconciliationOperationalAttention({ tradingAccountId: 1, environment: 'PAPER', findings: [ownershipFinding],
      eventIds: new Map(), runIdentifier: 'run-4' });
    expect(mocks.open).toHaveBeenCalledOnce();
  });
});
