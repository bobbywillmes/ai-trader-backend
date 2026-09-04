import { SystemEventSeverity, type Prisma } from "@prisma/client";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";

import { prisma } from "../db/prisma.js";
import { AlpacaRateLimitDeferredError } from "../errors/alpaca-rate-limit-deferred-error.js";
import { getNormalizedPositions } from "./positions.service.js";
import { createSystemEvent } from "./system-event.service.js";
import { recordAccountSnapshot } from "./account-snapshot.service.js";
import {
  attributeCloseFillsForTrackedPosition,
  syncBrokerActivitiesForAccountUnlocked,
} from "./broker-activity.service.js";
import {
  ensurePositionExitState,
  markPositionExitStateClosed,
  resetPositionExitStateForOpenPosition,
} from "./position-exit-state.service.js";
import { captureTrackedPositionConfigSnapshot } from "./trade-cycle-config-snapshot.service.js";
import {
  linkLocalEntryOwnership,
  resolveTrackedPositionSubscription,
  type SubscriptionResolutionResult,
} from "./tracked-position-subscription-resolution.service.js";
import {
  adaptivePollingCoordinator,
  type AdaptivePollingDecision,
} from "./adaptive-polling.service.js";
import {
  resolveDefaultTradingAccountId,
  TRADING_ACCOUNT_SUMMARY_SELECT,
} from "./trading-account.service.js";
import { runTradingAccountWorkflow } from "./trading-account-workflow-runner.service.js";
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES, withTradingAccountWorkflowLock } from "./trading-account-workflow-lock.service.js";
import { HttpError } from "../errors/http-error.js";
import { enumerateLifecycleAccounts } from "./lifecycle-account-eligibility.service.js";
import { observeUnexpectedShortExposure } from "./unexpected-short-exposure.service.js";
import { reconcileRemainingExposureCloseAfterPositionClosure } from "./remaining-exposure-close.service.js";

export type TrackedPositionSyncResult = {
  polled: boolean;
  skipped: boolean;
  skipReason: "adaptive_poll_not_due" | "rate_limited" | null;
  deferred: boolean;
  backoffUntil?: string | null;
  seen: number;
  created: number;
  updated: number;
  closed: number;
  symbolErrors: Array<{ symbol: string; error: string }>;
  mode?: AdaptivePollingDecision["mode"];
  effectiveIntervalMs?: number | null;
  nextDueAt?: string | null;
};

export function positionAttributionSeverity(args: {
  environment: "PAPER" | "LIVE";
  resolved: boolean;
  expectedCanonical: boolean;
  authoritativeProductionExecutor?: boolean;
}) {
  if (args.resolved && args.expectedCanonical) return SystemEventSeverity.INFO;
  if (args.environment === "PAPER") return SystemEventSeverity.ERROR;
  const authoritative =
    args.authoritativeProductionExecutor ??
    (env.NODE_ENV === "production" &&
      env.LIVE_WRITE_DEPLOYMENT_ROLE === "PRODUCTION_EXECUTOR");
  return authoritative
    ? SystemEventSeverity.CRITICAL
    : SystemEventSeverity.WARNING;
}

function getCloseFillSide(positionSide: string): "buy" | "sell" {
  return positionSide.toLowerCase() === "short" ? "buy" : "sell";
}

function summarizeCloseFills(
  fills: Array<{
    id: number;
    qty: number | null;
    price: number | null;
    orderId: string | null;
    transactionTime: Date | null;
  }>,
) {
  const closeQty = fills.reduce(
    (total, fill) => total + Math.abs(fill.qty ?? 0),
    0,
  );
  const notional = fills.reduce(
    (total, fill) => total + Math.abs(fill.qty ?? 0) * (fill.price ?? 0),
    0,
  );
  const closePrice = closeQty > 0 ? notional / closeQty : null;
  const orderedTimes = fills
    .map((fill) => fill.transactionTime)
    .filter((time): time is Date => time !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    closeQty: closeQty > 0 ? closeQty : null,
    closePrice,
    firstCloseFillTime: orderedTimes[0]?.toISOString() ?? null,
    lastCloseFillTime: orderedTimes.at(-1)?.toISOString() ?? null,
    brokerActivityIds: fills.map((fill) => fill.id),
    closeOrderIds: Array.from(
      new Set(fills.map((fill) => fill.orderId).filter(Boolean)),
    ),
  };
}

