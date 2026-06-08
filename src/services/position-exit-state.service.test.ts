import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  positionExitStateUpdate: vi.fn(),
  positionExitStateUpdateMany: vi.fn(),
  positionExitStateUpsert: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    positionExitState: {
      update: mocks.positionExitStateUpdate,
      updateMany: mocks.positionExitStateUpdateMany,
      upsert: mocks.positionExitStateUpsert,
    },
  },
}));

import {
  markPositionExitStateClosed,
  markTrailingStopOrderSubmitted,
  markTrailingStopOrderSubmitFailed,
  syncTrailingStopOrderStatus,
} from './position-exit-state.service.js';

describe('position exit attention states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks attention required when trailing-stop order submission fails', async () => {
    const payload = {
      name: 'Error',
      message: 'broker rejected trailing stop',
    };

    mocks.positionExitStateUpdate.mockResolvedValue({});

    await markTrailingStopOrderSubmitFailed(101, payload);

    expect(mocks.positionExitStateUpdate).toHaveBeenCalledWith({
      where: { trackedPositionId: 101 },
      data: expect.objectContaining({
        status: 'trailing_stop_submit_failed',
        trailOrderStatus: 'submit_failed',
        rawBrokerJson: payload,
        attentionRequired: true,
        attentionCode: 'trail_submit_failed',
        attentionMessage: 'Protective trailing stop order submission failed.',
        attentionAt: expect.any(Date),
        attentionClearedAt: null,
      }),
    });
  });

  it('marks attention required when broker sync reports a rejected trailing-stop order', async () => {
    const rawBrokerJson = {
      id: 'alpaca-order-123',
      status: 'rejected',
    };

    mocks.positionExitStateUpdateMany.mockResolvedValue({ count: 1 });

    await syncTrailingStopOrderStatus({
      clientOrderId: 'ai-exit-trail-SPY-101-20260606153000',
      brokerOrderId: 'alpaca-order-123',
      orderStatus: 'rejected',
      rawBrokerJson,
    });

    expect(mocks.positionExitStateUpdateMany).toHaveBeenCalledWith({
      where: {
        trailClientOrderId: 'ai-exit-trail-SPY-101-20260606153000',
      },
      data: expect.objectContaining({
        status: 'trailing_stop_rejected',
        trailOrderStatus: 'rejected',
        trailBrokerOrderId: 'alpaca-order-123',
        rawBrokerJson,
        attentionRequired: true,
        attentionCode: 'trail_order_rejected',
        attentionMessage:
          'Protective trailing stop order was rejected by the broker.',
        attentionAt: expect.any(Date),
        attentionClearedAt: null,
      }),
    });
  });

  it('marks attention required when broker sync reports a canceled trailing-stop order', async () => {
    const rawBrokerJson = {
      id: 'alpaca-order-456',
      status: 'canceled',
    };

    mocks.positionExitStateUpdateMany.mockResolvedValue({ count: 1 });

    await syncTrailingStopOrderStatus({
      clientOrderId: 'ai-exit-trail-QQQ-102-20260606153000',
      brokerOrderId: 'alpaca-order-456',
      orderStatus: 'canceled',
      rawBrokerJson,
    });

    expect(mocks.positionExitStateUpdateMany).toHaveBeenCalledWith({
      where: {
        trailClientOrderId: 'ai-exit-trail-QQQ-102-20260606153000',
      },
      data: expect.objectContaining({
        status: 'trailing_stop_canceled',
        trailOrderStatus: 'canceled',
        trailBrokerOrderId: 'alpaca-order-456',
        rawBrokerJson,
        attentionRequired: true,
        attentionCode: 'trail_order_canceled',
        attentionMessage: 'Protective trailing stop order was canceled.',
        attentionAt: expect.any(Date),
        attentionClearedAt: null,
      }),
    });
  });

  it('marks attention required when broker sync reports an expired trailing-stop order', async () => {
    const rawBrokerJson = {
      id: 'alpaca-order-789',
      status: 'expired',
    };

    mocks.positionExitStateUpdateMany.mockResolvedValue({ count: 1 });

    await syncTrailingStopOrderStatus({
      clientOrderId: 'ai-exit-trail-DIA-103-20260606153000',
      brokerOrderId: 'alpaca-order-789',
      orderStatus: 'expired',
      rawBrokerJson,
    });

    expect(mocks.positionExitStateUpdateMany).toHaveBeenCalledWith({
      where: {
        trailClientOrderId: 'ai-exit-trail-DIA-103-20260606153000',
      },
      data: expect.objectContaining({
        status: 'trailing_stop_expired',
        trailOrderStatus: 'expired',
        trailBrokerOrderId: 'alpaca-order-789',
        rawBrokerJson,
        attentionRequired: true,
        attentionCode: 'trail_order_expired',
        attentionMessage: 'Protective trailing stop order expired.',
        attentionAt: expect.any(Date),
        attentionClearedAt: null,
      }),
    });
  });

  it('clears attention when trailing-stop order submission is accepted', async () => {
    const rawBrokerJson = {
      id: 'alpaca-order-123',
      status: 'accepted',
    };

    mocks.positionExitStateUpdate.mockResolvedValue({});

    await markTrailingStopOrderSubmitted({
      trackedPositionId: 101,
      broker: 'alpaca',
      brokerOrderId: 'alpaca-order-123',
      clientOrderId: 'ai-exit-trail-SPY-101-20260606153000',
      orderStatus: 'accepted',
      rawBrokerJson,
    });

    expect(mocks.positionExitStateUpdate).toHaveBeenCalledWith({
      where: { trackedPositionId: 101 },
      data: expect.objectContaining({
        status: 'trailing_stop_submitted',
        trailBroker: 'alpaca',
        trailBrokerOrderId: 'alpaca-order-123',
        trailClientOrderId: 'ai-exit-trail-SPY-101-20260606153000',
        trailOrderStatus: 'accepted',
        rawBrokerJson,
        attentionRequired: false,
        attentionCode: null,
        attentionMessage: null,
        attentionAt: null,
        attentionClearedAt: expect.any(Date),
      }),
    });
  });

  it('clears attention when position exit state is closed', async () => {
    const payload = {
      reason: 'close fill imported',
    };

    mocks.positionExitStateUpsert.mockResolvedValue({});

    await markPositionExitStateClosed(101, payload);

    expect(mocks.positionExitStateUpsert).toHaveBeenCalledWith({
      where: { trackedPositionId: 101 },
      create: expect.objectContaining({
        trackedPositionId: 101,
        status: 'closed',
        rawBrokerJson: payload,
        attentionRequired: false,
        attentionCode: null,
        attentionMessage: null,
        attentionAt: null,
        attentionClearedAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        status: 'closed',
        rawBrokerJson: payload,
        attentionRequired: false,
        attentionCode: null,
        attentionMessage: null,
        attentionAt: null,
        attentionClearedAt: expect.any(Date),
      }),
    });
  });
});