import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PositionSizingType } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  tradingAccountFindUnique: vi.fn(),
  accountSubscriptionFindMany: vi.fn(),
  accountSubscriptionFindFirst: vi.fn(),
  getTickerLatestPrice: vi.fn(),
  getTickerDailyCandles: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findUnique: mocks.tradingAccountFindUnique,
    },
    tradingAccountSubscription: {
      findMany: mocks.accountSubscriptionFindMany,
      findFirst: mocks.accountSubscriptionFindFirst,
    },
  },
}));

vi.mock('./massive-market-data.service.js', () => ({
  getTickerLatestPrice: mocks.getTickerLatestPrice,
  getTickerDailyCandles: mocks.getTickerDailyCandles,
}));

import {
  getAccountSubscriptionPriceHistoryForAdmin,
  listAccountSubscriptionMarketContextForAdmin,
  parseAccountSubscriptionMarketContextStatus,
  parseAccountSubscriptionPriceHistoryRange,
} from './account-subscription-market-context.service.js';
import type { DailyMarketCandle } from './massive-market-data.service.js';

const NOW = new Date('2026-06-30T16:00:00.000Z');

function accountSubscriptionRecord(
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 20,
    tradingAccountId: 1,
    subscriptionId: 30,
    enabled: true,
    sizingType: PositionSizingType.MAX_NOTIONAL,
    fixedQty: null,
    maxPositionNotional: 1_000,
    minPositionNotional: null,
    maxQty: null,
    subscription: {
      id: 30,
      key: 'dia-swing',
      symbol: 'DIA',
    },
    ...overrides,
  };
}

function candle(
  date: string,
  close: number,
  overrides: Partial<DailyMarketCandle> = {}
): DailyMarketCandle {
  return {
    date,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 100_000,
    ...overrides,
  };
}