const ACTIVE_POSITION_STATUSES = ["open", "closing"] as const;

async function findActiveTrackedPosition(args: {
  broker: string;
  symbol: string;
  tradingAccountId: number;
}) {
  return prisma.trackedPosition.findFirst({
    where: {
      broker: args.broker,
      symbol: args.symbol,
      tradingAccountId: args.tradingAccountId,
      status: {
        in: [...ACTIVE_POSITION_STATUSES],
      },
    },
    orderBy: {
      openedAt: "desc",
    },
  });
}

async function hasRecentSubscriptionResolutionEvent(args: {
  trackedPositionId: number;
  tradingAccountId: number;
  type: string;
}) {
  const since = new Date(Date.now() - 60 * 60_000);

  const existing = await prisma.systemEvent.findFirst({
    where: {
      type: args.type,
      entityType: "trackedPosition",
      entityId: String(args.trackedPositionId),
      tradingAccountId: args.tradingAccountId,
      createdAt: {
        gte: since,
      },
    },
  });

  return Boolean(existing);
}

async function createSubscriptionResolutionEvent(args: {
  trackedPositionId: number;
  tradingAccountId: number;
  symbol: string;
  result: SubscriptionResolutionResult;
  environment: "PAPER" | "LIVE";
}) {
  const eventType =
    args.result.status === "resolved"
      ? "position.subscription_resolved"
      : args.result.status === "ambiguous"
        ? "position.subscription_resolution_ambiguous"
        : "position.subscription_resolution_unresolved";

  if (
    args.result.status !== "resolved" &&
    (await hasRecentSubscriptionResolutionEvent({
      trackedPositionId: args.trackedPositionId,
      tradingAccountId: args.tradingAccountId,
      type: eventType,
    }))
  ) {
    return;
  }

  await createSystemEvent({
    type: eventType,
    entityType: "trackedPosition",
    entityId: args.trackedPositionId,
    tradingAccountId: args.tradingAccountId,
    severity: positionAttributionSeverity({
      environment: args.environment,
      resolved: args.result.status === "resolved",
      expectedCanonical:
        args.result.status === "resolved" &&
        args.result.source !== "unique_observer_fallback",
    }),
    message:
      args.result.status === "resolved"
        ? `${args.symbol} subscription resolved via ${args.result.source}.`
        : `${args.symbol} subscription resolution ${args.result.status}: ${args.result.reason}.`,
    payloadJson: {
      symbol: args.symbol,
      trackedPositionId: args.trackedPositionId,
      status: args.result.status,
      source: args.result.source,
      subscriptionId: args.result.subscriptionId,
      subscriptionKey: args.result.subscriptionKey,
      tradingAccountSubscriptionId: args.result.tradingAccountSubscriptionId,
      reason: args.result.reason,
      evidence: args.result.evidence,
      environment: args.environment,
      deploymentRole: env.LIVE_WRITE_DEPLOYMENT_ROLE,
      authoritativeProductionExecutor:
        env.NODE_ENV === "production" &&
        env.LIVE_WRITE_DEPLOYMENT_ROLE === "PRODUCTION_EXECUTOR",
    } as Prisma.InputJsonValue,
  });
}

