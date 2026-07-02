import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { AlpacaRateLimitDeferredError } from '../errors/alpaca-rate-limit-deferred-error.js';
import { getNormalizedPositions } from './positions.service.js';
import { createSystemEvent } from './system-event.service.js';
import { recordAccountSnapshot } from './account-snapshot.service.js';
import {
  attributeCloseFillsForTrackedPosition,
  syncBrokerActivities,
} from './broker-activity.service.js';
import {
  ensurePositionExitState,
  markPositionExitStateClosed,
  resetPositionExitStateForOpenPosition,
} from './position-exit-state.service.js';
import { captureTrackedPositionConfigSnapshot } from './trade-cycle-config-snapshot.service.js';
import {
  linkLocalEntryOwnership,
  resolveTrackedPositionSubscription,
  type SubscriptionResolutionResult,
} from './tracked-position-subscription-resolution.service.js';
import {
  adaptivePollingCoordinator,
  type AdaptivePollingDecision,
} from './adaptive-polling.service.js';
import {
  resolveDefaultTradingAccountId,
  TRADING_ACCOUNT_SUMMARY_SELECT,
} from './trading-account.service.js';

export type TrackedPositionSyncResult = {
  polled: boolean;
  skipped: boolean;
  skipReason: 'adaptive_poll_not_due' | 'rate_limited' | null;
  deferred: boolean;
  backoffUntil?: string | null;
  seen: number;
  created: number;
  updated: number;
  closed: number;
  mode?: AdaptivePollingDecision['mode'];
  effectiveIntervalMs?: number | null;
  nextDueAt?: string | null;
};


function getCloseFillSide(positionSide: string): 'buy' | 'sell' {
  return positionSide.toLowerCase() === 'short' ? 'buy' : 'sell';
}

function summarizeCloseFills(
  fills: Array<{
    id: number;
    qty: number | null;
    price: number | null;
    orderId: string | null;
    transactionTime: Date | null;
  }>
) {
  const closeQty = fills.reduce(
    (total, fill) => total + Math.abs(fill.qty ?? 0),
    0
  );
  const notional = fills.reduce(
    (total, fill) => total + Math.abs(fill.qty ?? 0) * (fill.price ?? 0),
    0
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
      new Set(fills.map((fill) => fill.orderId).filter(Boolean))
    ),
  };
}

