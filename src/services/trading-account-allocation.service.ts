import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type {
  CreateTradingAccountAllocationInput,
  UpdateTradingAccountAllocationInput,
} from '../validators/trading-account.schema.js';

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
  if (!(await tradingAccountExists(tradingAccountId))) {
    return null;
  }

  try {
    const allocation = await prisma.tradingAccountAllocation.create({
      data: {
        tradingAccountId,
        key: input.key,
        name: input.name,
        enabled: input.enabled ?? true,
        ...(input.description !== undefined && {
          description: input.description,
        }),
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
  if (!(await tradingAccountExists(tradingAccountId))) {
    return null;
  }

  const existing = await prisma.tradingAccountAllocation.findFirst({
    where: {
      id: allocationId,
      tradingAccountId,
    },
    select: { id: true },
  });

  if (!existing) {
    return null;
  }

  try {
    const allocation = await prisma.tradingAccountAllocation.update({
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
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw allocationConflictError();
    }

    throw error;
  }
}
