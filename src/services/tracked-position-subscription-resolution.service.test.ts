import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  orderIntentFindMany: vi.fn(),
  orderIntentUpdateMany: vi.fn(),
  orderIntentCount: vi.fn(),
  trackedPositionUpdateMany: vi.fn(),
  trackedPositionFindFirst: vi.fn(),
  brokerOrderUpdateMany: vi.fn(),
  brokerOrderCount: vi.fn(),
  brokerActivityUpdateMany: vi.fn(),
  brokerActivityCount: vi.fn(),
  transaction: vi.fn(),
  brokerActivityFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  tradingAccountFindUniqueOrThrow: vi.fn(),
  linkEntryDecisionToTrackedPosition: vi.fn(),
  entryDecisionCount: vi.fn(),
  entryDecisionUpdateMany: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    orderIntent: {
      findMany: mocks.orderIntentFindMany,
      updateMany: mocks.orderIntentUpdateMany,
    },
    trackedPosition: {
      updateMany: mocks.trackedPositionUpdateMany,
    },
    brokerOrder: {
      updateMany: mocks.brokerOrderUpdateMany,
    },
    brokerActivity: {
      findMany: mocks.brokerActivityFindMany,
      updateMany: mocks.brokerActivityUpdateMany,
    },
    subscription: {
      findMany: mocks.subscriptionFindMany,
      findFirst: mocks.subscriptionFindFirst,
      findUnique: mocks.subscriptionFindUnique,
    },
    tradingAccount: {
      findUniqueOrThrow: mocks.tradingAccountFindUniqueOrThrow,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('./entry-decision.service.js', () => ({
  linkEntryDecisionToTrackedPosition: mocks.linkEntryDecisionToTrackedPosition,
}));

import { buildClientOrderId } from './client-order-id.service.js';
import {
  linkLocalEntryOwnership,
  resolveTrackedPositionSubscription,
} from './tracked-position-subscription-resolution.service.js';

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
    accountSubscriptions: [{ id: 44 }],
    ...overrides,
  };
}