async function applySubscriptionResolution(args: {
  trackedPositionId: number;
  tradingAccountId: number;
  broker: string;
  symbol: string;
  side: string;
  openedAt: Date;
  currentSubscriptionId: number | null;
  configSnapshotJson: Prisma.JsonValue | null;
  initialObservation: boolean;
  qty: number;
  avgEntryPrice: number;
  environment: "PAPER" | "LIVE";
}) {
  if (args.currentSubscriptionId !== null) {
    await linkLocalEntryOwnership({
      trackedPositionId: args.trackedPositionId,
      tradingAccountId: args.tradingAccountId,
      broker: args.broker,
      symbol: args.symbol,
      side: args.side,
      openedAt: args.openedAt,
      expectedSubscriptionId: args.currentSubscriptionId,
    });
    if (args.configSnapshotJson === null) {
      await captureTrackedPositionConfigSnapshot({
        trackedPositionId: args.trackedPositionId,
        source: "position_opened",
        subscriptionResolutionSource: "local_order_intent",
      });
    }

    return null;
  }

  const resolution = await resolveTrackedPositionSubscription({
    tradingAccountId: args.tradingAccountId,
    broker: args.broker,
    symbol: args.symbol,
    side: args.side,
    openedAt: args.openedAt,
    qty: args.qty,
    avgEntryPrice: args.avgEntryPrice,
    brokerLookupPolicy: args.initialObservation
      ? "ALLOW_EXACT_ORDER_ID_READ"
      : "LOCAL_ONLY",
  });

  if (resolution.status !== "resolved") {
    await createSubscriptionResolutionEvent({
      trackedPositionId: args.trackedPositionId,
      tradingAccountId: args.tradingAccountId,
      symbol: args.symbol,
      result: resolution,
      environment: args.environment,
    });

    return resolution;
  }

  if (resolution.source === "local_order_intent") {
    await linkLocalEntryOwnership({
      trackedPositionId: args.trackedPositionId,
      tradingAccountId: args.tradingAccountId,
      broker: args.broker,
      symbol: args.symbol,
      side: args.side,
      openedAt: args.openedAt,
      expectedSubscriptionId: resolution.subscriptionId,
      expectedTradingAccountSubscriptionId:
        resolution.tradingAccountSubscriptionId,
    });
  } else {
    await prisma.trackedPosition.update({
      where: { id: args.trackedPositionId },
      data: {
        subscriptionId: resolution.subscriptionId,
        tradingAccountSubscriptionId: resolution.tradingAccountSubscriptionId,
      },
    });
  }

  await captureTrackedPositionConfigSnapshot({
    trackedPositionId: args.trackedPositionId,
    source:
      resolution.source === "local_order_intent"
        ? "position_opened"
        : "subscription_recovered",
    subscriptionResolutionSource: resolution.source,
  });

  await createSubscriptionResolutionEvent({
    trackedPositionId: args.trackedPositionId,
    tradingAccountId: args.tradingAccountId,
    symbol: args.symbol,
    result: resolution,
    environment: args.environment,
  });

  return resolution;
}

