import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type {
  PlaceOrderInput,
  ResolvedPlaceOrderInput
} from '../validators/place-order.schema.js';
import type {
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
  CreateExitProfileInput,
  UpdateExitProfileInput,
} from '../validators/algo-admin.schema.js';

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

async function resolveStrategyId(input: {
  strategyId?: number;
  strategyKey?: string;
}) {
  if (input.strategyId !== undefined) {
    const strategy = await prisma.strategy.findUnique({
      where: { id: input.strategyId },
    });

    if (!strategy) {
      throw new HttpError(404, `Strategy id ${input.strategyId} was not found.`);
    }

    return strategy.id;
  }

  if (input.strategyKey !== undefined) {
    const strategy = await prisma.strategy.findUnique({
      where: { key: input.strategyKey },
    });

    if (!strategy) {
      throw new HttpError(404, `Strategy ${input.strategyKey} was not found.`);
    }

    return strategy.id;
  }

  return undefined;
}

async function resolveExitProfileId(input: {
  exitProfileId?: number;
  exitProfileKey?: string;
}) {
  if (input.exitProfileId !== undefined) {
    const exitProfile = await prisma.exitProfile.findUnique({
      where: { id: input.exitProfileId },
    });

    if (!exitProfile) {
      throw new HttpError(
        404,
        `Exit profile id ${input.exitProfileId} was not found.`
      );
    }

    return exitProfile.id;
  }

  if (input.exitProfileKey !== undefined) {
    const exitProfile = await prisma.exitProfile.findUnique({
      where: { key: input.exitProfileKey },
    });

    if (!exitProfile) {
      throw new HttpError(
        404,
        `Exit profile ${input.exitProfileKey} was not found.`
      );
    }

    return exitProfile.id;
  }

  return undefined;
}

async function assertNoEnabledSubscriptionConflict(input: {
  idToExclude?: number;
  broker: string;
  brokerMode: string;
  symbol: string;
  enabled: boolean;
}) {
  if (!input.enabled) return;

  const existing = await prisma.subscription.findFirst({
    where: {
      broker: input.broker,
      brokerMode: input.brokerMode,
      symbol: input.symbol,
      enabled: true,
      NOT: input.idToExclude ? { id: input.idToExclude } : undefined,
    },
  });

  if (existing) {
    throw new HttpError(
      409,
      `An enabled subscription already exists for ${input.symbol} on ${input.broker}-${input.brokerMode}: ${existing.key}.`
    );
  }
}

const subscriptionInclude = {
  strategy: true,
  exitProfile: true,
};

export async function createSubscription(input: CreateSubscriptionInput) {
  const strategyId = await resolveStrategyId(input);
  const exitProfileId = await resolveExitProfileId(input);

  if (!strategyId) {
    throw new HttpError(400, 'strategyId or strategyKey is required.');
  }

  if (!exitProfileId) {
    throw new HttpError(400, 'exitProfileId or exitProfileKey is required.');
  }

  const enabled = input.enabled ?? true;

  await assertNoEnabledSubscriptionConflict({
    broker: input.broker,
    brokerMode: input.brokerMode,
    symbol: input.symbol,
    enabled,
  });

  return prisma.subscription.create({
    data: {
      key: input.key,
      name: input.name,
      symbol: input.symbol,
      broker: input.broker,
      brokerMode: input.brokerMode,
      sizingType: input.sizingType,
      sizingValue: input.sizingValue,
      strategyId,
      exitProfileId,
      enabled,
    },
    include: subscriptionInclude,
  });
}

export async function updateSubscription(
  id: number,
  input: UpdateSubscriptionInput
) {
  const current = await prisma.subscription.findUnique({
    where: { id },
  });

  if (!current) {
    throw new HttpError(404, `Subscription id ${id} was not found.`);
  }

  const strategyId = await resolveStrategyId(input);
  const exitProfileId = await resolveExitProfileId(input);

  const nextBroker = input.broker ?? current.broker;
  const nextBrokerMode = input.brokerMode ?? current.brokerMode;
  const nextSymbol = input.symbol ?? current.symbol;
  const nextEnabled = input.enabled ?? current.enabled;

  await assertNoEnabledSubscriptionConflict({
    idToExclude: id,
    broker: nextBroker,
    brokerMode: nextBrokerMode,
    symbol: nextSymbol,
    enabled: nextEnabled,
  });

  return prisma.subscription.update({
    where: { id },
    data: {
      key: input.key,
      name: input.name,
      symbol: input.symbol,
      broker: input.broker,
      brokerMode: input.brokerMode,
      sizingType: input.sizingType,
      sizingValue: input.sizingValue,
      strategyId,
      exitProfileId,
      enabled: input.enabled,
    },
    include: subscriptionInclude,
  });
}

export async function createExitProfile(input: CreateExitProfileInput) {
  return prisma.exitProfile.create({
    data: {
      key: input.key,
      name: input.name,
      description: input.description,
      targetPct: input.targetPct,
      stopLossPct: input.stopLossPct,
      trailingStopPct: input.trailingStopPct,
      maxHoldDays: input.maxHoldDays,
      exitMode: input.exitMode,
      takeProfitBehavior: input.takeProfitBehavior,
      enabled: input.enabled ?? true,
    },
  });
}

export async function updateExitProfile(
  id: number,
  input: UpdateExitProfileInput
) {
  const current = await prisma.exitProfile.findUnique({
    where: { id },
  });

  if (!current) {
    throw new HttpError(404, `Exit profile id ${id} was not found.`);
  }

  return prisma.exitProfile.update({
    where: { id },
    data: {
      key: input.key,
      name: input.name,
      description: input.description,
      targetPct: input.targetPct,
      stopLossPct: input.stopLossPct,
      trailingStopPct: input.trailingStopPct,
      maxHoldDays: input.maxHoldDays,
      exitMode: input.exitMode,
      takeProfitBehavior: input.takeProfitBehavior,
      enabled: input.enabled,
    },
  });
}