import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PositionSizingType, Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  tradingAccountFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  allocationFindFirst: vi.fn(),
  accountSubscriptionCreate: vi.fn(),
  accountSubscriptionFindFirst: vi.fn(),
  accountSubscriptionFindMany: vi.fn(),
  accountSubscriptionUpdate: vi.fn(),
  assertAccountRiskConfiguration: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findUnique: mocks.tradingAccountFindUnique,
    },
    subscription: {
      findUnique: mocks.subscriptionFindUnique,
    },
    tradingAccountAllocation: {
      findFirst: mocks.allocationFindFirst,
    },
    tradingAccountSubscription: {
      create: mocks.accountSubscriptionCreate,
      findFirst: mocks.accountSubscriptionFindFirst,
      findMany: mocks.accountSubscriptionFindMany,
      update: mocks.accountSubscriptionUpdate,
    },
  },
}));

vi.mock('./trading-account-risk-configuration.service.js', () => ({
  assertAccountRiskConfiguration: mocks.assertAccountRiskConfiguration,
  withAccountRiskConfigurationTransaction: vi.fn((operation) =>
    operation({
      tradingAccount: { findUnique: mocks.tradingAccountFindUnique },
      subscription: { findUnique: mocks.subscriptionFindUnique },
      tradingAccountAllocation: { findFirst: mocks.allocationFindFirst },
      tradingAccountSubscription: {
        create: mocks.accountSubscriptionCreate,
        findFirst: mocks.accountSubscriptionFindFirst,
        update: mocks.accountSubscriptionUpdate,
      },
    })
  ),
}));

import {
  createTradingAccountSubscriptionForAdmin,
  getTradingAccountSubscriptionForAdmin,
  listTradingAccountSubscriptionsForAdmin,
  updateTradingAccountSubscriptionForAdmin,
} from './trading-account-subscription.service.js';
import {
  createTradingAccountSubscriptionSchema,
  updateTradingAccountSubscriptionSchema,
} from '../validators/trading-account.schema.js';

function accountSubscriptionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    tradingAccountId: 1,
    subscriptionId: 30,
    allocationId: 10,
    enabled: true,
    entriesEnabled: true,
    exitsEnabled: true,
    sizingType: PositionSizingType.FIXED_QTY,
    fixedQty: 1,
    maxPositionNotional: null,
    reservedNotional: 2_000,
    minPositionNotional: null,
    maxQty: null,
    notes: null,
    createdAt: new Date('2026-06-30T00:00:00.000Z'),
    updatedAt: new Date('2026-06-30T00:00:00.000Z'),
    subscription: {
      id: 30,
      key: 'spy-swing',
      symbol: 'SPY',
      enabled: true,
      strategy: {
        id: 40,
        key: 'swing',
        name: 'Swing',
      },
      exitProfile: {
        id: 50,
        key: 'standard',
        name: 'Standard',
      },
    },
    allocation: {
      id: 10,
      key: 'momentum',
      name: 'Momentum',
      enabled: true,
      maxAllocatedNotional: 10_000,
      maxOpenPositions: 4,
      maxPositionNotional: 2_500,
    },
    ...overrides,
  };
}

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      target: ['tradingAccountId', 'subscriptionId'],
    },
  });
}

describe('trading account subscription validators', () => {
  it('accepts valid FIXED_QTY create requests', () => {
    expect(
      createTradingAccountSubscriptionSchema.parse({
        subscriptionId: '30',
        allocationId: '10',
        fixedQty: '2',
        reservedNotional: '5000',
        minPositionNotional: '0',
      })
    ).toEqual({
      subscriptionId: 30,
      allocationId: 10,
      fixedQty: 2,
      reservedNotional: 5000,
      minPositionNotional: 0,
    });
  });

  it('requires fixedQty for FIXED_QTY create requests', () => {
    expect(() =>
      createTradingAccountSubscriptionSchema.parse({
        subscriptionId: 30,
        sizingType: PositionSizingType.FIXED_QTY,
      })
    ).toThrow();
  });

  it('requires maxPositionNotional for MAX_NOTIONAL create requests', () => {
    expect(() =>
      createTradingAccountSubscriptionSchema.parse({
        subscriptionId: 30,
        sizingType: PositionSizingType.MAX_NOTIONAL,
      })
    ).toThrow();
  });

  it('rejects invalid guardrail values and empty updates', () => {
    expect(() =>
      createTradingAccountSubscriptionSchema.parse({
        subscriptionId: 30,
        fixedQty: 1,
        maxQty: 0,
      })
    ).toThrow();

    expect(() => updateTradingAccountSubscriptionSchema.parse({})).toThrow();
  });
});

