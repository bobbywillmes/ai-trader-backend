import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  brokerActivityFindFirst: vi.fn(),
  brokerActivityFindUnique: vi.fn(),
  brokerActivityFindMany: vi.fn(),
  brokerActivityUpdate: vi.fn(),
  brokerActivityUpdateMany: vi.fn(),
  brokerActivityCreate: vi.fn(),

  brokerOrderFindFirst: vi.fn(),
  positionExitStateFindFirst: vi.fn(),
  trackedPositionFindFirst: vi.fn(),
  settingFindMany: vi.fn(),

  getAlpacaAccountActivities: vi.fn(),
  createSystemEvent: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    brokerActivity: {
      findFirst: mocks.brokerActivityFindFirst,
      findUnique: mocks.brokerActivityFindUnique,
      findMany: mocks.brokerActivityFindMany,
      update: mocks.brokerActivityUpdate,
      updateMany: mocks.brokerActivityUpdateMany,
      create: mocks.brokerActivityCreate,
    },
    brokerOrder: {
      findFirst: mocks.brokerOrderFindFirst,
    },
    positionExitState: {
      findFirst: mocks.positionExitStateFindFirst,
    },
    trackedPosition: {
      findFirst: mocks.trackedPositionFindFirst,
    },
    setting: {
      findMany: mocks.settingFindMany,
    },
  },
}));

