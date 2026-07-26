import type { Prisma } from '@prisma/client';

import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import {
  getAlpacaMarketSessionSnapshot,
  type NormalizedMarketSessionSnapshot,
} from '../integrations/alpaca/market-session.adapter.js';
import { TRADING_WORKER_INTERVAL_MS } from '../workers/worker-health.definitions.js';
import {
  isNonterminalBrokerOrderStatus,
  NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
} from './broker-order-lifecycle-status.service.js';

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

type AccountMarketRuntimeState = {
  lastSuccessfulMarketState: AdaptiveMarketState | null;
  lastSuccessfulTradingDate: string | null;
  hadMarketSessionFailure: boolean;
  consecutiveMarketSessionFailures: number;
  lastMarketSessionError: string | null;
  lastMarketSessionErrorAt: Date | null;
  recoveredAt: Date | null;
  latestMarketSessionSnapshot: NormalizedMarketSessionSnapshot | null;
  latestEvaluation: MarketEvaluation | null;
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
  tradingAccountId: number,
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
    prisma.orderIntent.count({ where: { status: 'submitted', tradingAccountId } }),
    prisma.orderIntent.count({ where: { status: 'submitting', tradingAccountId } }),
    prisma.brokerOrder.count({
      where: {
        tradingAccountId,
        status: NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
      },
    }),
    prisma.trackedPosition.count({ where: { status: 'open', tradingAccountId } }),
    prisma.trackedPosition.count({ where: { status: 'closing', tradingAccountId } }),
    prisma.positionExitState.count({
      where: {
        trackedPosition: {
          tradingAccountId,
        },
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
        tradingAccountId,
        OR: [
          {
            trailingStopOrderId: {
              not: null,
            },
            trailingStopStatus: {
              ...NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
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
    tradingAccountId: number,
    now: Date
  ) => Promise<NormalizedMarketSessionSnapshot>;
  private readonly localActivityProvider: (
    tradingAccountId: number,
    now: Date
  ) => Promise<AdaptivePollingLocalActivitySnapshot>;
  private readonly states = new Map<string, WorkerRuntimeState>();
  private readonly marketStates = new Map<number, AccountMarketRuntimeState>();
  private readonly localActivityCache = new Map<number, {
    capturedAtMs: number;
    promise: Promise<AdaptivePollingLocalActivitySnapshot>;
  }>();
  private readonly marketEvaluationCache = new Map<number, {
    capturedAtMs: number;
    promise: Promise<MarketEvaluation>;
  }>();

  constructor(args: {
    now?: () => Date;
    marketSessionProvider?: (
      tradingAccountId: number,
      now: Date
    ) => Promise<NormalizedMarketSessionSnapshot>;
    localActivityProvider?: (
      tradingAccountId: number,
      now: Date
    ) => Promise<AdaptivePollingLocalActivitySnapshot>;
  } = {}) {
    this.now = args.now ?? (() => new Date());
    this.marketSessionProvider =
      args.marketSessionProvider ?? getAlpacaMarketSessionSnapshot;
    this.localActivityProvider = args.localActivityProvider ?? readLocalActivity;
  }

  reset() {
    this.states.clear();
    this.marketStates.clear();
    this.localActivityCache.clear();
    this.marketEvaluationCache.clear();
  }

  forceSync(
    workers: AdaptiveWorkerKey[],
    reason: AdaptivePollingForceReason,
    tradingAccountId: number
  ) {
    for (const workerKey of workers) {
      const state = this.stateFor(tradingAccountId, workerKey);
      state.forced = true;
      state.forceReason =
        state.forceReason === null || state.forceReason === 'startup'
          ? reason
          : state.forceReason;
      state.nextDueAt = this.now();
    }
  }

  forceAfterBrokerOrderCreated(
    tradingAccountId: number,
    reason: AdaptivePollingForceReason
  ) {
    this.forceSync(
      ['submitted_order_sync', 'tracked_position_sync'],
      reason,
      tradingAccountId
    );
  }

  forceAfterBrokerPositionWrite(
    tradingAccountId: number,
    reason: AdaptivePollingForceReason
  ) {
    this.forceSync(
      ['submitted_order_sync', 'tracked_position_sync'],
      reason,
      tradingAccountId
    );
  }

  forceAfterBrokerOrderCancellation(
    tradingAccountId: number,
    reason: AdaptivePollingForceReason
  ) {
    this.forceSync(['submitted_order_sync'], reason, tradingAccountId);
  }

  async getDecision(
    tradingAccountId: number,
    workerKey: AdaptiveWorkerKey
  ): Promise<AdaptivePollingDecision> {
    const now = this.now();
    const [localActivity, market] = await Promise.all([
      this.getLocalActivity(tradingAccountId, now),
      this.evaluateMarket(tradingAccountId, now),
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
    const state = this.stateFor(tradingAccountId, workerKey);
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

  recordAttempt(
    workerKey: AdaptiveWorkerKey,
    tradingAccountId: number,
    attemptedAt = this.now()
  ) {
    const state = this.stateFor(tradingAccountId, workerKey);
    state.lastAttemptAt = attemptedAt;
  }

  recordSuccess(
    workerKey: AdaptiveWorkerKey,
    tradingAccountId: number,
    completedAt = this.now(),
    nextIntervalMs?: number | null
  ) {
    const state = this.stateFor(tradingAccountId, workerKey);
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

  recordFailure(
    workerKey: AdaptiveWorkerKey,
    tradingAccountId: number,
    failedAt = this.now()
  ) {
    const state = this.stateFor(tradingAccountId, workerKey);
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
    tradingAccountId: number,
    backoffUntil: Date | null,
    deferredAt = this.now()
  ) {
    const state = this.stateFor(tradingAccountId, workerKey);
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

  async getSnapshot(tradingAccountId: number): Promise<AdaptivePollingSnapshot> {
    const now = this.now();
    const activity = await this.getLocalActivity(tradingAccountId, now);
    const accountMarket = this.marketStateFor(tradingAccountId);
    const market =
      accountMarket.latestEvaluation ??
      ({
        state: 'unknown',
        snapshot: accountMarket.latestMarketSessionSnapshot,
        degraded: accountMarket.hadMarketSessionFailure,
        error: accountMarket.lastMarketSessionError,
        evaluatedAt: now,
      } satisfies MarketEvaluation);
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
        consecutiveFailures: accountMarket.consecutiveMarketSessionFailures,
        lastError: accountMarket.lastMarketSessionError,
        lastErrorAt: toIso(accountMarket.lastMarketSessionErrorAt),
        recoveredAt: toIso(accountMarket.recoveredAt),
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
          activity,
          tradingAccountId,
          market.state
        ),
        trackedPositionSync: this.toWorkerSnapshot(
          'tracked_position_sync',
          activity,
          tradingAccountId,
          market.state
        ),
      },
    };
  }

  private toWorkerSnapshot(
    workerKey: AdaptiveWorkerKey,
    activity: AdaptivePollingLocalActivitySnapshot,
    tradingAccountId: number,
    marketState: AdaptiveMarketState
  ): AdaptiveWorkerSnapshot {
    const state = this.stateFor(tradingAccountId, workerKey);
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
          marketState,
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
          marketState,
          active: localActivity,
        }),
    };
  }

  private async getLocalActivity(tradingAccountId: number, now: Date) {
    const nowMs = now.getTime();

    if (
      this.localActivityCache.get(tradingAccountId) &&
      nowMs - this.localActivityCache.get(tradingAccountId)!.capturedAtMs <=
        LOCAL_ACTIVITY_CACHE_TTL_MS
    ) {
      return this.localActivityCache.get(tradingAccountId)!.promise;
    }

    const promise = this.localActivityProvider(tradingAccountId, now).catch((error) => {
      logger.warn({ error }, 'Adaptive polling local activity lookup failed.');
      return defaultLocalActivity(now);
    });
    this.localActivityCache.set(tradingAccountId, {
      capturedAtMs: nowMs,
      promise,
    });

    return promise;
  }

  private async evaluateMarket(
    tradingAccountId: number,
    now: Date
  ): Promise<MarketEvaluation> {
    const nowMs = now.getTime();

    if (
      this.marketEvaluationCache.get(tradingAccountId) &&
      nowMs - this.marketEvaluationCache.get(tradingAccountId)!.capturedAtMs <=
        MARKET_EVALUATION_CACHE_TTL_MS
    ) {
      return this.marketEvaluationCache.get(tradingAccountId)!.promise;
    }

    const promise = this.marketSessionProvider(tradingAccountId, now)
      .then((snapshot) => {
        const accountMarket = this.marketStateFor(tradingAccountId);
        const marketState: AdaptiveMarketState = snapshot.marketOpen
          ? 'open'
          : 'closed';
        const previousState = accountMarket.lastSuccessfulMarketState;
        const previousTradingDate = accountMarket.lastSuccessfulTradingDate;
        const recovered = accountMarket.hadMarketSessionFailure;

        accountMarket.latestMarketSessionSnapshot = snapshot;
        accountMarket.lastSuccessfulMarketState = marketState;
        accountMarket.lastSuccessfulTradingDate = snapshot.tradingDate;
        accountMarket.hadMarketSessionFailure = false;
        accountMarket.consecutiveMarketSessionFailures = 0;
        accountMarket.lastMarketSessionError = null;
        accountMarket.lastMarketSessionErrorAt = null;

        if (recovered) {
          accountMarket.recoveredAt = now;
          this.forceSync(
            ['submitted_order_sync', 'tracked_position_sync'],
            'market_session_recovered',
            tradingAccountId
          );
        } else if (
          previousState !== null &&
          previousState !== marketState
        ) {
          this.forceSync(
            ['submitted_order_sync', 'tracked_position_sync'],
            'market_transition',
            tradingAccountId
          );
        } else if (
          previousTradingDate !== null &&
          previousTradingDate !== snapshot.tradingDate
        ) {
          this.forceSync(
            ['submitted_order_sync', 'tracked_position_sync'],
            'trading_date_changed',
            tradingAccountId
          );
        }

        const evaluation: MarketEvaluation = {
          state: marketState,
          snapshot,
          degraded: false,
          error: null,
          evaluatedAt: now,
        };
        accountMarket.latestEvaluation = evaluation;
        return evaluation;
      })
      .catch((error) => {
        const accountMarket = this.marketStateFor(tradingAccountId);
        const sanitized = sanitizeError(error);
        accountMarket.hadMarketSessionFailure = true;
        accountMarket.consecutiveMarketSessionFailures += 1;
        accountMarket.lastMarketSessionError = sanitized;
        accountMarket.lastMarketSessionErrorAt = now;
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
        accountMarket.latestEvaluation = evaluation;
        return evaluation;
      });

    this.marketEvaluationCache.set(tradingAccountId, {
      capturedAtMs: nowMs,
      promise,
    });

    return promise;
  }

  private stateFor(
    tradingAccountId: number,
    workerKey: AdaptiveWorkerKey
  ): WorkerRuntimeState {
    const key = `${tradingAccountId}:${workerKey}`;
    const existing = this.states.get(key);
    if (existing) return existing;
    const created = createWorkerState();
    this.states.set(key, created);
    return created;
  }

  private marketStateFor(tradingAccountId: number) {
    const existing = this.marketStates.get(tradingAccountId);
    if (existing) return existing;
    const created = createAccountMarketState();
    this.marketStates.set(tradingAccountId, created);
    return created;
  }
}

function createAccountMarketState(): AccountMarketRuntimeState {
  return {
    lastSuccessfulMarketState: null,
    lastSuccessfulTradingDate: null,
    hadMarketSessionFailure: false,
    consecutiveMarketSessionFailures: 0,
    lastMarketSessionError: null,
    lastMarketSessionErrorAt: null,
    recoveredAt: null,
    latestMarketSessionSnapshot: null,
    latestEvaluation: null,
  };
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
