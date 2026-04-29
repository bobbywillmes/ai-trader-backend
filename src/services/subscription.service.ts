import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type {
  PlaceOrderInput,
  ResolvedPlaceOrderInput
} from '../validators/place-order.schema.js';

export async function getStrategies() {
  return prisma.strategy.findMany({
    orderBy: { key: 'asc' }
  });
}

export async function getExitProfiles() {
  return prisma.exitProfile.findMany({
    orderBy: { key: 'asc' }
  });
}

export async function getSubscriptions() {
  return prisma.subscription.findMany({
    orderBy: { key: 'asc' },
    include: {
      strategy: true,
      exitProfile: true
    }
  });
}

export async function getSubscriptionByKey(key: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { key },
    include: {
      strategy: true,
      exitProfile: true
    }
  });

  if (!subscription) {
    throw new HttpError(404, `Subscription ${key} was not found.`);
  }

  return subscription;
}

export async function resolveSubscriptionOrderInput(
  input: PlaceOrderInput
): Promise<ResolvedPlaceOrderInput> {
  if (!input.subscriptionKey) {
    if (!input.symbol || !input.side || !input.orderType || !input.timeInForce) {
      throw new HttpError(400, 'Manual orders require symbol, side, orderType, and timeInForce.');
    }

    return input as ResolvedPlaceOrderInput;
  }

  const subscription = await getSubscriptionByKey(input.subscriptionKey);

  if (!subscription.enabled) {
    throw new HttpError(403, `Subscription ${subscription.key} is disabled.`);
  }

  if (!subscription.strategy.enabled) {
    throw new HttpError(403, `Strategy ${subscription.strategy.key} is disabled.`);
  }

  if (!subscription.exitProfile.enabled) {
    throw new HttpError(403, `Exit profile ${subscription.exitProfile.key} is disabled.`);
  }

  return {
    ...input,
    subscriptionId: subscription.id,
    symbol: subscription.symbol,
    side: input.signalType === 'exit' ? 'sell' : 'buy',
    orderType: input.orderType ?? 'market',
    timeInForce: input.timeInForce ?? 'day',
    qty:
      subscription.sizingType === 'fixed_qty'
        ? subscription.sizingValue
        : undefined,
    notional:
      subscription.sizingType === 'dollar_amount'
        ? subscription.sizingValue
        : undefined
  };
}