import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindMany: vi.fn(),
  orderIntentFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: { findMany: mocks.trackedPositionFindMany },
    orderIntent: { findMany: mocks.orderIntentFindMany },
  },
}));

import { getTradingAccountEntryRiskUsage } from './trading-account-entry-risk-usage.service.js';

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    symbol: 'SPY',
    subscriptionId: 22,
    side: 'buy',
    status: 'accepted',
    blockReason: null,
    trackedPositionId: null,
    notional: 1_000,
    qty: null,
    limitPrice: null,
    rawRequestJson: {},
    brokerOrders: [{ id: 10 }],
    ...overrides,
  };
}

describe('trading account entry risk usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trackedPositionFindMany.mockResolvedValue([]);
    mocks.orderIntentFindMany.mockResolvedValue([]);
  });

  it.each([
    ['winter EST', new Date('2026-01-15T17:00:00.000Z'), '2026-01-15T05:00:00.000Z', '2026-01-16T05:00:00.000Z'],
    ['summer EDT', new Date('2026-07-15T17:00:00.000Z'), '2026-07-15T04:00:00.000Z', '2026-07-16T04:00:00.000Z'],
    ['before New York midnight', new Date('2026-07-16T03:59:59.000Z'), '2026-07-15T04:00:00.000Z', '2026-07-16T04:00:00.000Z'],
    ['after New York midnight', new Date('2026-07-16T04:00:01.000Z'), '2026-07-16T04:00:00.000Z', '2026-07-17T04:00:00.000Z'],
  ])('queries the %s daily window with a half-open UTC interval', async (_label, now, start, nextStart) => {
    await getTradingAccountEntryRiskUsage({ tradingAccountId: 7, symbol: 'SPY', now });

    expect(mocks.orderIntentFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          tradingAccountId: 7,
          createdAt: {
            gte: new Date(start),
            lt: new Date(nextStart),
          },
        }),
      })
    );
  });

  it('separates daily activity from unmaterialized pending exposure', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        id: 40,
        symbol: 'SPY',
        subscriptionId: 22,
        tradingAccountSubscriptionId: 8,
        marketValue: 2_500,
        costBasis: 2_400,
        status: 'open',
      },
    ]);
    mocks.orderIntentFindMany
      .mockResolvedValueOnce([
        intent({ id: 1, status: 'filled', trackedPositionId: 40, notional: 2_400 }),
        intent({ id: 2, status: 'accepted', notional: 1_000 }),
        intent({ id: 3, status: 'rejected', notional: 9_000, brokerOrders: [] }),
      ])
      .mockResolvedValueOnce([intent({ id: 2, status: 'accepted', notional: 1_000 })]);

    const usage = await getTradingAccountEntryRiskUsage({
      tradingAccountId: 7,
      symbol: 'SPY',
      now: new Date('2026-07-15T17:00:00.000Z'),
    });

    expect(usage.dailyEntryOrderCount).toBe(2);
    expect(usage.dailyEntryNotional).toBe(3_400);
    expect(usage.openPositionNotional).toBe(2_500);
    expect(usage.pendingEntryNotional).toBe(1_000);
    expect(usage.currentAccountExposure).toBe(3_500);
    expect(usage.currentAccountPositionSlots).toBe(2);
    expect(usage.currentSymbolExposure).toBe(3_500);
    expect(usage.pendingEntryNotionalBySubscriptionId.get(22)).toBe(1_000);
  });

  it('excludes the current intent during worker safety rechecks', async () => {
    await getTradingAccountEntryRiskUsage({
      tradingAccountId: 7,
      symbol: 'SPY',
      excludeOrderIntentId: 99,
    });

    expect(mocks.orderIntentFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: 99 } }),
      })
    );
  });
});
