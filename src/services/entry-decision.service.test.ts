import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  entryDecisionCreate: vi.fn(),
  entryDecisionFindFirst: vi.fn(),
  entryDecisionFindMany: vi.fn(),
  entryDecisionFindUnique: vi.fn(),
  entryDecisionCount: vi.fn(),
  entryDecisionUpdateMany: vi.fn(),
  securityFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  tradingAccountSubscriptionFindUnique: vi.fn(),
  membershipFindUnique: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    entryDecision: {
      create: mocks.entryDecisionCreate,
      findFirst: mocks.entryDecisionFindFirst,
      findMany: mocks.entryDecisionFindMany,
      findUnique: mocks.entryDecisionFindUnique,
      count: mocks.entryDecisionCount,
      updateMany: mocks.entryDecisionUpdateMany,
    },
    security: {
      findUnique: mocks.securityFindUnique,
    },
    subscription: {
      findUnique: mocks.subscriptionFindUnique,
    },
    tradingAccountSubscription: {
      findUnique: mocks.tradingAccountSubscriptionFindUnique,
    },
    tradingAccountMembership: { findUnique: mocks.membershipFindUnique },
  },
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
  TRADING_ACCOUNT_SUMMARY_SELECT: {
    id: true,
    displayName: true,
    broker: true,
    environment: true,
    status: true,
  },
}));

import {
  ensureEntryDecisionCanLink,
  getEntryDecisionById,
  getAccessibleEntryDecisionById,
  linkEntryDecisionToBrokerOrder,
  linkEntryDecisionToOrderIntent,
  linkEntryDecisionToTrackedPosition,
  listEntryDecisions,
  listAccessibleEntryDecisions,
  recordEntryDecision,
} from './entry-decision.service.js';

function input(overrides: Record<string, unknown> = {}) {
  return {
    decisionKey: 'n8n:spy:2026-06-25T15:00',
    evaluatedAt: '2026-06-25T15:00:00.000Z',
    source: 'n8n-ai-trader',
    symbol: 'spy',
    decisionState: 'idle',
    decisionReason: 'above_dip_threshold',
    signalEligible: false,
    signalCreated: false,
    signalBlocked: false,
    dipPercent: -0.5,
    dipThresholdPercent: -1,
    allowOrderSignals: true,
    cooldownActive: false,
    paperMode: true,
    rawDecisionJson: {
      raw: true,
    },
    tradingAccountId: 1,
    tradingAccountSubscriptionId: 44,
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    decisionKey: 'n8n:spy:previous',
    evaluatedAt: new Date('2026-06-25T14:59:00.000Z'),
    symbol: 'SPY',
    decisionState: 'idle',
    decisionReason: 'above_dip_threshold',
    signalCreated: false,
    signalBlocked: false,
    dipPercent: -0.5,
    dipThresholdPercent: -1,
    cooldownActive: false,
    allowOrderSignals: true,
    eventRisk: null,
    decisionFingerprint: 'same-fingerprint',
    ...overrides,
  };
}

