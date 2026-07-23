import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  entryDecisionCreate: vi.fn(),
  entryDecisionFindFirst: vi.fn(),
  entryDecisionFindMany: vi.fn(),
  entryDecisionFindUnique: vi.fn(),
  entryDecisionUpdateMany: vi.fn(),
  securityFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  tradingAccountSubscriptionFindUnique: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    entryDecision: {
      create: mocks.entryDecisionCreate,
      findFirst: mocks.entryDecisionFindFirst,
      findMany: mocks.entryDecisionFindMany,
      findUnique: mocks.entryDecisionFindUnique,
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
  linkEntryDecisionToBrokerOrder,
  linkEntryDecisionToOrderIntent,
  linkEntryDecisionToTrackedPosition,
  listEntryDecisions,
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
        decisionState: 'idle',
        subscriptionId: 22,
        tradingAccountId: 1,
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
});
