import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindMany: vi.fn(),
  trackedPositionFindFirst: vi.fn(),
  systemEventFindMany: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: {
      findMany: mocks.trackedPositionFindMany,
      findFirst: mocks.trackedPositionFindFirst,
    },
    systemEvent: {
      findMany: mocks.systemEventFindMany,
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
  getTradeCycleById,
  listTradeCycles,
  listTradeCyclesForTradingAccount,
} from './trade-cycles.service.js';

function buildCycle(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    tradingAccountId: 1,
    tradingAccount: {
      id: 1,
      displayName: 'Bobby Paper',
      broker: 'ALPACA',
      environment: 'PAPER',
      status: 'ACTIVE',
    },
    broker: 'alpaca',
    symbol: 'SPY',
    side: 'long',
    qty: 3,
    avgEntryPrice: 100,
    currentPrice: 104,
    marketValue: 312,
    costBasis: 300,
    unrealizedPnL: 12,
    unrealizedPnLPct: 0.04,
    status: 'closed',
    openedAt: new Date('2026-06-12T14:30:00.000Z'),
    closedAt: new Date('2026-06-12T18:00:00.000Z'),
    rawPositionJson: {},
    configSnapshotJson: null,
    configSnapshotCapturedAt: null,
    exitState: {
      id: 201,
      status: 'closed',
      attentionCode: null,
    },
    subscription: {
      id: 301,
      key: 'spy_core',
      name: 'SPY Core',
      brokerMode: 'paper',
      strategy: {
        id: 401,
        key: 'dip_buy',
        name: 'Dip Buy',
      },
      exitProfile: {
        id: 501,
        key: 'target_trail',
        name: 'Target Trail',
      },
    },
    entryDecision: null,
    brokerActivities: [
      {
        id: 601,
        activityType: 'FILL',
        side: 'buy',
        qty: 3,
        price: 100,
        orderId: 'entry-order',
        transactionTime: new Date('2026-06-12T14:31:00.000Z'),
        createdAt: new Date('2026-06-12T14:31:05.000Z'),
      },
      {
        id: 602,
        activityType: 'FILL',
        side: 'sell',
        qty: 1,
        price: 104,
        orderId: 'close-order',
        transactionTime: new Date('2026-06-12T17:59:00.000Z'),
        createdAt: new Date('2026-06-12T17:59:05.000Z'),
      },
      {
        id: 603,
        activityType: 'FILL',
        side: 'sell',
        qty: 2,
        price: 105,
        orderId: 'close-order',
        transactionTime: new Date('2026-06-12T18:00:00.000Z'),
        createdAt: new Date('2026-06-12T18:00:05.000Z'),
      },
    ],
    ...overrides,
  };
}

