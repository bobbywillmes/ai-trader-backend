import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  tradingAccountFindUnique: vi.fn(),
  allocationCreate: vi.fn(),
  allocationFindFirst: vi.fn(),
  allocationFindMany: vi.fn(),
  allocationUpdate: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findUnique: mocks.tradingAccountFindUnique,
    },
    tradingAccountAllocation: {
      create: mocks.allocationCreate,
      findFirst: mocks.allocationFindFirst,
      findMany: mocks.allocationFindMany,
      update: mocks.allocationUpdate,
    },
  },
}));

import {
  createTradingAccountAllocationForAdmin,
  listTradingAccountAllocationsForAdmin,
  updateTradingAccountAllocationForAdmin,
} from './trading-account-allocation.service.js';
import {
  createTradingAccountAllocationSchema,
  updateTradingAccountAllocationSchema,
} from '../validators/trading-account.schema.js';

function allocationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    tradingAccountId: 1,
    key: 'momentum',
    name: 'Momentum',
    description: null,
    enabled: true,
    maxAllocatedNotional: 10_000,
    maxOpenPositions: 4,
    maxPositionNotional: 2_500,
    notes: null,
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    updatedAt: new Date('2026-06-30T00:00:00.000Z'),
    _count: {
      accountSubscriptions: 2,
    },
    ...overrides,
  };
}

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      target: ['tradingAccountId', 'key'],
    },
  });
}

describe('trading account allocation validators', () => {
  it('normalizes allocation keys on create', () => {
    expect(
      createTradingAccountAllocationSchema.parse({
        key: ' Momentum_One ',
        name: 'Momentum One',
      })
    ).toEqual({
      key: 'momentum_one',
      name: 'Momentum One',
    });
  });

  it('rejects invalid allocation keys and numeric limits', () => {
    expect(() =>
      createTradingAccountAllocationSchema.parse({
        key: 'momentum one',
        name: 'Momentum One',
      })
    ).toThrow();

    expect(() =>
      createTradingAccountAllocationSchema.parse({
        key: 'momentum',
        name: 'Momentum',
        maxAllocatedNotional: 0,
      })
    ).toThrow();

    expect(() =>
      updateTradingAccountAllocationSchema.parse({
        maxOpenPositions: 1.5,
      })
    ).toThrow();
  });

  it('rejects empty allocation updates', () => {
    expect(() => updateTradingAccountAllocationSchema.parse({})).toThrow();
  });
});

describe('trading account allocation service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tradingAccountFindUnique.mockResolvedValue({ id: 1 });
    mocks.allocationFindMany.mockResolvedValue([]);
    mocks.allocationFindFirst.mockResolvedValue({ id: 10 });
    mocks.allocationCreate.mockResolvedValue(allocationRecord());
    mocks.allocationUpdate.mockResolvedValue(allocationRecord());
  });

  it('lists allocations for an existing account with assigned subscription counts', async () => {
    mocks.allocationFindMany.mockResolvedValue([
      allocationRecord({ key: 'swing', _count: { accountSubscriptions: 3 } }),
    ]);

    await expect(listTradingAccountAllocationsForAdmin(1)).resolves.toEqual([
      expect.objectContaining({
        id: 10,
        tradingAccountId: 1,
        key: 'swing',
        accountSubscriptionCount: 3,
      }),
    ]);

    expect(mocks.tradingAccountFindUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true },
    });
    expect(mocks.allocationFindMany).toHaveBeenCalledWith({
      where: { tradingAccountId: 1 },
      select: expect.any(Object),
      orderBy: [{ enabled: 'desc' }, { key: 'asc' }],
    });
  });

  it('returns null when listing allocations for a missing account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(listTradingAccountAllocationsForAdmin(404)).resolves.toBeNull();
    expect(mocks.allocationFindMany).not.toHaveBeenCalled();
  });

  it('creates allocations for existing trading accounts', async () => {
    const result = await createTradingAccountAllocationForAdmin(1, {
      key: 'momentum',
      name: 'Momentum',
      description: null,
      maxAllocatedNotional: 10_000,
      maxOpenPositions: 4,
      maxPositionNotional: 2_500,
      notes: 'Primary swing allocation.',
    });

    expect(mocks.allocationCreate).toHaveBeenCalledWith({
      data: {
        tradingAccountId: 1,
        key: 'momentum',
        name: 'Momentum',
        enabled: true,
        description: null,
        maxAllocatedNotional: 10_000,
        maxOpenPositions: 4,
        maxPositionNotional: 2_500,
        notes: 'Primary swing allocation.',
      },
      select: expect.any(Object),
    });
    expect(result).toEqual(
      expect.objectContaining({
        key: 'momentum',
        accountSubscriptionCount: 2,
      })
    );
  });

  it('returns null when creating allocations for a missing account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(
      createTradingAccountAllocationForAdmin(404, {
        key: 'momentum',
        name: 'Momentum',
      })
    ).resolves.toBeNull();
    expect(mocks.allocationCreate).not.toHaveBeenCalled();
  });

  it('maps duplicate allocation keys to a clean conflict', async () => {
    mocks.allocationCreate.mockRejectedValue(uniqueConstraintError());

    await expect(
      createTradingAccountAllocationForAdmin(1, {
        key: 'momentum',
        name: 'Momentum',
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Trading account allocation key already exists for this account.',
    });
  });

  it('updates only safe mutable allocation fields', async () => {
    mocks.allocationUpdate.mockResolvedValue(
      allocationRecord({
        key: 'swing',
        name: 'Swing',
        enabled: false,
        maxAllocatedNotional: null,
        notes: 'Paused.',
      })
    );

    const result = await updateTradingAccountAllocationForAdmin(1, 10, {
      key: 'swing',
      name: 'Swing',
      enabled: false,
      maxAllocatedNotional: null,
      notes: 'Paused.',
    });

    expect(mocks.allocationFindFirst).toHaveBeenCalledWith({
      where: {
        id: 10,
        tradingAccountId: 1,
      },
      select: { id: true },
    });
    expect(mocks.allocationUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: {
        key: 'swing',
        name: 'Swing',
        enabled: false,
        maxAllocatedNotional: null,
        notes: 'Paused.',
      },
      select: expect.any(Object),
    });
    expect(result).toEqual(
      expect.objectContaining({
        key: 'swing',
        enabled: false,
        maxAllocatedNotional: null,
      })
    );
  });

  it('returns null when updating a missing allocation under an existing account', async () => {
    mocks.allocationFindFirst.mockResolvedValue(null);

    await expect(
      updateTradingAccountAllocationForAdmin(1, 404, {
        name: 'Missing',
      })
    ).resolves.toBeNull();
    expect(mocks.allocationUpdate).not.toHaveBeenCalled();
  });

  it('maps duplicate update keys to a clean conflict', async () => {
    mocks.allocationUpdate.mockRejectedValue(uniqueConstraintError());

    await expect(
      updateTradingAccountAllocationForAdmin(1, 10, {
        key: 'existing',
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Trading account allocation key already exists for this account.',
    });
  });
});
