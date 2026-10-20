import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  open: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({ prisma: { operationalAttention: { findFirst: mocks.findFirst } } }));
vi.mock('./operational-attention.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./operational-attention.service.js')>();
  return { ...actual, openOrObserveOperationalAttention: mocks.open, resolveOperationalAttentionAuthoritatively: mocks.resolve };
});

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
  beforeEach(() => vi.clearAllMocks());

  it('retries a stale revision with freshly read state', async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: 8, revision: 1 }).mockResolvedValueOnce({ id: 8, revision: 2 });
    mocks.resolve.mockRejectedValueOnce(new Error('Operational attention revision is stale.')).mockResolvedValueOnce({ id: 8, status: 'RESOLVED' });
    await expect(reconcilePaperBrokerWriteAuthorityAttention(assessment(1, 'AUTHORIZED'))).resolves.toMatchObject({ status: 'RESOLVED' });
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it('preserves an exposed observer incident but resolves a non-exposed observer authoritatively', async () => {
    mocks.findFirst.mockResolvedValue({ id: 9, revision: 3 });
    const observer = { ...assessment(1, 'INTENTIONAL_OBSERVATION_ONLY'), ownershipRole: 'OBSERVER' as const, intendedExecutor: false };
    await expect(reconcilePaperBrokerWriteAuthorityAttention(observer)).resolves.toBeNull();
    expect(mocks.resolve).not.toHaveBeenCalled();
    mocks.resolve.mockResolvedValue({ id: 9, status: 'RESOLVED' });
    await expect(reconcilePaperBrokerWriteAuthorityAttention({ ...observer, openLifecycleExposure: false,
      exposure: { activePositions: 0, nonterminalBrokerOrders: 0, activeOrderIntents: 0, activeEntryClaims: 0 } })).resolves.toMatchObject({ status: 'RESOLVED' });
  });

  it('isolates one failed account and continues later reconciliation', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.open.mockRejectedValueOnce(new Error('first failed')).mockResolvedValueOnce({ attention: { id: 2 } });
    const result = await reconcileAllPaperBrokerWriteAuthorityAttention(async () => ({ accounts: [assessment(1), assessment(2)] }));
    expect(result).toEqual({ assessed: 2, failures: [{ tradingAccountId: 1, error: 'first failed' }] });
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });
});
