import type { Prisma } from '@prisma/client';

import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import {
  getAlpacaMarketSessionSnapshot,
  type NormalizedMarketSessionSnapshot,
} from '../integrations/alpaca/market-session.adapter.js';
import { TRADING_WORKER_INTERVAL_MS } from '../workers/worker-health.definitions.js';

export type AdaptiveWorkerKey =
  | 'submitted_order_sync'
  | 'tracked_position_sync';

export type AdaptiveMarketState = 'open' | 'closed' | 'unknown';

export type AdaptivePollingMode =
  | 'market_open_active'
  | 'market_open_idle'
  | 'market_closed_active'
  | 'market_closed_idle'
  | 'market_unknown';

export type AdaptivePollingDecisionReason =
  | 'startup_due'
  | 'interval_elapsed'
  | 'forced_after_broker_write'
  | 'market_transition'
  | 'trading_date_changed'
  | 'adaptive_poll_not_due'
  | 'no_local_submitted_orders'
  | 'market_state_unknown'
  | 'rate_limit_backoff';

export type AdaptivePollingForceReason =
  | 'startup'
  | 'broker_order_created'
  | 'broker_position_close_requested'
  | 'broker_order_cancel_requested'
  | 'broker_order_cancel_all_requested'
  | 'protective_order_created'
  | 'market_transition'
  | 'trading_date_changed'
  | 'market_session_recovered';

export type AdaptivePollingLocalActivitySnapshot = {
  submittedOrderCount: number;
  submittingOrderCount: number;
  nonterminalBrokerOrderCount: number;
  openPositionCount: number;
  closingPositionCount: number;
  activeExitCount: number;
  activeProtectiveOrderCount: number;
  evaluatedAt: Date;
};

export type AdaptivePollingDecision = {
  workerKey: AdaptiveWorkerKey;
  due: boolean;
  forced: boolean;
  forceReason: AdaptivePollingForceReason | null;
  mode: AdaptivePollingMode;
  marketState: AdaptiveMarketState;
  localActivity: AdaptivePollingLocalActivitySnapshot;
  effectiveIntervalMs: number | null;
  evaluatedAt: Date;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  nextDueAt: Date | null;
  reason: AdaptivePollingDecisionReason;
  marketSessionDegraded: boolean;
  marketSessionError: string | null;
  marketSessionSnapshot: NormalizedMarketSessionSnapshot | null;
};

export type AdaptiveWorkerSnapshot = {
  schedulerIntervalMs: number;
  effectiveIntervalMs: number | null;
  due: boolean;
  forced: boolean;
  forceReason: AdaptivePollingForceReason | null;
  decisionReason: AdaptivePollingDecisionReason;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  localActivity: boolean;
  mode: AdaptivePollingMode;
};

export type AdaptivePollingSnapshot = {
  status: 'normal' | 'degraded';
  evaluatedAt: string;
  marketState: AdaptiveMarketState;
  mode: AdaptivePollingMode;
  marketSession: {
    tradingDate: string | null;
    marketOpen: boolean | null;
    evaluatedAt: string | null;
    fetchedAt: string | null;
    nextOpenAt: string | null;
    nextCloseAt: string | null;
    clockCacheStatus: string | null;
    consecutiveFailures: number;
    lastError: string | null;
    lastErrorAt: string | null;
    recoveredAt: string | null;
  };
  localActivity: Omit<AdaptivePollingLocalActivitySnapshot, 'evaluatedAt'> & {
    evaluatedAt: string;
  };
  workers: {
    submittedOrderSync: AdaptiveWorkerSnapshot;
    trackedPositionSync: AdaptiveWorkerSnapshot;
  };
};

type WorkerRuntimeState = {
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  nextDueAt: Date | null;
  forced: boolean;
  forceReason: AdaptivePollingForceReason | null;
  lastDecision: AdaptivePollingDecision | null;
};

type MarketEvaluation = {
  state: AdaptiveMarketState;
  snapshot: NormalizedMarketSessionSnapshot | null;
  degraded: boolean;
  error: string | null;
  evaluatedAt: Date;
};

