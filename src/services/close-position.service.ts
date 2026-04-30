import { prisma } from '../db/prisma.js';
import type { Prisma } from '@prisma/client';
import { createSystemEvent } from './system-event.service.js';
import { closeAlpacaPosition } from '../integrations/alpaca/positions.adapter.js';

export async function closePosition(symbol: string) {
  const upperSymbol = symbol.toUpperCase();

  const result = await closeAlpacaPosition(upperSymbol);

  const tracked = await prisma.trackedPosition.updateMany({
    where: {
      symbol: upperSymbol,
      status: 'open',
    },
    data: {
      status: 'closing',
      lastSyncedAt: new Date(),
    },
  });

  await createSystemEvent({
    type: 'position.close_requested',
    entityType: 'trackedPosition',
    entityId: null,
    payloadJson: {
      symbol: upperSymbol,
      broker: 'alpaca',
      result,
      matchedTrackedPositions: tracked.count,
    } as Prisma.InputJsonValue,
  });

  return {
    ok: true,
    symbol: upperSymbol,
    brokerResult: result,
    matchedTrackedPositions: tracked.count,
  };
}