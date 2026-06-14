import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindMany: vi.fn(),
  trackedPositionFindUnique: vi.fn(),
  systemEventFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: {
      findMany: mocks.trackedPositionFindMany,
      findUnique: mocks.trackedPositionFindUnique,
    },
    systemEvent: {
      findMany: mocks.systemEventFindMany,
    },
  },
}));

import { getTradeCycleById, listTradeCycles } from './trade-cycles.service.js';

function buildCycle(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
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

  it('returns a trade-cycle detail with related records and timeline', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue({
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

    expect(mocks.trackedPositionFindUnique).toHaveBeenCalledWith({
      where: { id: 101 },
      include: expect.objectContaining({
        orderIntents: expect.any(Object),
        brokerOrders: expect.any(Object),
      }),
    });
    expect(mocks.systemEventFindMany).toHaveBeenCalledWith({
      where: {
        entityType: 'trackedPosition',
        entityId: '101',
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
        'order_intent',
        'broker_order',
        'broker_activity',
        'system_event',
      ])
    );
  });

  it('throws a 404 when a trade cycle is missing', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue(null);

    await expect(getTradeCycleById(999)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Trade cycle 999 was not found.',
    });
  });
});
