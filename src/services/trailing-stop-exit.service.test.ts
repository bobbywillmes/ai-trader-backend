import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindUnique: vi.fn(),

  brokerOrderFindUnique: vi.fn(),
  brokerOrderUpsert: vi.fn(),

  orderIntentFindFirst: vi.fn(),
  orderIntentCreate: vi.fn(),

  getAlpacaOrderByClientOrderId: vi.fn(),
  placeAlpacaOrder: vi.fn(),

  createSystemEvent: vi.fn(),

  ensurePositionExitState: vi.fn(),
  markTrailingStopOrderSubmitted: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: {
      findUnique: mocks.trackedPositionFindUnique,
    },
    brokerOrder: {
      findUnique: mocks.brokerOrderFindUnique,
      upsert: mocks.brokerOrderUpsert,
    },
    orderIntent: {
      findFirst: mocks.orderIntentFindFirst,
      create: mocks.orderIntentCreate,
    },
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

import { submitTrailingStopExitOrder } from './trailing-stop-exit.service.js';

function buildPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    symbol: 'SPY',
    qty: 3,
    securityId: 11,
    subscriptionId: 22,
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
    ...overrides,
  };
}

describe('submitTrailingStopExitOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.brokerOrderFindUnique.mockResolvedValue(null);

    // But Alpaca already has the order with the deterministic clientOrderId.
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(existingAlpacaOrder);

    mocks.orderIntentFindFirst.mockResolvedValue(null);
    mocks.orderIntentCreate.mockResolvedValue({ id: 301 });
    mocks.brokerOrderUpsert.mockResolvedValue({});
    mocks.markTrailingStopOrderSubmitted.mockResolvedValue({});

    const result = await submitTrailingStopExitOrder(101);

    expect(result).toEqual({
      submitted: false,
      reason: 'already_at_broker',
      brokerOrderId: 'alpaca-existing-trail-123',
      clientOrderId: expectedClientOrderId,
    });

    expect(mocks.brokerOrderFindUnique).toHaveBeenCalledWith({
      where: {
        broker_clientOrderId: {
          broker: 'alpaca',
          clientOrderId: expectedClientOrderId,
        },
      },
    });

    expect(mocks.getAlpacaOrderByClientOrderId).toHaveBeenCalledWith(
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
        subscriptionId: 22,
        subscriptionKey: 'SPY_dip_core',
        status: 'submitted',
      }),
    });

    expect(mocks.brokerOrderUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          broker_clientOrderId: {
            broker: 'alpaca',
            clientOrderId: expectedClientOrderId,
          },
        },
        create: expect.objectContaining({
          orderIntentId: 301,
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
  });
});
