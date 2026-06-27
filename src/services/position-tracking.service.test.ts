import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getNormalizedPositions: vi.fn(),
  createSystemEvent: vi.fn(),
  recordAccountSnapshot: vi.fn(),
  attributeCloseFillsForTrackedPosition: vi.fn(),
  syncBrokerActivities: vi.fn(),
  ensurePositionExitState: vi.fn(),
  markPositionExitStateClosed: vi.fn(),
  resetPositionExitStateForOpenPosition: vi.fn(),
  captureTrackedPositionConfigSnapshot: vi.fn(),
  resolveTrackedPositionSubscription: vi.fn(),
  linkLocalEntryOwnership: vi.fn(),
  securityFindUnique: vi.fn(),
  trackedPositionFindFirst: vi.fn(),
  trackedPositionCreate: vi.fn(),
  trackedPositionUpdate: vi.fn(),
  trackedPositionUpdateMany: vi.fn(),
  trackedPositionFindUnique: vi.fn(),
  trackedPositionFindMany: vi.fn(),
  systemEventFindFirst: vi.fn(),
  adaptiveGetDecision: vi.fn(),
  adaptiveRecordAttempt: vi.fn(),
  adaptiveRecordSuccess: vi.fn(),
  adaptiveRecordFailure: vi.fn(),
  adaptiveRecordRateLimitDeferred: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('./positions.service.js', () => ({
  getNormalizedPositions: mocks.getNormalizedPositions,
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

vi.mock('./account-snapshot.service.js', () => ({
  recordAccountSnapshot: mocks.recordAccountSnapshot,
}));

vi.mock('./broker-activity.service.js', () => ({
  attributeCloseFillsForTrackedPosition:
    mocks.attributeCloseFillsForTrackedPosition,
  syncBrokerActivities: mocks.syncBrokerActivities,
}));

vi.mock('./position-exit-state.service.js', () => ({
  ensurePositionExitState: mocks.ensurePositionExitState,
  markPositionExitStateClosed: mocks.markPositionExitStateClosed,
  resetPositionExitStateForOpenPosition: mocks.resetPositionExitStateForOpenPosition,
}));

vi.mock('./trade-cycle-config-snapshot.service.js', () => ({
  captureTrackedPositionConfigSnapshot:
    mocks.captureTrackedPositionConfigSnapshot,
}));

vi.mock('./tracked-position-subscription-resolution.service.js', () => ({
  resolveTrackedPositionSubscription: mocks.resolveTrackedPositionSubscription,
  linkLocalEntryOwnership: mocks.linkLocalEntryOwnership,
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    security: {
      findUnique: mocks.securityFindUnique,
    },
    trackedPosition: {
      findFirst: mocks.trackedPositionFindFirst,
      create: mocks.trackedPositionCreate,
      update: mocks.trackedPositionUpdate,
      updateMany: mocks.trackedPositionUpdateMany,
      findUnique: mocks.trackedPositionFindUnique,
      findMany: mocks.trackedPositionFindMany,
    },
    systemEvent: {
      findFirst: mocks.systemEventFindFirst,
    },
  },
}));

vi.mock('./adaptive-polling.service.js', () => ({
  adaptivePollingCoordinator: {
    getDecision: mocks.adaptiveGetDecision,
    recordAttempt: mocks.adaptiveRecordAttempt,
    recordSuccess: mocks.adaptiveRecordSuccess,
    recordFailure: mocks.adaptiveRecordFailure,
    recordRateLimitDeferred: mocks.adaptiveRecordRateLimitDeferred,
  },
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

import { syncTrackedPositions } from './position-tracking.service.js';

const brokerPosition = {
  broker: 'alpaca',
  symbol: 'DIA',
  side: 'long',
  qty: 1,
  avgEntryPrice: 350,
  currentPrice: 351,
  marketValue: 351,
  costBasis: 350,
  unrealizedPnL: 1,
  unrealizedPnLPct: 0.0028,
};

describe('position tracking subscription recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getNormalizedPositions.mockResolvedValue([brokerPosition]);
    mocks.securityFindUnique.mockResolvedValue({ id: 11, symbol: 'DIA' });
    mocks.systemEventFindFirst.mockResolvedValue(null);
    mocks.createSystemEvent.mockResolvedValue({});
    mocks.captureTrackedPositionConfigSnapshot.mockResolvedValue({});
    mocks.ensurePositionExitState.mockResolvedValue({});
    mocks.trackedPositionFindMany.mockResolvedValue([]);
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.adaptiveGetDecision.mockResolvedValue({
      due: true,
      mode: 'market_open_active',
      effectiveIntervalMs: 15_000,
      nextDueAt: null,
      reason: 'startup_due',
    });
  });

  it('recovers an existing open cycle with null subscriptionId on a later sync and captures its snapshot', async () => {
    const openedAt = new Date('2026-06-16T15:00:00.000Z');
    const existing = {
      id: 101,
      broker: 'alpaca',
      symbol: 'DIA',
      side: 'long',
      status: 'open',
      tradingAccountId: 1,
      openedAt,
      subscriptionId: null,
      configSnapshotJson: null,
    };
    const updated = {
      ...existing,
      qty: 1,
      avgEntryPrice: 350,
      currentPrice: 351,
      marketValue: 351,
      costBasis: 350,
      unrealizedPnL: 1,
      unrealizedPnLPct: 0.0028,
      rawPositionJson: brokerPosition,
    };

    mocks.trackedPositionFindFirst.mockResolvedValue(existing);
    mocks.trackedPositionUpdate
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce({ ...updated, subscriptionId: 22 });
    mocks.resolveTrackedPositionSubscription.mockResolvedValue({
      status: 'resolved',
      source: 'unique_observer_fallback',
      subscriptionId: 22,
      subscriptionKey: 'dia_dip_core',
      reason: 'single_eligible_subscription_for_observed_position',
      evidence: { symbol: 'DIA' },
    });

    await syncTrackedPositions();

    expect(mocks.trackedPositionUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: 101 },
      data: { subscriptionId: 22 },
    });
    expect(mocks.captureTrackedPositionConfigSnapshot).toHaveBeenCalledWith({
      trackedPositionId: 101,
      source: 'subscription_recovered',
      subscriptionResolutionSource: 'unique_observer_fallback',
    });
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'position.subscription_resolved',
        entityType: 'trackedPosition',
        entityId: 101,
        tradingAccountId: 1,
      })
    );
  });

  it('skips the Alpaca positions request when adaptive polling is not due', async () => {
    mocks.adaptiveGetDecision.mockResolvedValue({
      due: false,
      mode: 'market_closed_idle',
      effectiveIntervalMs: 300_000,
      nextDueAt: new Date('2026-06-22T14:05:00.000Z'),
      reason: 'adaptive_poll_not_due',
    });

    const result = await syncTrackedPositions();

    expect(result).toMatchObject({
      polled: false,
      skipped: true,
      skipReason: 'adaptive_poll_not_due',
      seen: 0,
    });
    expect(mocks.getNormalizedPositions).not.toHaveBeenCalled();
  });
});
