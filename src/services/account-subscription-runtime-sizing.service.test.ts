import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PositionSizingType } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  accountSubscriptionFindFirst: vi.fn(),
  getTradingReferencePrice: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccountSubscription: {
      findFirst: mocks.accountSubscriptionFindFirst,
    },
  },
}));

vi.mock('./trading-reference-price.service.js', () => ({
  getTradingReferencePrice: mocks.getTradingReferencePrice,
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
    provider: 'TIINGO_CONSOLIDATED',
    price: 522.67,
    basis: 'TIINGO_TNGO_LAST',
    observedAt: '2026-06-30T15:59:00.000Z',
    fetchedAt: '2026-06-30T16:00:00.000Z',
    ageMs: 60_000,
    clockSkewMs: null,
    sessionPhase: 'REGULAR',
    usable: true,
    rejectionReason: null,
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
    mocks.getTradingReferencePrice.mockResolvedValue(latestPrice());
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
    expect(mocks.getTradingReferencePrice).toHaveBeenCalledWith('DIA');
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
          latestPriceProvider: 'TIINGO_CONSOLIDATED',
          latestPriceBasis: 'TIINGO_TNGO_LAST',
          latestPriceAgeMs: 60_000,
          latestPriceSessionPhase: 'REGULAR',
          latestPriceRejectionReason: null,
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

    expect(mocks.getTradingReferencePrice).toHaveBeenCalledWith('DIA');
    expect(result.tradingAccountSubscriptionId).toBe(20);
    expect(result.qty).toBe(3);
    expect(result.estimatedNotional).toBeCloseTo(1568.01);
    expect(result.snapshot).toEqual(
      expect.objectContaining({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        maxPositionNotional: 1_600,
        latestPrice: 522.67,
        latestPriceAt: '2026-06-30T15:59:00.000Z',
        latestPriceSource: 'TIINGO_TNGO_LAST',
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
    mocks.getTradingReferencePrice.mockResolvedValue(
      latestPrice({
        price: null,
        basis: null,
        observedAt: null,
        usable: false,
        rejectionReason: 'PROVIDER_ERROR',
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

  it('fails closed with policy provenance when outside the trading-price session', async () => {
    mocks.getTradingReferencePrice.mockResolvedValue(latestPrice({
      price: null,
      observedAt: null,
      sessionPhase: 'PREMARKET',
      usable: false,
      rejectionReason: 'OUTSIDE_TRADING_PRICE_SESSION',
    }));

    await expect(resolveRuntimeAccountSubscriptionSizing({
      tradingAccountId: 1, subscriptionId: 30, symbol: 'DIA',
    })).rejects.toMatchObject({
      statusCode: 409,
      message: 'latest_price_unavailable',
      details: expect.objectContaining({
        latestPriceProvider: 'TIINGO_CONSOLIDATED',
        latestPriceBasis: 'TIINGO_TNGO_LAST',
        latestPriceSessionPhase: 'PREMARKET',
        latestPriceRejectionReason: 'OUTSIDE_TRADING_PRICE_SESSION',
      }),
    });
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

  it('accepts the minimum-notional boundary exactly', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(accountSubscriptionRecord({
      sizingType: PositionSizingType.MAX_NOTIONAL,
      fixedQty: null,
      maxPositionNotional: 1045.34,
      minPositionNotional: 1045.34,
    }));

    const result = await resolveRuntimeAccountSubscriptionSizing({
      tradingAccountId: 1, subscriptionId: 30, symbol: 'DIA',
    });
    expect(result).toMatchObject({ qty: 2, estimatedNotional: 1045.34 });
  });
});