export const ADAPTIVE_POLLING_INTERVALS_MS = {
  submittedOrderSync: {
    marketOpenActive: 10_000,
    marketClosedActive: 60_000,
    marketUnknownActive: 10_000,
  },
  trackedPositionSync: {
    marketOpenActive: 15_000,
    marketOpenIdle: 60_000,
    marketClosedActive: 120_000,
    marketClosedIdle: 300_000,
    marketUnknownActive: 15_000,
    marketUnknownIdle: 60_000,
  },
  retry: {
    minimum: 5_000,
    maximum: 15_000,
  },
} as const;

const LOCAL_ACTIVITY_CACHE_TTL_MS = 1_500;
const MARKET_EVALUATION_CACHE_TTL_MS = 1_500;
const SANITIZED_ERROR_MAX_LENGTH = 500;

function createWorkerState(): WorkerRuntimeState {
  return {
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: null,
    forced: true,
    forceReason: 'startup',
    lastDecision: null,
  };
}

function toIso(date: Date | null) {
  return date?.toISOString() ?? null;
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return message
    .replace(/\s+/g, ' ')
    .replace(/(password|token|secret|api[_-]?key)=\S+/gi, '$1=[redacted]')
    .slice(0, SANITIZED_ERROR_MAX_LENGTH);
}

function isNonterminalBrokerOrderStatus(status: string) {
  return ![
    'filled',
    'canceled',
    'expired',
    'rejected',
    'suspended',
  ].includes(status);
}

function modeFor(args: {
  marketState: AdaptiveMarketState;
  active: boolean;
}): AdaptivePollingMode {
  if (args.marketState === 'unknown') {
    return 'market_unknown';
  }

  if (args.marketState === 'open') {
    return args.active ? 'market_open_active' : 'market_open_idle';
  }

  return args.active ? 'market_closed_active' : 'market_closed_idle';
}

function hasTrackedPositionActivity(
  activity: AdaptivePollingLocalActivitySnapshot
) {
  return (
    activity.submittedOrderCount > 0 ||
    activity.submittingOrderCount > 0 ||
    activity.nonterminalBrokerOrderCount > 0 ||
    activity.openPositionCount > 0 ||
    activity.closingPositionCount > 0 ||
    activity.activeExitCount > 0 ||
    activity.activeProtectiveOrderCount > 0
  );
}

function hasSubmittedOrderActivity(
  activity: AdaptivePollingLocalActivitySnapshot
) {
  return activity.submittedOrderCount > 0;
}

function intervalFor(args: {
  workerKey: AdaptiveWorkerKey;
  marketState: AdaptiveMarketState;
  active: boolean;
}) {
  if (args.workerKey === 'submitted_order_sync') {
    if (!args.active) {
      return null;
    }

    if (args.marketState === 'closed') {
      return ADAPTIVE_POLLING_INTERVALS_MS.submittedOrderSync.marketClosedActive;
    }

    return ADAPTIVE_POLLING_INTERVALS_MS.submittedOrderSync.marketOpenActive;
  }

  if (args.marketState === 'unknown') {
    return args.active
      ? ADAPTIVE_POLLING_INTERVALS_MS.trackedPositionSync.marketUnknownActive
      : ADAPTIVE_POLLING_INTERVALS_MS.trackedPositionSync.marketUnknownIdle;
  }

  if (args.marketState === 'open') {
    return args.active
      ? ADAPTIVE_POLLING_INTERVALS_MS.trackedPositionSync.marketOpenActive
      : ADAPTIVE_POLLING_INTERVALS_MS.trackedPositionSync.marketOpenIdle;
  }

  return args.active
    ? ADAPTIVE_POLLING_INTERVALS_MS.trackedPositionSync.marketClosedActive
    : ADAPTIVE_POLLING_INTERVALS_MS.trackedPositionSync.marketClosedIdle;
}

function defaultLocalActivity(now: Date): AdaptivePollingLocalActivitySnapshot {
  return {
    submittedOrderCount: 0,
    submittingOrderCount: 0,
    nonterminalBrokerOrderCount: 0,
    openPositionCount: 0,
    closingPositionCount: 0,
    activeExitCount: 0,
    activeProtectiveOrderCount: 0,
    evaluatedAt: now,
  };
}

