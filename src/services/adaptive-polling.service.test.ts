import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADAPTIVE_POLLING_INTERVALS_MS,
  AdaptivePollingCoordinator,
  adaptivePollingLocalActivityFromCounts,
  type AdaptivePollingLocalActivitySnapshot,
} from './adaptive-polling.service.js';
import type { NormalizedMarketSessionSnapshot } from '../integrations/alpaca/market-session.adapter.js';

function marketSnapshot(args: {
  open: boolean;
  tradingDate?: string;
}): NormalizedMarketSessionSnapshot {
  const tradingDate = args.tradingDate ?? '2026-06-22';

  return {
    source: 'alpaca',
    brokerTimestamp: `${tradingDate}T14:00:00.000Z`,
    evaluatedTimestamp: `${tradingDate}T14:00:00.000Z`,
    marketOpen: args.open,
    tradingDate,
    sessionOpenAt: args.open ? `${tradingDate}T13:30:00.000Z` : null,
    sessionCloseAt: args.open ? `${tradingDate}T20:00:00.000Z` : null,
    nextOpenAt: `${tradingDate}T13:30:00.000Z`,
    nextCloseAt: `${tradingDate}T20:00:00.000Z`,
    fetchedAt: `${tradingDate}T13:59:00.000Z`,
    cache: {
      clock: 'cached',
      calendar: 'cached',
    },
  };
}

function activity(
  overrides: Partial<
    Omit<AdaptivePollingLocalActivitySnapshot, 'evaluatedAt'>
  > = {},
  evaluatedAt = new Date('2026-06-22T14:00:00.000Z')
) {
  return adaptivePollingLocalActivityFromCounts(
    {
      submittedOrderCount: 0,
      submittingOrderCount: 0,
      nonterminalBrokerOrderCount: 0,
      openPositionCount: 0,
      closingPositionCount: 0,
      activeExitCount: 0,
      activeProtectiveOrderCount: 0,
      ...overrides,
    },
    evaluatedAt
  );
}

function createHarness(args: {
  open?: boolean;
  active?: boolean;
  marketProvider?: (now: Date) => Promise<NormalizedMarketSessionSnapshot>;
} = {}) {
  let nowMs = new Date('2026-06-22T14:00:00.000Z').getTime();
  const marketProvider: (now: Date) => Promise<NormalizedMarketSessionSnapshot> =
    args.marketProvider ??
    vi.fn(async () => marketSnapshot({ open: args.open ?? true }));
  const localActivityProvider = vi.fn(async () =>
    activity({
      submittedOrderCount: args.active ? 1 : 0,
      openPositionCount: args.active ? 1 : 0,
    }, new Date(nowMs))
  );
  const coordinator = new AdaptivePollingCoordinator({
    now: () => new Date(nowMs),
    marketSessionProvider: marketProvider,
    localActivityProvider,
  });

  return {
    coordinator,
    marketProvider,
    localActivityProvider,
    advance(ms: number) {
      nowMs += ms;
    },
    setNow(value: string) {
      nowMs = new Date(value).getTime();
    },
    now() {
      return new Date(nowMs);
    },
  };
}

