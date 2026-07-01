import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PositionSizingType } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  orderIntentCreate: vi.fn(),
  orderIntentFindMany: vi.fn(),
  orderIntentFindFirst: vi.fn(),
  orderIntentUpdate: vi.fn(),
  brokerOrderCreate: vi.fn(),
  securityFindUnique: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    orderIntent: {
      create: mocks.orderIntentCreate,
      findMany: mocks.orderIntentFindMany,
      findFirst: mocks.orderIntentFindFirst,
      update: mocks.orderIntentUpdate,
    },
    brokerOrder: {
      create: mocks.brokerOrderCreate,
    },
    security: {
      findUnique: mocks.securityFindUnique,
    },
  },
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

import { createOrderIntent } from './order-audit.service.js';

describe('order audit service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orderIntentCreate.mockResolvedValue({ id: 55 });
  });

  it('stores account subscription linkage and sizing snapshot on order intents', async () => {
    const input = {
      subscriptionKey: 'spy_dip_core',
      subscriptionId: 22,
      symbol: 'SPY',
      side: 'buy' as const,
      signalType: 'entry' as const,
      orderType: 'market' as const,
      timeInForce: 'day' as const,
      qty: 3,
      extendedHours: false,
    };
    const snapshot = {
      tradingAccountSubscriptionId: 44,
      sizingType: PositionSizingType.MAX_NOTIONAL,
      fixedQty: null,
      maxPositionNotional: 1_600,
      minPositionNotional: null,
      maxQty: null,
      latestPrice: 522.67,
      latestPriceAt: '2026-06-30T15:59:00.000Z',
      latestPriceSource: 'lastTrade',
      calculatedQty: 3,
      estimatedNotional: 1568.01,
    };

    await createOrderIntent(input, 'api', 'client-101', 1, {
      tradingAccountSubscriptionId: 44,
      accountSubscriptionSizing: snapshot,
    });

    expect(mocks.orderIntentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'api',
        symbol: 'SPY',
        qty: 3,
        notional: null,
        subscriptionId: 22,
        subscriptionKey: 'spy_dip_core',
        tradingAccountId: 1,
        tradingAccountSubscriptionId: 44,
        rawRequestJson: expect.objectContaining({
          ...input,
          clientOrderId: 'client-101',
          accountSubscriptionSizing: snapshot,
        }),
      }),
    });
  });
});
