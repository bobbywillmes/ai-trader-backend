import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enumerateLifecycleAccounts } from './lifecycle-account-eligibility.service.js';

const mocks = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  intentGroupBy: vi.fn(),
  positionGroupBy: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: { findMany: mocks.accountFindMany },
    orderIntent: { groupBy: mocks.intentGroupBy },
    trackedPosition: { groupBy: mocks.positionGroupBy },
  },
}));

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    displayName: 'Bobby Paper',
    broker: 'ALPACA',
    environment: 'PAPER',
    status: 'ACTIVE',
    credential: { status: 'ACTIVE' },
    _count: {
      orderIntents: 0,
      brokerOrders: 0,
      trackedPositions: 0,
      brokerActivities: 0,
    },
    ...overrides,
  };
}

describe('lifecycle account eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.intentGroupBy.mockResolvedValue([]);
    mocks.positionGroupBy.mockResolvedValue([]);
  });

  it('returns accounts in stable ID order with workflow-specific reasons', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({ id: 1 }),
      account({
        id: 2,
        displayName: 'Bobby Live',
        environment: 'LIVE',
        status: 'NEEDS_CREDENTIALS',
        credential: null,
      }),
    ]);

    const result = await enumerateLifecycleAccounts('scheduled_snapshots');

    expect(mocks.accountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: 'asc' } })
    );
    expect(result.map((item) => item.tradingAccountId)).toEqual([1, 2]);
    expect(result[0]).toMatchObject({
      eligible: true,
      reason: 'usable_credentials_operational_account',
    });
    expect(result[1]).toMatchObject({
      eligible: false,
      reason: 'credentials_unavailable_dormant',
    });
  });

  it('marks a credentialless paused account with exposure as critical lifecycle work', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({
        status: 'PAUSED',
        credential: null,
        _count: {
          orderIntents: 1,
          brokerOrders: 1,
          trackedPositions: 1,
          brokerActivities: 0,
        },
      }),
    ]);
    mocks.intentGroupBy.mockResolvedValue([
      {
        tradingAccountId: 1,
        status: 'submitted',
        _count: { _all: 1 },
      },
    ]);

    const result = await enumerateLifecycleAccounts('positions');

    expect(result[0]).toMatchObject({
      eligible: false,
      reason: 'credentials_unavailable_with_exposure',
      exposureSummary: {
        submittedIntents: 1,
        nonterminalOrders: 1,
        activePositions: 1,
        hasLifecycleWork: true,
      },
    });
  });

  it('keeps paused accounts with usable credentials lifecycle-eligible', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({
        status: 'PAUSED',
        _count: {
          orderIntents: 0,
          brokerOrders: 0,
          trackedPositions: 1,
          brokerActivities: 0,
        },
      }),
    ]);

    const result = await enumerateLifecycleAccounts('positions');

    expect(result[0]).toMatchObject({
      eligible: true,
      reason: 'usable_credentials_with_work',
    });
  });

  it('evaluates exits for paused or kill-switched accounts with exposure', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({
        id: 1,
        status: 'PAUSED',
        _count: {
          orderIntents: 0,
          brokerOrders: 0,
          trackedPositions: 1,
          brokerActivities: 0,
        },
      }),
      account({
        id: 2,
        status: 'ERROR',
        _count: {
          orderIntents: 0,
          brokerOrders: 0,
          trackedPositions: 1,
          brokerActivities: 0,
        },
      }),
    ]);

    const result = await enumerateLifecycleAccounts('exit_evaluation');

    expect(result).toEqual([
      expect.objectContaining({ tradingAccountId: 1, eligible: true }),
      expect.objectContaining({ tradingAccountId: 2, eligible: true }),
    ]);
  });

  it('does not enumerate a credentialed account without exposure for exit evaluation', async () => {
    mocks.accountFindMany.mockResolvedValue([account()]);

    const result = await enumerateLifecycleAccounts('exit_evaluation');

    expect(result[0]).toMatchObject({
      eligible: false,
      reason: 'no_work_for_workflow',
    });
  });

  it('reports credentialless pending submissions without making them eligible', async () => {
    mocks.accountFindMany.mockResolvedValue([
      account({
        credential: null,
        _count: {
          orderIntents: 1,
          brokerOrders: 0,
          trackedPositions: 0,
          brokerActivities: 0,
        },
      }),
    ]);
    mocks.intentGroupBy.mockResolvedValue([
      {
        tradingAccountId: 1,
        status: 'pending',
        _count: { _all: 1 },
      },
    ]);

    const result = await enumerateLifecycleAccounts('pending_submissions');

    expect(result[0]).toMatchObject({
      eligible: false,
      reason: 'credentials_unavailable_with_exposure',
      exposureSummary: { pendingIntents: 1 },
    });
  });
});
