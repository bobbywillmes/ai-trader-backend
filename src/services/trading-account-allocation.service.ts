import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type {
  CreateTradingAccountAllocationInput,
  UpdateTradingAccountAllocationInput,
} from '../validators/trading-account.schema.js';
import {
  assertAccountRiskConfiguration,
  withAccountRiskConfigurationTransaction,
} from './trading-account-risk-configuration.service.js';

const TRADING_ACCOUNT_ALLOCATION_SELECT = {
  id: true,
  tradingAccountId: true,
  key: true,
  name: true,
  description: true,
  enabled: true,
  maxAllocatedNotional: true,
  maxOpenPositions: true,
  maxPositionNotional: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      accountSubscriptions: true,
    },
  },
  accountSubscriptions: {
    where: {
      enabled: true,
      entriesEnabled: true,
    },
    select: {
      reservedNotional: true,
    },
  },
} satisfies Prisma.TradingAccountAllocationSelect;

type TradingAccountAllocationAdminRecord =
  Prisma.TradingAccountAllocationGetPayload<{
    select: typeof TRADING_ACCOUNT_ALLOCATION_SELECT;
  }>;

export type TradingAccountAllocationAdminResponse = ReturnType<
  typeof serializeTradingAccountAllocationForAdmin
>;

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function allocationConflictError() {
  return new HttpError(
    409,
    'Trading account allocation key already exists for this account.'
  );
}

async function tradingAccountExists(tradingAccountId: number) {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { id: true },
  });

  return account !== null;
}

export function serializeTradingAccountAllocationForAdmin(
  allocation: TradingAccountAllocationAdminRecord
) {
  const reservedNotional = allocation.accountSubscriptions.reduce(
    (total, accountSubscription) =>
      total + (accountSubscription.reservedNotional ?? 0),
    0
  );

  return {
    id: allocation.id,
    tradingAccountId: allocation.tradingAccountId,
    key: allocation.key,
    name: allocation.name,
    description: allocation.description,
    enabled: allocation.enabled,
    maxAllocatedNotional: allocation.maxAllocatedNotional,
    maxOpenPositions: allocation.maxOpenPositions,
    maxPositionNotional: allocation.maxPositionNotional,
    reservedNotional,
    remainingAllocatedNotional:
      allocation.maxAllocatedNotional === null
        ? null
        : allocation.maxAllocatedNotional - reservedNotional,
    entryEnabledSubscriptionCount: allocation.accountSubscriptions.length,
    notes: allocation.notes,
    createdAt: allocation.createdAt,
    updatedAt: allocation.updatedAt,
    accountSubscriptionCount: allocation._count.accountSubscriptions,
  };
}

export async function listTradingAccountAllocationsForAdmin(
  tradingAccountId: number
) {
  if (!(await tradingAccountExists(tradingAccountId))) {
    return null;
  }

  const allocations = await prisma.tradingAccountAllocation.findMany({
    where: { tradingAccountId },
    select: TRADING_ACCOUNT_ALLOCATION_SELECT,
    orderBy: [{ enabled: 'desc' }, { key: 'asc' }],
  });

  return allocations.map(serializeTradingAccountAllocationForAdmin);
}

export async function createTradingAccountAllocationForAdmin(
  tradingAccountId: number,
  input: CreateTradingAccountAllocationInput
) {
  try {
    return await withAccountRiskConfigurationTransaction(async (tx) => {
      const exists = await tx.tradingAccount.findUnique({
        where: { id: tradingAccountId },
        select: { id: true },
      });
      if (!exists) return null;

      await assertAccountRiskConfiguration(tx, tradingAccountId, {
        allocation: {
          id: null,
          enabled: input.enabled ?? true,
          maxAllocatedNotional: input.maxAllocatedNotional ?? null,
          maxOpenPositions: input.maxOpenPositions ?? null,
          maxPositionNotional: input.maxPositionNotional ?? null,
        },
      });

      const allocation = await tx.tradingAccountAllocation.create({
        data: {
          tradingAccountId,
          key: input.key,
          name: input.name,
          enabled: input.enabled ?? true,
          ...(input.description !== undefined && { description: input.description }),
          ...(input.maxAllocatedNotional !== undefined && { maxAllocatedNotional: input.maxAllocatedNotional }),
          ...(input.maxOpenPositions !== undefined && { maxOpenPositions: input.maxOpenPositions }),
          ...(input.maxPositionNotional !== undefined && { maxPositionNotional: input.maxPositionNotional }),
          ...(input.notes !== undefined && { notes: input.notes }),
        },
        select: TRADING_ACCOUNT_ALLOCATION_SELECT,
      });
      return serializeTradingAccountAllocationForAdmin(allocation);
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw allocationConflictError();
    }

    throw error;
  }
}

export async function updateTradingAccountAllocationForAdmin(
  tradingAccountId: number,
  allocationId: number,
  input: UpdateTradingAccountAllocationInput
) {
  try {
    return await withAccountRiskConfigurationTransaction(async (tx) => {
      const existing = await tx.tradingAccountAllocation.findFirst({
        where: { id: allocationId, tradingAccountId },
        select: {
          id: true,
          enabled: true,
          maxAllocatedNotional: true,
          maxOpenPositions: true,
          maxPositionNotional: true,
        },
      });
      if (!existing) return null;

      await assertAccountRiskConfiguration(tx, tradingAccountId, {
        allocation: {
          id: allocationId,
          enabled: input.enabled ?? existing.enabled,
          maxAllocatedNotional:
            input.maxAllocatedNotional !== undefined
              ? input.maxAllocatedNotional
              : existing.maxAllocatedNotional,
          maxOpenPositions:
            input.maxOpenPositions !== undefined
              ? input.maxOpenPositions
              : existing.maxOpenPositions,
          maxPositionNotional:
            input.maxPositionNotional !== undefined
              ? input.maxPositionNotional
              : existing.maxPositionNotional,
        },
      });

      const allocation = await tx.tradingAccountAllocation.update({
      where: { id: allocationId },
      data: {
        ...(input.key !== undefined && { key: input.key }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.maxAllocatedNotional !== undefined && {
          maxAllocatedNotional: input.maxAllocatedNotional,
        }),
        ...(input.maxOpenPositions !== undefined && {
          maxOpenPositions: input.maxOpenPositions,
        }),
        ...(input.maxPositionNotional !== undefined && {
          maxPositionNotional: input.maxPositionNotional,
        }),
        ...(input.notes !== undefined && { notes: input.notes }),
      },
      select: TRADING_ACCOUNT_ALLOCATION_SELECT,
      });
      return serializeTradingAccountAllocationForAdmin(allocation);
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw allocationConflictError();
    }

    throw error;
  }
}
