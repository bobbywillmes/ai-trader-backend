import { PositionSizingType, Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

export const ACCOUNT_RISK_CONFIGURATION_VIOLATION_CODES = {
  ACCOUNT_DEPLOYABLE_NOTIONAL_REQUIRED:
    'ACCOUNT_DEPLOYABLE_NOTIONAL_REQUIRED',
  ACCOUNT_ALLOCATION_TOTAL_EXCEEDED:
    'ACCOUNT_ALLOCATION_TOTAL_EXCEEDED',
  ALLOCATION_LIMITS_INCOMPLETE:
    'ALLOCATION_LIMITS_INCOMPLETE',
  ALLOCATION_POSITION_LIMIT_EXCEEDS_TOTAL:
    'ALLOCATION_POSITION_LIMIT_EXCEEDS_TOTAL',
  ALLOCATION_RESERVED_NOTIONAL_EXCEEDED:
    'ALLOCATION_RESERVED_NOTIONAL_EXCEEDED',
  ALLOCATION_HAS_ENTRY_ENABLED_SUBSCRIPTIONS:
    'ALLOCATION_HAS_ENTRY_ENABLED_SUBSCRIPTIONS',
  ACCOUNT_SUBSCRIPTION_ALLOCATION_REQUIRED:
    'ACCOUNT_SUBSCRIPTION_ALLOCATION_REQUIRED',
  ACCOUNT_SUBSCRIPTION_ALLOCATION_ACCOUNT_MISMATCH:
    'ACCOUNT_SUBSCRIPTION_ALLOCATION_ACCOUNT_MISMATCH',
  ACCOUNT_SUBSCRIPTION_ALLOCATION_DISABLED:
    'ACCOUNT_SUBSCRIPTION_ALLOCATION_DISABLED',
  ACCOUNT_SUBSCRIPTION_RESERVATION_REQUIRED:
    'ACCOUNT_SUBSCRIPTION_RESERVATION_REQUIRED',
  ACCOUNT_SUBSCRIPTION_RESERVATION_EXCEEDS_POSITION_LIMIT:
    'ACCOUNT_SUBSCRIPTION_RESERVATION_EXCEEDS_POSITION_LIMIT',
  ACCOUNT_SUBSCRIPTION_MAX_NOTIONAL_EXCEEDS_RESERVATION:
    'ACCOUNT_SUBSCRIPTION_MAX_NOTIONAL_EXCEEDS_RESERVATION',
  ACCOUNT_SUBSCRIPTION_MAX_NOTIONAL_REQUIRED:
    'ACCOUNT_SUBSCRIPTION_MAX_NOTIONAL_REQUIRED',
  ACCOUNT_SUBSCRIPTION_FIXED_QTY_REQUIRED:
    'ACCOUNT_SUBSCRIPTION_FIXED_QTY_REQUIRED',
} as const;

export type AccountRiskConfigurationViolationCode =
  (typeof ACCOUNT_RISK_CONFIGURATION_VIOLATION_CODES)[keyof typeof ACCOUNT_RISK_CONFIGURATION_VIOLATION_CODES];

export type AccountRiskConfigurationViolation = {
  code: AccountRiskConfigurationViolationCode;
  message: string;
  entityType: 'TradingAccount' | 'TradingAccountAllocation' | 'TradingAccountSubscription';
  entityId: number | null;
  path: string;
  tradingAccountId: number;
  allocationId?: number | null;
  accountSubscriptionId?: number | null;
  actualValue?: number | string | boolean | null;
  limitValue?: number | null;
};

type RiskConfigurationClient = Pick<
  Prisma.TransactionClient,
  'tradingAccount' | 'tradingAccountAllocation' | 'tradingAccountSubscription'
>;

export type AccountRiskConfigurationCandidate = {
  account?: {
    maxDeployableNotional?: number | null;
  };
  allocation?: {
    id: number | null;
    enabled: boolean;
    maxAllocatedNotional: number | null;
    maxOpenPositions: number | null;
    maxPositionNotional: number | null;
  };
  accountSubscription?: {
    id: number | null;
    allocationId: number | null;
    enabled: boolean;
    entriesEnabled: boolean;
    sizingType: PositionSizingType;
    fixedQty: number | null;
    maxPositionNotional: number | null;
    reservedNotional: number | null;
  };
};

const CONFIGURATION_SELECT = {
  id: true,
  maxDeployableNotional: true,
  allocations: {
    select: {
      id: true,
      enabled: true,
      maxAllocatedNotional: true,
      maxOpenPositions: true,
      maxPositionNotional: true,
      accountSubscriptions: {
        select: {
          id: true,
          allocationId: true,
          enabled: true,
          entriesEnabled: true,
          sizingType: true,
          fixedQty: true,
          maxPositionNotional: true,
          reservedNotional: true,
        },
      },
    },
  },
  accountSubscriptions: {
    where: { allocationId: null },
    select: {
      id: true,
      allocationId: true,
      enabled: true,
      entriesEnabled: true,
      sizingType: true,
      fixedQty: true,
      maxPositionNotional: true,
      reservedNotional: true,
    },
  },
} satisfies Prisma.TradingAccountSelect;

type ConfigurationState = Prisma.TradingAccountGetPayload<{
  select: typeof CONFIGURATION_SELECT;
}>;

function isPositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function violation(
  values: AccountRiskConfigurationViolation
): AccountRiskConfigurationViolation {
  return values;
}

function applyCandidate(
  state: ConfigurationState,
  candidate: AccountRiskConfigurationCandidate
) {
  const allocations = state.allocations.map((allocation) => ({
    ...allocation,
    accountSubscriptions: [...allocation.accountSubscriptions],
  }));
  const unassigned = [...state.accountSubscriptions];

  if (candidate.allocation) {
    const index = allocations.findIndex(
      (allocation) => allocation.id === candidate.allocation?.id
    );
    const next = {
      ...candidate.allocation,
      id: candidate.allocation.id ?? -1,
      accountSubscriptions:
        index >= 0 ? allocations[index]!.accountSubscriptions : [],
    };
    if (index >= 0) allocations[index] = next;
    else allocations.push(next);
  }

  if (candidate.accountSubscription) {
    for (const allocation of allocations) {
      allocation.accountSubscriptions = allocation.accountSubscriptions.filter(
        (subscription) => subscription.id !== candidate.accountSubscription?.id
      );
    }
    const unassignedIndex = unassigned.findIndex(
      (subscription) => subscription.id === candidate.accountSubscription?.id
    );
    if (unassignedIndex >= 0) unassigned.splice(unassignedIndex, 1);

    const next = {
      ...candidate.accountSubscription,
      id: candidate.accountSubscription.id ?? -1,
    };
    const allocation = allocations.find(
      (item) => item.id === next.allocationId
    );
    if (allocation) allocation.accountSubscriptions.push(next);
    else unassigned.push(next);
  }

  return {
    id: state.id,
    maxDeployableNotional:
      candidate.account?.maxDeployableNotional !== undefined
        ? candidate.account.maxDeployableNotional
        : state.maxDeployableNotional,
    allocations,
    unassigned,
  };
}

export function evaluateAccountRiskConfiguration(
  state: ConfigurationState,
  candidate: AccountRiskConfigurationCandidate = {}
) {
  const next = applyCandidate(state, candidate);
  const violations: AccountRiskConfigurationViolation[] = [];
  const enabledAllocations = next.allocations.filter((item) => item.enabled);
  const subscriptions = [
    ...next.unassigned,
    ...next.allocations.flatMap((allocation) => allocation.accountSubscriptions),
  ];
  const hasActiveEntries = subscriptions.some(
    (item) => item.enabled && item.entriesEnabled
  );
  const enabledAllocatedNotional = enabledAllocations.reduce(
    (total, allocation) => total + (allocation.maxAllocatedNotional ?? 0),
    0
  );

  if (
    (enabledAllocations.length > 0 || hasActiveEntries) &&
    !isPositive(next.maxDeployableNotional)
  ) {
    violations.push(
      violation({
        code: 'ACCOUNT_DEPLOYABLE_NOTIONAL_REQUIRED',
        message: 'Trading account max deployable notional is required for enabled allocations.',
        entityType: 'TradingAccount',
        entityId: next.id,
        path: 'maxDeployableNotional',
        tradingAccountId: next.id,
        actualValue: next.maxDeployableNotional,
      })
    );
  } else if (
    isPositive(next.maxDeployableNotional) &&
    enabledAllocatedNotional > next.maxDeployableNotional
  ) {
    violations.push(
      violation({
        code: 'ACCOUNT_ALLOCATION_TOTAL_EXCEEDED',
        message: 'Enabled allocation budgets exceed the account deployable notional.',
        entityType: 'TradingAccount',
        entityId: next.id,
        path: 'allocations.enabled.maxAllocatedNotional',
        tradingAccountId: next.id,
        actualValue: enabledAllocatedNotional,
        limitValue: next.maxDeployableNotional,
      })
    );
  }

  for (const allocation of next.allocations) {
    const activeSubscriptions = allocation.accountSubscriptions.filter(
      (item) => item.enabled && item.entriesEnabled
    );

    if (!allocation.enabled && activeSubscriptions.length > 0) {
      violations.push(
        violation({
          code: 'ALLOCATION_HAS_ENTRY_ENABLED_SUBSCRIPTIONS',
          message: 'Allocation cannot be disabled while assigned subscriptions remain enabled for entries.',
          entityType: 'TradingAccountAllocation',
          entityId: allocation.id < 0 ? null : allocation.id,
          path: 'enabled',
          tradingAccountId: next.id,
          allocationId: allocation.id < 0 ? null : allocation.id,
          actualValue: false,
        })
      );
    }

    if (allocation.enabled) {
      const incompleteFields = [
        ['maxAllocatedNotional', allocation.maxAllocatedNotional],
        ['maxOpenPositions', allocation.maxOpenPositions],
        ['maxPositionNotional', allocation.maxPositionNotional],
      ].filter(([, value]) => !isPositive(value as number | null));

      if (incompleteFields.length > 0) {
        violations.push(
          violation({
            code: 'ALLOCATION_LIMITS_INCOMPLETE',
            message: `Enabled allocation is missing required limits: ${incompleteFields.map(([field]) => field).join(', ')}.`,
            entityType: 'TradingAccountAllocation',
            entityId: allocation.id < 0 ? null : allocation.id,
            path: incompleteFields.map(([field]) => field).join(','),
            tradingAccountId: next.id,
            allocationId: allocation.id < 0 ? null : allocation.id,
          })
        );
      }
    }

    if (
      isPositive(allocation.maxAllocatedNotional) &&
      isPositive(allocation.maxPositionNotional) &&
      allocation.maxPositionNotional > allocation.maxAllocatedNotional
    ) {
      violations.push(
        violation({
          code: 'ALLOCATION_POSITION_LIMIT_EXCEEDS_TOTAL',
          message: 'Allocation per-position limit exceeds its total budget.',
          entityType: 'TradingAccountAllocation',
          entityId: allocation.id < 0 ? null : allocation.id,
          path: 'maxPositionNotional',
          tradingAccountId: next.id,
          allocationId: allocation.id < 0 ? null : allocation.id,
          actualValue: allocation.maxPositionNotional,
          limitValue: allocation.maxAllocatedNotional,
        })
      );
    }

    const reservedTotal = activeSubscriptions.reduce(
      (total, item) => total + (item.reservedNotional ?? 0),
      0
    );
    if (
      isPositive(allocation.maxAllocatedNotional) &&
      reservedTotal > allocation.maxAllocatedNotional
    ) {
      violations.push(
        violation({
          code: 'ALLOCATION_RESERVED_NOTIONAL_EXCEEDED',
          message: 'Entry-enabled subscription reservations exceed the allocation budget.',
          entityType: 'TradingAccountAllocation',
          entityId: allocation.id < 0 ? null : allocation.id,
          path: 'accountSubscriptions.reservedNotional',
          tradingAccountId: next.id,
          allocationId: allocation.id < 0 ? null : allocation.id,
          actualValue: reservedTotal,
          limitValue: allocation.maxAllocatedNotional,
        })
      );
    }
  }

  for (const subscription of subscriptions) {
    if (!subscription.enabled || !subscription.entriesEnabled) continue;
    const allocation = next.allocations.find(
      (item) => item.id === subscription.allocationId
    );
    const entityId = subscription.id < 0 ? null : subscription.id;

    if (subscription.allocationId === null) {
      violations.push(
        violation({
          code: 'ACCOUNT_SUBSCRIPTION_ALLOCATION_REQUIRED',
          message: 'An enabled, entry-enabled account subscription requires an allocation.',
          entityType: 'TradingAccountSubscription',
          entityId,
          path: 'allocationId',
          tradingAccountId: next.id,
          accountSubscriptionId: entityId,
          actualValue: null,
        })
      );
    } else if (!allocation) {
      violations.push(
        violation({
          code: 'ACCOUNT_SUBSCRIPTION_ALLOCATION_ACCOUNT_MISMATCH',
          message: 'Assigned allocation must belong to the same trading account.',
          entityType: 'TradingAccountSubscription',
          entityId,
          path: 'allocationId',
          tradingAccountId: next.id,
          allocationId: subscription.allocationId,
          accountSubscriptionId: entityId,
          actualValue: subscription.allocationId,
        })
      );
    } else if (!allocation.enabled) {
      violations.push(
        violation({
          code: 'ACCOUNT_SUBSCRIPTION_ALLOCATION_DISABLED',
          message: 'Assigned allocation is disabled for new entries.',
          entityType: 'TradingAccountSubscription',
          entityId,
          path: 'allocationId',
          tradingAccountId: next.id,
          allocationId: allocation.id,
          accountSubscriptionId: entityId,
          actualValue: allocation.id,
        })
      );
    }

    if (!isPositive(subscription.reservedNotional)) {
      violations.push(
        violation({
          code: 'ACCOUNT_SUBSCRIPTION_RESERVATION_REQUIRED',
          message: 'An enabled, entry-enabled account subscription requires reserved notional.',
          entityType: 'TradingAccountSubscription',
          entityId,
          path: 'reservedNotional',
          tradingAccountId: next.id,
          allocationId: subscription.allocationId,
          accountSubscriptionId: entityId,
          actualValue: subscription.reservedNotional,
        })
      );
    }

    if (
      allocation &&
      isPositive(allocation.maxPositionNotional) &&
      isPositive(subscription.reservedNotional) &&
      subscription.reservedNotional > allocation.maxPositionNotional
    ) {
      violations.push(
        violation({
          code: 'ACCOUNT_SUBSCRIPTION_RESERVATION_EXCEEDS_POSITION_LIMIT',
          message: 'Subscription reservation exceeds the allocation per-position limit.',
          entityType: 'TradingAccountSubscription',
          entityId,
          path: 'reservedNotional',
          tradingAccountId: next.id,
          allocationId: allocation.id,
          accountSubscriptionId: entityId,
          actualValue: subscription.reservedNotional,
          limitValue: allocation.maxPositionNotional,
        })
      );
    }

    if (subscription.sizingType === PositionSizingType.FIXED_QTY) {
      if (!isPositive(subscription.fixedQty)) {
        violations.push(
          violation({
            code: 'ACCOUNT_SUBSCRIPTION_FIXED_QTY_REQUIRED',
            message: 'FIXED_QTY sizing requires fixed quantity.',
            entityType: 'TradingAccountSubscription',
            entityId,
            path: 'fixedQty',
            tradingAccountId: next.id,
            allocationId: subscription.allocationId,
            accountSubscriptionId: entityId,
            actualValue: subscription.fixedQty,
          })
        );
      }
    } else if (!isPositive(subscription.maxPositionNotional)) {
      violations.push(
        violation({
          code: 'ACCOUNT_SUBSCRIPTION_MAX_NOTIONAL_REQUIRED',
          message: 'MAX_NOTIONAL sizing requires max position notional.',
          entityType: 'TradingAccountSubscription',
          entityId,
          path: 'maxPositionNotional',
          tradingAccountId: next.id,
          allocationId: subscription.allocationId,
          accountSubscriptionId: entityId,
          actualValue: subscription.maxPositionNotional,
        })
      );
    } else if (
      isPositive(subscription.reservedNotional) &&
      subscription.maxPositionNotional > subscription.reservedNotional
    ) {
      violations.push(
        violation({
          code: 'ACCOUNT_SUBSCRIPTION_MAX_NOTIONAL_EXCEEDS_RESERVATION',
          message: 'Subscription max position notional exceeds its reservation.',
          entityType: 'TradingAccountSubscription',
          entityId,
          path: 'maxPositionNotional',
          tradingAccountId: next.id,
          allocationId: subscription.allocationId,
          accountSubscriptionId: entityId,
          actualValue: subscription.maxPositionNotional,
          limitValue: subscription.reservedNotional,
        })
      );
    }
  }

  return violations;
}

export async function validateAccountRiskConfiguration(
  client: RiskConfigurationClient,
  tradingAccountId: number,
  candidate: AccountRiskConfigurationCandidate = {}
) {
  const state = await client.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: CONFIGURATION_SELECT,
  });
  if (!state) return null;
  const violations = evaluateAccountRiskConfiguration(state, candidate);
  if (!candidate.account && !candidate.allocation && !candidate.accountSubscription) {
    return violations;
  }

  const relevantAllocationIds = new Set<number | null>();
  if (candidate.allocation) relevantAllocationIds.add(candidate.allocation.id);
  if (candidate.accountSubscription) {
    relevantAllocationIds.add(candidate.accountSubscription.allocationId);
    const existing = [
      ...state.accountSubscriptions,
      ...state.allocations.flatMap((allocation) => allocation.accountSubscriptions),
    ].find((item) => item.id === candidate.accountSubscription?.id);
    if (existing) relevantAllocationIds.add(existing.allocationId);
  }

  return violations.filter((item) => {
    if (candidate.account) return item.entityType === 'TradingAccount';
    if (item.entityType === 'TradingAccount') return true;
    if (candidate.accountSubscription && item.entityType === 'TradingAccountSubscription') {
      return item.entityId === candidate.accountSubscription.id;
    }
    return relevantAllocationIds.has(item.allocationId ?? null);
  });
}

export async function assertAccountRiskConfiguration(
  client: RiskConfigurationClient,
  tradingAccountId: number,
  candidate: AccountRiskConfigurationCandidate
) {
  const violations = await validateAccountRiskConfiguration(
    client,
    tradingAccountId,
    candidate
  );
  if (violations === null) return false;
  if (violations.length > 0) {
    throw new HttpError(409, 'Account risk configuration is invalid.', {
      violations,
    });
  }
  return true;
}

function isTransactionConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
  );
}

export async function withAccountRiskConfigurationTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isTransactionConflict(error) || attempt === 3) throw error;
    }
  }
  throw new Error('Account risk configuration transaction retry exhausted.');
}