describe('trading account subscription service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tradingAccountFindUnique.mockResolvedValue({ id: 1 });
    mocks.subscriptionFindUnique.mockResolvedValue({ id: 30 });
    mocks.allocationFindFirst.mockResolvedValue({ id: 10 });
    mocks.accountSubscriptionFindMany.mockResolvedValue([]);
    mocks.accountSubscriptionFindFirst.mockResolvedValue({
      id: 20,
      allocationId: 10,
      enabled: true,
      entriesEnabled: true,
      sizingType: PositionSizingType.FIXED_QTY,
      fixedQty: 1,
      maxPositionNotional: null,
      reservedNotional: 2_000,
    });
    mocks.accountSubscriptionCreate.mockResolvedValue(accountSubscriptionRecord());
    mocks.accountSubscriptionUpdate.mockResolvedValue(accountSubscriptionRecord());
    mocks.assertAccountRiskConfiguration.mockResolvedValue(true);
  });

  it('lists account subscriptions with joined subscription and allocation context', async () => {
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      accountSubscriptionRecord(),
    ]);

    await expect(listTradingAccountSubscriptionsForAdmin(1)).resolves.toEqual([
      expect.objectContaining({
        id: 20,
        tradingAccountId: 1,
        reservedNotional: 2_000,
        subscription: {
          id: 30,
          key: 'spy-swing',
          symbol: 'SPY',
          enabled: true,
          strategy: {
            id: 40,
            key: 'swing',
            name: 'Swing',
          },
          exitProfile: {
            id: 50,
            key: 'standard',
            name: 'Standard',
          },
        },
        allocation: {
          id: 10,
          key: 'momentum',
          name: 'Momentum',
          enabled: true,
          maxAllocatedNotional: 10_000,
          maxOpenPositions: 4,
          maxPositionNotional: 2_500,
        },
      }),
    ]);

    expect(mocks.accountSubscriptionFindMany).toHaveBeenCalledWith({
      where: { tradingAccountId: 1 },
      select: expect.any(Object),
      orderBy: [{ enabled: 'desc' }, { id: 'asc' }],
    });
  });

  it('returns null when listing account subscriptions for a missing account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(
      listTradingAccountSubscriptionsForAdmin(404)
    ).resolves.toBeNull();
    expect(mocks.accountSubscriptionFindMany).not.toHaveBeenCalled();
  });

  it('reads an account subscription by account scope', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord()
    );

    await expect(getTradingAccountSubscriptionForAdmin(1, 20)).resolves.toEqual(
      expect.objectContaining({
        id: 20,
        subscriptionId: 30,
        allocationId: 10,
      })
    );

    expect(mocks.accountSubscriptionFindFirst).toHaveBeenCalledWith({
      where: {
        id: 20,
        tradingAccountId: 1,
      },
      select: expect.any(Object),
    });
  });

  it('creates account subscriptions with FIXED_QTY normalization', async () => {
    const result = await createTradingAccountSubscriptionForAdmin(1, {
      subscriptionId: 30,
      allocationId: 10,
      fixedQty: 2,
      maxPositionNotional: 5_000,
      reservedNotional: 4_000,
      maxQty: 10,
      notes: 'Initial account subscription.',
    });

    expect(mocks.accountSubscriptionCreate).toHaveBeenCalledWith({
      data: {
        tradingAccountId: 1,
        subscriptionId: 30,
        sizingType: PositionSizingType.FIXED_QTY,
        fixedQty: 2,
        maxPositionNotional: null,
        enabled: true,
        entriesEnabled: true,
        exitsEnabled: true,
        allocationId: 10,
        reservedNotional: 4_000,
        maxQty: 10,
        notes: 'Initial account subscription.',
      },
      select: expect.any(Object),
    });
    expect(result).toEqual(
      expect.objectContaining({
        sizingType: PositionSizingType.FIXED_QTY,
        fixedQty: 1,
        maxPositionNotional: null,
        reservedNotional: 2_000,
      })
    );
  });

  it('creates account subscriptions with MAX_NOTIONAL normalization', async () => {
    mocks.accountSubscriptionCreate.mockResolvedValue(
      accountSubscriptionRecord({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 5_000,
      })
    );

    await createTradingAccountSubscriptionForAdmin(1, {
      subscriptionId: 30,
      sizingType: PositionSizingType.MAX_NOTIONAL,
      maxPositionNotional: 5_000,
    });

    expect(mocks.accountSubscriptionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 5_000,
      }),
      select: expect.any(Object),
    });
  });

  it('returns null when creating account subscriptions for a missing account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(
      createTradingAccountSubscriptionForAdmin(404, {
        subscriptionId: 30,
        fixedQty: 1,
      })
    ).resolves.toBeNull();
    expect(mocks.accountSubscriptionCreate).not.toHaveBeenCalled();
  });

  it('returns not found when creating with a missing subscription', async () => {
    mocks.subscriptionFindUnique.mockResolvedValue(null);

    await expect(
      createTradingAccountSubscriptionForAdmin(1, {
        subscriptionId: 404,
        fixedQty: 1,
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      message: 'Subscription not found.',
    });
  });

  it('rejects allocations from another trading account', async () => {
    mocks.assertAccountRiskConfiguration.mockRejectedValue(
      Object.assign(new Error('Account risk configuration is invalid.'), {
        statusCode: 409,
        details: {
          violations: [
            { code: 'ACCOUNT_SUBSCRIPTION_ALLOCATION_ACCOUNT_MISMATCH' },
          ],
        },
      })
    );

    await expect(
      createTradingAccountSubscriptionForAdmin(1, {
        subscriptionId: 30,
        allocationId: 99,
        fixedQty: 1,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      details: {
        violations: [
          { code: 'ACCOUNT_SUBSCRIPTION_ALLOCATION_ACCOUNT_MISMATCH' },
        ],
      },
    });
  });

  it('maps duplicate account subscription rows to a clean conflict', async () => {
    mocks.accountSubscriptionCreate.mockRejectedValue(uniqueConstraintError());

    await expect(
      createTradingAccountSubscriptionForAdmin(1, {
        subscriptionId: 30,
        fixedQty: 1,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message:
        'Trading account subscription already exists for this account and subscription.',
    });
  });

  it('updates safe mutable account subscription fields without touching identity fields', async () => {
    await updateTradingAccountSubscriptionForAdmin(1, 20, {
      allocationId: null,
      enabled: false,
      entriesEnabled: false,
      exitsEnabled: true,
      minPositionNotional: 0,
      maxQty: 5,
      notes: null,
    });

    expect(mocks.accountSubscriptionUpdate).toHaveBeenCalledWith({
      where: { id: 20 },
      data: {
        allocationId: null,
        enabled: false,
        entriesEnabled: false,
        exitsEnabled: true,
        minPositionNotional: 0,
        maxQty: 5,
        notes: null,
      },
      select: expect.any(Object),
    });
  });

  it('normalizes opposite sizing fields when switching to MAX_NOTIONAL', async () => {
    mocks.accountSubscriptionUpdate.mockResolvedValue(
      accountSubscriptionRecord({
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 8_000,
      })
    );

    await updateTradingAccountSubscriptionForAdmin(1, 20, {
      sizingType: PositionSizingType.MAX_NOTIONAL,
      maxPositionNotional: 8_000,
    });

    expect(mocks.accountSubscriptionUpdate).toHaveBeenCalledWith({
      where: { id: 20 },
      data: {
        sizingType: PositionSizingType.MAX_NOTIONAL,
        fixedQty: null,
        maxPositionNotional: 8_000,
      },
      select: expect.any(Object),
    });
  });

  it('normalizes opposite sizing fields when switching to FIXED_QTY', async () => {
    mocks.accountSubscriptionFindFirst.mockResolvedValue({
      id: 20,
      sizingType: PositionSizingType.MAX_NOTIONAL,
      fixedQty: null,
      maxPositionNotional: 8_000,
    });

    await updateTradingAccountSubscriptionForAdmin(1, 20, {
      sizingType: PositionSizingType.FIXED_QTY,
      fixedQty: 3,
    });

    expect(mocks.accountSubscriptionUpdate).toHaveBeenCalledWith({
      where: { id: 20 },
      data: {
        sizingType: PositionSizingType.FIXED_QTY,
        fixedQty: 3,
        maxPositionNotional: null,
      },
      select: expect.any(Object),
    });
  });

  it('rejects incomplete sizing switches', async () => {
    await expect(
      updateTradingAccountSubscriptionForAdmin(1, 20, {
        sizingType: PositionSizingType.MAX_NOTIONAL,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        'maxPositionNotional must be greater than 0 for MAX_NOTIONAL sizing.',
    });
  });
});