vi.mock('../integrations/alpaca/activities.adapter.js', () => ({
  getAlpacaAccountActivities: mocks.getAlpacaAccountActivities,
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

import {
  attributeCloseFillsForTrackedPosition,
  syncBrokerActivities,
} from './broker-activity.service.js';

describe('broker activity tracked-position attribution', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.brokerActivityFindFirst.mockResolvedValue(null);
    mocks.brokerActivityFindUnique.mockResolvedValue(null);
    mocks.brokerOrderFindFirst.mockResolvedValue(null);
    mocks.positionExitStateFindFirst.mockResolvedValue(null);
    mocks.trackedPositionFindFirst.mockResolvedValue(null);
    mocks.settingFindMany.mockResolvedValue([{ key: 'paperMode', value: 'true' }]);
    mocks.createSystemEvent.mockResolvedValue({});
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
  });

  it('links observer-discovered close fills when one local cycle is eligible', async () => {
    const candidate = {
      id: 501,
      qty: 3,
      price: 101.25,
      orderId: 'external-close-order',
      transactionTime: new Date('2026-06-12T18:00:00.000Z'),
    };
    const linked = {
      ...candidate,
      trackedPositionId: 101,
      trackedPositionLinkSource: 'reconciliation_discovered_close',
    };

    mocks.brokerActivityFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate])
      .mockResolvedValueOnce([linked]);
    mocks.brokerActivityUpdateMany.mockResolvedValue({ count: 1 });

    const result = await attributeCloseFillsForTrackedPosition({
      trackedPositionId: 101,
      broker: 'alpaca',
      symbol: 'SPY',
      closeSide: 'sell',
      openedAt: new Date('2026-06-12T14:30:00.000Z'),
      qty: 3,
    });

    expect(result).toEqual({
      status: 'linked',
      source: 'reconciliation_discovered_close',
      activities: [linked],
    });

    expect(mocks.trackedPositionFindFirst).toHaveBeenCalledWith({
      where: {
        id: {
          not: 101,
        },
        broker: 'alpaca',
        symbol: 'SPY',
        status: {
          in: ['open', 'closing'],
        },
      },
      orderBy: {
        openedAt: 'desc',
      },
    });

    expect(mocks.brokerActivityUpdateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [501],
        },
        trackedPositionId: null,
      },
      data: {
        trackedPositionId: 101,
        trackedPositionLinkSource: 'reconciliation_discovered_close',
        trackedPositionLinkedAt: expect.any(Date),
      },
    });
  });

  it('does not observer-link close fills when a newer active same-symbol cycle exists', async () => {
    mocks.brokerActivityFindMany.mockResolvedValueOnce([]);
    mocks.trackedPositionFindFirst.mockResolvedValue({
      id: 202,
      symbol: 'SPY',
      status: 'open',
    });

    const result = await attributeCloseFillsForTrackedPosition({
      trackedPositionId: 101,
      broker: 'alpaca',
      symbol: 'SPY',
      closeSide: 'sell',
      openedAt: new Date('2026-06-12T14:30:00.000Z'),
      qty: 3,
    });

    expect(result).toEqual({
      status: 'ambiguous',
      source: null,
      activities: [],
      reason: 'active_same_symbol_cycle_exists',
    });
    expect(mocks.brokerActivityUpdateMany).not.toHaveBeenCalled();
  });

  it('leaves observer close fills ambiguous when candidate quantity is inconsistent', async () => {
    const candidate = {
      id: 502,
      qty: 10,
      price: 101.25,
      orderId: 'external-close-order',
      transactionTime: new Date('2026-06-12T18:00:00.000Z'),
    };

    mocks.brokerActivityFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate]);

    const result = await attributeCloseFillsForTrackedPosition({
      trackedPositionId: 101,
      broker: 'alpaca',
      symbol: 'SPY',
      closeSide: 'sell',
      openedAt: new Date('2026-06-12T14:30:00.000Z'),
      qty: 3,
    });

    expect(result).toEqual({
      status: 'ambiguous',
      source: null,
      activities: [candidate],
      reason: 'candidate_fill_quantity_inconsistent',
    });
    expect(mocks.brokerActivityUpdateMany).not.toHaveBeenCalled();
  });

  it('preserves tracked-position links during duplicate broker activity ingestion', async () => {
    mocks.brokerActivityFindUnique.mockResolvedValue({
      id: 501,
      activityId: 'fill-501',
      trackedPositionId: 101,
      trackedPositionLinkSource: 'reconciliation_discovered_close',
      trackedPositionLinkedAt: new Date('2026-06-12T18:00:05.000Z'),
    });
    mocks.getAlpacaAccountActivities
      .mockResolvedValueOnce([
        {
          id: 'fill-501',
          activity_type: 'FILL',
          type: 'fill',
          symbol: 'SPY',
          side: 'sell',
          qty: '3',
          price: '101.25',
          order_id: 'external-close-order',
          transaction_time: '2026-06-12T18:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([]);

    await syncBrokerActivities({
      activityType: 'FILL',
      after: new Date('2026-06-12T17:55:00.000Z'),
      pageSize: 100,
      maxPages: 1,
    });

    expect(mocks.brokerActivityUpdate).toHaveBeenCalledWith({
      where: {
        activityId: 'fill-501',
      },
      data: expect.objectContaining({
        trackedPositionId: 101,
        tradingAccountId: 1,
        trackedPositionLinkSource: 'reconciliation_discovered_close',
        trackedPositionLinkedAt: new Date('2026-06-12T18:00:05.000Z'),
      }),
    });
  });

  it('links production close fills through local close-order ownership', async () => {
    mocks.brokerOrderFindFirst.mockResolvedValue({
      id: 301,
      orderIntentId: 201,
      trackedPositionId: 101,
      orderIntent: {
        id: 201,
        source: 'close-position',
        trackedPositionId: 101,
      },
    });
    mocks.getAlpacaAccountActivities
      .mockResolvedValueOnce([
        {
          id: 'fill-601',
          activity_type: 'FILL',
          type: 'fill',
          symbol: 'SPY',
          side: 'sell',
          qty: '3',
          price: '101.25',
          order_id: 'alpaca-close-order-123',
          transaction_time: '2026-06-12T18:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([]);

    await syncBrokerActivities({
      activityType: 'FILL',
      after: new Date('2026-06-12T17:55:00.000Z'),
      pageSize: 100,
      maxPages: 1,
    });

    expect(mocks.brokerActivityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activityId: 'fill-601',
        tradingAccountId: 1,
        orderId: 'alpaca-close-order-123',
        brokerOrderRecordId: 301,
        orderIntentId: 201,
        trackedPositionId: 101,
        trackedPositionLinkSource: 'close_order_submission',
        trackedPositionLinkedAt: expect.any(Date),
      }),
    });
  });
});
