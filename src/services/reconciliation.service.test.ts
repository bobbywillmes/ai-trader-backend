import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindMany: vi.fn(),
  getNormalizedPositions: vi.fn(),
  getOpenAlpacaOrders: vi.fn(),
  createSystemEvent: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: {
      findMany: mocks.trackedPositionFindMany,
    },
  },
}));

vi.mock('./positions.service.js', () => ({
  getNormalizedPositions: mocks.getNormalizedPositions,
}));

vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getOpenAlpacaOrders: mocks.getOpenAlpacaOrders,
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

import {
  reconcileSnapshots,
  runReconciliationCheck,
} from './reconciliation.service.js';

describe('reconcileSnapshots', () => {
  it('reports an active tracked position missing from broker open positions', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
        },
      ],
      brokerPositions: [],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tracked_position_missing_at_broker',
        severity: 'warn',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
      }),
    ]);
  });

  it('reports a broker position with no active tracked position', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'QQQ',
          qty: '1',
          side: 'long',
        },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'broker_position_untracked',
        severity: 'critical',
        entityType: 'brokerPosition',
        symbol: 'QQQ',
      }),
    ]);
  });

  it('reports a missing protective trailing-stop order after target unlock', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
          exitState: {
            targetUnlocked: true,
            trailClientOrderId: null,
            trailBrokerOrderId: null,
          },
        },
      ],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'SPY',
          qty: '1',
          side: 'long',
        },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
        attentionCode: 'trail_order_missing_after_unlock',
      }),
    ]);
  });

  it('reports a problem broker status for a protective trailing-stop order', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
          exitState: {
            targetUnlocked: true,
            trailClientOrderId: 'ai-exit-trail-SPY-101',
            trailBrokerOrderId: 'alpaca-order-123',
            trailOrderStatus: 'accepted',
          },
        },
      ],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'SPY',
          qty: '1',
          side: 'long',
        },
      ],
      brokerOrders: [
        {
          broker: 'alpaca',
          id: 'alpaca-order-123',
          client_order_id: 'ai-exit-trail-SPY-101',
          symbol: 'SPY',
          side: 'sell',
          type: 'trailing_stop',
          status: 'rejected',
        },
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'trail_order_problem_status',
          severity: 'critical',
          entityType: 'trackedPosition',
          entityId: '101',
          symbol: 'SPY',
          attentionCode: 'trail_order_rejected',
        }),
      ])
    );
  });

  it('reports a trailing-stop status mismatch between backend and broker', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
          exitState: {
            targetUnlocked: true,
            trailClientOrderId: 'ai-exit-trail-SPY-101',
            trailBrokerOrderId: 'alpaca-order-123',
            trailOrderStatus: 'accepted',
          },
        },
      ],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'SPY',
          qty: '1',
          side: 'long',
        },
      ],
      brokerOrders: [
        {
          broker: 'alpaca',
          id: 'alpaca-order-123',
          client_order_id: 'ai-exit-trail-SPY-101',
          symbol: 'SPY',
          side: 'sell',
          type: 'trailing_stop',
          status: 'new',
        },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'trail_order_status_mismatch',
        severity: 'warn',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
      }),
    ]);
  });

  it('does not report healthy matching position state', () => {
    const findings = reconcileSnapshots({
      trackedPositions: [
        {
          id: 101,
          broker: 'alpaca',
          symbol: 'SPY',
          status: 'open',
          exitState: {
            targetUnlocked: false,
          },
        },
      ],
      brokerPositions: [
        {
          broker: 'alpaca',
          symbol: 'SPY',
          qty: '1',
          side: 'long',
        },
      ],
    });

    expect(findings).toEqual([]);
  });
});

describe('runReconciliationCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads backend and broker snapshots, then creates system events for findings', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        id: 101,
        broker: 'alpaca',
        symbol: 'SPY',
        status: 'open',
        side: 'long',
        qty: 1,
        exitState: {
          targetUnlocked: true,
          trailClientOrderId: null,
          trailBrokerOrderId: null,
          trailOrderStatus: null,
          attentionRequired: false,
        },
      },
    ]);

    mocks.getNormalizedPositions.mockResolvedValue([
      {
        broker: 'alpaca',
        symbol: 'SPY',
        qty: 1,
        side: 'long',
      },
    ]);

    mocks.getOpenAlpacaOrders.mockResolvedValue([]);
    mocks.createSystemEvent.mockResolvedValue({});

    const result = await runReconciliationCheck();

    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith({
      where: {
        status: {
          in: ['open', 'closing'],
        },
      },
      include: {
        exitState: true,
      },
      orderBy: {
        symbol: 'asc',
      },
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        entityType: 'trackedPosition',
        entityId: '101',
        symbol: 'SPY',
      }),
    ]);

    expect(result.eventCount).toBe(1);

    expect(mocks.createSystemEvent).toHaveBeenCalledWith({
      type: 'reconciliation.trail_order_missing_after_unlock',
      entityType: 'trackedPosition',
      entityId: '101',
      message:
        'SPY target is unlocked, but no protective trailing-stop order is linked.',
      payloadJson: expect.objectContaining({
        code: 'trail_order_missing_after_unlock',
        severity: 'critical',
        symbol: 'SPY',
        attentionCode: 'trail_order_missing_after_unlock',
      }),
    });
  });

  it('does not create system events when reconciliation has no findings', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        id: 101,
        broker: 'alpaca',
        symbol: 'SPY',
        status: 'open',
        side: 'long',
        qty: 1,
        exitState: {
          targetUnlocked: false,
          trailClientOrderId: null,
          trailBrokerOrderId: null,
          trailOrderStatus: null,
          attentionRequired: false,
        },
      },
    ]);

    mocks.getNormalizedPositions.mockResolvedValue([
      {
        broker: 'alpaca',
        symbol: 'SPY',
        qty: 1,
        side: 'long',
      },
    ]);

    mocks.getOpenAlpacaOrders.mockResolvedValue([]);

    const result = await runReconciliationCheck();

    expect(result.findings).toEqual([]);
    expect(result.eventCount).toBe(0);
    expect(mocks.createSystemEvent).not.toHaveBeenCalled();
  });
});