describe('AdaptivePollingCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks adaptive workers due at startup when relevant local work exists', async () => {
    const { coordinator } = createHarness({ active: true });

    await expect(
      coordinator.getDecision('submitted_order_sync')
    ).resolves.toMatchObject({
      due: true,
      reason: 'startup_due',
      forced: true,
      effectiveIntervalMs:
        ADAPTIVE_POLLING_INTERVALS_MS.submittedOrderSync.marketOpenActive,
    });

    await expect(
      coordinator.getDecision('tracked_position_sync')
    ).resolves.toMatchObject({
      due: true,
      reason: 'startup_due',
      forced: true,
      effectiveIntervalMs:
        ADAPTIVE_POLLING_INTERVALS_MS.trackedPositionSync.marketOpenActive,
    });
  });

  it('does not schedule submitted-order broker reads when no submitted intents exist', async () => {
    const { coordinator } = createHarness({ active: false });

    await expect(
      coordinator.getDecision('submitted_order_sync')
    ).resolves.toMatchObject({
      due: false,
      reason: 'no_local_submitted_orders',
      effectiveIntervalMs: null,
    });
  });

  it('uses exact nextDueAt boundary semantics', async () => {
    const { coordinator, advance, now } = createHarness({ active: true });
    const first = await coordinator.getDecision('tracked_position_sync');
    coordinator.recordAttempt('tracked_position_sync', now());
    coordinator.recordSuccess(
      'tracked_position_sync',
      now(),
      first.effectiveIntervalMs
    );

    advance((first.effectiveIntervalMs ?? 0) - 1);
    await expect(
      coordinator.getDecision('tracked_position_sync')
    ).resolves.toMatchObject({
      due: false,
      reason: 'adaptive_poll_not_due',
    });

    advance(1);
    await expect(
      coordinator.getDecision('tracked_position_sync')
    ).resolves.toMatchObject({
      due: true,
      reason: 'interval_elapsed',
    });
  });

  it('schedules the next interval from completion time', async () => {
    const { coordinator, advance, now } = createHarness({ active: true });
    const decision = await coordinator.getDecision('submitted_order_sync');
    coordinator.recordAttempt('submitted_order_sync', now());
    advance(700);
    coordinator.recordSuccess(
      'submitted_order_sync',
      now(),
      decision.effectiveIntervalMs
    );

    const snapshot = await coordinator.getSnapshot();

    expect(snapshot.workers.submittedOrderSync.nextDueAt).toBe(
      '2026-06-22T14:00:10.700Z'
    );
  });

  it('uses bounded retry after failed reads and retains forced state', async () => {
    const { coordinator, now } = createHarness({ active: true });

    await coordinator.getDecision('tracked_position_sync');
    coordinator.recordAttempt('tracked_position_sync', now());
    coordinator.recordFailure('tracked_position_sync', now());

    const snapshot = await coordinator.getSnapshot();

    expect(snapshot.workers.trackedPositionSync.nextDueAt).toBe(
      '2026-06-22T14:00:05.000Z'
    );
    expect(snapshot.workers.trackedPositionSync.forced).toBe(true);
  });

  it('coalesces multiple force requests and clears force after success', async () => {
    const { coordinator, now } = createHarness({ active: true });

    coordinator.forceSync(['submitted_order_sync'], 'broker_order_created');
    coordinator.forceSync(['submitted_order_sync'], 'protective_order_created');

    await expect(
      coordinator.getDecision('submitted_order_sync')
    ).resolves.toMatchObject({
      due: true,
      forceReason: 'startup',
    });

    coordinator.recordAttempt('submitted_order_sync', now());
    coordinator.recordSuccess('submitted_order_sync', now(), 10_000);

    const snapshot = await coordinator.getSnapshot();

    expect(snapshot.workers.submittedOrderSync.forced).toBe(false);
    expect(snapshot.workers.submittedOrderSync.forceReason).toBeNull();
  });

  it.each([
    ['open active', true, true, 'market_open_active', 15_000],
    ['open idle', true, false, 'market_open_idle', 60_000],
    ['closed active', false, true, 'market_closed_active', 120_000],
    ['closed idle', false, false, 'market_closed_idle', 300_000],
  ] as const)(
    'selects %s tracked-position cadence',
    async (_label, open, active, mode, intervalMs) => {
      const { coordinator } = createHarness({ open, active });

      await expect(
        coordinator.getDecision('tracked_position_sync')
      ).resolves.toMatchObject({
        mode,
        effectiveIntervalMs: intervalMs,
      });
    }
  );

  it('uses conservative cadence when market state is unknown', async () => {
    const marketProvider = vi.fn(async () => {
      throw new Error('clock unavailable token=abc');
    });
    const { coordinator } = createHarness({
      active: true,
      marketProvider,
    });

    const decision = await coordinator.getDecision('tracked_position_sync');

    expect(decision).toMatchObject({
      marketState: 'unknown',
      marketSessionDegraded: true,
      mode: 'market_unknown',
      effectiveIntervalMs:
        ADAPTIVE_POLLING_INTERVALS_MS.trackedPositionSync.marketUnknownActive,
    });
    expect(decision.marketSessionError).toContain('token=[redacted]');
  });

  it('forces both workers on market transitions and trading-date changes, but not initial snapshot', async () => {
    const marketProvider = vi
      .fn()
      .mockResolvedValueOnce(marketSnapshot({ open: false }))
      .mockResolvedValueOnce(marketSnapshot({ open: true }))
      .mockResolvedValueOnce(
        marketSnapshot({ open: true, tradingDate: '2026-06-23' })
      );
    const { coordinator, advance } = createHarness({
      active: true,
      marketProvider,
    });

    await coordinator.getDecision('tracked_position_sync');
    coordinator.recordSuccess('submitted_order_sync', new Date(), 60_000);
    coordinator.recordSuccess('tracked_position_sync', new Date(), 120_000);

    advance(2_000);
    await expect(
      coordinator.getDecision('submitted_order_sync')
    ).resolves.toMatchObject({
      due: true,
      reason: 'market_transition',
    });

    coordinator.recordSuccess('submitted_order_sync', new Date(), 10_000);
    coordinator.recordSuccess('tracked_position_sync', new Date(), 15_000);

    advance(2_000);
    await expect(
      coordinator.getDecision('tracked_position_sync')
    ).resolves.toMatchObject({
      due: true,
      reason: 'trading_date_changed',
    });
  });

  it('forces catch-up when market-session data recovers', async () => {
    const marketProvider = vi
      .fn()
      .mockRejectedValueOnce(new Error('clock unavailable'))
      .mockResolvedValueOnce(marketSnapshot({ open: true }));
    const { coordinator, advance } = createHarness({
      active: true,
      marketProvider,
    });

    await coordinator.getDecision('tracked_position_sync');
    coordinator.recordSuccess('submitted_order_sync', new Date(), 60_000);
    coordinator.recordSuccess('tracked_position_sync', new Date(), 60_000);

    advance(2_000);
    await expect(
      coordinator.getDecision('submitted_order_sync')
    ).resolves.toMatchObject({
      due: true,
      forceReason: 'market_session_recovered',
    });
  });

  it('deduplicates repeated cached decisions within a scheduler tick', async () => {
    const { coordinator, marketProvider } = createHarness({ active: true });

    await Promise.all([
      coordinator.getDecision('submitted_order_sync'),
      coordinator.getDecision('tracked_position_sync'),
      coordinator.getSnapshot(),
    ]);

    expect(marketProvider).toHaveBeenCalledTimes(1);
  });

  it('does not request market-session data just to build a status snapshot', async () => {
    const { coordinator, marketProvider } = createHarness({ active: false });

    const snapshot = await coordinator.getSnapshot();

    expect(marketProvider).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      marketState: 'unknown',
      mode: 'market_unknown',
    });
  });
});