async function readLocalActivity(
  now: Date
): Promise<AdaptivePollingLocalActivitySnapshot> {
  const [
    submittedOrderCount,
    submittingOrderCount,
    nonterminalBrokerOrderCount,
    openPositionCount,
    closingPositionCount,
    activeExitCount,
    activeProtectiveOrderCount,
  ] = await Promise.all([
    prisma.orderIntent.count({ where: { status: 'submitted' } }),
    prisma.orderIntent.count({ where: { status: 'submitting' } }),
    prisma.brokerOrder.count({
      where: {
        status: {
          notIn: ['filled', 'canceled', 'expired', 'rejected', 'suspended'],
        },
      },
    }),
    prisma.trackedPosition.count({ where: { status: 'open' } }),
    prisma.trackedPosition.count({ where: { status: 'closing' } }),
    prisma.positionExitState.count({
      where: {
        status: {
          in: [
            'watching',
            'target_unlocked',
            'trailing_stop_submitted',
            'trailing_stop_filled',
          ],
        },
      },
    }),
    prisma.trackedPosition.count({
      where: {
        OR: [
          {
            trailingStopOrderId: {
              not: null,
            },
            trailingStopStatus: {
              notIn: ['filled', 'canceled', 'expired', 'rejected', 'suspended'],
            },
          },
          {
            trailingStopStatus: 'pending_submit',
          },
        ],
      },
    }),
  ]);

  return {
    submittedOrderCount,
    submittingOrderCount,
    nonterminalBrokerOrderCount,
    openPositionCount,
    closingPositionCount,
    activeExitCount,
    activeProtectiveOrderCount,
    evaluatedAt: now,
  };
}

export class AdaptivePollingCoordinator {
  private readonly now: () => Date;
  private readonly marketSessionProvider: (
    now: Date
  ) => Promise<NormalizedMarketSessionSnapshot>;
  private readonly localActivityProvider: (
    now: Date
  ) => Promise<AdaptivePollingLocalActivitySnapshot>;
  private readonly states: Record<AdaptiveWorkerKey, WorkerRuntimeState> = {
    submitted_order_sync: createWorkerState(),
    tracked_position_sync: createWorkerState(),
  };
  private localActivityCache: {
    capturedAtMs: number;
    promise: Promise<AdaptivePollingLocalActivitySnapshot>;
  } | null = null;
  private marketEvaluationCache: {
    capturedAtMs: number;
    promise: Promise<MarketEvaluation>;
  } | null = null;
  private lastSuccessfulMarketState: AdaptiveMarketState | null = null;
  private lastSuccessfulTradingDate: string | null = null;
  private hadMarketSessionFailure = false;
  private consecutiveMarketSessionFailures = 0;
  private lastMarketSessionError: string | null = null;
  private lastMarketSessionErrorAt: Date | null = null;
  private recoveredAt: Date | null = null;
  private latestMarketSessionSnapshot: NormalizedMarketSessionSnapshot | null =
    null;
  private latestEvaluation: MarketEvaluation | null = null;

  constructor(args: {
    now?: () => Date;
    marketSessionProvider?: (
      now: Date
    ) => Promise<NormalizedMarketSessionSnapshot>;
    localActivityProvider?: (
      now: Date
    ) => Promise<AdaptivePollingLocalActivitySnapshot>;
  } = {}) {
    this.now = args.now ?? (() => new Date());
    this.marketSessionProvider =
      args.marketSessionProvider ?? getAlpacaMarketSessionSnapshot;
    this.localActivityProvider = args.localActivityProvider ?? readLocalActivity;
  }

  reset() {
    this.states.submitted_order_sync = createWorkerState();
    this.states.tracked_position_sync = createWorkerState();
    this.localActivityCache = null;
    this.marketEvaluationCache = null;
    this.lastSuccessfulMarketState = null;
    this.lastSuccessfulTradingDate = null;
    this.hadMarketSessionFailure = false;
    this.consecutiveMarketSessionFailures = 0;
    this.lastMarketSessionError = null;
    this.lastMarketSessionErrorAt = null;
    this.recoveredAt = null;
    this.latestMarketSessionSnapshot = null;
    this.latestEvaluation = null;
  }

