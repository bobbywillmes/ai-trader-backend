import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindMany: vi.fn(),

  closePosition: vi.fn(),

  createSystemEvent: vi.fn(),

  ensurePositionExitState: vi.fn(),
  markTrailingStopOrderSubmitFailed: vi.fn(),
  unlockTrailingStopExitState: vi.fn(),

  submitTrailingStopExitOrder: vi.fn(),

  submitNativeTrailingStopForTrackedPosition: vi.fn(),
  syncNativeTrailingStopForTrackedPosition: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: {
      findMany: mocks.trackedPositionFindMany,
    },
  },
}));

vi.mock('./close-position.service.js', () => ({
  closePosition: mocks.closePosition,
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

vi.mock('./position-exit-state.service.js', () => ({
  ensurePositionExitState: mocks.ensurePositionExitState,
  markTrailingStopOrderSubmitFailed: mocks.markTrailingStopOrderSubmitFailed,
  unlockTrailingStopExitState: mocks.unlockTrailingStopExitState,
}));

vi.mock('./trailing-stop-exit.service.js', () => ({
  submitTrailingStopExitOrder: mocks.submitTrailingStopExitOrder,
}));

vi.mock('./trailing-stop.service.js', () => ({
  submitNativeTrailingStopForTrackedPosition:
    mocks.submitNativeTrailingStopForTrackedPosition,
  syncNativeTrailingStopForTrackedPosition:
    mocks.syncNativeTrailingStopForTrackedPosition,
}));

import { evaluateExits } from './exit-evaluator.service.js';

function buildUnlockTrailingPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    symbol: 'SPY',
    status: 'open',
    currentPrice: 100.4,
    unrealizedPnLPct: 0.003, // 0.3%
    trailingStopOrderId: null,
    trailingStopStatus: null,
    exitState: null,
    subscription: {
      exitProfile: {
        key: 'exit_etf_unlock_0_5_trail_0_25',
        exitMode: 'unlock_trailing_stop',
        targetPct: 0.5,
        trailingStopPct: 0.25,
        stopLossPct: null,
      },
    },
    ...overrides,
  };
}

function buildExitState(overrides: Record<string, unknown> = {}) {
  return {
    id: 201,
    trackedPositionId: 101,
    status: 'watching',
    targetUnlocked: false,
    targetUnlockedAt: null,
    targetUnlockedPrice: null,
    targetUnlockedPnlPct: null,
    highWaterMark: null,
    trailStopPrice: null,
    targetPct: 0.5,
    trailingStopPct: 0.25,
    trailBroker: null,
    trailBrokerOrderId: null,
    trailClientOrderId: null,
    trailOrderStatus: null,
    rawBrokerJson: null,
    ...overrides,
  };
}

describe('evaluateExits - unlock trailing stop lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('does nothing dangerous when an unlock-trailing position has not reached target', async () => {
    const exitState = buildExitState();

    mocks.trackedPositionFindMany.mockResolvedValue([
      buildUnlockTrailingPosition({
        unrealizedPnLPct: 0.003, // 0.3%, below 0.5% target
        exitState: null,
      }),
    ]);

    mocks.ensurePositionExitState.mockResolvedValue(exitState);

    await evaluateExits();

    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith({
      where: { status: 'open' },
      include: {
        exitState: true,
        subscription: {
          include: {
            exitProfile: true,
          },
        },
      },
    });

    expect(mocks.ensurePositionExitState).toHaveBeenCalledWith(101);

    expect(mocks.unlockTrailingStopExitState).not.toHaveBeenCalled();
    expect(mocks.submitTrailingStopExitOrder).not.toHaveBeenCalled();
    expect(mocks.closePosition).not.toHaveBeenCalled();
    expect(mocks.createSystemEvent).not.toHaveBeenCalled();
  });

  it('unlocks the target and submits a trailing-stop exit order when target is reached', async () => {
    const unlockedExitState = buildExitState({
      status: 'target_unlocked',
      targetUnlocked: true,
      targetUnlockedAt: new Date('2026-06-06T15:30:00.000Z'),
      targetUnlockedPrice: 101,
      targetUnlockedPnlPct: 0.006,
      highWaterMark: 101,
      trailStopPrice: 100.7475,
    });

    mocks.trackedPositionFindMany.mockResolvedValue([
      buildUnlockTrailingPosition({
        currentPrice: 101,
        unrealizedPnLPct: 0.006, // 0.6%, above 0.5% target
        exitState: buildExitState(),
      }),
    ]);

    mocks.unlockTrailingStopExitState.mockResolvedValue(unlockedExitState);
    mocks.createSystemEvent.mockResolvedValue({});
    mocks.submitTrailingStopExitOrder.mockResolvedValue({
      submitted: true,
      brokerOrderId: 'alpaca-order-123',
      clientOrderId: 'ai-exit-trail-SPY-101',
    });

    await evaluateExits();

    expect(mocks.unlockTrailingStopExitState).toHaveBeenCalledWith({
      trackedPositionId: 101,
      currentPrice: 101,
      pnlPct: 0.006,
      targetPct: 0.5,
      trailingStopPct: 0.25,
    });

    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'exit.target_unlocked',
        entityType: 'trackedPosition',
        entityId: 101,
        message: 'SPY reached target unlock for trailing stop exit.',
      })
    );

    expect(mocks.submitTrailingStopExitOrder).toHaveBeenCalledWith(101);

    // Important: target reached should NOT mean immediate close anymore.
    expect(mocks.closePosition).not.toHaveBeenCalled();
  });

  it('does not submit a duplicate trailing-stop order when one is already linked', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      buildUnlockTrailingPosition({
        unrealizedPnLPct: 0.01,
        exitState: buildExitState({
          status: 'trailing_stop_submitted',
          targetUnlocked: true,
          trailBroker: 'alpaca',
          trailBrokerOrderId: 'existing-broker-order-id',
          trailClientOrderId: 'existing-client-order-id',
          trailOrderStatus: 'accepted',
        }),
      }),
    ]);

    await evaluateExits();

    expect(mocks.unlockTrailingStopExitState).not.toHaveBeenCalled();
    expect(mocks.submitTrailingStopExitOrder).not.toHaveBeenCalled();
    expect(mocks.closePosition).not.toHaveBeenCalled();
    expect(mocks.createSystemEvent).not.toHaveBeenCalled();
  });

  it('marks the trailing-stop submission as failed when broker submission throws', async () => {
    const unlockedExitState = buildExitState({
      status: 'target_unlocked',
      targetUnlocked: true,
      targetUnlockedAt: new Date('2026-06-06T15:30:00.000Z'),
      targetUnlockedPrice: 101,
      targetUnlockedPnlPct: 0.006,
      highWaterMark: 101,
      trailStopPrice: 100.7475,
    });

    const submissionError = new Error('broker rejected trailing stop');

    mocks.trackedPositionFindMany.mockResolvedValue([
      buildUnlockTrailingPosition({
        currentPrice: 101,
        unrealizedPnLPct: 0.006,
        exitState: buildExitState(),
      }),
    ]);

    mocks.unlockTrailingStopExitState.mockResolvedValue(unlockedExitState);
    mocks.createSystemEvent.mockResolvedValue({});
    mocks.submitTrailingStopExitOrder.mockRejectedValue(submissionError);
    mocks.markTrailingStopOrderSubmitFailed.mockResolvedValue({});

    await evaluateExits();

    expect(mocks.unlockTrailingStopExitState).toHaveBeenCalledOnce();
    expect(mocks.submitTrailingStopExitOrder).toHaveBeenCalledWith(101);

    expect(mocks.markTrailingStopOrderSubmitFailed).toHaveBeenCalledWith(101, {
      name: 'Error',
      message: 'broker rejected trailing stop',
    });

    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'exit.trailing_stop_submit_failed',
        entityType: 'trackedPosition',
        entityId: 101,
        message: 'SPY trailing stop exit order submission failed.',
      })
    );

    expect(mocks.closePosition).not.toHaveBeenCalled();
  });
});