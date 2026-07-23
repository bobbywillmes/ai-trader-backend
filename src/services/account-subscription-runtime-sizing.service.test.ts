import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PositionSizingType } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  accountSubscriptionFindFirst: vi.fn(),
  getTickerLatestPrice: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccountSubscription: {
      findFirst: mocks.accountSubscriptionFindFirst,
    },
  },
}));

vi.mock('./massive-market-data.service.js', () => ({
  getTickerLatestPrice: mocks.getTickerLatestPrice,
}));

import {
  resolveRuntimeAccountSubscriptionSizing as resolveSizingService,
} from './account-subscription-runtime-sizing.service.js';

function resolveRuntimeAccountSubscriptionSizing(
  args: Omit<Parameters<typeof resolveSizingService>[0], 'tradingAccountSubscriptionId'>
) {
  return resolveSizingService({
    tradingAccountSubscriptionId: 20,
    ...args,
  });
}

function accountSubscriptionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    tradingAccountId: 1,
    subscriptionId: 30,
    enabled: true,
    entriesEnabled: true,
    sizingType: PositionSizingType.FIXED_QTY,
    fixedQty: 1,
    maxPositionNotional: null,
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

function latestPrice(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'DIA',
    latestPrice: 522.67,
    latestPriceAt: '2026-06-30T15:59:00.000Z',
    latestPriceSource: 'lastTrade',
    ...overrides,
  };
}

async function expectRuntimeSizingError(
  promise: Promise<unknown>,
  code: string
) {
  await expect(promise).rejects.toMatchObject({
    statusCode: expect.any(Number),
    message: code,
    details: expect.objectContaining({
      code,
      rule: code,
    }),
  });
}

describe('account subscription runtime sizing service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord()
    );
    mocks.getTickerLatestPrice.mockResolvedValue(latestPrice());
  });

  it('prices FIXED_QTY sizing so projected exposure can be enforced', async () => {
    const result = await resolveRuntimeAccountSubscriptionSizing({
      tradingAccountId: 1,
      subscriptionId: 30,
      symbol: 'DIA',
    });

    expect(mocks.accountSubscriptionFindFirst).toHaveBeenCalledWith({
      where: {
        id: 20,
        tradingAccountId: 1,
        subscriptionId: 30,
      },
      select: expect.any(Object),
    });
    expect(mocks.getTickerLatestPrice).toHaveBeenCalledWith('DIA');
    expect(result).toEqual(
      expect.objectContaining({
        tradingAccountSubscriptionId: 20,
        qty: 1,
        estimatedNotional: 522.67,
        snapshot: expect.objectContaining({
          tradingAccountSubscriptionId: 20,
          sizingType: PositionSizingType.FIXED_QTY,
          fixedQty: 1,
          latestPrice: 522.67,
          calculatedQty: 1,
          estimatedNotional: 522.67,
        }),
      })
    );
  });

  it('resolves MAX_NOTIONAL sizing from backend latest price using whole shares', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 1_600,
      })
    );

    const result = await resolveRuntimeAccountSubscriptionSizing({
      tradingAccountId: 1,
      subscriptionId: 30,
      symbol: 'DIA',
    });

    expect(mocks.getTickerLatestPrice).toHaveBeenCalledWith('DIA');
    expect(result.tradingAccountSubscriptionId).toBe(20);
    expect(result.qty).toBe(3);
    expect(result.estimatedNotional).toBeCloseTo(1568.01);
    expect(result.snapshot).toEqual(
      expect.objectContaining({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        maxPositionNotional: 1_600,
        latestPrice: 522.67,
        latestPriceAt: '2026-06-30T15:59:00.000Z',
        latestPriceSource: 'lastTrade',
        calculatedQty: 3,
      })
    );
    expect(result.snapshot.estimatedNotional).toBeCloseTo(1568.01);
  });

  it('rejects missing account subscription config without falling back to legacy sizing', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(null);

    await expectRuntimeSizingError(
      resolveRuntimeAccountSubscriptionSizing({
        tradingAccountId: 1,
        subscriptionId: 30,
        symbol: 'DIA',
      }),
      'account_subscription_missing'
    );
  });

  it('rejects disabled account subscriptions', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({ enabled: false })
    );

    await expectRuntimeSizingError(
      resolveRuntimeAccountSubscriptionSizing({
        tradingAccountId: 1,
        subscriptionId: 30,
        symbol: 'DIA',
      }),
      'account_subscription_disabled'
    );
  });

  it('rejects account subscriptions with disabled entries', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({ entriesEnabled: false })
    );

    await expectRuntimeSizingError(
      resolveRuntimeAccountSubscriptionSizing({
        tradingAccountId: 1,
        subscriptionId: 30,
        symbol: 'DIA',
      }),
      'account_subscription_entries_disabled'
    );
  });

  it('rejects invalid FIXED_QTY sizing', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({ fixedQty: 0 })
    );

    await expectRuntimeSizingError(
      resolveRuntimeAccountSubscriptionSizing({
        tradingAccountId: 1,
        subscriptionId: 30,
        symbol: 'DIA',
      }),
      'invalid_fixed_qty_sizing'
    );
  });

  it('rejects MAX_NOTIONAL sizing when latest price is unavailable', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 1_000,
      })
    );
    mocks.getTickerLatestPrice.mockResolvedValue(
      latestPrice({
        latestPrice: null,
        latestPriceAt: null,
        latestPriceSource: null,
      })
    );

    await expectRuntimeSizingError(
      resolveRuntimeAccountSubscriptionSizing({
        tradingAccountId: 1,
        subscriptionId: 30,
        symbol: 'DIA',
      }),
      'latest_price_unavailable'
    );
  });

  it('rejects MAX_NOTIONAL sizing when budget is below one share', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 400,
      })
    );

    await expectRuntimeSizingError(
      resolveRuntimeAccountSubscriptionSizing({
        tradingAccountId: 1,
        subscriptionId: 30,
        symbol: 'DIA',
      }),
      'max_notional_below_share_price'
    );
  });

  it('caps calculated quantity with maxQty', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 2_000,
        maxQty: 2,
      })
    );

    const result = await resolveRuntimeAccountSubscriptionSizing({
      tradingAccountId: 1,
      subscriptionId: 30,
      symbol: 'DIA',
    });

    expect(result.qty).toBe(2);
    expect(result.estimatedNotional).toBe(1045.34);
    expect(result.snapshot).toEqual(
      expect.objectContaining({
        maxQty: 2,
        calculatedQty: 2,
        estimatedNotional: 1045.34,
      })
    );
  });

  it('rejects orders below minPositionNotional after whole-share sizing', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 1_100,
        minPositionNotional: 1_100,
      })
    );

    await expectRuntimeSizingError(
      resolveRuntimeAccountSubscriptionSizing({
        tradingAccountId: 1,
        subscriptionId: 30,
        symbol: 'DIA',
      }),
      'min_position_notional_not_met'
    );
  });
});