  forceSync(
    workers: AdaptiveWorkerKey[],
    reason: AdaptivePollingForceReason
  ) {
    for (const workerKey of workers) {
      const state = this.states[workerKey];
      state.forced = true;
      state.forceReason = state.forceReason ?? reason;
      state.nextDueAt = this.now();
    }
  }

  forceAfterBrokerOrderCreated(reason: AdaptivePollingForceReason) {
    this.forceSync(['submitted_order_sync', 'tracked_position_sync'], reason);
  }

  forceAfterBrokerPositionWrite(reason: AdaptivePollingForceReason) {
    this.forceSync(['submitted_order_sync', 'tracked_position_sync'], reason);
  }

  forceAfterBrokerOrderCancellation(reason: AdaptivePollingForceReason) {
    this.forceSync(['submitted_order_sync'], reason);
  }

  async getDecision(
    workerKey: AdaptiveWorkerKey
  ): Promise<AdaptivePollingDecision> {
    const now = this.now();
    const [localActivity, market] = await Promise.all([
      this.getLocalActivity(now),
      this.evaluateMarket(now),
    ]);

    const active =
      workerKey === 'submitted_order_sync'
        ? hasSubmittedOrderActivity(localActivity)
        : hasTrackedPositionActivity(localActivity);
    const mode = modeFor({ marketState: market.state, active });
    const effectiveIntervalMs = intervalFor({
      workerKey,
      marketState: market.state,
      active,
    });
    const state = this.states[workerKey];
    const evaluatedAt = now;
    let due = false;
    let reason: AdaptivePollingDecisionReason = 'adaptive_poll_not_due';

    if (workerKey === 'submitted_order_sync' && !active) {
      due = false;
      reason = 'no_local_submitted_orders';
    } else if (state.forced) {
      due = true;
      reason =
        state.forceReason === 'market_transition'
          ? 'market_transition'
          : state.forceReason === 'trading_date_changed'
            ? 'trading_date_changed'
            : state.forceReason === 'startup'
              ? 'startup_due'
              : 'forced_after_broker_write';
    } else if (market.state === 'unknown' && state.lastAttemptAt === null) {
      due = true;
      reason = 'market_state_unknown';
    } else if (!state.nextDueAt) {
      due = true;
      reason = 'startup_due';
    } else if (now.getTime() >= state.nextDueAt.getTime()) {
      due = true;
      reason = 'interval_elapsed';
    }

    const decision: AdaptivePollingDecision = {
      workerKey,
      due,
      forced: state.forced,
      forceReason: state.forceReason,
      mode,
      marketState: market.state,
      localActivity,
      effectiveIntervalMs,
      evaluatedAt,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      nextDueAt: state.nextDueAt,
      reason,
      marketSessionDegraded: market.degraded,
      marketSessionError: market.error,
      marketSessionSnapshot: market.snapshot,
    };

    state.lastDecision = decision;
    return decision;
  }

  recordAttempt(workerKey: AdaptiveWorkerKey, attemptedAt = this.now()) {
    const state = this.states[workerKey];
    state.lastAttemptAt = attemptedAt;
  }

  recordSuccess(
    workerKey: AdaptiveWorkerKey,
    completedAt = this.now(),
    nextIntervalMs?: number | null
  ) {
    const state = this.states[workerKey];
    state.lastSuccessAt = completedAt;
    state.forced = false;
    state.forceReason = null;

    const interval =
      nextIntervalMs ??
      state.lastDecision?.effectiveIntervalMs ??
      (workerKey === 'submitted_order_sync'
        ? ADAPTIVE_POLLING_INTERVALS_MS.submittedOrderSync.marketOpenActive
        : ADAPTIVE_POLLING_INTERVALS_MS.trackedPositionSync.marketOpenIdle);

    state.nextDueAt =
      interval === null ? null : new Date(completedAt.getTime() + interval);
  }

