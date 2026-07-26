import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trackedPositionFindMany: vi.fn(),
  closePosition: vi.fn(),
  createSystemEvent: vi.fn(),
  ensurePositionExitState: vi.fn(),
  markTrailingStopOrderSubmitFailed: vi.fn(),
  unlockTrailingStopExitState: vi.fn(),
  submitTrailingStopExitOrder: vi.fn(),
  enumerateLifecycleAccounts: vi.fn(),
  syncProtectiveOrdersForAccount: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../config/logger.js', () => ({
  logger: { info: mocks.loggerInfo, error: mocks.loggerError },
}));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    trackedPosition: { findMany: mocks.trackedPositionFindMany },
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
vi.mock('./lifecycle-account-eligibility.service.js', () => ({
  enumerateLifecycleAccounts: mocks.enumerateLifecycleAccounts,
}));
vi.mock('./protective-order-sync.service.js', () => ({
  syncProtectiveOrdersForAccount: mocks.syncProtectiveOrdersForAccount,
}));

import {
  evaluateExitsForAccount,
  evaluateExitsForEligibleAccounts,
} from './exit-evaluator.service.js';

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    tradingAccountId: 1,
    subscriptionId: 21,
    enabled: true,
    exitsEnabled: true,
    subscription: {
      exitProfile: {
        key: 'fixed-exit',
        exitMode: 'fixed',
        targetPct: 1,
        trailingStopPct: null,
        stopLossPct: 1,
      },
    },
    ...overrides,
  };
}

function position(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    symbol: 'SPY',
    tradingAccountId: 1,
    tradingAccountSubscriptionId: 11,
    subscriptionId: 21,
    status: 'open',
    currentPrice: 101,
    unrealizedPnLPct: 0,
    exitState: null,
    subscription: {
      exitProfile: assignment().subscription.exitProfile,
    },
    tradingAccountSubscription: assignment(),
    ...overrides,
  };
}

function unlockPosition(overrides: Record<string, unknown> = {}) {
  const trailingAssignment = assignment({
    subscription: {
      exitProfile: {
        key: 'unlock-trail',
        exitMode: 'unlock_trailing_stop',
        targetPct: 0.5,
        trailingStopPct: 0.25,
        stopLossPct: null,
      },
    },
  });
  return position({
    unrealizedPnLPct: 0.006,
    tradingAccountSubscription: trailingAssignment,
    subscription: trailingAssignment.subscription,
    ...overrides,
  });
}

function account(
  id: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    tradingAccountId: id,
    displayName: id === 1 ? 'Bobby Paper' : 'Bobby Live',
    broker: 'ALPACA',
    environment: id === 1 ? 'PAPER' : 'LIVE',
    status: 'PAUSED',
    credentialStatus: 'ACTIVE',
    eligible: true,
    reason: 'usable_credentials_with_work',
    exposureSummary: {
      pendingIntents: 0,
      submittingIntents: 0,
      submittedIntents: 0,
      nonterminalOrders: 0,
      activePositions: 1,
      unresolvedActivities: 0,
      unresolvedExitPositions: 0,
      hasLifecycleWork: true,
    },
    ...overrides,
  };
}

