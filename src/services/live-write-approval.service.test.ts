import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'development',
    LIVE_WRITE_DEPLOYMENT_ROLE: 'OBSERVATION_ONLY',
    ALLOW_LIVE_TRADING: true,
    ALLOW_LIVE_RISK_REDUCING_WRITES: true,
  },
  accountFindUnique: vi.fn(),
  credentialFindUnique: vi.fn(),
  approvalFindUnique: vi.fn(),
  decisionFindMany: vi.fn(),
}));

vi.mock('../config/env.js', () => ({ env: mocks.env }));
vi.mock('../db/prisma.js', () => ({ prisma: {
  tradingAccount: { findUnique: mocks.accountFindUnique },
  tradingAccountCredential: { findUnique: mocks.credentialFindUnique },
  tradingAccountLiveWriteApproval: { findUnique: mocks.approvalFindUnique },
  tradingAccountLiveWriteApprovalDecision: { findMany: mocks.decisionFindMany },
} }));
vi.mock('../integrations/alpaca/orders.adapter.js', () => ({ getOpenAlpacaOrders: vi.fn() }));
vi.mock('../integrations/alpaca/positions.adapter.js', () => ({ getAlpacaPositions: vi.fn() }));

import { authorizeLiveBrokerWrite, getLiveWriteApprovalState, invalidateLiveWriteApprovals } from './live-write-approval.service.js';

const account = {
  id: 2, broker: 'ALPACA', environment: 'LIVE', baseCurrency: 'USD',
  maxDeployableNotional: 1000, brokerAccountId: 'live-account', riskSettings: null,
  allocations: [], accountSubscriptions: [],
};
const credential = {
  id: 4, authType: 'API_KEY', status: 'ACTIVE', keyFingerprint: 'safe-fingerprint',
  encryptionVersion: 1, verifiedAt: new Date('2026-08-15T00:00:00Z'), revokedAt: null,
  updatedAt: new Date('2026-08-15T00:00:00Z'),
};

describe('Live write authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.env, { NODE_ENV: 'development', LIVE_WRITE_DEPLOYMENT_ROLE: 'OBSERVATION_ONLY',
      ALLOW_LIVE_TRADING: true, ALLOW_LIVE_RISK_REDUCING_WRITES: true });
    mocks.accountFindUnique.mockResolvedValue(account);
    mocks.credentialFindUnique.mockResolvedValue(credential);
    mocks.approvalFindUnique.mockResolvedValue(null);
  });

  it('keeps development observation-only even when global Live flags are enabled', async () => {
    await expect(authorizeLiveBrokerWrite(2, 'ENTRY_WRITE')).rejects.toThrow('observation-only');
    expect(mocks.approvalFindUnique).not.toHaveBeenCalled();
  });

  it('does not apply Live write approval to PAPER writes', async () => {
    mocks.accountFindUnique.mockResolvedValueOnce({ ...account, environment: 'PAPER' });
    await expect(authorizeLiveBrokerWrite(1, 'ENTRY_WRITE')).resolves.toBeUndefined();
  });

  it('fails closed for an unknown write classification', async () => {
    Object.assign(mocks.env, { NODE_ENV: 'production', LIVE_WRITE_DEPLOYMENT_ROLE: 'PRODUCTION_EXECUTOR' });
    await expect(authorizeLiveBrokerWrite(2, 'LIFECYCLE_READ')).rejects.toThrow('Unknown Live write classification');
  });

  it('makes ENTRY ineffective when its risk-reducing dependency is missing', async () => {
    const initial = await getLiveWriteApprovalState(2);
    const entryFingerprints = initial.capabilities.find((item) => item.capability === 'ENTRY')!.fingerprints!;
    mocks.approvalFindUnique.mockImplementation(async ({ where }) => {
      const capability = where.tradingAccountId_capability.capability;
      if (capability === 'RISK_REDUCING') return null;
      return {
        status: 'GRANTED', revision: 1, expiresAt: new Date('2099-01-01T00:00:00Z'),
        ...entryFingerprints,
        grantedByUser: null, revokedByUser: null,
      };
    });
    const state = await getLiveWriteApprovalState(2);
    expect(state.capabilities.find((item) => item.capability === 'ENTRY')).toMatchObject({
      effective: false,
      reason: 'RISK_REDUCING_DEPENDENCY_MISSING',
    });
  });

  it('authorizes ENTRY only when both current approvals are effective', async () => {
    const initial = await getLiveWriteApprovalState(2);
    const byCapability = new Map(initial.capabilities.map((item) => [item.capability, item.fingerprints!]));
    mocks.approvalFindUnique.mockImplementation(async ({ where }) => ({
      status: 'GRANTED', revision: 2, expiresAt: new Date('2099-01-01T00:00:00Z'),
      ...byCapability.get(where.tradingAccountId_capability.capability),
      grantedByUser: null, revokedByUser: null,
    }));
    Object.assign(mocks.env, { NODE_ENV: 'production', LIVE_WRITE_DEPLOYMENT_ROLE: 'PRODUCTION_EXECUTOR' });
    await expect(authorizeLiveBrokerWrite(2, 'ENTRY_WRITE')).resolves.toBeUndefined();
  });

  it('persists invalidation as a revisioned immutable decision', async () => {
    const approvalUpdate = vi.fn().mockResolvedValue({});
    const decisionCreate = vi.fn().mockResolvedValue({});
    const eventCreate = vi.fn().mockResolvedValue({});
    const tx = {
      tradingAccountLiveWriteApproval: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ status: 'GRANTED' })
          .mockResolvedValueOnce({
            id: 1, status: 'GRANTED', revision: 4,
            configurationFingerprint: 'configuration', credentialFingerprint: 'credential',
            readinessAssessmentId: 9, expiresAt: null,
          }),
        update: approvalUpdate,
      },
      tradingAccountLiveWriteApprovalDecision: { create: decisionCreate },
      systemEvent: { create: eventCreate },
    };
    await invalidateLiveWriteApprovals(tx as never, 2, ['ENTRY'] as never,
      'Entry configuration changed.');
    expect(approvalUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'INVALIDATED', revision: 5 }),
    }));
    expect(decisionCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'INVALIDATE', priorRevision: 4, resultingRevision: 5 }),
    }));
    expect(eventCreate).toHaveBeenCalledOnce();
  });
});