  recordFailure(workerKey: AdaptiveWorkerKey, failedAt = this.now()) {
    const state = this.states[workerKey];
    const lastAttemptMs = state.lastAttemptAt?.getTime() ?? failedAt.getTime();
    const elapsedSinceAttempt = Math.max(0, failedAt.getTime() - lastAttemptMs);
    const retryDelayMs = Math.min(
      ADAPTIVE_POLLING_INTERVALS_MS.retry.maximum,
      Math.max(ADAPTIVE_POLLING_INTERVALS_MS.retry.minimum, elapsedSinceAttempt)
    );

    state.nextDueAt = new Date(failedAt.getTime() + retryDelayMs);
  }

  recordRateLimitDeferred(
    workerKey: AdaptiveWorkerKey,
    backoffUntil: Date | null,
    deferredAt = this.now()
  ) {
    const state = this.states[workerKey];
    state.nextDueAt =
      backoffUntil && backoffUntil.getTime() > deferredAt.getTime()
        ? backoffUntil
        : new Date(
            deferredAt.getTime() + ADAPTIVE_POLLING_INTERVALS_MS.retry.minimum
          );
    state.lastDecision =
      state.lastDecision === null
        ? null
        : {
            ...state.lastDecision,
            due: false,
            reason: 'rate_limit_backoff',
            nextDueAt: state.nextDueAt,
          };
  }

  async getSnapshot(): Promise<AdaptivePollingSnapshot> {
    const now = this.now();
    const [activity, market] = await Promise.all([
      this.getLocalActivity(now),
      this.evaluateMarket(now),
    ]);
    const active = hasTrackedPositionActivity(activity);
    const mode = modeFor({ marketState: market.state, active });

    return {
      status: market.degraded ? 'degraded' : 'normal',
      evaluatedAt: now.toISOString(),
      marketState: market.state,
      mode,
      marketSession: {
        tradingDate: market.snapshot?.tradingDate ?? null,
        marketOpen: market.snapshot?.marketOpen ?? null,
        evaluatedAt: market.snapshot?.evaluatedTimestamp ?? null,
        fetchedAt: market.snapshot?.fetchedAt ?? null,
        nextOpenAt: market.snapshot?.nextOpenAt ?? null,
        nextCloseAt: market.snapshot?.nextCloseAt ?? null,
        clockCacheStatus: market.snapshot?.cache.clock ?? null,
        consecutiveFailures: this.consecutiveMarketSessionFailures,
        lastError: this.lastMarketSessionError,
        lastErrorAt: toIso(this.lastMarketSessionErrorAt),
        recoveredAt: toIso(this.recoveredAt),
      },
      localActivity: {
        submittedOrderCount: activity.submittedOrderCount,
        submittingOrderCount: activity.submittingOrderCount,
        nonterminalBrokerOrderCount: activity.nonterminalBrokerOrderCount,
        openPositionCount: activity.openPositionCount,
        closingPositionCount: activity.closingPositionCount,
        activeExitCount: activity.activeExitCount,
        activeProtectiveOrderCount: activity.activeProtectiveOrderCount,
        evaluatedAt: activity.evaluatedAt.toISOString(),
      },
      workers: {
        submittedOrderSync: this.toWorkerSnapshot(
          'submitted_order_sync',
          activity
        ),
        trackedPositionSync: this.toWorkerSnapshot(
          'tracked_position_sync',
          activity
        ),
      },
    };
  }

  private toWorkerSnapshot(
    workerKey: AdaptiveWorkerKey,
    activity: AdaptivePollingLocalActivitySnapshot
  ): AdaptiveWorkerSnapshot {
    const state = this.states[workerKey];
    const decision = state.lastDecision;
    const localActivity =
      workerKey === 'submitted_order_sync'
        ? hasSubmittedOrderActivity(activity)
        : hasTrackedPositionActivity(activity);

    return {
      schedulerIntervalMs: TRADING_WORKER_INTERVAL_MS,
      effectiveIntervalMs:
        decision?.effectiveIntervalMs ??
        intervalFor({
          workerKey,
          marketState: this.latestEvaluation?.state ?? 'unknown',
          active: localActivity,
        }),
      due: decision?.due ?? state.forced,
      forced: state.forced,
      forceReason: state.forceReason,
      decisionReason: decision?.reason ?? 'startup_due',
      lastAttemptAt: toIso(state.lastAttemptAt),
      lastSuccessAt: toIso(state.lastSuccessAt),
      nextDueAt: toIso(state.nextDueAt),
      localActivity,
      mode:
        decision?.mode ??
        modeFor({
          marketState: this.latestEvaluation?.state ?? 'unknown',
          active: localActivity,
        }),
    };
  }