describe('entry decision service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entryDecisionCount.mockResolvedValue(0);
    mocks.entryDecisionFindUnique.mockResolvedValue(null);
    mocks.entryDecisionFindFirst.mockResolvedValue(null);
    mocks.entryDecisionFindMany.mockResolvedValue([]);
    mocks.entryDecisionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.securityFindUnique.mockResolvedValue({ id: 11, symbol: 'SPY' });
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    mocks.tradingAccountSubscriptionFindUnique.mockResolvedValue({
      tradingAccountId: 1,
      subscriptionId: 22,
    });
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.entryDecisionCreate.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 101,
        createdAt: new Date('2026-06-25T15:00:01.000Z'),
        updatedAt: new Date('2026-06-25T15:00:01.000Z'),
        ...data,
      })
    );
  });

  it('persists the first decision snapshot for a symbol', async () => {
    const result = await recordEntryDecision(input());

    expect(result.persisted).toBe(true);
    expect(result.persistenceReason).toBe('initial_state');
    expect(mocks.entryDecisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decisionKey: 'n8n:spy:2026-06-25T15:00',
        symbol: 'SPY',
        decisionState: 'idle',
        persistenceReason: 'initial_state',
        tradingAccountId: 1,
        securityId: 11,
      }),
    });
  });

  it('returns the existing row for duplicate decision keys', async () => {
    const existing = decision({ decisionKey: 'n8n:spy:2026-06-25T15:00' });
    mocks.entryDecisionFindUnique.mockResolvedValue(existing);

    const result = await recordEntryDecision(input());

    expect(result).toEqual({
      persisted: false,
      skipped: false,
      duplicate: true,
      persistenceReason: 'duplicate_decision_key',
      decision: existing,
    });
    expect(mocks.entryDecisionCreate).not.toHaveBeenCalled();
  });

  it('skips unchanged idle decisions inside the checkpoint interval', async () => {
    const decisionFingerprint = 'same-fingerprint';
    mocks.entryDecisionFindFirst.mockResolvedValue(
      decision({ decisionFingerprint })
    );

    const result = await recordEntryDecision(
      input({
        decisionKey: 'n8n:spy:2026-06-25T15:01',
        decisionFingerprint,
      })
    );

    expect(result).toEqual({
      persisted: false,
      skipped: true,
      duplicate: false,
      persistenceReason: null,
      decision: null,
    });
    expect(mocks.entryDecisionCreate).not.toHaveBeenCalled();
  });

  it('persists meaningful decision state changes', async () => {
    mocks.entryDecisionFindFirst.mockResolvedValue(decision());

    const result = await recordEntryDecision(
      input({
        decisionKey: 'n8n:spy:2026-06-25T15:02',
        decisionState: 'eligible',
        decisionReason: 'dip_threshold_met',
      })
    );

    expect(result.persisted).toBe(true);
    expect(result.persistenceReason).toBe('decision_state_changed');
    expect(mocks.entryDecisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decisionState: 'eligible',
        persistenceReason: 'decision_state_changed',
        tradingAccountId: 1,
      }),
    });
  });

  it('always persists signal-created decisions', async () => {
    mocks.entryDecisionFindFirst.mockResolvedValue(decision());

    const result = await recordEntryDecision(
      input({
        decisionKey: 'n8n:spy:2026-06-25T15:03',
        signalCreated: true,
        decisionState: 'signal_created',
      })
    );

    expect(result.persisted).toBe(true);
    expect(result.persistenceReason).toBe('signal_created');
  });

  it('persists one global signal decision without an account assignment', async () => {
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: 22,
      key: 'spy_dip_core',
      securityId: 11,
      strategyId: 33,
      exitProfileId: 44,
      security: { id: 11, symbol: 'SPY' },
      strategy: { id: 33, key: 'dip_n_ride_etf' },
      exitProfile: { id: 44, key: 'quick_exit' },
    });

    const result = await recordEntryDecision(
      input({
        signalCreated: true,
        decisionState: 'signal_created',
        tradingAccountId: undefined,
        tradingAccountSubscriptionId: undefined,
        subscriptionKey: 'spy_dip_core',
      })
    );

    expect(result.persisted).toBe(true);
    expect(mocks.entryDecisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decisionKey: 'n8n:spy:2026-06-25T15:00',
        tradingAccountId: null,
        tradingAccountSubscriptionId: null,
        subscriptionKey: 'spy_dip_core',
      }),
    });
  });

  it('enriches decision context from subscription keys', async () => {
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: 22,
      key: 'spy_dip_core',
      securityId: 11,
      strategyId: 33,
      exitProfileId: 44,
      security: {
        id: 11,
        symbol: 'SPY',
      },
      strategy: {
        id: 33,
        key: 'dip_n_ride_etf',
      },
      exitProfile: {
        id: 44,
        key: 'quick_exit',
      },
    });

    await recordEntryDecision(
      input({
        subscriptionKey: 'spy_dip_core',
      })
    );

    expect(mocks.subscriptionFindUnique).toHaveBeenCalledWith({
      where: { key: 'spy_dip_core' },
      include: {
        strategy: true,
        exitProfile: true,
        security: true,
      },
    });
    expect(mocks.entryDecisionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        securityId: 11,
        tradingAccountId: 1,
        subscriptionId: 22,
        subscriptionKey: 'spy_dip_core',
        strategyId: 33,
        strategyKey: 'dip_n_ride_etf',
        exitProfileId: 44,
        exitProfileKey: 'quick_exit',
      }),
    });
  });

  it('preflights linkable entry decisions', async () => {
    mocks.entryDecisionFindUnique.mockResolvedValue({
      id: 101,
      decisionKey: 'decision-101',
      orderIntentId: null,
    });

    const result = await ensureEntryDecisionCanLink('decision-101');

    expect(result).toEqual({
      id: 101,
      decisionKey: 'decision-101',
      orderIntentId: null,
    });
  });

  it('rejects missing entry decisions before linking', async () => {
    mocks.entryDecisionFindUnique.mockResolvedValue(null);

    await expect(ensureEntryDecisionCanLink('missing')).rejects.toMatchObject({
      statusCode: 404,
      message: 'Entry decision missing was not found.',
    });
  });

  it('rejects entry decisions already linked to another order intent', async () => {
    mocks.entryDecisionFindUnique.mockResolvedValue({
      id: 101,
      decisionKey: 'decision-101',
      orderIntentId: 25,
    });

    await expect(
      ensureEntryDecisionCanLink('decision-101')
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        'Entry decision decision-101 is already linked to order intent 25.',
    });
  });

  it('links an entry decision to an order intent', async () => {
    mocks.entryDecisionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.entryDecisionFindUnique.mockResolvedValue(
      decision({
        decisionKey: 'decision-101',
        orderIntentId: 55,
      })
    );

    await linkEntryDecisionToOrderIntent({
      decisionKey: 'decision-101',
      orderIntentId: 55,
      tradingAccountId: 1,
      tradingAccountSubscriptionId: 44,
    });

    expect(mocks.entryDecisionUpdateMany).toHaveBeenCalledWith({
      where: {
        decisionKey: 'decision-101',
        orderIntentId: null,
      },
      data: {
        orderIntentId: 55,
        tradingAccountId: 1,
        tradingAccountSubscriptionId: 44,
      },
    });
  });

  it('links an entry decision to a broker order by order intent', async () => {
    await linkEntryDecisionToBrokerOrder({
      orderIntentId: 55,
      brokerOrderRecordId: 77,
      tradingAccountId: 1,
    });

    expect(mocks.entryDecisionUpdateMany).toHaveBeenCalledWith({
      where: {
        orderIntentId: 55,
        brokerOrderRecordId: null,
      },
      data: {
        brokerOrderRecordId: 77,
        tradingAccountId: 1,
      },
    });
  });

  it('links an entry decision to a tracked position by order intent', async () => {
    await linkEntryDecisionToTrackedPosition({
      orderIntentId: 55,
      trackedPositionId: 303,
      tradingAccountSubscriptionId: 44,
    });

    expect(mocks.entryDecisionUpdateMany).toHaveBeenCalledWith({
      where: {
        orderIntentId: 55,
        trackedPositionId: null,
      },
      data: {
        trackedPositionId: 303,
        tradingAccountSubscriptionId: 44,
      },
    });
  });

  it('lists entry decisions with bounded filters', async () => {
    mocks.entryDecisionFindMany.mockResolvedValue([
      decision({ id: 101, decisionKey: 'decision-101' }),
    ]);

    const result = await listEntryDecisions({
      symbol: 'spy',
      decisionState: 'idle',
      subscriptionId: 22,
      signalCreated: false,
      dateFrom: new Date('2026-06-25T14:00:00.000Z'),
      dateTo: new Date('2026-06-25T16:00:00.000Z'),
      limit: 900,
    });

    expect(mocks.entryDecisionFindMany).toHaveBeenCalledWith({
      where: {
        symbol: 'SPY',
        decisionState: { equals: 'idle', mode: 'insensitive' },
        subscriptionId: 22,
        OR: [
          { tradingAccountId: null },
          { tradingAccountId: 1 },
        ],
        signalCreated: false,
        evaluatedAt: {
          gte: new Date('2026-06-25T14:00:00.000Z'),
          lte: new Date('2026-06-25T16:00:00.000Z'),
        },
      },
      orderBy: {
        evaluatedAt: 'desc',
      },
      take: 500,
      select: expect.objectContaining({
        tradingAccountId: true,
        tradingAccount: {
          select: {
            id: true,
            displayName: true,
            broker: true,
            environment: true,
            status: true,
          },
        },
      }),
    });
    expect(result.filters).toMatchObject({
      symbol: 'SPY',
      decisionState: 'idle',
      subscriptionId: 22,
      signalCreated: false,
      limit: 500,
    });
  });

  it('lists global and default-account decisions without exposing other accounts', async () => {
    mocks.entryDecisionFindMany.mockResolvedValue([
      decision({ id: 101, tradingAccountId: null }),
      decision({ id: 102, tradingAccountId: 1 }),
    ]);

    const result = await listEntryDecisions();

    expect(mocks.entryDecisionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { tradingAccountId: null },
            { tradingAccountId: 1 },
          ],
        },
      })
    );
    expect(result.decisions).toHaveLength(2);
  });

  it('returns an account-neutral global decision by id', async () => {
    const globalDecision = decision({ id: 101, tradingAccountId: null });
    mocks.entryDecisionFindFirst.mockResolvedValue(globalDecision);

    const result = await getEntryDecisionById(101);

    expect(mocks.entryDecisionFindFirst).toHaveBeenCalledWith({
      where: {
        id: 101,
        OR: [
          { tradingAccountId: null },
          { tradingAccountId: 1 },
        ],
      },
      include: expect.any(Object),
    });
    expect(result.decision).toBe(globalDecision);
  });

  it('returns a default-account decision by id', async () => {
    const accountDecision = decision({ id: 102, tradingAccountId: 1 });
    mocks.entryDecisionFindFirst.mockResolvedValue(accountDecision);

    const result = await getEntryDecisionById(102);

    expect(result.decision).toBe(accountDecision);
  });

  it('does not expose a decision belonging only to another account', async () => {
    mocks.entryDecisionFindFirst.mockResolvedValue(null);

    await expect(getEntryDecisionById(103)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mocks.entryDecisionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 103,
          OR: [
            { tradingAccountId: null },
            { tradingAccountId: 1 },
          ],
        },
      })
    );
  });

  it('includes null-attributed decisions only for owner ALL scope', async () => {
    mocks.entryDecisionFindMany.mockResolvedValue([]);
    mocks.entryDecisionCount.mockResolvedValue(51);
    const result = await listAccessibleEntryDecisions({ id: 1, platformRole: 'SYSTEM_OWNER' }, null, { page: 2, pageSize: 25 });
    expect(mocks.entryDecisionFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    expect(mocks.entryDecisionFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 25, take: 25 }));
    expect(result.pagination).toEqual({ page: 2, pageSize: 25, total: 51, totalPages: 3 });
    await listAccessibleEntryDecisions({ id: 9, platformRole: 'OPERATOR' }, null, {});
    expect(mocks.entryDecisionFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { tradingAccount: { memberships: { some: { userId: 9 } } } },
    }));
  });

  it('matches a displayed decision-state label case-insensitively', async () => {
    mocks.entryDecisionFindMany.mockResolvedValue([]);
    await listAccessibleEntryDecisions(
      { id: 1, platformRole: 'SYSTEM_OWNER' },
      null,
      { decisionState: 'Watching dip setup' }
    );
    expect(mocks.entryDecisionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { decisionState: { equals: 'Watching_dip_setup', mode: 'insensitive' } },
    }));
  });

  it('excludes null history from selected-account scope', async () => {
    mocks.membershipFindUnique.mockResolvedValue({ id: 5 });
    mocks.entryDecisionFindMany.mockResolvedValue([]);
    await listAccessibleEntryDecisions({ id: 9, platformRole: 'OPERATOR' }, 7, {});
    expect(mocks.entryDecisionFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tradingAccountId: 7 } }));
  });

  it('uses record attribution for arbitrary-account detail authorization', async () => {
    mocks.entryDecisionFindFirst.mockResolvedValue(null);
    await expect(getAccessibleEntryDecisionById({ id: 9, platformRole: 'OPERATOR' }, 103)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.entryDecisionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 103, tradingAccount: { memberships: { some: { userId: 9 } } } },
    }));
  });
});
