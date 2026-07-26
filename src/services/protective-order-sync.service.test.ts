import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exitStateFindMany: vi.fn(),
  brokerOrderUpdateMany: vi.fn(),
  getAlpacaOrderById: vi.fn(),
  syncTrailingStopOrderStatus: vi.fn(),
  markPositionExitStateAttentionRequired: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    positionExitState: { findMany: mocks.exitStateFindMany },
    brokerOrder: { updateMany: mocks.brokerOrderUpdateMany },
  },
}));
vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderById: mocks.getAlpacaOrderById,
}));
vi.mock('./position-exit-state.service.js', () => ({
  syncTrailingStopOrderStatus: mocks.syncTrailingStopOrderStatus,
  markPositionExitStateAttentionRequired:
    mocks.markPositionExitStateAttentionRequired,
}));

import { syncProtectiveOrdersForAccount } from './protective-order-sync.service.js';

function exitState(overrides: Record<string, unknown> = {}) {
  return {
    id: 201,
    trackedPositionId: 101,
    trailBrokerOrderId: 'shared-order',
    trailClientOrderId: 'shared-client',
    trailOrderStatus: 'accepted',
    trackedPosition: {
      id: 101,
      tradingAccountId: 1,
      symbol: 'SPY',
    },
    ...overrides,
  };
}

function brokerOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shared-order',
    client_order_id: 'shared-client',
    symbol: 'SPY',
    side: 'sell',
    type: 'trailing_stop',
    time_in_force: 'gtc',
    qty: '4',
    filled_qty: '0',
    status: 'accepted',
    submitted_at: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

describe('syncProtectiveOrdersForAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.brokerOrderUpdateMany.mockResolvedValue({ count: 1 });
    mocks.syncTrailingStopOrderStatus.mockResolvedValue({ count: 1 });
    mocks.markPositionExitStateAttentionRequired.mockResolvedValue({});
  });

  it('synchronizes linked orders through the exact account even when controls are paused elsewhere', async () => {
    mocks.exitStateFindMany.mockResolvedValue([exitState()]);
    mocks.getAlpacaOrderById.mockResolvedValue(brokerOrder());

    const result = await syncProtectiveOrdersForAccount(1);

    expect(mocks.exitStateFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trackedPosition: { tradingAccountId: 1 },
        }),
      })
    );
    expect(mocks.getAlpacaOrderById).toHaveBeenCalledWith(
      1,
      'shared-order',
      'protective_order_sync'
    );
    expect(mocks.syncTrailingStopOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        tradingAccountId: 1,
        clientOrderId: 'shared-client',
        brokerOrderId: 'shared-order',
      })
    );
    expect(result.synchronized).toBe(1);
  });

  it('keeps identical broker and client IDs isolated by trading account', async () => {
    mocks.exitStateFindMany
      .mockResolvedValueOnce([exitState()])
      .mockResolvedValueOnce([
        exitState({
          trackedPositionId: 202,
          trackedPosition: {
            id: 202,
            tradingAccountId: 2,
            symbol: 'SPY',
          },
        }),
      ]);
    mocks.getAlpacaOrderById.mockResolvedValue(brokerOrder());

    await syncProtectiveOrdersForAccount(1);
    await syncProtectiveOrdersForAccount(2);

    expect(mocks.getAlpacaOrderById.mock.calls.map(([id]) => id)).toEqual([
      1,
      2,
    ]);
    expect(
      mocks.brokerOrderUpdateMany.mock.calls.map(
        ([query]) => query.where.tradingAccountId
      )
    ).toEqual([1, 2]);
  });

  it('records partial and terminal fills only on the owning account state', async () => {
    mocks.exitStateFindMany.mockResolvedValue([exitState()]);
    mocks.getAlpacaOrderById.mockResolvedValue(
      brokerOrder({ filled_qty: '2', status: 'filled' })
    );

    const result = await syncProtectiveOrdersForAccount(1);

    expect(result).toMatchObject({
      synchronized: 1,
      partialFills: 1,
      terminalOrders: 1,
    });
    expect(mocks.syncTrailingStopOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        tradingAccountId: 1,
        orderStatus: 'filled',
      })
    );
  });

  it('marks a confirmed 404 as attention-required without replacement submission', async () => {
    mocks.exitStateFindMany.mockResolvedValue([exitState()]);
    mocks.getAlpacaOrderById.mockResolvedValue(null);

    const result = await syncProtectiveOrdersForAccount(1);

    expect(result.confirmedMissing).toBe(1);
    expect(mocks.markPositionExitStateAttentionRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        trackedPositionId: 101,
        code: 'protective_order_confirmed_missing',
      })
    );
    expect(mocks.syncTrailingStopOrderStatus).not.toHaveBeenCalled();
  });

  it('treats a temporary lookup error as retryable failure rather than confirmed absence', async () => {
    mocks.exitStateFindMany.mockResolvedValue([
      exitState(),
      exitState({
        id: 202,
        trackedPositionId: 102,
        trailBrokerOrderId: 'later-order',
        trackedPosition: {
          id: 102,
          tradingAccountId: 1,
          symbol: 'QQQ',
        },
      }),
    ]);
    mocks.getAlpacaOrderById
      .mockRejectedValueOnce(new Error('temporary timeout'))
      .mockResolvedValueOnce(
        brokerOrder({
          id: 'later-order',
          client_order_id: 'shared-client',
          symbol: 'QQQ',
        })
      );

    const result = await syncProtectiveOrdersForAccount(1);

    expect(result).toMatchObject({ failed: 1, synchronized: 1 });
    expect(result.failures[0]).toMatchObject({
      trackedPositionId: 101,
      error: 'temporary timeout',
    });
    expect(mocks.markPositionExitStateAttentionRequired).not.toHaveBeenCalled();
  });
});
