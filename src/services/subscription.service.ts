import { prisma } from '../db/prisma.js';
import { Prisma } from '@prisma/client';
import { HttpError } from '../errors/http-error.js';
import { createAdminAuditEvent, getChangedFields } from './admin-audit.service.js';
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
  strategyId?: number | undefined;
  strategyKey?: string | undefined;
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
  exitProfileId?: number | undefined;
  exitProfileKey?: string | undefined;
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

    const normalizedSymbol = input.symbol.trim().toUpperCase();
    const security = await prisma.security.findUnique({
      where: { symbol: normalizedSymbol },
    });

    if (!security) {
      throw new Error(`Security not found for symbol ${normalizedSymbol}`);
    }
  const subscription = await prisma.subscription.create({
    data: {
      key: input.key,
      name: input.name,
      symbol: input.symbol,
      securityId: security.id,
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

  await createAdminAuditEvent({
    eventType: 'subscription_created',
    entityType: 'subscription',
    entityId: subscription.id,
    message: `Subscription ${subscription.key} was created for ${subscription.symbol}.`,
    payload: {
      subscriptionId: subscription.id,
      subscriptionKey: subscription.key,
      symbol: subscription.symbol,
      enabled: subscription.enabled,
      broker: subscription.broker,
      brokerMode: subscription.brokerMode,
      sizingType: subscription.sizingType,
      sizingValue: subscription.sizingValue,
      strategyId: subscription.strategyId,
      exitProfileId: subscription.exitProfileId,
    },
  });

  return subscription
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

  // Prevent disabling a subscription if it has an active position
  if (input.enabled === false) {
    const activePosition = await prisma.trackedPosition.findFirst({
      where: {
        subscriptionId: current.id,
        status: {
          in: ['open', 'closing'],
        },
      },
      select: {
        id: true,
        symbol: true,
        status: true,
      },
    });

    if (activePosition) {
      throw new HttpError(
        409,
        `Cannot disable subscription ${current.key} because it has an active ${activePosition.symbol} position with status "${activePosition.status}". Close the position before disabling the subscription.`
      );
    }
  }

  const beforeSubscription = await prisma.subscription.findUnique({
    where: { id },
  });

  if (!beforeSubscription) {
    throw new Error(`Subscription not found for id ${id}`);
  }

  const subscription = await prisma.subscription.update({
    where: { id },
    data: {
      ...(input.key !== undefined && { key: input.key }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.symbol !== undefined && { symbol: input.symbol }),
      ...(input.broker !== undefined && { broker: input.broker }),
      ...(input.brokerMode !== undefined && { brokerMode: input.brokerMode }),
      ...(input.sizingType !== undefined && { sizingType: input.sizingType }),
      ...(input.sizingValue !== undefined && { sizingValue: input.sizingValue }),
      ...(strategyId !== undefined && { strategyId }),
      ...(exitProfileId !== undefined && { exitProfileId }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
    include: subscriptionInclude,
  });


  const before = {
    key: beforeSubscription.key,
    name: beforeSubscription.name,
    symbol: beforeSubscription.symbol,
    broker: beforeSubscription.broker,
    brokerMode: beforeSubscription.brokerMode,
    sizingType: beforeSubscription.sizingType,
    sizingValue: beforeSubscription.sizingValue,
    strategyId: beforeSubscription.strategyId,
    exitProfileId: beforeSubscription.exitProfileId,
    enabled: beforeSubscription.enabled,
  };

  const after = {
    key: subscription.key,
    name: subscription.name,
    symbol: subscription.symbol,
    broker: subscription.broker,
    brokerMode: subscription.brokerMode,
    sizingType: subscription.sizingType,
    sizingValue: subscription.sizingValue,
    strategyId: subscription.strategyId,
    exitProfileId: subscription.exitProfileId,
    enabled: subscription.enabled,
  };

  const changedFields = getChangedFields(before, after);

  if (changedFields.length > 0) {
    const eventType =
      changedFields.length === 1 && changedFields.includes('enabled')
        ? subscription.enabled
          ? 'subscription_enabled'
          : 'subscription_disabled'
        : 'subscription_updated';

    await createAdminAuditEvent({
      eventType,
      entityType: 'subscription',
      entityId: subscription.id,
      message: `Subscription ${subscription.key} was updated.`,
      payload: {
        subscriptionId: subscription.id,
        subscriptionKey: subscription.key,
        symbol: subscription.symbol,
        changedFields,
        before,
        after,
      },
    });
  }


  return subscription
}

export async function createExitProfile(input: CreateExitProfileInput) {
  return prisma.exitProfile.create({
    data: {
      key: input.key,
      name: input.name,
      ...(input.description !== undefined && { description: input.description }),
      ...(input.targetPct !== undefined && { targetPct: input.targetPct }),
      ...(input.stopLossPct !== undefined && { stopLossPct: input.stopLossPct }),
      ...(input.trailingStopPct !== undefined && { trailingStopPct: input.trailingStopPct }),
      ...(input.maxHoldDays !== undefined && { maxHoldDays: input.maxHoldDays }),
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
      ...(input.key !== undefined && { key: input.key }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.targetPct !== undefined && { targetPct: input.targetPct }),
      ...(input.stopLossPct !== undefined && { stopLossPct: input.stopLossPct }),
      ...(input.trailingStopPct !== undefined && { trailingStopPct: input.trailingStopPct }),
      ...(input.maxHoldDays !== undefined && { maxHoldDays: input.maxHoldDays }),
      ...(input.exitMode !== undefined && { exitMode: input.exitMode }),
      ...(input.takeProfitBehavior !== undefined && { takeProfitBehavior: input.takeProfitBehavior }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    },
  });
}