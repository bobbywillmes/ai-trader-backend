import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getNormalizedPositions } from './positions.service.js';
import { createSystemEvent } from './system-event.service.js';
import { recordAccountSnapshot } from './account-snapshot.service.js';
import {
  getLatestBrokerFillForSymbol,
  syncBrokerActivities,
} from './broker-activity.service.js';


function getCloseFillSide(positionSide: string): 'buy' | 'sell' {
  return positionSide.toLowerCase() === 'short' ? 'buy' : 'sell';
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000);
}

export async function syncTrackedPositions() {
  const brokerPositions = await getNormalizedPositions();

  for (const position of brokerPositions) {
    const existing = await prisma.trackedPosition.findUnique({
      where: { symbol: position.symbol },
    });

    const matchedIntent = await prisma.orderIntent.findFirst({
      where: {
        symbol: position.symbol,
        status: 'filled',
        subscriptionId: { not: null },
      },
      orderBy: {
        updatedAt: 'desc',
      },
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
          securityId: security.id,
          side: position.side,
          qty: position.qty,
          avgEntryPrice: position.avgEntryPrice,
          currentPrice: position.currentPrice,
          marketValue: position.marketValue,
          costBasis: position.costBasis,
          unrealizedPnL: position.unrealizedPnL,
          unrealizedPnLPct: position.unrealizedPnLPct,
          status: 'open',
          subscriptionId: matchedIntent?.subscriptionId ?? null,
          lastSyncedAt: new Date(),
          rawPositionJson: position as unknown as Prisma.InputJsonValue,
        },
      });

      await createSystemEvent({
        type: 'position.opened',
        entityType: 'trackedPosition',
        entityId: created.id,
        payloadJson: {
          symbol: created.symbol,
          side: created.side,
          qty: created.qty,
          avgEntryPrice: created.avgEntryPrice,
        } as Prisma.InputJsonValue,
      });

      await recordAccountSnapshot({
        reason: 'position_opened',
        force: true,
        sourceEntityType: 'trackedPosition',
        sourceEntityId: created.id,
      });

      await syncBrokerActivities({
        activityType: 'FILL',
        pageSize: 100,
        maxPages: 2,
      });

      console.log(`Position opened: ${created.symbol}`);
      continue;
    }

    const wasClosedOrInactive = existing.status !== 'open';

    const updateResult = await prisma.trackedPosition.updateMany({
      where: {
        id: existing.id,
        status: wasClosedOrInactive ? { not: 'open' } : 'open',
      },
      data: {
        securityId: security.id,
        side: position.side,
        qty: position.qty,
        avgEntryPrice: position.avgEntryPrice,
        currentPrice: position.currentPrice,
        marketValue: position.marketValue,
        costBasis: position.costBasis,
        unrealizedPnL: position.unrealizedPnL,
        unrealizedPnLPct: position.unrealizedPnLPct,
        status: 'open',
        closedAt: null,
        subscriptionId: matchedIntent?.subscriptionId ?? existing.subscriptionId,
        lastSyncedAt: new Date(),
        rawPositionJson: position as unknown as Prisma.InputJsonValue,
      },
    });

    if (updateResult.count !== 1) {
      console.log(
        `Tracked position ${existing.id} for ${existing.symbol} was already updated by another sync.`
      );
      continue;
    }

    if (wasClosedOrInactive) {
      const opened = await prisma.trackedPosition.findUniqueOrThrow({
        where: { id: existing.id },
      });

      await createSystemEvent({
        type: 'position.opened',
        entityType: 'trackedPosition',
        entityId: opened.id,
        payloadJson: {
          symbol: opened.symbol,
          side: opened.side,
          qty: opened.qty,
          avgEntryPrice: opened.avgEntryPrice,
          previousStatus: existing.status,
          nextStatus: 'open',
        } as Prisma.InputJsonValue,
      });

      await recordAccountSnapshot({
        reason: 'position_opened',
        force: true,
        sourceEntityType: 'trackedPosition',
        sourceEntityId: opened.id,
      });

      await syncBrokerActivities({
        activityType: 'FILL',
        pageSize: 100,
        maxPages: 2,
      });

      console.log(`Position opened: ${opened.symbol}`);
    }
  }

  const activeTrackedPositions = await prisma.trackedPosition.findMany({
    where: {
      status: {
        in: ['open', 'closing'],
      },
    },
  });

  const brokerSymbols = new Set(
    brokerPositions.map((position) => position.symbol)
  );

  for (const tracked of activeTrackedPositions) {
    if (brokerSymbols.has(tracked.symbol)) {
      continue;
    }

    const closedResult = await prisma.trackedPosition.updateMany({
      where: {
        id: tracked.id,
        status: {
          in: ['open', 'closing'],
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

    const closed = await prisma.trackedPosition.findUniqueOrThrow({
      where: { id: tracked.id },
    });

    await syncBrokerActivities({
      activityType: 'FILL',
      pageSize: 100,
      maxPages: 2,
    });

    const closeSide = getCloseFillSide(tracked.side);

    const closeFill = await getLatestBrokerFillForSymbol({
      symbol: closed.symbol,
      side: closeSide,
      after: minutesAgo(30),
    });

    await createSystemEvent({
      type: 'position.closed',
      entityType: 'trackedPosition',
      entityId: closed.id,
      payloadJson: {
        symbol: closed.symbol,
        previousStatus: tracked.status,
        nextStatus: 'closed',
        closeSide,
        closeQty: closeFill?.qty ?? null,
        closePrice: closeFill?.price ?? null,
        closeFillTime: closeFill?.transactionTime?.toISOString() ?? null,
        brokerActivityId: closeFill?.id ?? null,
        closeOrderId: closeFill?.orderId ?? null,
      } as Prisma.InputJsonValue,
    });

    await recordAccountSnapshot({
      reason: 'position_closed',
      force: true,
      sourceEntityType: 'trackedPosition',
      sourceEntityId: closed.id,
    });

    console.log(`Position closed: ${closed.symbol}`);
  }
}

export async function getTrackedPositions() {
  return prisma.trackedPosition.findMany({
    orderBy: { symbol: 'asc' },
    include: {
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
    where: { status: 'open' },
    orderBy: { symbol: 'asc' },
    include: {
      subscription: {
        include: {
          strategy: true,
          exitProfile: true,
        },
      },
    },
  });
}