  private async getLocalActivity(now: Date) {
    const nowMs = now.getTime();

    if (
      this.localActivityCache &&
      nowMs - this.localActivityCache.capturedAtMs <=
        LOCAL_ACTIVITY_CACHE_TTL_MS
    ) {
      return this.localActivityCache.promise;
    }

    const promise = this.localActivityProvider(now).catch((error) => {
      logger.warn({ error }, 'Adaptive polling local activity lookup failed.');
      return defaultLocalActivity(now);
    });
    this.localActivityCache = {
      capturedAtMs: nowMs,
      promise,
    };

    return promise;
  }

  private async evaluateMarket(now: Date): Promise<MarketEvaluation> {
    const nowMs = now.getTime();

    if (
      this.marketEvaluationCache &&
      nowMs - this.marketEvaluationCache.capturedAtMs <=
        MARKET_EVALUATION_CACHE_TTL_MS
    ) {
      return this.marketEvaluationCache.promise;
    }

    const promise = this.marketSessionProvider(now)
      .then((snapshot) => {
        const marketState: AdaptiveMarketState = snapshot.marketOpen
          ? 'open'
          : 'closed';
        const previousState = this.lastSuccessfulMarketState;
        const previousTradingDate = this.lastSuccessfulTradingDate;
        const recovered = this.hadMarketSessionFailure;

        this.latestMarketSessionSnapshot = snapshot;
        this.lastSuccessfulMarketState = marketState;
        this.lastSuccessfulTradingDate = snapshot.tradingDate;
        this.hadMarketSessionFailure = false;
        this.consecutiveMarketSessionFailures = 0;
        this.lastMarketSessionError = null;
        this.lastMarketSessionErrorAt = null;

        if (recovered) {
          this.recoveredAt = now;
          this.forceSync(
            ['submitted_order_sync', 'tracked_position_sync'],
            'market_session_recovered'
          );
        } else if (
          previousState !== null &&
          previousState !== marketState
        ) {
          this.forceSync(
            ['submitted_order_sync', 'tracked_position_sync'],
            'market_transition'
          );
        } else if (
          previousTradingDate !== null &&
          previousTradingDate !== snapshot.tradingDate
        ) {
          this.forceSync(
            ['submitted_order_sync', 'tracked_position_sync'],
            'trading_date_changed'
          );
        }

        const evaluation: MarketEvaluation = {
          state: marketState,
          snapshot,
          degraded: false,
          error: null,
          evaluatedAt: now,
        };
        this.latestEvaluation = evaluation;
        return evaluation;
      })
      .catch((error) => {
        const sanitized = sanitizeError(error);
        this.hadMarketSessionFailure = true;
        this.consecutiveMarketSessionFailures += 1;
        this.lastMarketSessionError = sanitized;
        this.lastMarketSessionErrorAt = now;
        logger.warn(
          { error: sanitized },
          'Adaptive polling market-session lookup failed.'
        );

        const evaluation: MarketEvaluation = {
          state: 'unknown',
          snapshot: null,
          degraded: true,
          error: sanitized,
          evaluatedAt: now,
        };
        this.latestEvaluation = evaluation;
        return evaluation;
      });

    this.marketEvaluationCache = {
      capturedAtMs: nowMs,
      promise,
    };

    return promise;
  }
}

export const adaptivePollingCoordinator = new AdaptivePollingCoordinator();

export function isNonterminalBrokerOrder(status: string) {
  return isNonterminalBrokerOrderStatus(status);
}

export function adaptivePollingLocalActivityFromCounts(
  counts: Omit<AdaptivePollingLocalActivitySnapshot, 'evaluatedAt'>,
  evaluatedAt: Date
): AdaptivePollingLocalActivitySnapshot {
  return {
    ...counts,
    evaluatedAt,
  };
}

export function adaptivePollingSnapshotAsJson(
  snapshot: AdaptivePollingSnapshot
): Prisma.InputJsonValue {
  return snapshot as unknown as Prisma.InputJsonValue;
}
