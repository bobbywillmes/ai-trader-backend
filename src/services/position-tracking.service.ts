import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
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
}) {
  return prisma.trackedPosition.findFirst({
    where: {
      broker: args.broker,
      symbol: args.symbol,
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
  type: string;
}) {
  const since = new Date(Date.now() - 60 * 60_000);

  const existing = await prisma.systemEvent.findFirst({
    where: {
      type: args.type,
      entityType: 'trackedPosition',
      entityId: String(args.trackedPositionId),
      createdAt: {
        gte: since,
      },
    },
  });

  return Boolean(existing);
}

async function createSubscriptionResolutionEvent(args: {
  trackedPositionId: number;
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
      type: eventType,
    }))
  ) {
    return;
  }

  await createSystemEvent({
    type: eventType,
    entityType: 'trackedPosition',
    entityId: args.trackedPositionId,
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
    symbol: args.symbol,
    result: resolution,
  });

  return resolution;
}

export async function syncTrackedPositions() {
  const brokerPositions = await getNormalizedPositions();

  for (const position of brokerPositions) {
    const existing = await findActiveTrackedPosition({
      broker: position.broker,
      symbol: position.symbol,
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
          openedAt: new Date(),
          lastSyncedAt: new Date(),
          rawPositionJson: position as unknown as Prisma.InputJsonValue,
          securityId: security.id,
        },
      });

      await resetPositionExitStateForOpenPosition(created.id);

      const openingSubscriptionResolution = await applySubscriptionResolution({
        trackedPositionId: created.id,
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

    await ensurePositionExitState(updated.id);

    await applySubscriptionResolution({
      trackedPositionId: updated.id,
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
}

export async function getTrackedPositions() {
  return prisma.trackedPosition.findMany({
    orderBy: { symbol: 'asc' },
    include: {
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
  return prisma.trackedPosition.findMany({
    where: { 
      status: {
          in: [...ACTIVE_POSITION_STATUSES],
        }
     },
    orderBy: { symbol: 'asc' },
    include: {
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