const ACTIVE_POSITION_STATUSES = ['open', 'closing'] as const;

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
      openedAt: 'desc',
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
      entityType: 'trackedPosition',
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
}) {
  const eventType =
    args.result.status === 'resolved'
      ? 'position.subscription_resolved'
      : args.result.status === 'ambiguous'
        ? 'position.subscription_resolution_ambiguous'
        : 'position.subscription_resolution_unresolved';

  if (
    args.result.status !== 'resolved' &&
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
    entityType: 'trackedPosition',
    entityId: args.trackedPositionId,
    tradingAccountId: args.tradingAccountId,
    message:
      args.result.status === 'resolved'
        ? `${args.symbol} subscription resolved via ${args.result.source}.`
        : `${args.symbol} subscription resolution ${args.result.status}: ${args.result.reason}.`,
    payloadJson: {
      symbol: args.symbol,
      trackedPositionId: args.trackedPositionId,
      status: args.result.status,
      source: args.result.source,
      subscriptionId: args.result.subscriptionId,
      subscriptionKey: args.result.subscriptionKey,
      reason: args.result.reason,
      evidence: args.result.evidence,
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
}) {
  if (args.currentSubscriptionId !== null) {
    if (args.configSnapshotJson === null) {
      await captureTrackedPositionConfigSnapshot({
        trackedPositionId: args.trackedPositionId,
        source: 'position_opened',
        subscriptionResolutionSource: 'local_order_intent',
      });
    }

    return null;
  }

  const resolution = await resolveTrackedPositionSubscription({
    broker: args.broker,
    symbol: args.symbol,
    side: args.side,
    openedAt: args.openedAt,
  });

  if (resolution.status !== 'resolved') {
    await createSubscriptionResolutionEvent({
      trackedPositionId: args.trackedPositionId,
      tradingAccountId: args.tradingAccountId,
      symbol: args.symbol,
      result: resolution,
    });

    return resolution;
  }

  await prisma.trackedPosition.update({
    where: { id: args.trackedPositionId },
    data: {
      subscriptionId: resolution.subscriptionId,
    },
  });

  if (resolution.source === 'local_order_intent') {
    await linkLocalEntryOwnership({
      trackedPositionId: args.trackedPositionId,
      broker: args.broker,
      symbol: args.symbol,
      side: args.side,
      openedAt: args.openedAt,
    });
  }

  await captureTrackedPositionConfigSnapshot({
    trackedPositionId: args.trackedPositionId,
    source:
      resolution.source === 'local_order_intent'
        ? 'position_opened'
        : 'subscription_recovered',
    subscriptionResolutionSource: resolution.source,
  });

  await createSubscriptionResolutionEvent({
    trackedPositionId: args.trackedPositionId,
    tradingAccountId: args.tradingAccountId,
    symbol: args.symbol,
    result: resolution,
  });

  return resolution;
}

export async function syncTrackedPositions(): Promise<TrackedPositionSyncResult> {
  const decision = await adaptivePollingCoordinator.getDecision(
    'tracked_position_sync'
  );

  if (!decision.due) {
    return {
      polled: false,
      skipped: true,
      skipReason:
        decision.reason === 'rate_limit_backoff'
          ? 'rate_limited'
          : 'adaptive_poll_not_due',
      deferred: false,
      seen: 0,
      created: 0,
      updated: 0,
      closed: 0,
      mode: decision.mode,
      effectiveIntervalMs: decision.effectiveIntervalMs,
      nextDueAt: decision.nextDueAt?.toISOString() ?? null,
    };
  }

  const tradingAccountId = await resolveDefaultTradingAccountId();
  let brokerPositions: Awaited<ReturnType<typeof getNormalizedPositions>>;

  try {
    adaptivePollingCoordinator.recordAttempt('tracked_position_sync');
    brokerPositions = await getNormalizedPositions('tracked_position_sync', {
      tradingAccountId,
    });
  } catch (error) {
    if (error instanceof AlpacaRateLimitDeferredError) {
      adaptivePollingCoordinator.recordRateLimitDeferred(
        'tracked_position_sync',
        error.backoffUntil
      );

      return {
        polled: false,
        skipped: true,
        skipReason: 'rate_limited',
        deferred: true,
        backoffUntil: error.backoffUntil?.toISOString() ?? null,
        seen: 0,
        created: 0,
        updated: 0,
        closed: 0,
        mode: decision.mode,
        effectiveIntervalMs: decision.effectiveIntervalMs,
        nextDueAt: error.backoffUntil?.toISOString() ?? null,
      };
    }

    adaptivePollingCoordinator.recordFailure('tracked_position_sync');
    throw error;
  }

  let createdCount = 0;
  let updatedCount = 0;
  let closedCount = 0;

  for (const position of brokerPositions) {
    const existing = await findActiveTrackedPosition({
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
      const created = await prisma.trackedPosition.create({
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
          status: 'open',
          tradingAccountId,
          openedAt: new Date(),
          lastSyncedAt: new Date(),
          rawPositionJson: position as unknown as Prisma.InputJsonValue,
          securityId: security.id,
        },
      });

      createdCount += 1;
      await resetPositionExitStateForOpenPosition(created.id);

      const openingSubscriptionResolution = await applySubscriptionResolution({
        trackedPositionId: created.id,
        tradingAccountId,
        broker: created.broker,
        symbol: created.symbol,
        side: created.side,
        openedAt: created.openedAt,
        currentSubscriptionId: created.subscriptionId,
        configSnapshotJson: created.configSnapshotJson as Prisma.JsonValue | null,
      });

      await createSystemEvent({
        type: 'position.opened',
        entityType: 'trackedPosition',
        entityId: created.id,
        tradingAccountId,
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
        } as Prisma.InputJsonValue,
      });

      continue;
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
        status: 'open',
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
      configSnapshotJson: updated.configSnapshotJson as Prisma.JsonValue | null,
    });
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
      positionKey({ broker: position.broker, symbol: position.symbol })
    )
  );

  for (const tracked of activeTrackedPositions) {
    if (brokerPositionKeys.has(positionKey({ broker: tracked.broker, symbol: tracked.symbol }))) {
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
        status: 'closed',
        closedAt: new Date(),
        lastSyncedAt: new Date(),
      },
    });

    if (closedResult.count !== 1) {
      console.log(
        `Tracked position ${tracked.id} for ${tracked.symbol} was already closed by another sync.`
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

    await syncBrokerActivities({
      activityType: 'FILL',
      pageSize: 100,
      maxPages: 2,
    });

    const closeSide = getCloseFillSide(tracked.side);

    const closeFillAttribution = await attributeCloseFillsForTrackedPosition({
      trackedPositionId: closed.id,
      tradingAccountId: closed.tradingAccountId,
      broker: closed.broker,
      symbol: closed.symbol,
      closeSide,
      openedAt: closed.openedAt,
      qty: closed.qty,
    });
    const closeFillSummary = summarizeCloseFills(
      closeFillAttribution.activities
    );

    if (closeFillAttribution.status === 'ambiguous') {
      await createSystemEvent({
        type: 'position.close_fill_attribution_ambiguous',
        entityType: 'trackedPosition',
        entityId: closed.id,
        tradingAccountId: closed.tradingAccountId,
        message: `${closed.symbol} close-fill attribution is ambiguous.`,
        payloadJson: {
          symbol: closed.symbol,
          trackedPositionId: closed.id,
          closeSide,
          reason: closeFillAttribution.reason ?? null,
          candidateBrokerActivityIds: closeFillAttribution.activities.map(
            (activity) => activity.id
          ),
        } as Prisma.InputJsonValue,
      });
    }

    await createSystemEvent({
      type: 'position.closed',
      entityType: 'trackedPosition',
      entityId: closed.id,
      tradingAccountId: closed.tradingAccountId,
      payloadJson: {
        symbol: closed.symbol,
        previousStatus: tracked.status,
        nextStatus: 'closed',
        closeSide,
        closeFillAttributionStatus: closeFillAttribution.status,
        closeFillAttributionSource: closeFillAttribution.source,
        closeFillAttributionReason: closeFillAttribution.reason ?? null,
        ...closeFillSummary,
      } as Prisma.InputJsonValue,
    });

    await recordAccountSnapshot({
      reason: 'position_closed',
      force: true,
      sourceEntityType: 'trackedPosition',
      sourceEntityId: closed.id,
      tradingAccountId: closed.tradingAccountId,
    });

    await markPositionExitStateClosed(closed.id, {
      closeSide,
      closeFillAttributionStatus: closeFillAttribution.status,
      closeFillAttributionSource: closeFillAttribution.source,
      closeFillAttributionReason: closeFillAttribution.reason ?? null,
      ...closeFillSummary,
    } as Prisma.InputJsonValue);

    console.log(`Position closed: ${closed.symbol}`);
  }

  const completedAt = new Date();
  adaptivePollingCoordinator.recordSuccess(
    'tracked_position_sync',
    completedAt,
    decision.effectiveIntervalMs
  );

  return {
    polled: true,
    skipped: false,
    skipReason: null,
    deferred: false,
    seen: brokerPositions.length,
    created: createdCount,
    updated: updatedCount,
    closed: closedCount,
    mode: decision.mode,
    effectiveIntervalMs: decision.effectiveIntervalMs,
    nextDueAt:
      decision.effectiveIntervalMs === null
        ? null
        : new Date(completedAt.getTime() + decision.effectiveIntervalMs).toISOString(),
  };
}

export async function getTrackedPositions() {
  const tradingAccountId = await resolveDefaultTradingAccountId();

  return prisma.trackedPosition.findMany({
    where: {
      tradingAccountId,
    },
    orderBy: { symbol: 'asc' },
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

  return prisma.trackedPosition.findMany({
    where: {
      tradingAccountId,
      status: {
          in: [...ACTIVE_POSITION_STATUSES],
        }
     },
    orderBy: { symbol: 'asc' },
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
