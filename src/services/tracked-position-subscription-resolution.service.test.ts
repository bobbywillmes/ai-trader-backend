import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  orderIntentFindFirst: vi.fn(),
  orderIntentUpdateMany: vi.fn(),
  brokerOrderUpdateMany: vi.fn(),
  brokerActivityFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  settingFindMany: vi.fn(),
  linkEntryDecisionToTrackedPosition: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    orderIntent: {
      findFirst: mocks.orderIntentFindFirst,
      updateMany: mocks.orderIntentUpdateMany,
    },
    brokerOrder: {
      updateMany: mocks.brokerOrderUpdateMany,
    },
    brokerActivity: {
      findMany: mocks.brokerActivityFindMany,
    },
    subscription: {
      findMany: mocks.subscriptionFindMany,
      findFirst: mocks.subscriptionFindFirst,
      findUnique: mocks.subscriptionFindUnique,
    },
    setting: {
      findMany: mocks.settingFindMany,
    },
  },
}));

vi.mock('./entry-decision.service.js', () => ({
  linkEntryDecisionToTrackedPosition: mocks.linkEntryDecisionToTrackedPosition,
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

import { buildClientOrderId } from './client-order-id.service.js';
import {
  linkLocalEntryOwnership,
  resolveTrackedPositionSubscription,
} from './tracked-position-subscription-resolution.service.js';

function mockPaperMode() {
  mocks.settingFindMany.mockResolvedValue([
    { key: 'paperMode', value: 'true' },
    { key: 'tradingEnabled', value: 'true' },
  ]);
}

function subscription(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 22,
    key: 'dia_dip_core',
    symbol: 'DIA',
    broker: 'alpaca',
    brokerMode: 'paper',
    enabled: true,
    strategy: { enabled: true },
    exitProfile: { enabled: true },
    ...overrides,
  };
}

describe('tracked position subscription resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPaperMode();
    mocks.orderIntentFindFirst.mockResolvedValue(null);
    mocks.brokerActivityFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.subscriptionFindFirst.mockResolvedValue(null);
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.orderIntentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.brokerOrderUpdateMany.mockResolvedValue({ count: 1 });
    mocks.linkEntryDecisionToTrackedPosition.mockResolvedValue({ count: 1 });
  });

  it('resolves a locally submitted entry through its local order intent', async () => {
    mocks.orderIntentFindFirst.mockResolvedValue({
      id: 101,
      tradingAccountId: 1,
      clientOrderId: 'ai-20260616T-DIA-buy-market-abcdef12',
      subscriptionId: 22,
      subscription: subscription(),
      brokerOrders: [{ id: 201 }],
    });

    const result = await resolveTrackedPositionSubscription({
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'resolved',
      source: 'local_order_intent',
      subscriptionId: 22,
      subscriptionKey: 'dia_dip_core',
    });
    expect(mocks.subscriptionFindMany).not.toHaveBeenCalled();
  });

  it('resolves a broker-carried subscription key to the matching local subscription', async () => {
    const clientOrderId = buildClientOrderId({
      subscriptionKey: 'dia_dip_core',
      subscriptionId: 22,
      signalType: 'entry',
      symbol: 'DIA',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: false,
    });

    mocks.brokerActivityFindMany.mockResolvedValue([
      {
        rawBrokerJson: { client_order_id: clientOrderId },
        brokerOrderRecord: null,
      },
    ]);
    mocks.subscriptionFindFirst.mockResolvedValue(subscription());

    const result = await resolveTrackedPositionSubscription({
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'resolved',
      source: 'broker_client_order_id',
      subscriptionId: 22,
      subscriptionKey: 'dia_dip_core',
    });
  });

  it('resolves an observer-created position when exactly one eligible subscription exists', async () => {
    mocks.subscriptionFindMany.mockResolvedValue([subscription()]);

    const result = await resolveTrackedPositionSubscription({
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'resolved',
      source: 'unique_observer_fallback',
      subscriptionId: 22,
      subscriptionKey: 'dia_dip_core',
    });
  });

  it('leaves an observer-created position unresolved when no subscription is eligible', async () => {
    const result = await resolveTrackedPositionSubscription({
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'unresolved',
      source: 'unresolved',
      subscriptionId: null,
      reason: 'no_eligible_subscription_for_observed_position',
    });
  });

  it('leaves an observer-created position ambiguous when multiple subscriptions are eligible', async () => {
    mocks.subscriptionFindMany.mockResolvedValue([
      subscription(),
      subscription({ id: 23, key: 'dia_dip_alt' }),
    ]);

    const result = await resolveTrackedPositionSubscription({
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'ambiguous',
      source: 'ambiguous',
      subscriptionId: null,
      reason: 'multiple_eligible_subscriptions_for_observed_position',
    });
  });

  it('does not select an ownership source from a previously closed linked cycle', async () => {
    mocks.subscriptionFindMany.mockResolvedValue([subscription()]);

    await resolveTrackedPositionSubscription({
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(mocks.orderIntentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { trackedPositionId: null },
            { trackedPosition: { is: { status: { not: 'closed' } } } },
          ],
          brokerOrders: expect.objectContaining({
            some: expect.objectContaining({
              OR: [
                { trackedPositionId: null },
                { trackedPosition: { is: { status: { not: 'closed' } } } },
              ],
            }),
          }),
        }),
      })
    );
  });

  it('links local entry ownership to the recovered tracked position', async () => {
    mocks.orderIntentFindFirst.mockResolvedValue({
      id: 101,
      tradingAccountId: 1,
      clientOrderId: 'ai-20260616T-DIA-buy-market-abcdef12',
      subscriptionId: 22,
      subscription: subscription(),
      brokerOrders: [{ id: 201 }],
    });

    await linkLocalEntryOwnership({
      trackedPositionId: 303,
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(mocks.orderIntentUpdateMany).toHaveBeenCalledWith({
      where: { id: 101, trackedPositionId: null },
      data: { trackedPositionId: 303 },
    });
    expect(mocks.brokerOrderUpdateMany).toHaveBeenCalledWith({
      where: { orderIntentId: 101, trackedPositionId: null },
      data: { trackedPositionId: 303 },
    });
    expect(mocks.linkEntryDecisionToTrackedPosition).toHaveBeenCalledWith({
      orderIntentId: 101,
      trackedPositionId: 303,
      tradingAccountId: 1,
    });
  });
});
