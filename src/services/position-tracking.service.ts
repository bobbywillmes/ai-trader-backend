import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getNormalizedPositions } from './positions.service.js';
import { createSystemEvent } from './system-event.service.js';

export async function syncTrackedPositions() {
  const brokerPositions = await getNormalizedPositions();

  for (const position of brokerPositions) {
    const existing = await prisma.trackedPosition.findUnique({
      where: { symbol: position.symbol }
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
          subscriptionId: matchedIntent?.subscriptionId ?? null,
          lastSyncedAt: new Date(),
          rawPositionJson: position as unknown as Prisma.InputJsonValue
        }
      });

      await createSystemEvent({
        type: 'position.opened',
        entityType: 'trackedPosition',
        entityId: created.id,
        payloadJson: {
          symbol: created.symbol,
          side: created.side,
          qty: created.qty,
          avgEntryPrice: created.avgEntryPrice
        } as Prisma.InputJsonValue
      });

      console.log(`Position opened: ${created.symbol}`);
      continue;
    }

    await prisma.trackedPosition.update({
      where: { symbol: position.symbol },
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
        rawPositionJson: position as unknown as Prisma.InputJsonValue
      }
    });
  }

  const openTrackedPositions = await prisma.trackedPosition.findMany({
    where: { status: 'open' }
  });

  const brokerSymbols = new Set(brokerPositions.map((position) => position.symbol));

  for (const tracked of openTrackedPositions) {
    if (brokerSymbols.has(tracked.symbol)) {
      continue;
    }

    const closed = await prisma.trackedPosition.update({
      where: { id: tracked.id },
      data: {
        status: 'closed',
        closedAt: new Date(),
        lastSyncedAt: new Date()
      }
    });

    await createSystemEvent({
      type: 'position.closed',
      entityType: 'trackedPosition',
      entityId: closed.id,
      payloadJson: {
        symbol: closed.symbol,
        previousStatus: 'open',
        nextStatus: 'closed'
      } as Prisma.InputJsonValue
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