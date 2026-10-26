import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  open: vi.fn(),
  resolve: vi.fn(),
  assessLifecycleAuthority: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({ prisma: { operationalAttention: { findFirst: mocks.findFirst } } }));
vi.mock('./operational-attention.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./operational-attention.service.js')>();
  return { ...actual, openOrObserveOperationalAttention: mocks.open, resolveOperationalAttentionAuthoritatively: mocks.resolve };
});
vi.mock('./lifecycle-authority.service.js', () => ({ assessLifecycleAuthority: mocks.assessLifecycleAuthority }));

import {
  reconcileAllPaperBrokerWriteAuthorityAttention,
  reconcilePaperBrokerWriteAuthorityAttention,
} from './paper-broker-write-authority-attention.service.js';
import type { PaperAccountAuthorityAssessment } from './paper-broker-write-authority.service.js';

const assessment = (id: number, outcome: PaperAccountAuthorityAssessment['outcome'] = 'DENIED'): PaperAccountAuthorityAssessment => ({
  tradingAccountId: id, displayName: `Account ${id}`, ownershipRole: 'EXECUTOR', expectedBrokerAccountId: `PA${id}`,
  openLifecycleExposure: true, exposure: { activePositions: 1, nonterminalBrokerOrders: 0, activeOrderIntents: 0, activeEntryClaims: 0 },
  credentialUsable: false, brokerAccountIdVerified: true, credentialFingerprintConsistent: false,
  intendedExecutor: true, outcome, ready: outcome === 'AUTHORIZED', reason: 'fixture',
});

describe('PAPER authority attention reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assessLifecycleAuthority.mockResolvedValue({ outcome: 'OBSERVER', reasonCode: 'VERIFIED_OBSERVER',
      verifiedAt: '2026-10-26T12:00:00.000Z', expiresAt: '2026-10-26T12:05:00.000Z',
      expectedBrokerAccountId: 'PA1', observedBrokerAccountId: 'PA1' });
  });

  it('retries a stale revision with freshly read state', async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: 8, revision: 1 }).mockResolvedValueOnce({ id: 8, revision: 2 });
    mocks.resolve.mockRejectedValueOnce(new Error('Operational attention revision is stale.')).mockResolvedValueOnce({ id: 8, status: 'RESOLVED' });
    await expect(reconcilePaperBrokerWriteAuthorityAttention(assessment(1, 'AUTHORIZED'))).resolves.toMatchObject({ status: 'RESOLVED' });
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it('resolves an exposed observer incident as inapplicable without claiming executor authority was restored', async () => {
    mocks.findFirst.mockResolvedValue({ id: 9, revision: 3 });
    mocks.resolve.mockResolvedValue({ id: 9, status: 'RESOLVED' });
    const observer = { ...assessment(1, 'INTENTIONAL_OBSERVATION_ONLY'), ownershipRole: 'OBSERVER' as const, intendedExecutor: false };
    await expect(reconcilePaperBrokerWriteAuthorityAttention(observer)).resolves.toMatchObject({ status: 'RESOLVED' });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining('executor authority was not restored'),
      evidence: expect.objectContaining({ executorAuthorityRestored: false, applicability: 'OBSERVER_INAPPLICABLE', openLifecycleExposure: true }),
    }));
  });

  it('does not create an executor incident for an observer when no active episode exists', async () => {
    mocks.findFirst.mockResolvedValue(null);
    const observer = { ...assessment(1, 'INTENTIONAL_OBSERVATION_ONLY'), ownershipRole: 'OBSERVER' as const, intendedExecutor: false };
    await expect(reconcilePaperBrokerWriteAuthorityAttention(observer)).resolves.toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('fails safe and opens attention when observer authority cannot be freshly verified', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.assessLifecycleAuthority.mockResolvedValue({ outcome: 'DENIED', reasonCode: 'BROKER_IDENTITY_MISMATCH' });
    const observer = { ...assessment(1, 'INTENTIONAL_OBSERVATION_ONLY'), ownershipRole: 'OBSERVER' as const, intendedExecutor: false };
    await reconcilePaperBrokerWriteAuthorityAttention(observer);
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ lifecycleAuthorityOutcome: 'DENIED', lifecycleAuthorityReasonCode: 'BROKER_IDENTITY_MISMATCH' }),
    }));
  });

  it('isolates one failed account and continues later reconciliation', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.open.mockRejectedValueOnce(new Error('first failed')).mockResolvedValueOnce({ attention: { id: 2 } });
    const result = await reconcileAllPaperBrokerWriteAuthorityAttention(async () => ({ accounts: [assessment(1), assessment(2)] }));
    expect(result).toEqual({ assessed: 2, failures: [{ tradingAccountId: 1, error: 'first failed' }], assessmentUnresolved: [] });
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });
});