/** Internal operation: caller must hold the account lifecycle-mutation barrier. */
export async function syncTrackedPositionsForAccountUnlocked(
  tradingAccountId: number,
  environment: "PAPER" | "LIVE" = "PAPER",
): Promise<TrackedPositionSyncResult> {
  const decision = await adaptivePollingCoordinator.getDecision(
    tradingAccountId,
    "tracked_position_sync",
  );

  if (!decision.due) {
    return {
      polled: false,
      skipped: true,
      skipReason:
        decision.reason === "rate_limit_backoff"
          ? "rate_limited"
          : "adaptive_poll_not_due",
      deferred: false,
      seen: 0,
      created: 0,
      updated: 0,
      closed: 0,
      symbolErrors: [],
      mode: decision.mode,
      effectiveIntervalMs: decision.effectiveIntervalMs,
      nextDueAt: decision.nextDueAt?.toISOString() ?? null,
    };
  }

  let brokerPositions: Awaited<ReturnType<typeof getNormalizedPositions>>;

  try {
    adaptivePollingCoordinator.recordAttempt(
      "tracked_position_sync",
      tradingAccountId,
      new Date(),
    );
    brokerPositions = await getNormalizedPositions(
      tradingAccountId,
      "tracked_position_sync",
    );
  } catch (error) {
    if (error instanceof AlpacaRateLimitDeferredError) {
      adaptivePollingCoordinator.recordRateLimitDeferred(
        "tracked_position_sync",
        tradingAccountId,
        error.backoffUntil,
        new Date(),
      );

      return {
        polled: false,
        skipped: true,
        skipReason: "rate_limited",
        deferred: true,
        backoffUntil: error.backoffUntil?.toISOString() ?? null,
        seen: 0,
        created: 0,
        updated: 0,
        closed: 0,
        symbolErrors: [],
        mode: decision.mode,
        effectiveIntervalMs: decision.effectiveIntervalMs,
        nextDueAt: error.backoffUntil?.toISOString() ?? null,
      };
    }

    adaptivePollingCoordinator.recordFailure(
      "tracked_position_sync",
      tradingAccountId,
      new Date(),
    );
    throw error;
  }

  let createdCount = 0;
  let updatedCount = 0;
  let closedCount = 0;
  const symbolErrors: Array<{ symbol: string; error: string }> = [];

  for (const position of brokerPositions) {
    try {
      if (position.side.toLowerCase() === "short") {
        const existingShort = await findActiveTrackedPosition({
          broker: position.broker,
          symbol: position.symbol,
          tradingAccountId,
        });
        await observeUnexpectedShortExposure({
          tradingAccountId,
          environment,
          symbol: position.symbol,
          brokerQty: position.qty,
          brokerSide: position.side,
          broker: position.broker,
          trackedPositionId: existingShort?.id ?? null,
          source: "POSITION_SYNC",
        });
        continue;
      }
      let existing = await findActiveTrackedPosition({
        broker: position.broker,
        symbol: position.symbol,
        tradingAccountId,
      });

      const security = await prisma.security.findUnique({
        where: { symbol: position.symbol },
      });

      if (!security) {
        throw new Error(`Security not found for symbol: ${position.symbol}`);
      }

      if (!existing) {
        let positionCreated = false;
        const created = await prisma.$transaction(async (tx) => {
          const rechecked = await tx.trackedPosition.findFirst({
            where: {
              broker: position.broker,
              symbol: position.symbol,
              tradingAccountId,
              status: { in: [...ACTIVE_POSITION_STATUSES] },
            },
            orderBy: { openedAt: "desc" },
          });
          if (rechecked) return rechecked;
          positionCreated = true;
          return tx.trackedPosition.create({
            data: {
              broker: position.broker,
              symbol: position.symbol,
              side: position.side,
              qty: position.qty,
              avgEntryPrice: position.avgEntryPrice,
              currentPrice: position.currentPrice,
              marketValue: position.marketValue,
              costBasis: position.costBasis,
              unrealizedPnL: position.unrealizedPnL,
              unrealizedPnLPct: position.unrealizedPnLPct,
              status: "open",
              tradingAccountId,
              openedAt: new Date(),
              lastSyncedAt: new Date(),
              rawPositionJson: position as unknown as Prisma.InputJsonValue,
              securityId: security.id,
            },
          });
        });

        existing = created;
        if (positionCreated) {
          createdCount += 1;
          await resetPositionExitStateForOpenPosition(created.id);

          const openingSubscriptionResolution =
            await applySubscriptionResolution({
              trackedPositionId: created.id,
              tradingAccountId,
              broker: created.broker,
              symbol: created.symbol,
              side: created.side,
              openedAt: created.openedAt,
              currentSubscriptionId: created.subscriptionId,
              configSnapshotJson:
                created.configSnapshotJson as Prisma.JsonValue | null,
              initialObservation: true,
              qty: created.qty,
              avgEntryPrice: created.avgEntryPrice,
              environment,
            });

          await createSystemEvent({
            type: "position.opened",
            entityType: "trackedPosition",
            entityId: created.id,
            tradingAccountId,
            severity: positionAttributionSeverity({
              environment,
              resolved:
                openingSubscriptionResolution === null ||
                openingSubscriptionResolution.status === "resolved",
              expectedCanonical:
                openingSubscriptionResolution === null ||
                (openingSubscriptionResolution.status === "resolved" &&
                  openingSubscriptionResolution.source !==
                    "unique_observer_fallback"),
            }),
            message: `Position opened: ${created.symbol}`,
            payloadJson: {
              symbol: created.symbol,
              qty: created.qty,
              avgEntryPrice: created.avgEntryPrice,
              subscriptionId:
                openingSubscriptionResolution?.subscriptionId ??
                created.subscriptionId,
              subscriptionResolutionSource:
                openingSubscriptionResolution?.source ?? null,
              subscriptionResolutionStatus:
                openingSubscriptionResolution?.status ?? null,
              environment,
              deploymentRole: env.LIVE_WRITE_DEPLOYMENT_ROLE,
            } as Prisma.InputJsonValue,
          });

          continue;
        }
      }

      const updated = await prisma.trackedPosition.update({
        where: { id: existing.id },
        data: {
          side: position.side,
          qty: position.qty,
          avgEntryPrice: position.avgEntryPrice,
          currentPrice: position.currentPrice,
          marketValue: position.marketValue,
          costBasis: position.costBasis,
          unrealizedPnL: position.unrealizedPnL,
          unrealizedPnLPct: position.unrealizedPnLPct,
          status: "open",
          lastSyncedAt: new Date(),
          rawPositionJson: position as unknown as Prisma.InputJsonValue,
        },
      });

      updatedCount += 1;
      await ensurePositionExitState(updated.id);

      await applySubscriptionResolution({
        trackedPositionId: updated.id,
        tradingAccountId: updated.tradingAccountId ?? tradingAccountId,
        broker: updated.broker,
        symbol: updated.symbol,
        side: updated.side,
        openedAt: updated.openedAt,
        currentSubscriptionId: updated.subscriptionId,
        configSnapshotJson:
          updated.configSnapshotJson as Prisma.JsonValue | null,
        initialObservation: false,
        qty: updated.qty,
        avgEntryPrice: updated.avgEntryPrice,
        environment,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown position sync error.";
      symbolErrors.push({ symbol: position.symbol, error: message });
      logger.trace(
        {
          workflow: "positions",
          tradingAccountId,
          symbol: position.symbol,
          outcome: "FAILED",
          error: message,
        },
        "Position sync item failure captured for account health.",
      );
    }
  }

  const activeTrackedPositions = await prisma.trackedPosition.findMany({
    where: {
      status: {
        in: [...ACTIVE_POSITION_STATUSES],
      },
      tradingAccountId,
    },
  });

  function positionKey(args: { broker: string; symbol: string }) {
    return `${args.broker}:${args.symbol}`;
  }

  const brokerPositionKeys = new Set(
    brokerPositions.map((position) =>
      positionKey({ broker: position.broker, symbol: position.symbol }),
    ),
  );

  for (const tracked of activeTrackedPositions) {
    if (
      brokerPositionKeys.has(
        positionKey({ broker: tracked.broker, symbol: tracked.symbol }),
      )
    ) {
      continue;
    }

    const closedResult = await prisma.trackedPosition.updateMany({
      where: {
        id: tracked.id,
        status: {
          in: [...ACTIVE_POSITION_STATUSES],
        },
      },
      data: {
        status: "closed",
        closedAt: new Date(),
        lastSyncedAt: new Date(),
      },
    });

    if (closedResult.count !== 1) {
      logger.trace(
        { trackedPositionId: tracked.id },
        "Tracked position was already closed by another sync.",
      );
      continue;
    }

    closedCount += 1;

    const closed = await prisma.trackedPosition.findUnique({
      where: { id: tracked.id },
    });

    if (!closed) {
      continue;
    }

    await syncBrokerActivitiesForAccountUnlocked(tradingAccountId, {
      activityType: "FILL",
      pageSize: 100,
      maxPages: 2,
    });

    const closeSide = getCloseFillSide(tracked.side);

    const closeFillAttribution = await attributeCloseFillsForTrackedPosition({
      trackedPositionId: closed.id,
      tradingAccountId,
      broker: closed.broker,
      symbol: closed.symbol,
      closeSide,
      openedAt: closed.openedAt,
      qty: closed.qty,
    });
    const closeFillSummary = summarizeCloseFills(
      closeFillAttribution.activities,
    );

    if (closeFillAttribution.status === "ambiguous") {
      await createSystemEvent({
        type: "position.close_fill_attribution_ambiguous",
        entityType: "trackedPosition",
        entityId: closed.id,
        tradingAccountId: closed.tradingAccountId,
        severity: SystemEventSeverity.ERROR,
        message: `${closed.symbol} close-fill attribution is ambiguous.`,
        payloadJson: {
          symbol: closed.symbol,
          trackedPositionId: closed.id,
          closeSide,
          reason: closeFillAttribution.reason ?? null,
          candidateBrokerActivityIds: closeFillAttribution.activities.map(
            (activity) => activity.id,
          ),
        } as Prisma.InputJsonValue,
      });
    }

    await createSystemEvent({
      type: "position.closed",
      entityType: "trackedPosition",
      entityId: closed.id,
      tradingAccountId: closed.tradingAccountId,
      severity: SystemEventSeverity.INFO,
      payloadJson: {
        symbol: closed.symbol,
        previousStatus: tracked.status,
        nextStatus: "closed",
        closeSide,
        closeFillAttributionStatus: closeFillAttribution.status,
        closeFillAttributionSource: closeFillAttribution.source,
        closeFillAttributionReason: closeFillAttribution.reason ?? null,
        ...closeFillSummary,
      } as Prisma.InputJsonValue,
    });

    await recordAccountSnapshot(tradingAccountId, {
      reason: "position_closed",
      force: true,
      sourceEntityType: "trackedPosition",
      sourceEntityId: closed.id,
    });

    await markPositionExitStateClosed(closed.id, {
      closeSide,
      closeFillAttributionStatus: closeFillAttribution.status,
      closeFillAttributionSource: closeFillAttribution.source,
      closeFillAttributionReason: closeFillAttribution.reason ?? null,
      ...closeFillSummary,
    } as Prisma.InputJsonValue);

    await reconcileRemainingExposureCloseAfterPositionClosure({
      tradingAccountId,
      trackedPositionId: closed.id,
    });

    logger.trace({ trackedPositionId: closed.id }, "Tracked position closed.");
  }

  const completedAt = new Date();
  if (symbolErrors.length > 0) {
    adaptivePollingCoordinator.recordFailure(
      "tracked_position_sync",
      tradingAccountId,
      completedAt,
    );
  } else {
    adaptivePollingCoordinator.recordSuccess(
      "tracked_position_sync",
      tradingAccountId,
      completedAt,
      decision.effectiveIntervalMs,
    );
  }

  return {
    polled: true,
    skipped: false,
    skipReason: null,
    deferred: false,
    seen: brokerPositions.length,
    created: createdCount,
    updated: updatedCount,
    closed: closedCount,
    symbolErrors,
    mode: decision.mode,
    effectiveIntervalMs: decision.effectiveIntervalMs,
    nextDueAt:
      decision.effectiveIntervalMs === null
        ? null
        : new Date(
            completedAt.getTime() + decision.effectiveIntervalMs,
          ).toISOString(),
  };
}

/** Public/manual operation: acquires the account lifecycle-mutation barrier. */
export async function syncTrackedPositionsForAccount(tradingAccountId: number, environment?: "PAPER" | "LIVE") {
  const result = await withTradingAccountWorkflowLock({
    tradingAccountId, workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.LIFECYCLE_MUTATION,
    processInstanceId: `tracked-position-sync:${Date.now()}`,
    execute: () => syncTrackedPositionsForAccountUnlocked(tradingAccountId, environment),
  });
  if (result.outcome !== 'ACQUIRED_AND_COMPLETED') throw (result.outcome === 'WORKFLOW_ERROR' || result.outcome === 'LOCK_ERROR' ? result.error : new HttpError(409, 'Lifecycle mutation is already in progress.'));
  return result.value;
}

export async function syncTrackedPositionsAcrossAccounts() {
  const accounts = await enumerateLifecycleAccounts("positions");
  const results = [];

  for (const account of accounts) {
    if (!account.eligible) {
      results.push({
        account,
        outcome:
          account.reason === "credentials_unavailable_with_exposure"
            ? ("CREDENTIALS_UNAVAILABLE" as const)
            : ("SKIPPED" as const),
      });
      continue;
    }

    try {
      const run = await runTradingAccountWorkflow({
        tradingAccountId: account.tradingAccountId,
        workerKey: "tracked_position_sync",
        lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.LIFECYCLE_MUTATION,
        execute: () =>
          syncTrackedPositionsForAccountUnlocked(
            account.tradingAccountId,
            account.environment,
          ),
        classify: (result) =>
          result.symbolErrors.length > 0
            ? {
                outcome: "failure",
                error: new Error(
                  `${result.symbolErrors.length} tracked position symbol synchronization(s) failed.`,
                ),
                errorCode: "TRACKED_POSITION_ITEM_FAILURE",
                summary: result,
              }
            : result.skipped
              ? { outcome: "skipped", skipReason: "not_due", summary: result }
              : { outcome: "success", workSucceeded: true, summary: result },
      });
      if (run.outcome === "FAILED") {
        if (run.value !== undefined) {
          results.push({
            account,
            outcome: "FAILED" as const,
            result: run.value,
          });
          continue;
        }
        throw run.error;
      }
      if (run.outcome !== "PROCESSED") {
        results.push({ account, outcome: run.outcome });
        continue;
      }
      const result = run.value;
      results.push({
        account,
        outcome:
          result.symbolErrors.length > 0
            ? ("FAILED" as const)
            : result.skipped
              ? ("SKIPPED" as const)
              : ("PROCESSED" as const),
        result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown worker error.";
      results.push({
        account,
        outcome: "FAILED" as const,
        error: message,
      });
      logger.trace(
        {
          workflow: "positions",
          tradingAccountId: account.tradingAccountId,
          displayName: account.displayName,
          environment: account.environment,
          outcome: "FAILED",
          error: message,
        },
        "Position sync account failure captured for account health.",
      );
    }
  }

  return {
    workflow: "positions" as const,
    processedAccounts: results.filter((item) => item.outcome === "PROCESSED")
      .length,
    failedAccounts: results.filter((item) => item.outcome === "FAILED").length,
    results,
  };
}

// Compatibility wrapper for legacy admin/manual callers. The scheduled trading
// loop uses syncTrackedPositionsAcrossAccounts.
export async function syncTrackedPositions(): Promise<TrackedPositionSyncResult> {
  return syncTrackedPositionsForAccount(await resolveDefaultTradingAccountId());
}

export async function getTrackedPositions() {
  const tradingAccountId = await resolveDefaultTradingAccountId();

  return prisma.trackedPosition.findMany({
    where: {
      tradingAccountId,
    },
    orderBy: { symbol: "asc" },
    include: {
      tradingAccount: {
        select: TRADING_ACCOUNT_SUMMARY_SELECT,
      },
      exitState: true,
      subscription: {
        include: {
          strategy: true,
          exitProfile: true,
        },
      },
    },
  });
}

export async function getOpenTrackedPositions() {
  const tradingAccountId = await resolveDefaultTradingAccountId();

  return getOpenTrackedPositionsForTradingAccount(tradingAccountId);
}

export async function getOpenTrackedPositionsForTradingAccount(
  tradingAccountId: number,
) {
  return prisma.trackedPosition.findMany({
    where: {
      tradingAccountId,
      status: {
        in: [...ACTIVE_POSITION_STATUSES],
      },
    },
    orderBy: { symbol: "asc" },
    include: {
      tradingAccount: {
        select: TRADING_ACCOUNT_SUMMARY_SELECT,
      },
      exitState: true,
      subscription: {
        include: {
          strategy: true,
          exitProfile: true,
        },
      },
    },
  });
}