describe('tracked position subscription resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.tradingAccountFindUniqueOrThrow.mockResolvedValue({
      environment: 'PAPER',
    });
    mocks.orderIntentFindMany.mockResolvedValue([]);
    mocks.brokerActivityFindMany.mockResolvedValue([]);
    mocks.subscriptionFindMany.mockResolvedValue([]);
    mocks.subscriptionFindFirst.mockResolvedValue(null);
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    mocks.orderIntentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.trackedPositionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.brokerOrderUpdateMany.mockResolvedValue({ count: 1 });
    mocks.brokerActivityUpdateMany.mockResolvedValue({ count: 1 });
    mocks.linkEntryDecisionToTrackedPosition.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation((callback) =>
      callback({
        orderIntent: { updateMany: mocks.orderIntentUpdateMany, count: mocks.orderIntentCount },
        trackedPosition: { updateMany: mocks.trackedPositionUpdateMany, findFirst: mocks.trackedPositionFindFirst },
        brokerOrder: { updateMany: mocks.brokerOrderUpdateMany, count: mocks.brokerOrderCount },
        brokerActivity: { updateMany: mocks.brokerActivityUpdateMany, count: mocks.brokerActivityCount },
        entryDecision: { updateMany: mocks.entryDecisionUpdateMany, count: mocks.entryDecisionCount },
        $queryRaw: mocks.queryRaw,
      })
    );
    mocks.orderIntentCount.mockResolvedValue(0);
    mocks.brokerOrderCount.mockResolvedValue(0);
    mocks.brokerActivityCount.mockResolvedValue(0);
    mocks.entryDecisionCount.mockResolvedValue(0);
    mocks.entryDecisionUpdateMany.mockResolvedValue({ count: 0 });
    mocks.trackedPositionFindFirst.mockResolvedValue({ id: 301, subscriptionId: null, tradingAccountSubscriptionId: null });
  });

  it('resolves a locally submitted entry through its local order intent', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([{
      id: 101,
      tradingAccountId: 1,
      tradingAccountSubscriptionId: 44,
      tradingAccountSubscription: {
        id: 44,
        tradingAccountId: 1,
        subscriptionId: 22,
      },
      clientOrderId: 'ai-20260616T-DIA-buy-market-abcdef12',
      subscriptionId: 22,
      subscription: subscription(),
      brokerOrders: [{ id: 201 }],
    }]);

    const result = await resolveTrackedPositionSubscription({
      tradingAccountId: 1,
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
      tradingAccountSubscriptionId: 44,
    });
    expect(mocks.subscriptionFindMany).not.toHaveBeenCalled();
  });

  it('uses the supplied Live account and environment for all ownership evidence', async () => {
    mocks.tradingAccountFindUniqueOrThrow.mockResolvedValue({
      environment: 'LIVE',
    });
    mocks.subscriptionFindMany.mockResolvedValue([
      subscription({
        id: 23,
        key: 'dia_live_core',
      }),
    ]);

    const result = await resolveTrackedPositionSubscription({
      tradingAccountId: 2,
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'resolved',
      source: 'unique_observer_fallback',
      subscriptionId: 23,
    });
    expect(mocks.orderIntentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tradingAccountId: 2 }),
      })
    );
    expect(mocks.brokerActivityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tradingAccountId: 2 }),
      })
    );
    expect(mocks.subscriptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accountSubscriptions: {
            some: {
              tradingAccountId: 2,
              enabled: true,
            },
          },
        }),
      })
    );
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
    }, { tradingAccountId: 1, environment: 'PAPER' });

    mocks.brokerActivityFindMany.mockResolvedValue([
      {
        rawBrokerJson: { client_order_id: clientOrderId },
        brokerOrderRecord: null,
      },
    ]);
    mocks.subscriptionFindFirst.mockResolvedValue(subscription());

    const result = await resolveTrackedPositionSubscription({
      tradingAccountId: 1,
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
      tradingAccountId: 1,
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
      tradingAccountId: 1,
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
      tradingAccountId: 1,
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
      tradingAccountId: 1,
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(mocks.orderIntentFindMany).toHaveBeenCalledWith(
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
    mocks.brokerOrderCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mocks.brokerActivityCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mocks.trackedPositionFindFirst.mockResolvedValue({ id: 303, subscriptionId: null, tradingAccountSubscriptionId: null });
    mocks.orderIntentFindMany.mockResolvedValue([{
      id: 101,
      tradingAccountId: 1,
      tradingAccountSubscriptionId: 44,
      tradingAccountSubscription: {
        id: 44,
        tradingAccountId: 1,
        subscriptionId: 22,
      },
      clientOrderId: 'ai-20260616T-DIA-buy-market-abcdef12',
      subscriptionId: 22,
      subscription: subscription(),
      brokerOrders: [{ id: 201 }],
    }]);

    await linkLocalEntryOwnership({
      trackedPositionId: 303,
      tradingAccountId: 1,
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      openedAt: new Date('2026-06-16T15:00:00.000Z'),
    });

    expect(mocks.orderIntentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 101,
        tradingAccountId: 1,
        OR: [{ trackedPositionId: null }, { trackedPositionId: 303 }],
      },
      data: { trackedPositionId: 303 },
    });
    expect(mocks.brokerOrderUpdateMany).toHaveBeenCalledWith({
      where: {
        orderIntentId: 101,
        tradingAccountId: 1,
        OR: [{ trackedPositionId: null }, { trackedPositionId: 303 }],
      },
      data: { trackedPositionId: 303 },
    });
    expect(mocks.trackedPositionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 303, tradingAccountId: 1 }),
      data: { subscriptionId: 22, tradingAccountSubscriptionId: 44 },
    }));
    expect(mocks.brokerActivityUpdateMany).toHaveBeenCalledWith({
      where: {
        orderIntentId: 101,
        tradingAccountId: 1,
        activityType: 'FILL',
        brokerOrderRecordId: { in: [201] },
        OR: [{ trackedPositionId: null }, { trackedPositionId: 303 }],
      },
      data: {
        trackedPositionId: 303,
        trackedPositionLinkSource: 'broker_order',
        trackedPositionLinkedAt: expect.any(Date),
      },
    });
    expect(mocks.entryDecisionUpdateMany).toHaveBeenCalled();
  });
});
