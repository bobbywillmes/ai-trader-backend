import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindUnique: vi.fn(),

  brokerOrderFindFirst: vi.fn(),
  brokerOrderCreate: vi.fn(),
  brokerOrderUpdate: vi.fn(),

  orderIntentFindFirst: vi.fn(),
  orderIntentCreate: vi.fn(),
  orderIntentUpdate: vi.fn(),
  orderIntentUpdateMany: vi.fn(),
  positionExitStateUpdateMany: vi.fn(),
  prismaTransaction: vi.fn(),

  getAlpacaOrderByClientOrderId: vi.fn(),
  placeAlpacaOrder: vi.fn(),

  createSystemEvent: vi.fn(),

  ensurePositionExitState: vi.fn(),
  markTrailingStopOrderSubmitted: vi.fn(),
  forceAfterBrokerOrderCreated: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: {
      findUnique: mocks.trackedPositionFindUnique,
    },
    brokerOrder: {
      findFirst: mocks.brokerOrderFindFirst,
      create: mocks.brokerOrderCreate,
      update: mocks.brokerOrderUpdate,
    },
    orderIntent: {
      findFirst: mocks.orderIntentFindFirst,
      create: mocks.orderIntentCreate,
      update: mocks.orderIntentUpdate,
      updateMany: mocks.orderIntentUpdateMany,
    },
    positionExitState: {
      updateMany: mocks.positionExitStateUpdateMany,
    },
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderByClientOrderId: mocks.getAlpacaOrderByClientOrderId,
  placeAlpacaOrder: mocks.placeAlpacaOrder,
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

vi.mock('./position-exit-state.service.js', () => ({
  ensurePositionExitState: mocks.ensurePositionExitState,
  markTrailingStopOrderSubmitted: mocks.markTrailingStopOrderSubmitted,
}));

