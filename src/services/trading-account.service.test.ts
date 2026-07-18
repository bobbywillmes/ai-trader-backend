import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Prisma,
  TradingAccountEnvironment,
  TradingAccountStatus,
  TradingBroker,
  type TradingAccount,
} from '@prisma/client';

const mocks = vi.hoisted(() => ({
  env: {} as { DEFAULT_TRADING_ACCOUNT_ID?: number },
  tradingAccountFindFirst: vi.fn(),
  tradingAccountFindMany: vi.fn(),
  tradingAccountFindUnique: vi.fn(),
  tradingAccountUpdate: vi.fn(),
  tradingAccountCreate: vi.fn(),
  userFindUnique: vi.fn(),
  transaction: vi.fn(),
  tradingAccountMembershipFindMany: vi.fn(),
  trackedPositionFindMany: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: mocks.env,
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    user: {
      findUnique: mocks.userFindUnique,
    },
    tradingAccount: {
      create: mocks.tradingAccountCreate,
      findFirst: mocks.tradingAccountFindFirst,
      findMany: mocks.tradingAccountFindMany,
      findUnique: mocks.tradingAccountFindUnique,
      update: mocks.tradingAccountUpdate,
    },
    tradingAccountMembership: {
      findMany: mocks.tradingAccountMembershipFindMany,
    },
    trackedPosition: {
      findMany: mocks.trackedPositionFindMany,
    },
  },
}));

vi.mock('./trading-account-risk-configuration.service.js', () => ({
  assertAccountRiskConfiguration: vi.fn().mockResolvedValue(true),
  withAccountRiskConfigurationTransaction: vi.fn((operation) =>
    operation({
      tradingAccount: {
        findUnique: mocks.tradingAccountFindUnique,
        update: mocks.tradingAccountUpdate,
      },
    })
  ),
}));

import {
  createTradingAccountForAdmin,
  getTradingAccountForAdmin,
  listTradingAccountsForAdmin,
  listTradingAccountsForUser,
  resolveDefaultTradingAccount,
  resolveDefaultTradingAccountId,
  updateTradingAccountForAdmin,
} from './trading-account.service.js';

function tradingAccount(overrides: Partial<TradingAccount> = {}): TradingAccount {
  return {
    id: 1,
    accountHolderUserId: 1,
    displayName: 'Bobby Paper',
    broker: TradingBroker.ALPACA,
    environment: TradingAccountEnvironment.PAPER,
    status: TradingAccountStatus.ACTIVE,
    tradingEnabled: false,
    killSwitchEnabled: true,
    estimatedTradingCapital: null,
    maxDeployableNotional: null,
    baseCurrency: 'USD',
    brokerAccountId: null,
    brokerAccountNumberMasked: null,
    brokerAccountStatus: null,
    lastBrokerSyncAt: null,
    lastCash: null,
    lastBuyingPower: null,
    lastEquity: null,
    lastPortfolioValue: null,
    tradingBlocked: null,
    pausedReason: null,
    notes: null,
    createdAt: new Date('2026-06-27T00:00:00.000Z'),
    updatedAt: new Date('2026-06-27T00:00:00.000Z'),
    ...overrides,
  };
}

