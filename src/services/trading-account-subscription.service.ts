import { PositionSizingType, Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type {
  CreateTradingAccountSubscriptionInput,
  UpdateTradingAccountSubscriptionInput,
} from '../validators/trading-account.schema.js';

const TRADING_ACCOUNT_SUBSCRIPTION_SELECT = {
  id: true,
  tradingAccountId: true,
  subscriptionId: true,
  allocationId: true,
  enabled: true,
  entriesEnabled: true,
  exitsEnabled: true,
  sizingType: true,
  fixedQty: true,
  maxPositionNotional: true,
  minPositionNotional: true,
  maxQty: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  subscription: {
    select: {
      id: true,
      key: true,
      symbol: true,
      enabled: true,
      strategy: {
        select: {
          id: true,
          key: true,
          name: true,
        },
      },
      exitProfile: {
        select: {
          id: true,
          key: true,
          name: true,
        },
      },
    },
  },
  allocation: {
    select: {
      id: true,
      key: true,
      name: true,
      enabled: true,
    },
  },
} satisfies Prisma.TradingAccountSubscriptionSelect;

type TradingAccountSubscriptionAdminRecord =
  Prisma.TradingAccountSubscriptionGetPayload<{
    select: typeof TRADING_ACCOUNT_SUBSCRIPTION_SELECT;
  }>;

export type TradingAccountSubscriptionAdminResponse = ReturnType<
  typeof serializeTradingAccountSubscriptionForAdmin
>;

type SizingInput = {
  sizingType: PositionSizingType;
  fixedQty?: number | null | undefined;
  maxPositionNotional?: number | null | undefined;
};

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function accountSubscriptionConflictError() {
  return new HttpError(
    409,
    'Trading account subscription already exists for this account and subscription.'
  );
}

async function tradingAccountExists(tradingAccountId: number) {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { id: true },
  });

  return account !== null;
}

async function subscriptionExists(subscriptionId: number) {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true },
  });

  return subscription !== null;
}

async function validateAllocationForAccount(
  tradingAccountId: number,
  allocationId: number | null | undefined
) {
  if (allocationId === undefined || allocationId === null) {
    return;
  }

  const allocation = await prisma.tradingAccountAllocation.findFirst({
    where: {
      id: allocationId,
      tradingAccountId,
    },
    select: { id: true },
  });

  if (!allocation) {
    throw new HttpError(
      400,
      'Allocation must belong to the same trading account.'
    );
  }
}

function normalizeSizing(input: SizingInput) {
  if (input.sizingType === PositionSizingType.FIXED_QTY) {
    if (input.fixedQty == null || input.fixedQty <= 0) {
      throw new HttpError(400, 'fixedQty must be greater than 0 for FIXED_QTY sizing.');
    }

    return {
      sizingType: PositionSizingType.FIXED_QTY,
      fixedQty: input.fixedQty,
      maxPositionNotional: null,
    };
  }

  if (input.maxPositionNotional == null || input.maxPositionNotional <= 0) {
    throw new HttpError(
      400,
      'maxPositionNotional must be greater than 0 for MAX_NOTIONAL sizing.'
    );
  }

  return {
    sizingType: PositionSizingType.MAX_NOTIONAL,
    fixedQty: null,
    maxPositionNotional: input.maxPositionNotional,
  };
}

function serializeRelatedSubscription(
  subscription: TradingAccountSubscriptionAdminRecord['subscription']
) {
  return {
    id: subscription.id,
    key: subscription.key,
    symbol: subscription.symbol,
    enabled: subscription.enabled,
    strategy: subscription.strategy
      ? {
          id: subscription.strategy.id,
          key: subscription.strategy.key,
          name: subscription.strategy.name,
        }
      : null,
    exitProfile: subscription.exitProfile
      ? {
          id: subscription.exitProfile.id,
          key: subscription.exitProfile.key,
          name: subscription.exitProfile.name,
        }
      : null,
  };
}

export function serializeTradingAccountSubscriptionForAdmin(
  accountSubscription: TradingAccountSubscriptionAdminRecord
) {
  return {
    id: accountSubscription.id,
    tradingAccountId: accountSubscription.tradingAccountId,
    subscriptionId: accountSubscription.subscriptionId,
    allocationId: accountSubscription.allocationId,
    enabled: accountSubscription.enabled,
    entriesEnabled: accountSubscription.entriesEnabled,
    exitsEnabled: accountSubscription.exitsEnabled,
    sizingType: accountSubscription.sizingType,
    fixedQty: accountSubscription.fixedQty,
    maxPositionNotional: accountSubscription.maxPositionNotional,
    minPositionNotional: accountSubscription.minPositionNotional,
    maxQty: accountSubscription.maxQty,
    notes: accountSubscription.notes,
    createdAt: accountSubscription.createdAt,
    updatedAt: accountSubscription.updatedAt,
    subscription: serializeRelatedSubscription(accountSubscription.subscription),
    allocation: accountSubscription.allocation
      ? {
          id: accountSubscription.allocation.id,
          key: accountSubscription.allocation.key,
          name: accountSubscription.allocation.name,
          enabled: accountSubscription.allocation.enabled,
        }
      : null,
  };
}

