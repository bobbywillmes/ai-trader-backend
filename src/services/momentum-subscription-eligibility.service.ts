import { Prisma, TradingAccountStatus } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { isMomentumContinuationStrategyKey } from '../types/strategies.js';

export const MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS = {
  NO_SUBSCRIPTION: 'NO_SUBSCRIPTION',
  NO_ENABLED_SUBSCRIPTION: 'NO_ENABLED_SUBSCRIPTION',
  NO_MOMENTUM_STRATEGY: 'NO_MOMENTUM_STRATEGY',
  STRATEGY_DISABLED: 'STRATEGY_DISABLED',
  NO_TRADING_ACCOUNT: 'NO_TRADING_ACCOUNT',
  ACCOUNT_ASSIGNMENT_DISABLED: 'ACCOUNT_ASSIGNMENT_DISABLED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  ALLOCATION_DISABLED: 'ALLOCATION_DISABLED',
  ELIGIBLE: 'ELIGIBLE',
} as const;

export type MomentumSubscriptionEligibilityReason =
  (typeof MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS)[keyof typeof MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS];

export const momentumSubscriptionEligibilitySelect = {
  id: true,
  key: true,
  enabled: true,
  strategy: {
    select: {
      id: true,
      key: true,
      enabled: true,
    },
  },
  accountSubscriptions: {
    select: {
      id: true,
      enabled: true,
      entriesEnabled: true,
      tradingAccount: {
        select: {
          id: true,
          status: true,
        },
      },
      allocation: {
        select: {
          id: true,
          enabled: true,
        },
      },
    },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.SubscriptionSelect;

export type MomentumSubscriptionEligibilityRecord =
  Prisma.SubscriptionGetPayload<{
    select: typeof momentumSubscriptionEligibilitySelect;
  }>;

export type QualifyingMomentumSubscription = {
  subscriptionId: number;
  subscriptionKey: string;
  strategyId: number;
  strategyKey: string;
  accountAssignments: Array<{
    accountSubscriptionId: number;
    tradingAccountId: number;
    allocationId: number | null;
  }>;
};

export type MomentumSubscriptionEligibility = {
  eligible: boolean;
  subscriptionCount: number;
  enabledSubscriptionCount: number;
  qualifyingSubscriptionIds: number[];
  qualifyingSubscriptions: QualifyingMomentumSubscription[];
  reasons: MomentumSubscriptionEligibilityReason[];
};

function uniqueReasons(reasons: MomentumSubscriptionEligibilityReason[]) {
  return [...new Set(reasons)];
}

export function evaluateMomentumSubscriptionEligibility(
  subscriptions: MomentumSubscriptionEligibilityRecord[]
): MomentumSubscriptionEligibility {
  const enabledSubscriptions = subscriptions.filter((item) => item.enabled);
  const reasons: MomentumSubscriptionEligibilityReason[] = [];

  if (subscriptions.length === 0) {
    reasons.push(MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS.NO_SUBSCRIPTION);
  } else if (enabledSubscriptions.length === 0) {
    reasons.push(
      MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS.NO_ENABLED_SUBSCRIPTION
    );
  }

  const momentumSubscriptions = enabledSubscriptions.filter((item) =>
    isMomentumContinuationStrategyKey(item.strategy.key)
  );

  if (
    enabledSubscriptions.length > 0 &&
    momentumSubscriptions.length === 0
  ) {
    reasons.push(MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS.NO_MOMENTUM_STRATEGY);
  }

  const enabledStrategySubscriptions = momentumSubscriptions.filter(
    (item) => item.strategy.enabled
  );

  if (
    momentumSubscriptions.length > 0 &&
    enabledStrategySubscriptions.length === 0
  ) {
    reasons.push(MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS.STRATEGY_DISABLED);
  }

  const qualifyingSubscriptions: QualifyingMomentumSubscription[] = [];

  for (const subscription of enabledStrategySubscriptions) {
    if (subscription.accountSubscriptions.length === 0) {
      reasons.push(MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS.NO_TRADING_ACCOUNT);
      continue;
    }

    const enabledAssignments = subscription.accountSubscriptions.filter(
      (assignment) => assignment.enabled && assignment.entriesEnabled
    );

    if (enabledAssignments.length === 0) {
      reasons.push(
        MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS.ACCOUNT_ASSIGNMENT_DISABLED
      );
      continue;
    }

    const accountAssignments = enabledAssignments.flatMap((assignment) => {
      if (assignment.tradingAccount.status !== TradingAccountStatus.ACTIVE) {
        reasons.push(MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS.ACCOUNT_DISABLED);
        return [];
      }

      if (assignment.allocation !== null && !assignment.allocation.enabled) {
        reasons.push(MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS.ALLOCATION_DISABLED);
        return [];
      }

      return [
        {
          accountSubscriptionId: assignment.id,
          tradingAccountId: assignment.tradingAccount.id,
          allocationId: assignment.allocation?.id ?? null,
        },
      ];
    });

    if (accountAssignments.length > 0) {
      qualifyingSubscriptions.push({
        subscriptionId: subscription.id,
        subscriptionKey: subscription.key,
        strategyId: subscription.strategy.id,
        strategyKey: subscription.strategy.key,
        accountAssignments,
      });
    }
  }

  const eligible = qualifyingSubscriptions.length > 0;

  return {
    eligible,
    subscriptionCount: subscriptions.length,
    enabledSubscriptionCount: enabledSubscriptions.length,
    qualifyingSubscriptionIds: qualifyingSubscriptions.map(
      (item) => item.subscriptionId
    ),
    qualifyingSubscriptions,
    reasons: eligible
      ? [MOMENTUM_SUBSCRIPTION_ELIGIBILITY_REASONS.ELIGIBLE]
      : uniqueReasons(reasons),
  };
}

export async function resolveActiveMomentumSubscriptionsForSecurity(
  securityId: number
) {
  const subscriptions = await prisma.subscription.findMany({
    where: { securityId },
    select: momentumSubscriptionEligibilitySelect,
    orderBy: { id: 'asc' },
  });

  return evaluateMomentumSubscriptionEligibility(subscriptions);
}
