import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { AlpacaOrder } from '../integrations/alpaca/alpaca.types.js';
import {
  getAlpacaOrderByClientOrderId,
  placeAlpacaOrder,
} from '../integrations/alpaca/orders.adapter.js';
import { createSystemEvent } from './system-event.service.js';
import {
  ensurePositionExitState,
  markTrailingStopOrderSubmitted,
} from './position-exit-state.service.js';

const TRAILING_STOP_TIME_IN_FORCE = 'gtc' as const;

function compactDate(date: Date) {
  return date
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
}

function buildTrailingStopClientOrderId(args: {
  symbol: string;
  trackedPositionId: number;
  targetUnlockedAt: Date;
}) {
  return [
    'ai',
    'exit',
    'trail',
    args.symbol.toUpperCase(),
    args.trackedPositionId,
    compactDate(args.targetUnlockedAt),
  ]
    .join('-')
    .slice(0, 128);
}

function getWholeShareQty(qty: number) {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`Invalid trailing stop quantity: ${qty}`);
  }

  if (!Number.isInteger(qty)) {
    throw new Error(
      `Broker-native trailing stop exits require a whole-share quantity. Received qty=${qty}.`
    );
  }

  return String(qty);
}

async function persistTrailingStopOrder(args: {
  trackedPositionId: number;
  clientOrderId: string;
  order: AlpacaOrder;
}) {
  const position = await prisma.trackedPosition.findUnique({
    where: { id: args.trackedPositionId },
    include: {
      subscription: true,
      exitState: true,
    },
  });

  if (!position) {
    throw new Error(`Tracked position ${args.trackedPositionId} was not found.`);
  }

  const existingIntent = await prisma.orderIntent.findFirst({
    where: { clientOrderId: args.clientOrderId },
    orderBy: { createdAt: 'desc' },
  });

  const orderIntent =
    existingIntent ??
    (await prisma.orderIntent.create({
      data: {
        source: 'exit-evaluator',
        symbol: position.symbol,
        side: 'sell',
        orderType: 'trailing_stop',
        timeInForce: TRAILING_STOP_TIME_IN_FORCE,
        qty: position.qty,
        notional: null,
        limitPrice: null,
        extendedHours: false,
        clientOrderId: args.clientOrderId,
        subscriptionId: position.subscriptionId,
        subscriptionKey: position.subscription?.key ?? null,
        status: 'submitted',
        rawRequestJson: {
          source: 'exit-evaluator',
          orderKind: 'target_unlock_trailing_stop',
          trackedPositionId: position.id,
          exitStateId: position.exitState?.id ?? null,
          trailPercent: position.exitState?.trailingStopPct ?? null,
          clientOrderId: args.clientOrderId,
        } as Prisma.InputJsonValue,
      },
    }));

  await prisma.brokerOrder.upsert({
    where: {
      broker_clientOrderId: {
        broker: 'alpaca',
        clientOrderId: args.clientOrderId,
      },
    },
    create: {
      orderIntentId: orderIntent.id,
      broker: 'alpaca',
      brokerOrderId: args.order.id,
      clientOrderId: args.clientOrderId,
      securityId: position.securityId,
      symbol: position.symbol,
      side: 'sell',
      status: args.order.status,
      rawBrokerJson: args.order as unknown as Prisma.InputJsonValue,
    },
    update: {
      brokerOrderId: args.order.id,
      status: args.order.status,
      rawBrokerJson: args.order as unknown as Prisma.InputJsonValue,
    },
  });

  await markTrailingStopOrderSubmitted({
    trackedPositionId: position.id,
    broker: 'alpaca',
    brokerOrderId: args.order.id,
    clientOrderId: args.clientOrderId,
    orderStatus: args.order.status,
    rawBrokerJson: args.order as unknown as Prisma.InputJsonValue,
  });
}

export async function submitTrailingStopExitOrder(trackedPositionId: number) {
  const position = await prisma.trackedPosition.findUnique({
    where: { id: trackedPositionId },
    include: {
      subscription: true,
      exitState: true,
    },
  });

  if (!position) {
    throw new Error(`Tracked position ${trackedPositionId} was not found.`);
  }

  const exitState =
    position.exitState ?? (await ensurePositionExitState(position.id));

  if (!exitState.targetUnlocked) {
    throw new Error(
      `Cannot submit trailing stop for ${position.symbol}; target has not been unlocked.`
    );
  }

  if (!exitState.targetUnlockedAt) {
    throw new Error(
      `Cannot submit trailing stop for ${position.symbol}; targetUnlockedAt is missing.`
    );
  }

  if (exitState.trailBrokerOrderId) {
    return {
      submitted: false,
      reason: 'already_submitted',
      brokerOrderId: exitState.trailBrokerOrderId,
      clientOrderId: exitState.trailClientOrderId,
    };
  }

  const trailingStopPct = exitState.trailingStopPct;

  if (trailingStopPct === null || trailingStopPct === undefined) {
    throw new Error(
      `Cannot submit trailing stop for ${position.symbol}; trailingStopPct is missing.`
    );
  }

  const qty = getWholeShareQty(position.qty);
  const clientOrderId = buildTrailingStopClientOrderId({
    symbol: position.symbol,
    trackedPositionId: position.id,
    targetUnlockedAt: exitState.targetUnlockedAt,
  });

  const existingBrokerOrder = await prisma.brokerOrder.findUnique({
    where: {
      broker_clientOrderId: {
        broker: 'alpaca',
        clientOrderId,
      },
    },
  });

  if (existingBrokerOrder) {
    await markTrailingStopOrderSubmitted({
      trackedPositionId: position.id,
      broker: 'alpaca',
      brokerOrderId: existingBrokerOrder.brokerOrderId,
      clientOrderId,
      orderStatus: existingBrokerOrder.status,
      rawBrokerJson: existingBrokerOrder.rawBrokerJson as Prisma.InputJsonValue,
    });

    return {
      submitted: false,
      reason: 'already_persisted',
      brokerOrderId: existingBrokerOrder.brokerOrderId,
      clientOrderId,
    };
  }

  const existingAlpacaOrder = await getAlpacaOrderByClientOrderId(clientOrderId);

  if (existingAlpacaOrder) {
    await persistTrailingStopOrder({
      trackedPositionId: position.id,
      clientOrderId,
      order: existingAlpacaOrder,
    });

    return {
      submitted: false,
      reason: 'already_at_broker',
      brokerOrderId: existingAlpacaOrder.id,
      clientOrderId,
    };
  }

  const payload = {
    symbol: position.symbol,
    side: 'sell' as const,
    type: 'trailing_stop' as const,
    time_in_force: TRAILING_STOP_TIME_IN_FORCE,
    qty,
    trail_percent: String(trailingStopPct),
    client_order_id: clientOrderId,
  };

  const created = await placeAlpacaOrder(payload);

  await persistTrailingStopOrder({
    trackedPositionId: position.id,
    clientOrderId,
    order: created,
  });

  await createSystemEvent({
    type: 'exit.trailing_stop_submitted',
    entityType: 'trackedPosition',
    entityId: position.id,
    message: `${position.symbol} trailing stop exit order submitted after target unlock.`,
    payloadJson: {
      symbol: position.symbol,
      qty,
      trailingStopPct,
      clientOrderId,
      brokerOrderId: created.id,
      brokerStatus: created.status,
      timeInForce: TRAILING_STOP_TIME_IN_FORCE,
    } as Prisma.InputJsonValue,
  });

  return {
    submitted: true,
    brokerOrderId: created.id,
    clientOrderId,
  };
}