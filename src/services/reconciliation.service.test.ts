import { describe, expect, it } from 'vitest';

import { reconcileSnapshots } from './reconciliation.service.js';

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