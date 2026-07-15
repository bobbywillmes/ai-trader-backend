import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import {
  evaluateMomentumSubscriptionEligibility,
  momentumSubscriptionEligibilitySelect,
} from './momentum-subscription-eligibility.service.js';
import { isMomentumContinuationStrategyKey } from '../types/strategies.js';
import type {
  StrategyDetailQuery,
  UpdateStrategyEnabledInput,
} from '../validators/strategy.validator.js';

const strategyUsageSubscriptionSelect = {
  id: true,
  enabled: true,
  symbol: true,
  exitProfile: {
    select: {
      id: true,
      key: true,
      name: true,
    },
  },
  tradingAccount: {
    select: {
      id: true,
      displayName: true,
    },
  },
  accountSubscriptions: {
    select: {
      tradingAccount: {
        select: {
          id: true,
          displayName: true,
        },
      },
    },
  },
} satisfies Prisma.SubscriptionSelect;

const strategyListInclude = {
  subscriptions: {
    select: strategyUsageSubscriptionSelect,
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.StrategyInclude;

type StrategyWithUsage = Prisma.StrategyGetPayload<{
  include: typeof strategyListInclude;
}>;

function uniqueById<T extends { id: number }>(items: T[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort(
    (left, right) => left.id - right.id,
  );
}

function summarizeUsage(strategy: StrategyWithUsage) {
  const symbols = [...new Set(strategy.subscriptions.map((item) => item.symbol))]
    .sort((left, right) => left.localeCompare(right));
  const tradingAccounts = uniqueById(
    strategy.subscriptions.flatMap((subscription) => [
      ...(subscription.tradingAccount ? [subscription.tradingAccount] : []),
      ...subscription.accountSubscriptions.map((item) => item.tradingAccount),
    ]),
  );
  const exitProfilesById = new Map<
    number,
    StrategyWithUsage['subscriptions'][number]['exitProfile'] & {
      subscriptionCount: number;
    }
  >();

  for (const subscription of strategy.subscriptions) {
    const existing = exitProfilesById.get(subscription.exitProfile.id);
    exitProfilesById.set(subscription.exitProfile.id, {
      ...subscription.exitProfile,
      subscriptionCount: (existing?.subscriptionCount ?? 0) + 1,
    });
  }

  return {
    totalSubscriptions: strategy.subscriptions.length,
    enabledSubscriptions: strategy.subscriptions.filter((item) => item.enabled)
      .length,
    disabledSubscriptions: strategy.subscriptions.filter((item) => !item.enabled)
      .length,
    symbols,
    tradingAccounts,
    exitProfiles: [...exitProfilesById.values()].sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
  };
}

function serializeStrategyListItem(strategy: StrategyWithUsage) {
  const { subscriptions: _subscriptions, ...record } = strategy;
  const usage = summarizeUsage(strategy);
  const allowedSymbols = Array.isArray(strategy.allowedSymbolsJson)
    ? strategy.allowedSymbolsJson.filter(
        (symbol): symbol is string => typeof symbol === 'string',
      )
    : [];
  const symbols = [
    ...new Set(
      [...usage.symbols, ...allowedSymbols]
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));

  return {
    ...record,
    subscriptionCount: usage.totalSubscriptions,
    activeSubscriptionCount: usage.enabledSubscriptions,
    symbols,
    tradingAccounts: usage.tradingAccounts,
    exitProfiles: usage.exitProfiles,
  };
}

async function findStrategyWithUsage(id: number) {
  const strategy = await prisma.strategy.findUnique({
    where: { id },
    include: strategyListInclude,
  });

  if (!strategy) {
    throw new HttpError(404, `Strategy id ${id} was not found.`);
  }

  return strategy;
}

export async function getStrategies() {
  const strategies = await prisma.strategy.findMany({
    include: strategyListInclude,
    orderBy: { key: 'asc' },
  });

  return strategies.map(serializeStrategyListItem);
}

export async function getStrategyChangeImpact(id: number) {
  const strategy = await findStrategyWithUsage(id);
  return buildStrategyChangeImpact(strategy);
}

function buildStrategyChangeImpact(strategy: StrategyWithUsage) {
  const usage = summarizeUsage(strategy);
  const momentumStrategy = isMomentumContinuationStrategyKey(strategy.key);
  const enabledMomentumSubscriptions = momentumStrategy
    ? usage.enabledSubscriptions
    : 0;
  const effects: string[] = [];

  if (momentumStrategy && strategy.enabled) {
    effects.push(
      'Disabling this strategy will make enabled linked momentum subscriptions ineligible for price confirmation and handoff processing.',
    );
  } else if (momentumStrategy) {
    effects.push(
      'Enabling this strategy may make individually enabled linked momentum subscriptions eligible; subscriptions will remain independently controlled.',
    );
  }

  effects.push('No subscription records will be changed.');
  effects.push('No signals or orders will be created by this change.');

  return {
    strategyId: strategy.id,
    currentEnabled: strategy.enabled,
    totalSubscriptions: usage.totalSubscriptions,
    enabledSubscriptions: usage.enabledSubscriptions,
    disabledSubscriptions: usage.disabledSubscriptions,
    distinctSymbols: usage.symbols.length,
    distinctTradingAccounts: usage.tradingAccounts.length,
    enabledMomentumSubscriptions,
    enablingCouldMakeMomentumSubscriptionsEligible:
      momentumStrategy && !strategy.enabled && enabledMomentumSubscriptions > 0,
    disablingMakesEnabledMomentumSubscriptionsIneligible:
      momentumStrategy && strategy.enabled && enabledMomentumSubscriptions > 0,
    effects,
  };
}

function serializeStrategyRecord(strategy: StrategyWithUsage) {
  const { subscriptions: _subscriptions, ...record } = strategy;
  return record;
}

export async function updateStrategyEnabled(
  id: number,
  input: UpdateStrategyEnabledInput,
  actorUserId: number,
) {
  const current = await findStrategyWithUsage(id);

  if (current.enabled === input.enabled) {
    return {
      strategy: serializeStrategyRecord(current),
      changed: false,
      impact: buildStrategyChangeImpact(current),
    };
  }

  return prisma.$transaction(async (transaction) => {
    const updateResult = await transaction.strategy.updateMany({
      where: {
        id,
        enabled: current.enabled,
      },
      data: { enabled: input.enabled },
    });

    if (updateResult.count === 0) {
      const latest = await transaction.strategy.findUnique({
        where: { id },
        include: strategyListInclude,
      });

      if (!latest) {
        throw new HttpError(404, `Strategy id ${id} was not found.`);
      }

      if (latest.enabled === input.enabled) {
        return {
          strategy: serializeStrategyRecord(latest),
          changed: false,
          impact: buildStrategyChangeImpact(latest),
        };
      }

      throw new HttpError(
        409,
        'Strategy state changed concurrently. Review the latest impact and retry.',
      );
    }

    const updated = await transaction.strategy.findUnique({
      where: { id },
      include: strategyListInclude,
    });

    if (!updated) {
      throw new HttpError(404, `Strategy id ${id} was not found.`);
    }

    const usage = summarizeUsage(updated);
    const momentumStrategy = isMomentumContinuationStrategyKey(updated.key);
    let qualifyingMomentumSubscriptions = 0;

    if (momentumStrategy) {
      const eligibilityRows = await transaction.subscription.findMany({
        where: { strategyId: id, enabled: true },
        select: momentumSubscriptionEligibilitySelect,
        orderBy: { id: 'asc' },
      });
      qualifyingMomentumSubscriptions = eligibilityRows.filter(
        (subscription) =>
          evaluateMomentumSubscriptionEligibility([subscription]).eligible,
      ).length;
    }

    await transaction.systemEvent.create({
      data: {
        type: updated.enabled ? 'strategy_enabled' : 'strategy_disabled',
        entityType: 'strategy',
        entityId: String(updated.id),
        message: `Strategy ${updated.key} was ${
          updated.enabled ? 'enabled' : 'disabled'
        }.`,
        payloadJson: {
          strategyId: updated.id,
          strategyKey: updated.key,
          strategyName: updated.name,
          previousEnabled: current.enabled,
          enabled: updated.enabled,
          totalSubscriptions: usage.totalSubscriptions,
          enabledSubscriptions: usage.enabledSubscriptions,
          distinctSymbols: usage.symbols.length,
          distinctTradingAccounts: usage.tradingAccounts.length,
          qualifyingMomentumSubscriptions,
          actorUserId,
        },
      },
    });

    return {
      strategy: serializeStrategyRecord(updated),
      changed: true,
      impact: buildStrategyChangeImpact(updated),
    };
  });
}

export async function getStrategy(id: number, query: StrategyDetailQuery) {
  const strategy = await findStrategyWithUsage(id);
  const usage = summarizeUsage(strategy);
  const skip = (query.page - 1) * query.pageSize;
  const subscriptions = await prisma.subscription.findMany({
    where: { strategyId: id },
    orderBy: [{ symbol: 'asc' }, { key: 'asc' }],
    skip,
    take: query.pageSize,
    select: {
      id: true,
      key: true,
      name: true,
      symbol: true,
      enabled: true,
      sizingType: true,
      sizingValue: true,
      security: {
        select: { name: true },
      },
      exitProfile: {
        select: { id: true, key: true, name: true },
      },
      tradingAccount: {
        select: { id: true, displayName: true },
      },
      accountSubscriptions: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          enabled: true,
          entriesEnabled: true,
          sizingType: true,
          fixedQty: true,
          maxPositionNotional: true,
          tradingAccount: {
            select: { id: true, displayName: true, status: true },
          },
          allocation: {
            select: { id: true, key: true, name: true, enabled: true },
          },
        },
      },
    },
  });
  const momentumStrategy = isMomentumContinuationStrategyKey(strategy.key);
  let currentlyQualifyingMomentumSubscriptions = 0;

  if (momentumStrategy) {
    const eligibilityRows = await prisma.subscription.findMany({
      where: { strategyId: id, enabled: true },
      select: momentumSubscriptionEligibilitySelect,
      orderBy: { id: 'asc' },
    });
    currentlyQualifyingMomentumSubscriptions = eligibilityRows.filter(
      (subscription) =>
        evaluateMomentumSubscriptionEligibility([subscription]).eligible,
    ).length;
  }

  const totalPages = Math.max(
    1,
    Math.ceil(usage.totalSubscriptions / query.pageSize),
  );

  return {
    strategy: {
      id: strategy.id,
      key: strategy.key,
      name: strategy.name,
      description: strategy.description,
      enabled: strategy.enabled,
      createdAt: strategy.createdAt,
      updatedAt: strategy.updatedAt,
    },
    usage,
    subscriptions: {
      data: subscriptions,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: usage.totalSubscriptions,
        totalPages,
      },
    },
    implications: {
      momentumStrategy,
      enabledMomentumSubscriptions: momentumStrategy
        ? usage.enabledSubscriptions
        : 0,
      currentlyQualifyingMomentumSubscriptions,
      eligibilityMessage: !momentumStrategy
        ? null
        : strategy.enabled
          ? 'Only individually enabled subscriptions with valid account and allocation configuration may become momentum eligible.'
          : 'All linked momentum subscriptions are blocked from price-confirmation and handoff eligibility while this strategy is disabled.',
    },
  };
}
