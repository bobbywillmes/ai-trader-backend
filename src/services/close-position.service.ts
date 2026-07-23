import { prisma } from '../db/prisma.js';
import type { Prisma } from '@prisma/client';
import { createSystemEvent } from './system-event.service.js';
import { closeAlpacaPosition } from '../integrations/alpaca/positions.adapter.js';
import { HttpError } from '../errors/http-error.js';
import { adaptivePollingCoordinator } from './adaptive-polling.service.js';

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

export async function closePosition(trackedPositionId: number) {
  const trackedPosition = await prisma.trackedPosition.findUnique({
    where: {
      id: trackedPositionId,
    },
    include: {
      tradingAccountSubscription: {
        select: {
          id: true,
          exitsEnabled: true,
        },
      },
    },
  });

  if (
    !trackedPosition ||
    !['open', 'closing'].includes(trackedPosition.status.toLowerCase())
  ) {
    throw new HttpError(
      404,
      `Active tracked position ${trackedPositionId} was not found.`
    );
  }

  if (trackedPosition.tradingAccountId === null) {
    throw new HttpError(
      409,
      `Tracked position ${trackedPosition.id} has no TradingAccount identity.`
    );
  }

  if (
    trackedPosition.tradingAccountSubscription &&
    !trackedPosition.tradingAccountSubscription.exitsEnabled
  ) {
    throw new HttpError(
      409,
      `TradingAccountSubscription ${trackedPosition.tradingAccountSubscription.id} has exits disabled.`
    );
  }

  const upperSymbol = trackedPosition.symbol.toUpperCase();
  const tradingAccountId = trackedPosition.tradingAccountId;
  const result = await closeAlpacaPosition(upperSymbol, 'position_close', {
    tradingAccountId,
  });

  adaptivePollingCoordinator.forceAfterBrokerPositionWrite(
    'broker_position_close_requested'
  );

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
        tradingAccountId,
        tradingAccountSubscriptionId:
          trackedPosition.tradingAccountSubscriptionId,
        status: 'submitted',
        subscriptionId: trackedPosition.subscriptionId,
        subscriptionKey: null,
        trackedPositionId: trackedPosition.id,
        rawRequestJson: {
          source: 'close-position',
          trackedPositionId: trackedPosition.id,
          tradingAccountSubscriptionId:
            trackedPosition.tradingAccountSubscriptionId,
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
        tradingAccountId,
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
        tradingAccountId,
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
    tradingAccountId,
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