describe('account-scoped exit evaluation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSystemEvent.mockResolvedValue({});
    mocks.syncProtectiveOrdersForAccount.mockResolvedValue({
      found: 0,
      synchronized: 0,
      partialFills: 0,
      terminalOrders: 0,
      confirmedMissing: 0,
      failed: 0,
      failures: [],
    });
  });

  it('uses the exact account assignment and creates a strategy close when allowed', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      position({ unrealizedPnLPct: 0.02 }),
    ]);
    mocks.closePosition.mockResolvedValue({ ok: true });

    const result = await evaluateExitsForAccount(1);

    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['open', 'closing'] }, tradingAccountId: 1 },
        orderBy: { id: 'asc' },
      })
    );
    expect(mocks.closePosition).toHaveBeenCalledWith(101);
    expect(result.counts).toMatchObject({
      positionsEvaluated: 1,
      exitSignalsTriggered: 1,
      closeIntentsCreated: 1,
      failedPositions: 0,
    });
  });

  it.each([
    ['exitsEnabled', assignment({ exitsEnabled: false })],
    ['enabled', assignment({ enabled: false })],
  ])('suppresses new automated exits when assignment %s is false', async (_name, value) => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      position({
        unrealizedPnLPct: 0.02,
        tradingAccountSubscription: value,
      }),
    ]);

    const result = await evaluateExitsForAccount(1);

    expect(mocks.closePosition).not.toHaveBeenCalled();
    expect(result.counts).toMatchObject({
      positionsSkipped: 1,
      blockedExits: 1,
    });
  });

  it('does not treat entriesEnabled=false as an exit control', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      position({
        unrealizedPnLPct: 0.02,
        tradingAccountSubscription: assignment({ entriesEnabled: false }),
      }),
    ]);
    mocks.closePosition.mockResolvedValue({ ok: true });

    await evaluateExitsForAccount(1);

    expect(mocks.closePosition).toHaveBeenCalledWith(101);
  });

  it('does not let one position failure stop later positions', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      position({
        id: 101,
        tradingAccountSubscription: null,
      }),
      position({ id: 102, unrealizedPnLPct: 0.02 }),
    ]);
    mocks.closePosition.mockResolvedValue({ ok: true });

    const result = await evaluateExitsForAccount(1);

    expect(mocks.closePosition).toHaveBeenCalledWith(102);
    expect(result.counts.failedPositions).toBe(1);
    expect(result.failures[0]).toMatchObject({ trackedPositionId: 101 });
  });

  it('has one authoritative unlock-to-trailing path', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([unlockPosition()]);
    mocks.ensurePositionExitState.mockResolvedValue({
      targetUnlocked: false,
      targetPct: 0.5,
      trailingStopPct: 0.25,
      trailBrokerOrderId: null,
      trailOrderStatus: null,
    });
    mocks.unlockTrailingStopExitState.mockResolvedValue({
      targetUnlocked: true,
      targetPct: 0.5,
      trailingStopPct: 0.25,
      trailBrokerOrderId: null,
      trailOrderStatus: null,
    });
    mocks.submitTrailingStopExitOrder.mockResolvedValue({ submitted: true });

    const result = await evaluateExitsForAccount(1);

    expect(mocks.unlockTrailingStopExitState).toHaveBeenCalledOnce();
    expect(mocks.submitTrailingStopExitOrder).toHaveBeenCalledWith(1, 101);
    expect(mocks.closePosition).not.toHaveBeenCalled();
    expect(result.counts).toMatchObject({
      exitSignalsTriggered: 1,
      closeIntentsCreated: 1,
    });
  });

  it('does not permanently suppress protective recovery after submit_failed', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      unlockPosition({
        exitState: {
          targetUnlocked: true,
          targetPct: 0.5,
          trailingStopPct: 0.25,
          trailBrokerOrderId: null,
          trailOrderStatus: 'submit_failed',
        },
      }),
    ]);
    mocks.submitTrailingStopExitOrder.mockResolvedValue({
      submitted: false,
      reason: 'recovery_backoff',
    });

    await evaluateExitsForAccount(1);

    expect(mocks.submitTrailingStopExitOrder).toHaveBeenCalledWith(1, 101);
  });

  it('keeps same-symbol positions isolated by coordinator account', async () => {
    mocks.trackedPositionFindMany
      .mockResolvedValueOnce([position({ tradingAccountId: 1 })])
      .mockResolvedValueOnce([
        position({
          id: 202,
          tradingAccountId: 2,
          tradingAccountSubscription: assignment({
            id: 22,
            tradingAccountId: 2,
          }),
        }),
      ]);

    await evaluateExitsForAccount(1);
    await evaluateExitsForAccount(2);

    expect(mocks.trackedPositionFindMany.mock.calls.map(([query]) =>
      query.where.tradingAccountId
    )).toEqual([1, 2]);
  });
});