describe('trade cycle service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.systemEventFindMany.mockResolvedValue([]);
  });

  it('lists trade cycles with computed lifecycle summary fields', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([buildCycle()]);

    const result = await listTradeCycles({
      symbol: 'spy',
      status: 'closed',
      limit: 25,
    });

    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith({
      where: {
        symbol: 'SPY',
        status: 'closed',
        tradingAccountId: 1,
      },
      include: expect.any(Object),
      orderBy: {
        openedAt: 'desc',
      },
      take: 25,
    });

    expect(result.cycles[0]).toEqual(
      expect.objectContaining({
        id: 101,
        tradingAccountId: 1,
        tradingAccount: {
          id: 1,
          displayName: 'Bobby Paper',
          broker: 'ALPACA',
          environment: 'PAPER',
          status: 'ACTIVE',
        },
        symbol: 'SPY',
        status: 'closed',
        quantity: 3,
        avgEntryPrice: 100,
        avgExitPrice: 104.66666666666667,
        closeFillQty: 3,
        strategy: {
          id: 401,
          key: 'dip_buy',
          name: 'Dip Buy',
        },
        subscription: {
          id: 301,
          key: 'spy_core',
          name: 'SPY Core',
          brokerMode: 'paper',
        },
        exitProfile: {
          id: 501,
          key: 'target_trail',
          name: 'Target Trail',
        },
      })
    );
    expect(result.cycles[0]?.realizedPnl).toBeCloseTo(14);
    expect(result.cycles[0]?.returnPct).toBeCloseTo(0.04666666666666671);
  });

  it('lists trade cycles for an explicit trading account without resolving the default account', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([buildCycle({ tradingAccountId: 7 })]);

    await listTradeCyclesForTradingAccount(7, {
      status: 'open',
      limit: 10,
    });

    expect(mocks.resolveDefaultTradingAccountId).not.toHaveBeenCalled();
    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith({
      where: {
        status: 'open',
        tradingAccountId: 7,
      },
      include: expect.any(Object),
      orderBy: {
        openedAt: 'desc',
      },
      take: 10,
    });
    expect(mocks.systemEventFindMany).toHaveBeenCalledWith({
      where: {
        entityType: 'trackedPosition',
        entityId: {
          in: ['101'],
        },
        tradingAccountId: 7,
        type: 'position.closed',
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  });

  it('uses position.closed event payloads as a legacy close summary fallback', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      buildCycle({
        brokerActivities: [],
        avgEntryPrice: 100,
        qty: 2,
      }),
    ]);
    mocks.systemEventFindMany.mockResolvedValue([
      {
        id: 901,
        type: 'position.closed',
        entityType: 'trackedPosition',
        entityId: '101',
        message: 'Position closed',
        createdAt: new Date('2026-06-12T18:00:10.000Z'),
        payloadJson: {
          closeQty: 2,
          closePrice: 105,
        },
      },
    ]);

    const result = await listTradeCycles();

    expect(result.cycles[0]).toEqual(
      expect.objectContaining({
        avgEntryPrice: 100,
        avgExitPrice: 105,
        closeFillQty: 2,
        realizedPnl: 10,
        returnPct: 0.05,
      })
    );
  });

  it('prefers historical config snapshot values over live joined config', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      buildCycle({
        configSnapshotJson: {
          schemaVersion: 1,
          subscription: {
            id: 301,
            key: 'spy_dip_core',
            name: 'Historical SPY Core',
            brokerMode: 'paper',
          },
          strategy: {
            id: 401,
            key: 'dip_buy',
            name: 'Historical Strategy Name',
          },
          exitProfile: {
            id: 501,
            key: 'target_trail',
            name: 'Historical Exit Profile',
          },
        },
        subscription: {
          id: 301,
          key: 'spy_dip_core',
          name: 'Renamed SPY Core',
          brokerMode: 'paper',
          strategy: {
            id: 401,
            key: 'dip_buy',
            name: 'Renamed Strategy',
          },
          exitProfile: {
            id: 501,
            key: 'target_trail',
            name: 'Renamed Exit Profile',
          },
        },
      }),
    ]);

    const result = await listTradeCycles();

    expect(result.cycles[0]).toEqual(
      expect.objectContaining({
        strategy: expect.objectContaining({
          name: 'Historical Strategy Name',
        }),
        subscription: expect.objectContaining({
          name: 'Historical SPY Core',
        }),
        exitProfile: expect.objectContaining({
          name: 'Historical Exit Profile',
        }),
      })
    );
  });

  it('includes linked entry decision summaries in trade cycles', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      buildCycle({
        entryDecision: {
          id: 901,
          decisionKey: 'decision-901',
          evaluatedAt: new Date('2026-06-12T14:29:00.000Z'),
          source: 'n8n-ai-trader',
          decisionState: 'signal_created',
          decisionReason: 'dip_threshold_met',
          signalCreated: true,
          signalBlocked: false,
          blockingReason: null,
          persistenceReason: 'signal_created',
        },
      }),
    ]);

    const result = await listTradeCycles();

    expect(result.cycles[0]).toEqual(
      expect.objectContaining({
        entryDecision: {
          id: 901,
          decisionKey: 'decision-901',
          evaluatedAt: new Date('2026-06-12T14:29:00.000Z'),
          source: 'n8n-ai-trader',
          decisionState: 'signal_created',
          decisionReason: 'dip_threshold_met',
          signalCreated: true,
          signalBlocked: false,
          blockingReason: null,
          persistenceReason: 'signal_created',
        },
      })
    );
  });

  it('returns a trade-cycle detail with related records and timeline', async () => {
    mocks.trackedPositionFindFirst.mockResolvedValue({
      ...buildCycle(),
      orderIntents: [
        {
          id: 701,
          source: 'close-position',
          side: 'sell',
          status: 'submitted',
          createdAt: new Date('2026-06-12T17:58:00.000Z'),
          brokerOrders: [],
        },
      ],
      brokerOrders: [
        {
          id: 801,
          brokerOrderId: 'close-order',
          side: 'sell',
          status: 'filled',
          createdAt: new Date('2026-06-12T17:58:01.000Z'),
        },
      ],
      entryDecision: {
        id: 903,
        decisionKey: 'decision-903',
        evaluatedAt: new Date('2026-06-12T14:29:00.000Z'),
        source: 'n8n-ai-trader',
        decisionState: 'signal_created',
        decisionReason: 'dip_threshold_met',
        signalCreated: true,
        signalBlocked: false,
        blockingReason: null,
        persistenceReason: 'signal_created',
      },
    });
    mocks.systemEventFindMany.mockResolvedValue([
      {
        id: 901,
        type: 'position.closed',
        message: 'Position closed',
        createdAt: new Date('2026-06-12T18:00:10.000Z'),
        payloadJson: {},
      },
    ]);

    const result = await getTradeCycleById(101);

    expect(mocks.trackedPositionFindFirst).toHaveBeenCalledWith({
      where: { id: 101, tradingAccountId: 1 },
      include: expect.objectContaining({
        tradingAccount: {
          select: {
            id: true,
            displayName: true,
            broker: true,
            environment: true,
            status: true,
          },
        },
        orderIntents: expect.objectContaining({
          include: {
            brokerOrders: true,
          },
          orderBy: {
            createdAt: 'asc',
          },
        }),
        brokerOrders: expect.objectContaining({
          orderBy: {
            createdAt: 'asc',
          },
        }),
        brokerActivities: expect.objectContaining({
          orderBy: {
            transactionTime: 'asc',
          },
        }),
      }),
    });
    expect(mocks.systemEventFindMany).toHaveBeenCalledWith({
      where: {
        entityType: 'trackedPosition',
        entityId: '101',
        tradingAccountId: 1,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    expect(result.cycle).toEqual(
      expect.objectContaining({
        id: 101,
        orderIntents: expect.arrayContaining([
          expect.objectContaining({ id: 701 }),
        ]),
        brokerOrders: expect.arrayContaining([
          expect.objectContaining({ id: 801 }),
        ]),
        entryDecision: expect.objectContaining({
          id: 903,
          decisionKey: 'decision-903',
        }),
        brokerActivities: expect.arrayContaining([
          expect.objectContaining({ id: 602 }),
        ]),
        systemEvents: expect.arrayContaining([
          expect.objectContaining({ id: 901 }),
        ]),
      })
    );
    expect(result.cycle.timeline.map((item) => item.source)).toEqual(
      expect.arrayContaining([
        'tracked_position',
        'entry_decision',
        'order_intent',
        'broker_order',
        'broker_activity',
        'system_event',
      ])
    );
  });

  it('returns empty lifecycle collections for cycles without related records', async () => {
    mocks.trackedPositionFindFirst.mockResolvedValue({
      ...buildCycle({
        brokerActivities: [],
        closedAt: null,
        status: 'open',
        subscription: null,
        exitState: null,
      }),
      orderIntents: [],
      brokerOrders: [],
    });
    mocks.systemEventFindMany.mockResolvedValue([]);

    const result = await getTradeCycleById(101);

    expect(result.cycle).toEqual(
      expect.objectContaining({
        status: 'open',
        closedAt: null,
        strategy: null,
        subscription: null,
        exitProfile: null,
        exitReason: null,
        exitStateStatus: null,
        avgExitPrice: null,
        realizedPnl: null,
        returnPct: null,
        closeFillQty: null,
        orderIntents: [],
        brokerOrders: [],
        brokerActivities: [],
        systemEvents: [],
      })
    );
    expect(result.cycle.timeline).toEqual([
      expect.objectContaining({
        type: 'position.opened',
        source: 'tracked_position',
      }),
    ]);
  });

  it('preserves nullable links and structured system event payloads in detail responses', async () => {
    mocks.trackedPositionFindFirst.mockResolvedValue({
      ...buildCycle({
        brokerActivities: [
          {
            id: 604,
            activityType: 'FILL',
            activityCategory: 'fill',
            side: 'sell',
            qty: 0.12345678,
            cumQty: 0.12345678,
            price: 104.987654,
            netAmount: 12.96143814812,
            orderId: 'close-order',
            orderIntentId: null,
            brokerOrderRecordId: null,
            trackedPositionId: null,
            trackedPositionLinkSource: null,
            trackedPositionLinkedAt: null,
            transactionTime: new Date('2026-06-12T17:59:30.000Z'),
            createdAt: new Date('2026-06-12T18:00:05.000Z'),
            rawBrokerJson: {
              id: 'activity-604',
              qty: '0.12345678',
            },
          },
        ],
      }),
      orderIntents: [
        {
          id: 702,
          source: 'observer',
          side: 'sell',
          status: 'blocked',
          blockReason: null,
          subscriptionId: null,
          subscriptionKey: null,
          trackedPositionId: null,
          createdAt: new Date('2026-06-12T17:58:00.000Z'),
          brokerOrders: [],
        },
      ],
      brokerOrders: [],
    });
    mocks.systemEventFindMany.mockResolvedValue([
      {
        id: 902,
        type: 'position.close_fill_attribution_ambiguous',
        entityType: 'trackedPosition',
        entityId: '101',
        message: null,
        createdAt: new Date('2026-06-12T18:00:10.000Z'),
        payloadJson: {
          reasons: ['multiple eligible close fills'],
          candidates: [
            {
              activityId: 'activity-604',
              qty: 0.12345678,
            },
          ],
        },
      },
    ]);

    const result = await getTradeCycleById(101);

    expect(result.cycle.orderIntents[0]).toEqual(
      expect.objectContaining({
        id: 702,
        subscriptionId: null,
        subscriptionKey: null,
        trackedPositionId: null,
        brokerOrders: [],
      })
    );
    expect(result.cycle.brokerActivities[0]).toEqual(
      expect.objectContaining({
        id: 604,
        orderIntentId: null,
        brokerOrderRecordId: null,
        trackedPositionId: null,
        trackedPositionLinkSource: null,
        qty: 0.12345678,
        price: 104.987654,
      })
    );
    expect(result.cycle.systemEvents[0]).toEqual(
      expect.objectContaining({
        id: 902,
        message: null,
        payloadJson: {
          reasons: ['multiple eligible close fills'],
          candidates: [
            {
              activityId: 'activity-604',
              qty: 0.12345678,
            },
          ],
        },
      })
    );
    expect(result.cycle.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'position.close_fill_attribution_ambiguous',
          source: 'system_event',
          summary: 'position.close_fill_attribution_ambiguous',
          entityId: 902,
        }),
      ])
    );
  });

  it('throws a 404 when a trade cycle is missing', async () => {
    mocks.trackedPositionFindFirst.mockResolvedValue(null);

    await expect(getTradeCycleById(999)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Trade cycle 999 was not found.',
    });
  });
});
