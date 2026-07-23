import { prisma } from '../db/prisma.js';
import {
  BrokerCredentialStatus,
  Prisma,
  TradingAccountStatus,
} from '@prisma/client';
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
  SubscriptionCatalogQuery,
  UpdateExitProfileInput,
} from '../validators/algo-admin.schema.js';

const catalogInclude = {
  security: true,
  strategy: true,
  exitProfile: true,
  accountSubscriptions: {
    select: {
      id: true,
      enabled: true,
      entriesEnabled: true,
      exitsEnabled: true,
      tradingAccount: {
        select: {
          id: true,
          displayName: true,
          environment: true,
          status: true,
        },
      },
    },
    orderBy: { tradingAccountId: 'asc' as const },
  },
} satisfies Prisma.SubscriptionInclude;

function catalogWhere(query: SubscriptionCatalogQuery) {
  const assignmentFilter: Prisma.TradingAccountSubscriptionWhereInput = {
    ...(query.tradingAccountId !== undefined && {
      tradingAccountId: query.tradingAccountId,
    }),
    ...(query.assignmentEnabled !== undefined && {
      enabled: query.assignmentEnabled,
    }),
    ...(query.entriesEnabled !== undefined && {
      entriesEnabled: query.entriesEnabled,
    }),
    ...(query.exitsEnabled !== undefined && {
      exitsEnabled: query.exitsEnabled,
    }),
  };
  const hasAssignmentFilter = Object.keys(assignmentFilter).length > 0;
  const where: Prisma.SubscriptionWhereInput = {
    ...(query.search && {
      OR: [
        { key: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { symbol: { contains: query.search, mode: 'insensitive' } },
        { security: { name: { contains: query.search, mode: 'insensitive' } } },
        { strategy: { name: { contains: query.search, mode: 'insensitive' } } },
        { strategy: { key: { contains: query.search, mode: 'insensitive' } } },
        { exitProfile: { name: { contains: query.search, mode: 'insensitive' } } },
        { exitProfile: { key: { contains: query.search, mode: 'insensitive' } } },
      ],
    }),
    ...(query.enabled !== undefined && { enabled: query.enabled }),
    ...(query.securityId !== undefined && { securityId: query.securityId }),
    ...(query.strategyId !== undefined && { strategyId: query.strategyId }),
    ...(query.exitProfileId !== undefined && {
      exitProfileId: query.exitProfileId,
    }),
  };

  if (query.assignmentStatus === 'unassigned') {
    where.accountSubscriptions = { none: assignmentFilter };
  } else if (query.assignmentStatus === 'assigned' || hasAssignmentFilter) {
    where.accountSubscriptions = { some: assignmentFilter };
  }

  return where;
}

function catalogOrderBy(query: SubscriptionCatalogQuery) {
  const direction = query.sortDirection;
  if (query.sortBy === 'assignmentCount') {
    return [{ accountSubscriptions: { _count: direction } }, { key: 'asc' }] satisfies Prisma.SubscriptionOrderByWithRelationInput[];
  }

  return [
    { [query.sortBy]: direction },
    ...(query.sortBy === 'key' ? [] : [{ key: 'asc' as const }]),
  ] satisfies Prisma.SubscriptionOrderByWithRelationInput[];
}

export async function getSubscriptions(query: SubscriptionCatalogQuery) {
  const where = catalogWhere(query);
  const skip = (query.page - 1) * query.pageSize;
  const [
    subscriptions,
    total,
    totalCatalog,
    globallyEnabled,
    assigned,
    tradingAccounts,
    securities,
    strategies,
    exitProfiles,
  ] = await prisma.$transaction([
    prisma.subscription.findMany({
      where,
      orderBy: catalogOrderBy(query),
      skip,
      take: query.pageSize,
      include: catalogInclude,
    }),
    prisma.subscription.count({ where }),
    prisma.subscription.count(),
    prisma.subscription.count({ where: { enabled: true } }),
    prisma.subscription.count({
      where: { accountSubscriptions: { some: {} } },
    }),
    prisma.tradingAccount.findMany({
      select: {
        id: true,
        displayName: true,
        environment: true,
        status: true,
      },
      orderBy: { displayName: 'asc' },
    }),
    prisma.security.findMany({
      select: { id: true, symbol: true, name: true },
      orderBy: { symbol: 'asc' },
    }),
    prisma.strategy.findMany({
      select: { id: true, key: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.exitProfile.findMany({
      select: { id: true, key: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return {
    subscriptions,
    data: subscriptions,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    },
    summary: {
      total: totalCatalog,
      globallyEnabled,
      globallyRetired: totalCatalog - globallyEnabled,
      assigned,
      unassigned: totalCatalog - assigned,
    },
    filters: {
      tradingAccounts,
      securities,
      strategies,
      exitProfiles,
    },
  };
}

export async function getSubscriptionByKey(key: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { key },
    include: {
      security: true,
      strategy: true,
      exitProfile: true,
      accountSubscriptions: {
        select: {
          id: true,
          enabled: true,
          entriesEnabled: true,
          exitsEnabled: true,
          tradingAccount: {
            select: {
              id: true,
              displayName: true,
              environment: true,
              status: true,
            },
          },
        },
      },
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
  const assignment = await prisma.tradingAccountSubscription.findUnique({
    where: { id: input.tradingAccountSubscriptionId },
    include: {
      subscription: {
        include: {
          security: true,
          strategy: true,
          exitProfile: true,
        },
      },
      allocation: true,
      tradingAccount: {
        include: {
          credential: {
            select: { status: true },
          },
        },
      },
    },
  });

  if (!assignment) {
    throw new HttpError(
      404,
      `TradingAccountSubscription ${input.tradingAccountSubscriptionId} was not found.`
    );
  }

  const subscription = assignment.subscription;
  if (input.subscriptionKey && input.subscriptionKey !== subscription.key) {
    throw new HttpError(
      409,
      `TradingAccountSubscription ${assignment.id} does not reference Subscription ${input.subscriptionKey}.`
    );
  }

  const isEntry = (input.signalType ?? 'entry') === 'entry';
  if (isEntry) {
    if (!subscription.enabled) {
      throw new HttpError(403, `Subscription ${subscription.key} is globally disabled.`);
    }
    if (!assignment.enabled) {
      throw new HttpError(403, `TradingAccountSubscription ${assignment.id} is disabled.`);
    }
    if (!assignment.entriesEnabled) {
      throw new HttpError(403, `Entries are disabled for TradingAccountSubscription ${assignment.id}.`);
    }
    if (!subscription.security.enabled) {
      throw new HttpError(403, `Security ${subscription.security.symbol} is disabled.`);
    }
    if (!subscription.strategy.enabled) {
      throw new HttpError(403, `Strategy ${subscription.strategy.key} is disabled.`);
    }
    if (!subscription.exitProfile.enabled) {
      throw new HttpError(403, `Exit profile ${subscription.exitProfile.key} is disabled.`);
    }
    if (assignment.tradingAccount.status !== TradingAccountStatus.ACTIVE) {
      throw new HttpError(
        403,
        `Trading account ${assignment.tradingAccountId} is not operational (${assignment.tradingAccount.status}).`
      );
    }
    if (!assignment.tradingAccount.tradingEnabled) {
      throw new HttpError(403, `Trading is disabled for account ${assignment.tradingAccountId}.`);
    }
    if (assignment.tradingAccount.killSwitchEnabled) {
      throw new HttpError(403, `Kill switch is enabled for account ${assignment.tradingAccountId}.`);
    }
    if (
      assignment.tradingAccount.credential?.status !==
      BrokerCredentialStatus.ACTIVE
    ) {
      throw new HttpError(
        403,
        `Trading account ${assignment.tradingAccountId} does not have active credentials.`
      );
    }
    if (!assignment.allocation) {
      throw new HttpError(409, `TradingAccountSubscription ${assignment.id} has no allocation.`);
    }
    if (
      assignment.allocation.tradingAccountId !== assignment.tradingAccountId ||
      !assignment.allocation.enabled
    ) {
      throw new HttpError(
        409,
        `TradingAccountSubscription ${assignment.id} does not have an enabled allocation for its account.`
      );
    }
  } else if (!assignment.exitsEnabled) {
    throw new HttpError(403, `Exits are disabled for TradingAccountSubscription ${assignment.id}.`);
  }

  return {
    ...input,
    tradingAccountId: assignment.tradingAccountId,
    tradingAccountSubscriptionId: assignment.id,
    subscriptionId: subscription.id,
    subscriptionKey: subscription.key,
    symbol: subscription.symbol,
    side: isEntry ? 'buy' : 'sell',
    orderType: input.orderType ?? 'market',
    timeInForce: input.timeInForce ?? 'day',
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
  security: true,
  strategy: true,
  exitProfile: true,
  accountSubscriptions: {
    select: {
      id: true,
      enabled: true,
      entriesEnabled: true,
      exitsEnabled: true,
      tradingAccount: {
        select: {
          id: true,
          displayName: true,
          environment: true,
          status: true,
        },
      },
    },
  },
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
    throw new HttpError(404, `Security ${normalizedSymbol} was not found.`);
  }

  const subscription = await prisma.subscription.create({
    data: {
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      symbol: normalizedSymbol,
      securityId: security.id,
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
      assignmentCount: subscription.accountSubscriptions.length,
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
  let securityId: number | undefined;
  let normalizedSymbol: string | undefined;
  if (input.symbol !== undefined) {
    normalizedSymbol = input.symbol.trim().toUpperCase();
    const security = await prisma.security.findUnique({
      where: { symbol: normalizedSymbol },
      select: { id: true },
    });
    if (!security) {
      throw new HttpError(404, `Security ${normalizedSymbol} was not found.`);
    }
    securityId = security.id;
  }

  const beforeSubscription = await prisma.subscription.findUnique({
    where: { id },
  });

  if (!beforeSubscription) {
    throw new Error(`Subscription not found for id ${id}`);
  }

  const updateData: Prisma.SubscriptionUncheckedUpdateInput = {
    ...(input.key !== undefined && { key: input.key }),
    ...(input.name !== undefined && { name: input.name }),
    ...(input.description !== undefined && { description: input.description }),
    ...(normalizedSymbol !== undefined && {
      symbol: normalizedSymbol,
      securityId: securityId as number,
    }),
    ...(strategyId !== undefined && { strategyId }),
    ...(exitProfileId !== undefined && { exitProfileId }),
    ...(input.enabled !== undefined && { enabled: input.enabled }),
  };

  const subscription = await prisma.subscription.update({
    where: { id },
    data: updateData,
    include: subscriptionInclude,
  });


  const before = {
    key: beforeSubscription.key,
    name: beforeSubscription.name,
    description: beforeSubscription.description,
    symbol: beforeSubscription.symbol,
    strategyId: beforeSubscription.strategyId,
    exitProfileId: beforeSubscription.exitProfileId,
    enabled: beforeSubscription.enabled,
  };

  const after = {
    key: subscription.key,
    name: subscription.name,
    description: subscription.description,
    symbol: subscription.symbol,
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