describe('exit evaluation coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSystemEvent.mockResolvedValue({});
    mocks.syncProtectiveOrdersForAccount.mockResolvedValue({
      found: 0,
      synchronized: 0,
      partialFills: 0,
      terminalOrders: 0,
      confirmedMissing: 0,
      failed: 0,
      failures: [],
    });
  });

  it('processes eligible accounts sequentially in enumerated stable order', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([account(1), account(2)]);
    mocks.trackedPositionFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await evaluateExitsForEligibleAccounts();

    expect(mocks.trackedPositionFindMany.mock.calls.map(([query]) =>
      query.where.tradingAccountId
    )).toEqual([1, 2]);
    expect(result.results.map((item) => item.account.tradingAccountId)).toEqual([
      1,
      2,
    ]);
  });

  it('continues after one account query fails', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([account(1), account(2)]);
    mocks.trackedPositionFindMany
      .mockRejectedValueOnce(new Error('paper query failed'))
      .mockResolvedValueOnce([]);

    const result = await evaluateExitsForEligibleAccounts();

    expect(result.results.map((item) => item.outcome)).toEqual([
      'FAILED',
      'PROCESSED',
    ]);
  });

  it('reports credentialless exposure without making a broker-facing evaluation', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      account(2, {
        credentialStatus: null,
        eligible: false,
        reason: 'credentials_unavailable_with_exposure',
      }),
    ]);

    const result = await evaluateExitsForEligibleAccounts();

    expect(mocks.trackedPositionFindMany).not.toHaveBeenCalled();
    expect(result.results[0]?.outcome).toBe('CREDENTIALS_UNAVAILABLE');
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'exit.credentials_unavailable_with_exposure',
        tradingAccountId: 2,
      })
    );
  });

  it('treats dormant credentialless accounts as a healthy skip', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      account(2, {
        credentialStatus: null,
        eligible: false,
        reason: 'credentials_unavailable_dormant',
        exposureSummary: {
          ...account(2).exposureSummary,
          activePositions: 0,
          hasLifecycleWork: false,
        },
      }),
    ]);

    const result = await evaluateExitsForEligibleAccounts();

    expect(result.results[0]?.outcome).toBe('SKIPPED');
    expect(mocks.createSystemEvent).not.toHaveBeenCalled();
  });

  it('keeps a market-closed attributed DIA cycle healthy while dormant Live is skipped', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      account(1),
      account(2, {
        credentialStatus: null,
        eligible: false,
        reason: 'credentials_unavailable_dormant',
        exposureSummary: {
          ...account(2).exposureSummary,
          activePositions: 0,
          hasLifecycleWork: false,
        },
      }),
    ]);
    mocks.trackedPositionFindMany.mockResolvedValueOnce([
      position({
        symbol: 'DIA',
        unrealizedPnLPct: 0,
        exitState: {
          status: 'watching',
          targetUnlocked: false,
          trailBrokerOrderId: null,
        },
      }),
    ]);

    const result = await evaluateExitsForEligibleAccounts();

    expect(result).toMatchObject({
      processedAccounts: 1,
      failedAccounts: 0,
      credentialUnavailableAccounts: 0,
      skippedAccounts: 1,
    });
    expect(result.results.map((item) => ({
      id: item.account.tradingAccountId,
      outcome: item.outcome,
      reason: item.account.reason,
    }))).toEqual([
      { id: 1, outcome: 'PROCESSED', reason: 'usable_credentials_with_work' },
      { id: 2, outcome: 'SKIPPED', reason: 'credentials_unavailable_dormant' },
    ]);
    expect(mocks.closePosition).not.toHaveBeenCalled();
    expect(mocks.submitTrailingStopExitOrder).not.toHaveBeenCalled();
    expect(mocks.trackedPositionFindMany).toHaveBeenCalledOnce();
  });
});
