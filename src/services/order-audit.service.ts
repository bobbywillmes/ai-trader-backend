import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { ResolvedPlaceOrderInput } from '../validators/place-order.schema.js';
import { HttpError } from '../errors/http-error.js';

type IntentStatus =
  | 'received'
  | 'blocked'
  | 'submitted'
  | 'pending'
  | 'duplicate'
  | 'rejected';

export async function createOrderIntent(
  input: ResolvedPlaceOrderInput,
  source = 'api',
  clientOrderId: string
) {
  return prisma.orderIntent.create({
    data: {
      source,
      symbol: input.symbol,
      side: input.side,
      orderType: input.orderType,
      timeInForce: input.timeInForce,
      qty: input.qty ?? null,
      notional: input.notional ?? null,
      limitPrice: input.limitPrice ?? null,
      extendedHours: input.extendedHours ?? false,
      clientOrderId,
      subscriptionId: input.subscriptionId ?? null,
      subscriptionKey: input.subscriptionKey ?? null,
      status: 'received',
      rawRequestJson: {
        ...input,
        clientOrderId
      } as Prisma.InputJsonValue
    }
  });
}

export async function updateOrderIntentStatus(
  id: number,
  status: IntentStatus,
  blockReason?: string
) {
  return prisma.orderIntent.update({
    where: { id },
    data: {
      status,
      blockReason: blockReason ?? null
    }
  });
}

export async function createBrokerOrder(args: {
  orderIntentId: number;
  brokerOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: string;
  status: string;
  rawBrokerJson: Prisma.InputJsonValue;
}) {
  return prisma.brokerOrder.create({
    data: {
      orderIntentId: args.orderIntentId,
      broker: 'alpaca',
      brokerOrderId: args.brokerOrderId,
      clientOrderId: args.clientOrderId,
      symbol: args.symbol,
      side: args.side,
      status: args.status,
      rawBrokerJson: args.rawBrokerJson
    }
  });
}

export async function getRecentOrderIntents(limit = 50) {
  return prisma.orderIntent.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      brokerOrders: true
    }
  });
}

export async function getOrderIntentById(id: number) {
  const intent = await prisma.orderIntent.findUnique({
    where: { id },
    include: {
      brokerOrders: true
    }
  });

  if (!intent) {
    throw new HttpError(404, `Order intent ${id} was not found.`);
  }

  return intent;
}