export async function listTradingAccountSubscriptionsForAdmin(
  tradingAccountId: number
) {
  if (!(await tradingAccountExists(tradingAccountId))) {
    return null;
  }

  const accountSubscriptions = await prisma.tradingAccountSubscription.findMany({
    where: { tradingAccountId },
    select: TRADING_ACCOUNT_SUBSCRIPTION_SELECT,
    orderBy: [{ enabled: 'desc' }, { id: 'asc' }],
  });

  return accountSubscriptions.map(serializeTradingAccountSubscriptionForAdmin);
}

export async function getTradingAccountSubscriptionForAdmin(
  tradingAccountId: number,
  accountSubscriptionId: number
) {
  if (!(await tradingAccountExists(tradingAccountId))) {
    return null;
  }

  const accountSubscription = await prisma.tradingAccountSubscription.findFirst({
    where: {
      id: accountSubscriptionId,
      tradingAccountId,
    },
    select: TRADING_ACCOUNT_SUBSCRIPTION_SELECT,
  });

  return accountSubscription
    ? serializeTradingAccountSubscriptionForAdmin(accountSubscription)
    : null;
}

export async function createTradingAccountSubscriptionForAdmin(
  tradingAccountId: number,
  input: CreateTradingAccountSubscriptionInput
) {
  if (!(await tradingAccountExists(tradingAccountId))) {
    return null;
  }

  if (!(await subscriptionExists(input.subscriptionId))) {
    throw new HttpError(404, 'Subscription not found.');
  }

  await validateAllocationForAccount(tradingAccountId, input.allocationId);

  const sizing = normalizeSizing({
    sizingType: input.sizingType ?? PositionSizingType.FIXED_QTY,
    fixedQty: input.fixedQty,
    maxPositionNotional: input.maxPositionNotional,
  });

  try {
    const accountSubscription = await prisma.tradingAccountSubscription.create({
      data: {
        tradingAccountId,
        subscriptionId: input.subscriptionId,
        ...sizing,
        enabled: input.enabled ?? true,
        entriesEnabled: input.entriesEnabled ?? true,
        exitsEnabled: input.exitsEnabled ?? true,
        ...(input.allocationId !== undefined && {
          allocationId: input.allocationId,
        }),
        ...(input.minPositionNotional !== undefined && {
          minPositionNotional: input.minPositionNotional,
        }),
        ...(input.maxQty !== undefined && { maxQty: input.maxQty }),
        ...(input.notes !== undefined && { notes: input.notes }),
      },
      select: TRADING_ACCOUNT_SUBSCRIPTION_SELECT,
    });

    return serializeTradingAccountSubscriptionForAdmin(accountSubscription);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw accountSubscriptionConflictError();
    }

    throw error;
  }
}

export async function updateTradingAccountSubscriptionForAdmin(
  tradingAccountId: number,
  accountSubscriptionId: number,
  input: UpdateTradingAccountSubscriptionInput
) {
  if (!(await tradingAccountExists(tradingAccountId))) {
    return null;
  }

  const existing = await prisma.tradingAccountSubscription.findFirst({
    where: {
      id: accountSubscriptionId,
      tradingAccountId,
    },
    select: {
      id: true,
      sizingType: true,
      fixedQty: true,
      maxPositionNotional: true,
    },
  });

  if (!existing) {
    return null;
  }

  await validateAllocationForAccount(tradingAccountId, input.allocationId);

  const shouldUpdateSizing =
    input.sizingType !== undefined ||
    input.fixedQty !== undefined ||
    input.maxPositionNotional !== undefined;
  const sizing = shouldUpdateSizing
    ? normalizeSizing({
        sizingType: input.sizingType ?? existing.sizingType,
        fixedQty:
          input.fixedQty !== undefined ? input.fixedQty : existing.fixedQty,
        maxPositionNotional:
          input.maxPositionNotional !== undefined
            ? input.maxPositionNotional
            : existing.maxPositionNotional,
      })
    : {};

  try {
    const accountSubscription = await prisma.tradingAccountSubscription.update({
      where: { id: accountSubscriptionId },
      data: {
        ...sizing,
        ...(input.allocationId !== undefined && {
          allocationId: input.allocationId,
        }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.entriesEnabled !== undefined && {
          entriesEnabled: input.entriesEnabled,
        }),
        ...(input.exitsEnabled !== undefined && {
          exitsEnabled: input.exitsEnabled,
        }),
        ...(input.minPositionNotional !== undefined && {
          minPositionNotional: input.minPositionNotional,
        }),
        ...(input.maxQty !== undefined && { maxQty: input.maxQty }),
        ...(input.notes !== undefined && { notes: input.notes }),
      },
      select: TRADING_ACCOUNT_SUBSCRIPTION_SELECT,
    });

    return serializeTradingAccountSubscriptionForAdmin(accountSubscription);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw accountSubscriptionConflictError();
    }

    throw error;
  }
}