describe('account subscription market context service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tradingAccountFindUnique.mockResolvedValue({ id: 1 });
    mocks.accountSubscriptionFindMany.mockResolvedValue([]);
    mocks.accountSubscriptionFindFirst.mockResolvedValue(null);
    mocks.getTickerLatestPrice.mockImplementation(async (symbol: string) => ({
      symbol,
      latestPrice: symbol === 'DIA' ? 522.67 : 100,
      latestPriceAt: '2026-06-30T15:59:00.000Z',
      latestPriceSource: 'lastTrade',
    }));
    mocks.getTickerDailyCandles.mockResolvedValue([
      candle('2025-07-01', 410, { high: 412, low: 408 }),
      candle('2026-06-30', 522.67, { high: 545.1, low: 520 }),
    ]);
  });

  it('defaults market context to active subscriptions and calculates whole-share MAX_NOTIONAL preview', async () => {
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      accountSubscriptionRecord(),
    ]);

    const result = await listAccountSubscriptionMarketContextForAdmin(1, {
      now: NOW,
    });

    expect(mocks.accountSubscriptionFindMany).toHaveBeenCalledWith({
      where: {
        tradingAccountId: 1,
        enabled: true,
      },
      select: expect.any(Object),
      orderBy: [{ enabled: 'desc' }, { id: 'asc' }],
    });
    expect(mocks.getTickerLatestPrice).toHaveBeenCalledWith('DIA');
    expect(mocks.getTickerDailyCandles).toHaveBeenCalledWith(
      'DIA',
      '2025-06-30',
      '2026-06-30'
    );
    expect(result).toEqual({
      tradingAccountId: 1,
      generatedAt: '2026-06-30T16:00:00.000Z',
      items: [
        expect.objectContaining({
          accountSubscriptionId: 20,
          subscriptionId: 30,
          symbol: 'DIA',
          subscriptionKey: 'dia-swing',
          latestPrice: 522.67,
          week52High: 545.1,
          week52HighAt: '2026-06-30',
          week52Low: 408,
          week52LowAt: '2025-07-01',
          sizingType: PositionSizingType.MAX_NOTIONAL,
          maxPositionNotional: 1_000,
          estimatedQty: 1,
          estimatedNotional: 522.67,
          nextShareQty: 2,
          nextShareNotional: 1045.34,
          dollarsToNextShare: 45.33999999999992,
          warnings: [],
        }),
      ],
    });
  });

  it('calculates FIXED_QTY estimated notional without next-share budget fields', async () => {
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      accountSubscriptionRecord({
        sizingType: PositionSizingType.FIXED_QTY,
        fixedQty: 2,
        maxPositionNotional: null,
      }),
    ]);

    const result = await listAccountSubscriptionMarketContextForAdmin(1, {
      now: NOW,
    });

    expect(result?.items[0]).toMatchObject({
      estimatedQty: 2,
      estimatedNotional: 1045.34,
      nextShareQty: null,
      nextShareNotional: null,
      dollarsToNextShare: null,
      warnings: [],
    });
  });

  it('returns per-row warnings when latest price is unavailable or budget is below one share', async () => {
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      accountSubscriptionRecord({
        id: 21,
        maxPositionNotional: 400,
      }),
      accountSubscriptionRecord({
        id: 22,
        subscription: {
          id: 31,
          key: 'bad-data',
          symbol: 'BAD',
        },
      }),
    ]);
    mocks.getTickerLatestPrice.mockImplementation(async (symbol: string) => {
      if (symbol === 'BAD') {
        throw new Error('upstream failed');
      }

      return {
        symbol,
        latestPrice: 522.67,
        latestPriceAt: '2026-06-30T15:59:00.000Z',
        latestPriceSource: 'lastTrade',
      };
    });

    const result = await listAccountSubscriptionMarketContextForAdmin(1, {
      now: NOW,
      status: 'all',
    });

    expect(result?.items).toHaveLength(2);
    expect(result?.items[0]).toMatchObject({
      accountSubscriptionId: 21,
      estimatedQty: 0,
      warnings: [
        'Budget is below the latest price; calculated quantity would be 0.',
      ],
    });
    expect(result?.items[1]).toMatchObject({
      accountSubscriptionId: 22,
      latestPrice: null,
      estimatedQty: null,
      warnings: ['Latest price unavailable.'],
    });
  });

  it('filters requested symbols after loading account-scoped subscriptions and reuses symbol market fetches', async () => {
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      accountSubscriptionRecord({ id: 20 }),
      accountSubscriptionRecord({ id: 21 }),
      accountSubscriptionRecord({
        id: 22,
        subscription: {
          id: 31,
          key: 'spy-swing',
          symbol: 'SPY',
        },
      }),
    ]);

    const result = await listAccountSubscriptionMarketContextForAdmin(1, {
      now: NOW,
      symbols: ['dia'],
    });

    expect(result?.items.map((item) => item.accountSubscriptionId)).toEqual([
      20,
      21,
    ]);
    expect(mocks.getTickerLatestPrice).toHaveBeenCalledTimes(1);
    expect(mocks.getTickerDailyCandles).toHaveBeenCalledTimes(1);
  });

  it('returns null when listing market context for a missing trading account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(
      listAccountSubscriptionMarketContextForAdmin(404, { now: NOW })
    ).resolves.toBeNull();
    expect(mocks.accountSubscriptionFindMany).not.toHaveBeenCalled();
  });

  it('returns price history with range candles and 52-week summary', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord()
    );
    mocks.getTickerDailyCandles
      .mockResolvedValueOnce([
        candle('2026-04-01', 500),
        candle('2026-06-30', 522.67),
      ])
      .mockResolvedValueOnce([
        candle('2025-07-01', 410, { high: 412, low: 408 }),
        candle('2026-06-30', 522.67, { high: 545.1, low: 520 }),
      ]);

    const result = await getAccountSubscriptionPriceHistoryForAdmin(1, 20, {
      now: NOW,
      range: '3m',
    });

    expect(mocks.accountSubscriptionFindFirst).toHaveBeenCalledWith({
      where: {
        id: 20,
        tradingAccountId: 1,
      },
      select: expect.any(Object),
    });
    expect(mocks.getTickerDailyCandles).toHaveBeenNthCalledWith(
      1,
      'DIA',
      '2026-03-30',
      '2026-06-30'
    );
    expect(mocks.getTickerDailyCandles).toHaveBeenNthCalledWith(
      2,
      'DIA',
      '2025-06-30',
      '2026-06-30'
    );
    expect(result).toMatchObject({
      tradingAccountId: 1,
      accountSubscriptionId: 20,
      subscriptionId: 30,
      symbol: 'DIA',
      range: '3m',
      generatedAt: '2026-06-30T16:00:00.000Z',
      summary: {
        latestClose: 522.67,
        latestCloseAt: '2026-06-30',
        week52High: 545.1,
        week52Low: 408,
      },
    });
  });

  it('returns null when price history account subscription is not in account scope', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(null);

    await expect(
      getAccountSubscriptionPriceHistoryForAdmin(1, 404, { now: NOW })
    ).resolves.toBeNull();
  });

  it('parses controller-facing query values with conservative defaults', () => {
    expect(parseAccountSubscriptionMarketContextStatus('all')).toBe('all');
    expect(parseAccountSubscriptionMarketContextStatus('disabled')).toBe(
      'disabled'
    );
    expect(parseAccountSubscriptionMarketContextStatus('bad')).toBe('active');
    expect(parseAccountSubscriptionPriceHistoryRange('3m')).toBe('3m');
    expect(parseAccountSubscriptionPriceHistoryRange('6m')).toBe('6m');
    expect(parseAccountSubscriptionPriceHistoryRange('bad')).toBe('1y');
  });
});
