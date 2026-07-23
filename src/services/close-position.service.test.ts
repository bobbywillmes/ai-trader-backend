import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindUnique: vi.fn(),
  trackedPositionUpdateMany: vi.fn(),
  orderIntentCreate: vi.fn(),
  brokerOrderUpsert: vi.fn(),
  closeAlpacaPosition: vi.fn(),
  createSystemEvent: vi.fn(),
  forceAfterBrokerPositionWrite: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: {
      findUnique: mocks.trackedPositionFindUnique,
      updateMany: mocks.trackedPositionUpdateMany,
    },
    orderIntent: {
      create: mocks.orderIntentCreate,
    },
    brokerOrder: {
      upsert: mocks.brokerOrderUpsert,
    },
  },
}));

vi.mock('../integrations/alpaca/positions.adapter.js', () => ({
  closeAlpacaPosition: mocks.closeAlpacaPosition,
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

vi.mock('./adaptive-polling.service.js', () => ({
  adaptivePollingCoordinator: {
    forceAfterBrokerPositionWrite: mocks.forceAfterBrokerPositionWrite,
  },
}));

import { closePosition } from './close-position.service.js';

function position(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    symbol: 'AAPL',
    side: 'long',
    qty: 2,
    status: 'open',
    securityId: 11,
    subscriptionId: 21,
    tradingAccountId: 31,
    tradingAccountSubscriptionId: 41,
    tradingAccountSubscription: {
      id: 41,
      exitsEnabled: true,
    },
    ...overrides,
  };
}

describe('closePosition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trackedPositionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.orderIntentCreate.mockResolvedValue({ id: 501 });
    mocks.brokerOrderUpsert.mockResolvedValue({ id: 601 });
    mocks.createSystemEvent.mockResolvedValue(undefined);
    mocks.closeAlpacaPosition.mockResolvedValue({
      id: 'broker-close-1',
      client_order_id: 'close-101',
      symbol: 'AAPL',
      side: 'sell',
      status: 'accepted',
    });
  });

  it('routes the close through the tracked position account and assignment', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue(position());

    await expect(closePosition(101)).resolves.toMatchObject({
      ok: true,
      trackedPositionId: 101,
      symbol: 'AAPL',
    });

    expect(mocks.closeAlpacaPosition).toHaveBeenCalledWith(
      'AAPL',
      'position_close',
      { tradingAccountId: 31 }
    );
    expect(mocks.orderIntentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tradingAccountId: 31,
        tradingAccountSubscriptionId: 41,
        subscriptionId: 21,
        trackedPositionId: 101,
      }),
    });
  });

  it('fails closed when the tracked position has no account identity', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue(
      position({ tradingAccountId: null })
    );

    await expect(closePosition(101)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.closeAlpacaPosition).not.toHaveBeenCalled();
  });

  it('honors an explicit exits-disabled assignment', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue(
      position({
        tradingAccountSubscription: { id: 41, exitsEnabled: false },
      })
    );

    await expect(closePosition(101)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('exits disabled'),
    });
    expect(mocks.closeAlpacaPosition).not.toHaveBeenCalled();
  });

  it('does not guess when the tracked position does not exist', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue(null);

    await expect(closePosition(999)).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.closeAlpacaPosition).not.toHaveBeenCalled();
  });
});
