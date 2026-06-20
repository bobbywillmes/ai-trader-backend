import { prisma } from '../db/prisma.js';
import type { Prisma } from '@prisma/client';
import { createSystemEvent } from './system-event.service.js';
import { closeAlpacaPosition } from '../integrations/alpaca/positions.adapter.js';
import { HttpError } from '../errors/http-error.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getCloseOrderFromBrokerResult(result: unknown) {
  const candidate = Array.isArray(result) ? result[0] : result;

  if (!isRecord(candidate)) {
    return null;
  }

  const id = candidate.id;
  const clientOrderId = candidate.client_order_id;

  if (typeof id !== 'string' || typeof clientOrderId !== 'string') {
    return null;
  }

  return {
    id,
    clientOrderId,
    symbol:
      typeof candidate.symbol === 'string'
        ? candidate.symbol.toUpperCase()
        : null,
    side: typeof candidate.side === 'string' ? candidate.side : null,
    status: typeof candidate.status === 'string' ? candidate.status : 'submitted',
    raw: candidate,
  };
}

export async function closePosition(symbol: string) {
  const upperSymbol = symbol.toUpperCase();

  const trackedPosition = await prisma.trackedPosition.findFirst({
    where: {
      symbol: upperSymbol,
      status: {
        in: ['open', 'closing'],
      },
    },
    orderBy: {
      openedAt: 'desc',
    },
  });

  if (!trackedPosition) {
    throw new HttpError(
      404,
      `No active tracked position was found for ${upperSymbol}.`
    );
  }

  const result = await closeAlpacaPosition(upperSymbol, 'position_close');

  const tracked = await prisma.trackedPosition.updateMany({
    where: {
      id: trackedPosition.id,
      status: {
        in: ['open', 'closing'],
      },
    },
    data: {
      status: 'closing',
      lastSyncedAt: new Date(),
    },
  });

  const closeOrder = getCloseOrderFromBrokerResult(result);

  if (closeOrder) {
    const orderIntent = await prisma.orderIntent.create({
      data: {
        source: 'close-position',
        symbol: upperSymbol,
        side: closeOrder.side ?? (trackedPosition.side === 'short' ? 'buy' : 'sell'),
        orderType: 'market',
        timeInForce: 'day',
        qty: Math.abs(trackedPosition.qty),
        notional: null,
        limitPrice: null,
        extendedHours: false,
        clientOrderId: closeOrder.clientOrderId,
        status: 'submitted',
        subscriptionId: trackedPosition.subscriptionId,
        subscriptionKey: null,
        trackedPositionId: trackedPosition.id,
        rawRequestJson: {
          source: 'close-position',
          trackedPositionId: trackedPosition.id,
          brokerResult: result,
        } as Prisma.InputJsonValue,
      },
    });

    await prisma.brokerOrder.upsert({
      where: {
        broker_brokerOrderId: {
          broker: 'alpaca',
          brokerOrderId: closeOrder.id,
        },
      },
      create: {
        orderIntentId: orderIntent.id,
        broker: 'alpaca',
        brokerOrderId: closeOrder.id,
        clientOrderId: closeOrder.clientOrderId,
        symbol: closeOrder.symbol ?? upperSymbol,
        side: closeOrder.side ?? (trackedPosition.side === 'short' ? 'buy' : 'sell'),
        status: closeOrder.status,
        securityId: trackedPosition.securityId,
        trackedPositionId: trackedPosition.id,
        rawBrokerJson: closeOrder.raw as Prisma.InputJsonValue,
      },
      update: {
        orderIntentId: orderIntent.id,
        status: closeOrder.status,
        trackedPositionId: trackedPosition.id,
        rawBrokerJson: closeOrder.raw as Prisma.InputJsonValue,
      },
    });
  }

  await createSystemEvent({
    type: 'position.close_requested',
    entityType: 'trackedPosition',
    entityId: trackedPosition.id,
    payloadJson: {
      symbol: upperSymbol,
      broker: 'alpaca',
      result,
      trackedPositionId: trackedPosition.id,
      brokerOrderId: closeOrder?.id ?? null,
      clientOrderId: closeOrder?.clientOrderId ?? null,
      matchedTrackedPositions: tracked.count,
    } as Prisma.InputJsonValue,
  });

  return {
    ok: true,
    trackedPositionId: trackedPosition.id,
    symbol: upperSymbol,
    brokerResult: result,
    matchedTrackedPositions: tracked.count,
  };
}