describe('trading account service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete mocks.env.DEFAULT_TRADING_ACCOUNT_ID;
    mocks.tradingAccountFindFirst.mockResolvedValue(null);
    mocks.tradingAccountFindMany.mockResolvedValue([]);
    mocks.tradingAccountFindUnique.mockResolvedValue(null);
    mocks.tradingAccountUpdate.mockResolvedValue({
      ...tradingAccount(),
      credential: null,
    });
    mocks.tradingAccountMembershipFindMany.mockResolvedValue([]);
    mocks.trackedPositionFindMany.mockResolvedValue([]);
    mocks.userFindUnique.mockResolvedValue({ id: 1, enabled: true });
    mocks.tradingAccountCreate.mockResolvedValue({ id: 10 });
    mocks.transaction.mockImplementation((operation) =>
      operation({
        user: { findUnique: mocks.userFindUnique },
        tradingAccount: {
          findFirst: mocks.tradingAccountFindFirst,
          create: mocks.tradingAccountCreate,
        },
      })
    );
  });

  it('resolves the configured default trading account id first', async () => {
    mocks.env.DEFAULT_TRADING_ACCOUNT_ID = 7;
    const account = tradingAccount({ id: 7, displayName: 'Configured Account' });
    mocks.tradingAccountFindUnique.mockResolvedValue(account);

    await expect(resolveDefaultTradingAccount()).resolves.toBe(account);

    expect(mocks.tradingAccountFindUnique).toHaveBeenCalledWith({
      where: { id: 7 },
    });
    expect(mocks.tradingAccountFindFirst).not.toHaveBeenCalled();
  });

  it('falls back to the bootstrapped Bobby Paper trading account', async () => {
    const account = tradingAccount();
    mocks.tradingAccountFindFirst.mockResolvedValue(account);

    await expect(resolveDefaultTradingAccountId()).resolves.toBe(1);

    expect(mocks.tradingAccountFindFirst).toHaveBeenCalledWith({
      where: {
        broker: TradingBroker.ALPACA,
        environment: TradingAccountEnvironment.PAPER,
        displayName: 'Bobby Paper',
        status: TradingAccountStatus.ACTIVE,
      },
      orderBy: {
        id: 'asc',
      },
    });
  });

  it('throws a clear operational error when no default account can be resolved', async () => {
    await expect(resolveDefaultTradingAccount()).rejects.toThrow(
      'Default trading account could not be resolved'
    );
    await expect(resolveDefaultTradingAccount()).rejects.toThrow(
      'scripts/bootstrap-default-trading-account.ts'
    );
  });

  it('lists admin trading account summaries without credential ciphertext', async () => {
    const verifiedAt = new Date('2026-06-27T01:00:00.000Z');
    const account = {
      ...tradingAccount({ brokerAccountId: 'account-1' }),
      accountHolder: { name: 'Bobby W' },
      credential: {
        status: 'ACTIVE',
        authType: 'API_KEY',
        keyFingerprint: 'sha256:fingerprint',
        verifiedAt,
        lastUsedAt: null,
        lastFailedAt: null,
        revokedAt: null,
        apiKeyCiphertext: 'must-not-leak',
        apiSecretCiphertext: 'must-not-leak',
      },
    };
    mocks.tradingAccountFindMany.mockResolvedValue([account]);
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        tradingAccountId: 1,
        marketValue: 1_200,
        costBasis: 1_100,
      },
      {
        tradingAccountId: 1,
        marketValue: 0,
        costBasis: 300,
      },
    ]);

    await expect(listTradingAccountsForAdmin()).resolves.toEqual([
      expect.objectContaining({
        id: 1,
        accountHolderName: 'Bobby W',
        brokerAccountId: 'account-1',
        totalOpenPositionNotional: 1_500,
        credential: {
          exists: true,
          status: 'ACTIVE',
          authType: 'API_KEY',
          keyFingerprint: 'sha256:fingerprint',
          verifiedAt,
          lastUsedAt: null,
          lastFailedAt: null,
          revokedAt: null,
        },
      }),
    ]);
    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith({
      where: {
        tradingAccountId: {
          in: [1],
        },
        status: {
          in: ['open', 'closing'],
        },
      },
      select: {
        tradingAccountId: true,
        marketValue: true,
        costBasis: true,
      },
    });
    expect(JSON.stringify(await listTradingAccountsForAdmin())).not.toContain(
      'must-not-leak'
    );
  });

  it('returns a safe empty credential summary when no credential exists', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      ...tradingAccount({ maxDeployableNotional: 20_000 }),
      accountHolder: { name: 'Bobby W' },
      credential: null,
      allocations: [
        { maxAllocatedNotional: 7_500 },
        { maxAllocatedNotional: 2_500 },
      ],
    });
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        tradingAccountId: 1,
        marketValue: 750,
        costBasis: 700,
      },
    ]);

    await expect(getTradingAccountForAdmin(1)).resolves.toEqual(
      expect.objectContaining({
        id: 1,
        maxDeployableNotional: 20_000,
        enabledAllocatedNotional: 10_000,
        remainingDeployableNotional: 10_000,
        totalOpenPositionNotional: 750,
        credential: {
          exists: false,
          status: null,
          authType: null,
          keyFingerprint: null,
          verifiedAt: null,
          lastUsedAt: null,
          lastFailedAt: null,
          revokedAt: null,
        },
      })
    );
    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith({
      where: {
        tradingAccountId: 1,
        status: {
          in: ['open', 'closing'],
        },
      },
      select: {
        tradingAccountId: true,
        marketValue: true,
        costBasis: true,
      },
    });
    expect(mocks.tradingAccountFindUnique).toHaveBeenLastCalledWith({
      where: { id: 1 },
      select: expect.objectContaining({
        credential: expect.objectContaining({
          select: expect.not.objectContaining({
            apiKeyCiphertext: true,
            apiSecretCiphertext: true,
          }),
        }),
      }),
    });
  });

  it('returns all trading accounts for system owners without querying memberships', async () => {
    mocks.tradingAccountFindMany.mockResolvedValue([
      { ...tradingAccount({ id: 1, displayName: 'Bobby Paper' }), accountHolder: { name: 'Bobby W' }, credential: null },
      { ...tradingAccount({ id: 2, displayName: 'Bobby Live' }), accountHolder: { name: 'Bobby W' }, credential: null },
    ]);

    await expect(
      listTradingAccountsForUser({
        userId: 42,
        isSystemOwner: true,
      })
    ).resolves.toEqual([
      expect.objectContaining({ id: 1, displayName: 'Bobby Paper' }),
      expect.objectContaining({ id: 2, displayName: 'Bobby Live' }),
    ]);

    expect(mocks.tradingAccountMembershipFindMany).not.toHaveBeenCalled();
  });

  it('filters trading account lists to memberships for non-owner users', async () => {
    mocks.tradingAccountFindMany.mockResolvedValue([
      { ...tradingAccount({ id: 1, displayName: 'Bobby Paper' }), accountHolder: { name: 'Bobby W' }, credential: null },
      { ...tradingAccount({ id: 2, displayName: 'Unassigned Account' }), accountHolder: { name: null }, credential: null },
    ]);
    mocks.tradingAccountMembershipFindMany.mockResolvedValue([
      { tradingAccountId: 1 },
    ]);

    await expect(
      listTradingAccountsForUser({
        userId: 42,
        isSystemOwner: false,
      })
    ).resolves.toEqual([
      expect.objectContaining({ id: 1, displayName: 'Bobby Paper' }),
    ]);

    expect(mocks.tradingAccountMembershipFindMany).toHaveBeenCalledWith({
      where: {
        userId: 42,
      },
      select: {
        tradingAccountId: true,
      },
    });
  });

  it('updates only safe admin trading account fields', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({ id: 1 });
    mocks.tradingAccountUpdate.mockResolvedValue({
      ...tradingAccount({
        displayName: 'Updated Paper',
        status: TradingAccountStatus.PAUSED,
        tradingEnabled: false,
        killSwitchEnabled: true,
        estimatedTradingCapital: 25_000,
        maxDeployableNotional: 20_000,
        pausedReason: 'credential rotation',
        notes: null,
      }),
      accountHolder: { name: 'Bobby W' },
      credential: null,
    });
    const result = await updateTradingAccountForAdmin(1, {
      displayName: 'Updated Paper',
      status: TradingAccountStatus.PAUSED,
      tradingEnabled: false,
      killSwitchEnabled: true,
      estimatedTradingCapital: 25_000,
      maxDeployableNotional: 20_000,
      pausedReason: 'credential rotation',
      notes: null,
    });

    expect(mocks.tradingAccountUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        displayName: 'Updated Paper',
        status: TradingAccountStatus.PAUSED,
        tradingEnabled: false,
        killSwitchEnabled: true,
        estimatedTradingCapital: 25_000,
        maxDeployableNotional: 20_000,
        pausedReason: 'credential rotation',
        notes: null,
      },
      select: expect.any(Object),
    });
    expect(result).toEqual(
      expect.objectContaining({
        displayName: 'Updated Paper',
        status: TradingAccountStatus.PAUSED,
        credential: expect.objectContaining({ exists: false }),
      })
    );
  });

  describe('creation', () => {
    function createdAccount(environment: TradingAccountEnvironment) {
      return {
        ...tradingAccount({
          id: 10,
          environment,
          status: TradingAccountStatus.NEEDS_CREDENTIALS,
          displayName: environment === TradingAccountEnvironment.PAPER ? 'Bobby Paper' : 'Bobby Live',
        }),
        accountHolder: { name: 'Bobby W' },
        credential: null,
        allocations: [],
      };
    }

    async function create(environment: TradingAccountEnvironment) {
      mocks.tradingAccountFindUnique.mockResolvedValue(createdAccount(environment));
      return createTradingAccountForAdmin({
        accountHolderUserId: 1,
        displayName: environment === TradingAccountEnvironment.PAPER ? 'Bobby Paper' : 'Bobby Live',
        environment,
        estimatedTradingCapital: 5_000,
        maxDeployableNotional: 5_000,
        notes: 'Initial account',
      });
    }

    it.each([TradingAccountEnvironment.PAPER, TradingAccountEnvironment.LIVE])(
      'allows a System Owner service caller to provision an Alpaca %s account with safe defaults',
      async (environment) => {
        await expect(create(environment)).resolves.toEqual(
          expect.objectContaining({ environment, status: TradingAccountStatus.NEEDS_CREDENTIALS })
        );
        expect(mocks.tradingAccountCreate).toHaveBeenCalledWith({
          data: expect.objectContaining({
            accountHolderUserId: 1,
            broker: TradingBroker.ALPACA,
            environment,
            status: TradingAccountStatus.NEEDS_CREDENTIALS,
            tradingEnabled: false,
            killSwitchEnabled: true,
            baseCurrency: 'USD',
            memberships: { create: { userId: 1 } },
          }),
          select: { id: true },
        });
      }
    );

    it('rejects a missing account holder before creating anything', async () => {
      mocks.userFindUnique.mockResolvedValue(null);
      await expect(create(TradingAccountEnvironment.PAPER)).rejects.toMatchObject({ statusCode: 404 });
      expect(mocks.tradingAccountCreate).not.toHaveBeenCalled();
    });

    it('rejects a disabled account holder before creating anything', async () => {
      mocks.userFindUnique.mockResolvedValue({ id: 1, enabled: false });
      await expect(create(TradingAccountEnvironment.PAPER)).rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.tradingAccountCreate).not.toHaveBeenCalled();
    });

    it('creates the account-holder membership atomically in the account transaction', async () => {
      await create(TradingAccountEnvironment.PAPER);
      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.tradingAccountCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ memberships: { create: { userId: 1 } } }) })
      );
    });

    it('propagates provisioning failures without returning a partially created account', async () => {
      mocks.tradingAccountCreate.mockRejectedValue(new Error('membership insert failed'));
      await expect(create(TradingAccountEnvironment.PAPER)).rejects.toThrow('membership insert failed');
      expect(mocks.tradingAccountFindUnique).not.toHaveBeenCalled();
    });

    it.each([TradingAccountEnvironment.PAPER, TradingAccountEnvironment.LIVE])(
      'returns a readable conflict for a duplicate Alpaca %s account',
      async (environment) => {
        mocks.tradingAccountFindFirst.mockResolvedValue({ id: 9 });
        await expect(create(environment)).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringContaining(environment === TradingAccountEnvironment.PAPER ? 'Paper' : 'Live'),
        });
        expect(mocks.tradingAccountCreate).not.toHaveBeenCalled();
      }
    );

    it('permits one Paper and one Live account for the same holder', async () => {
      await create(TradingAccountEnvironment.PAPER);
      await create(TradingAccountEnvironment.LIVE);
      expect(mocks.tradingAccountCreate).toHaveBeenCalledTimes(2);
      expect(mocks.tradingAccountFindFirst.mock.calls.map(([query]) => query.where.environment)).toEqual([
        TradingAccountEnvironment.PAPER,
        TradingAccountEnvironment.LIVE,
      ]);
    });

    it('checks holder identity rather than membership access for duplicates', async () => {
      await create(TradingAccountEnvironment.PAPER);
      expect(mocks.tradingAccountFindFirst).toHaveBeenCalledWith({
        where: { accountHolderUserId: 1, broker: TradingBroker.ALPACA, environment: TradingAccountEnvironment.PAPER },
        select: { id: true },
      });
      expect(mocks.tradingAccountMembershipFindMany).not.toHaveBeenCalled();
    });

    it('translates a concurrent Prisma unique violation into the domain conflict', async () => {
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.8.0',
        meta: { target: 'TradingAccount_holder_broker_environment_key' },
      });
      mocks.tradingAccountCreate.mockRejectedValue(error);
      await expect(create(TradingAccountEnvironment.LIVE)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('Alpaca Live'),
      });
    });
  });

  it('returns null instead of updating a missing trading account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(
      updateTradingAccountForAdmin(404, {
        displayName: 'Missing Account',
      })
    ).resolves.toBeNull();
    expect(mocks.tradingAccountUpdate).not.toHaveBeenCalled();
  });
});
