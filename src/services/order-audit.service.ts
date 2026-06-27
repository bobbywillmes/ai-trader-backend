import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { ResolvedPlaceOrderInput } from '../validators/place-order.schema.js';
import { HttpError } from '../errors/http-error.js';
import { resolveDefaultTradingAccountId } from './trading-account.service.js';

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
  clientOrderId: string,
  tradingAccountId?: number | null
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
      tradingAccountId: tradingAccountId ?? null,
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
  tradingAccountId?: number | null;
  brokerOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: string;
  status: string;
  rawBrokerJson: Prisma.InputJsonValue;
}) {
  const normalizedSymbol = args.symbol.trim().toUpperCase();
  const security = await prisma.security.findUnique({
    where: { symbol: normalizedSymbol },
  });

  if (!security) {
    throw new Error(`Security not found for symbol ${normalizedSymbol}`);
  }
  return prisma.brokerOrder.create({
    data: {
      orderIntentId: args.orderIntentId,
      tradingAccountId: args.tradingAccountId ?? null,
      broker: 'alpaca',
      brokerOrderId: args.brokerOrderId,
      clientOrderId: args.clientOrderId,
      securityId: security.id,
      symbol: args.symbol,
      side: args.side,
      status: args.status,
      rawBrokerJson: args.rawBrokerJson
    }
  });
}

export async function getRecentOrderIntents(limit = 50) {
  const tradingAccountId = await resolveDefaultTradingAccountId();

  return prisma.orderIntent.findMany({
    where: {
      tradingAccountId,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      brokerOrders: true
    }
  });
}

export async function getOrderIntentById(id: number) {
  const tradingAccountId = await resolveDefaultTradingAccountId();

  const intent = await prisma.orderIntent.findFirst({
    where: { id, tradingAccountId },
    include: {
      brokerOrders: true
    }
  });

  if (!intent) {
    throw new HttpError(404, `Order intent ${id} was not found.`);
  }

  return intent;
}