vi.mock('./adaptive-polling.service.js', () => ({
  adaptivePollingCoordinator: {
    forceAfterBrokerOrderCreated: mocks.forceAfterBrokerOrderCreated,
  },
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

import { submitTrailingStopExitOrder } from './trailing-stop-exit.service.js';
import { BrokerWriteDeliveryError } from '../errors/broker-write-delivery-error.js';

function buildPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    symbol: 'SPY',
    qty: 3,
    tradingAccountId: 1,
    securityId: 11,
    subscriptionId: 22,
    side: 'long',
    subscription: {
      key: 'SPY_dip_core',
    },
    exitState: {
      id: 201,
      trackedPositionId: 101,
      targetUnlocked: true,
      targetUnlockedAt: new Date('2026-06-06T15:30:00.000Z'),
      trailingStopPct: 0.25,
      trailBrokerOrderId: null,
      trailClientOrderId: null,
      trailOrderStatus: null,
    },
    tradingAccountSubscription: {
      id: 31,
      tradingAccountId: 1,
      subscriptionId: 22,
      enabled: true,
      exitsEnabled: true,
    },
    ...overrides,
  };
}

describe('submitTrailingStopExitOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.positionExitStateUpdateMany.mockResolvedValue({ count: 1 });
    mocks.orderIntentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.prismaTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          orderIntent: {
            findFirst: mocks.orderIntentFindFirst,
            create: mocks.orderIntentCreate,
          },
          positionExitState: {
            updateMany: mocks.positionExitStateUpdateMany,
          },
        })
    );
  });

  it('recovers an existing Alpaca trailing-stop order by client order ID instead of submitting a duplicate', async () => {
    const expectedClientOrderId = 'ai-exit-trail-SPY-101-20260606153000';

    const existingAlpacaOrder = {
      id: 'alpaca-existing-trail-123',
      client_order_id: expectedClientOrderId,
      status: 'accepted',
      symbol: 'SPY',
      side: 'sell',
      type: 'trailing_stop',
      qty: '3',
      trail_percent: '0.25',
    };

    const position = buildPosition();

    // submitTrailingStopExitOrder loads the position once.
    // persistTrailingStopOrder loads it again before saving local records.
    mocks.trackedPositionFindUnique.mockResolvedValue(position);

    // Nothing was persisted locally yet.
    mocks.brokerOrderFindFirst.mockResolvedValue(null);

    // But Alpaca already has the order with the deterministic clientOrderId.
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(existingAlpacaOrder);

    mocks.orderIntentFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 301,
        trackedPositionId: 101,
        tradingAccountId: 1,
      });
    mocks.orderIntentCreate.mockResolvedValue({
      id: 301,
      trackedPositionId: 101,
      tradingAccountId: 1,
      blockReason: null,
      updatedAt: new Date('2026-06-06T15:30:00.000Z'),
    });
    mocks.brokerOrderCreate.mockResolvedValue({});
    mocks.markTrailingStopOrderSubmitted.mockResolvedValue({});

    const result = await submitTrailingStopExitOrder(1, 101);

    expect(result).toEqual({
      submitted: false,
      reason: 'already_at_broker',
      brokerOrderId: 'alpaca-existing-trail-123',
      clientOrderId: expectedClientOrderId,
    });

    expect(mocks.brokerOrderFindFirst).toHaveBeenCalledWith({
      where: {
        tradingAccountId: 1,
        broker: 'alpaca',
        clientOrderId: expectedClientOrderId,
      },
    });

    expect(mocks.getAlpacaOrderByClientOrderId).toHaveBeenCalledWith(
      1,
      expectedClientOrderId,
      'protective_order_idempotency_check'
    );

    // This is the safety assertion:
    // recovery should link the existing broker order, not place a duplicate.
    expect(mocks.placeAlpacaOrder).not.toHaveBeenCalled();

    expect(mocks.orderIntentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'exit-evaluator',
        symbol: 'SPY',
        side: 'sell',
        orderType: 'trailing_stop',
        timeInForce: 'gtc',
        qty: 3,
        clientOrderId: expectedClientOrderId,
        tradingAccountId: 1,
        subscriptionId: 22,
        subscriptionKey: 'SPY_dip_core',
        status: 'submitting',
      }),
    });

    expect(mocks.brokerOrderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderIntentId: 301,
          tradingAccountId: 1,
          broker: 'alpaca',
          brokerOrderId: 'alpaca-existing-trail-123',
          clientOrderId: expectedClientOrderId,
          securityId: 11,
          symbol: 'SPY',
          side: 'sell',
          status: 'accepted',
        }),
      })
    );

    expect(mocks.markTrailingStopOrderSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        trackedPositionId: 101,
        broker: 'alpaca',
        brokerOrderId: 'alpaca-existing-trail-123',
        clientOrderId: expectedClientOrderId,
        orderStatus: 'accepted',
      })
    );

    // This was not a new submission, so the "submitted" event should not fire.
    expect(mocks.createSystemEvent).not.toHaveBeenCalled();
    expect(mocks.forceAfterBrokerOrderCreated).not.toHaveBeenCalled();
  });

  it('forces adaptive synchronization after creating a new Alpaca trailing-stop order', async () => {
    const expectedClientOrderId = 'ai-exit-trail-SPY-101-20260606153000';
    const createdOrder = {
      id: 'alpaca-new-trail-123',
      client_order_id: expectedClientOrderId,
      status: 'accepted',
      symbol: 'SPY',
      side: 'sell',
      type: 'trailing_stop',
      qty: '3',
      trail_percent: '0.25',
    };

    mocks.trackedPositionFindUnique.mockResolvedValue(buildPosition());
    mocks.brokerOrderFindFirst.mockResolvedValue(null);
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(null);
    mocks.placeAlpacaOrder.mockResolvedValue(createdOrder);
    mocks.orderIntentFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 301,
        trackedPositionId: 101,
        tradingAccountId: 1,
      });
    mocks.orderIntentCreate.mockResolvedValue({
      id: 301,
      trackedPositionId: 101,
      tradingAccountId: 1,
      blockReason: null,
      updatedAt: new Date('2026-06-06T15:30:00.000Z'),
    });
    mocks.brokerOrderCreate.mockResolvedValue({});
    mocks.markTrailingStopOrderSubmitted.mockResolvedValue({});
    mocks.createSystemEvent.mockResolvedValue({});

    const result = await submitTrailingStopExitOrder(1, 101);

    expect(result).toMatchObject({
      submitted: true,
      brokerOrderId: 'alpaca-new-trail-123',
    });
    expect(mocks.forceAfterBrokerOrderCreated).toHaveBeenCalledWith(
      1,
      'protective_order_created'
    );
  });

  it('allows a controlled retry after a definitely-not-sent failure', async () => {
    const oldIntent = {
      id: 301,
      trackedPositionId: 101,
      tradingAccountId: 1,
      blockReason:
        'BROKER_WRITE_DELIVERY:NOT_SENT_RETRYABLE:local rate limit',
      updatedAt: new Date('2026-06-06T15:30:00.000Z'),
    };
    const createdOrder = {
      id: 'alpaca-retried-trail',
      client_order_id: 'ai-exit-trail-SPY-101-20260606153000',
      status: 'accepted',
      symbol: 'SPY',
      side: 'sell',
      type: 'trailing_stop',
      qty: '3',
      trail_percent: '0.25',
    };
    mocks.trackedPositionFindUnique.mockResolvedValue(buildPosition());
    mocks.brokerOrderFindFirst.mockResolvedValue(null);
    mocks.orderIntentFindFirst.mockResolvedValueOnce(null);
    mocks.orderIntentCreate.mockResolvedValue({
      ...oldIntent,
      blockReason: null,
    });
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(null);
    mocks.placeAlpacaOrder.mockRejectedValueOnce(
      new BrokerWriteDeliveryError({
        classification: 'NOT_SENT_RETRYABLE',
        message: 'locally deferred',
      })
    );

    await expect(
      submitTrailingStopExitOrder(
        1,
        101,
        new Date('2026-06-06T15:30:01.000Z')
      )
    ).rejects.toThrow('locally deferred');
    expect(mocks.orderIntentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          blockReason: expect.stringContaining('NOT_SENT_RETRYABLE'),
        }),
      })
    );

    mocks.orderIntentFindFirst
      .mockReset()
      .mockResolvedValueOnce(oldIntent)
      .mockResolvedValueOnce(oldIntent);
    mocks.placeAlpacaOrder.mockResolvedValueOnce(createdOrder);

    await expect(
      submitTrailingStopExitOrder(
        1,
        101,
        new Date('2026-06-06T15:31:00.000Z')
      )
    ).resolves.toMatchObject({
      submitted: true,
      brokerOrderId: 'alpaca-retried-trail',
    });
    expect(mocks.placeAlpacaOrder).toHaveBeenCalledTimes(2);
  });

  it('does not blindly replay an inconclusive uncertain submission', async () => {
    const uncertainIntent = {
      id: 301,
      trackedPositionId: 101,
      tradingAccountId: 1,
      blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:timeout',
      updatedAt: new Date('2026-06-06T15:30:00.000Z'),
    };
    mocks.trackedPositionFindUnique.mockResolvedValue(buildPosition());
    mocks.brokerOrderFindFirst.mockResolvedValue(null);
    mocks.orderIntentFindFirst.mockResolvedValue(uncertainIntent);
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(null);

    const result = await submitTrailingStopExitOrder(
      1,
      101,
      new Date('2026-06-06T15:31:00.000Z')
    );

    expect(result).toMatchObject({ reason: 'recovery_inconclusive' });
    expect(mocks.placeAlpacaOrder).not.toHaveBeenCalled();
  });

  it('recovers broker acceptance after local persistence failure without duplicate submission', async () => {
    const acceptedOrder = {
      id: 'alpaca-accepted-before-persist',
      client_order_id: 'ai-exit-trail-SPY-101-20260606153000',
      status: 'accepted',
      symbol: 'SPY',
      side: 'sell',
      type: 'trailing_stop',
      qty: '3',
      trail_percent: '0.25',
    };
    const uncertainIntent = {
      id: 301,
      trackedPositionId: 101,
      tradingAccountId: 1,
      blockReason:
        'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:broker accepted before local persistence completed',
      updatedAt: new Date('2026-06-06T15:30:00.000Z'),
    };
    mocks.trackedPositionFindUnique
      .mockResolvedValueOnce(buildPosition())
      .mockRejectedValueOnce(new Error('database unavailable'));
    mocks.brokerOrderFindFirst.mockResolvedValue(null);
    mocks.orderIntentFindFirst.mockResolvedValueOnce(null);
    mocks.orderIntentCreate.mockResolvedValue({
      ...uncertainIntent,
      blockReason: null,
    });
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(null);
    mocks.placeAlpacaOrder.mockResolvedValueOnce(acceptedOrder);

    await expect(
      submitTrailingStopExitOrder(1, 101)
    ).rejects.toMatchObject({ classification: 'DELIVERY_UNCERTAIN' });

    mocks.trackedPositionFindUnique.mockReset().mockResolvedValue(buildPosition());
    mocks.orderIntentFindFirst
      .mockReset()
      .mockResolvedValueOnce(uncertainIntent)
      .mockResolvedValueOnce(uncertainIntent);
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValueOnce(acceptedOrder);

    await expect(
      submitTrailingStopExitOrder(
        1,
        101,
        new Date('2026-06-06T15:31:00.000Z')
      )
    ).resolves.toMatchObject({
      reason: 'already_at_broker',
      brokerOrderId: 'alpaca-accepted-before-persist',
    });
    expect(mocks.placeAlpacaOrder).toHaveBeenCalledOnce();
  });
});
