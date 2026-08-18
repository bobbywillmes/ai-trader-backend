import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Prisma,
  TradingAccountEnvironment,
  TradingAccountStatus,
  TradingBroker,
  type TradingAccount,
} from '@prisma/client';

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  tradingAccountFindFirst: vi.fn(),
  tradingAccountFindMany: vi.fn(),
  tradingAccountFindUnique: vi.fn(),
  tradingAccountUpdate: vi.fn(),
  tradingAccountCreate: vi.fn(),
  userFindUnique: vi.fn(),
  transaction: vi.fn(),
  tradingAccountMembershipFindMany: vi.fn(),
  trackedPositionFindMany: vi.fn(),
  orderIntentUpdateMany: vi.fn(),
  accountSubscriptionUpdateMany: vi.fn(),
  queryRaw: vi.fn(),
  readinessAssessmentFindFirst: vi.fn(),
  count: vi.fn(),
  computeReadinessFingerprints: vi.fn(),
  getLiveWriteApprovalState: vi.fn(),
  systemEventCreate: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: mocks.env,
}));
vi.mock('./live-write-approval.service.js', () => ({
  LiveWriteCapability: { RISK_REDUCING: 'RISK_REDUCING', ENTRY: 'ENTRY' },
  invalidateLiveWriteApprovals: vi.fn(),
  getLiveWriteApprovalState: mocks.getLiveWriteApprovalState,
}));
vi.mock('./trading-account-readiness.service.js', () => ({
  CREDENTIAL_VERIFICATION_MAX_AGE_MS: 15 * 60_000,
  READINESS_ASSESSMENT_VERSION: 1,
  computeReadinessFingerprints: mocks.computeReadinessFingerprints,
}));
vi.mock('./trading-account-workflow-lock.service.js', () => ({
  ACCOUNT_WORKFLOW_LOCK_FAMILIES: { OPERATIONAL_STATE: 'operational-state' },
  withTradingAccountWorkflowLock: vi.fn(async ({ execute }) => ({
    outcome: 'ACQUIRED_AND_COMPLETED',
    value: await execute(),
    scope: 'test',
  })),
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
    orderIntent: {
      updateMany: mocks.orderIntentUpdateMany,
    },
    systemEvent: {
      create: mocks.systemEventCreate,
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
      orderIntent: {
        updateMany: mocks.orderIntentUpdateMany,
        count: mocks.count,
      },
      tradingAccountSubscription: {
        updateMany: mocks.accountSubscriptionUpdateMany,
      },
      tradingAccountReadinessAssessment: {
        findFirst: mocks.readinessAssessmentFindFirst,
      },
      trackedPosition: { count: mocks.count },
      brokerOrder: { count: mocks.count },
      positionExitState: { count: mocks.count },
      systemEvent: {
        create: mocks.systemEventCreate,
      },
      $queryRaw: mocks.queryRaw,
    }),
  ),
}));

import {
  activateTradingAccountForAdmin,
  createTradingAccountForAdmin,
  deactivateTradingAccountForAdmin,
  getTradingAccountForAdmin,
  listTradingAccountsForAdmin,
  listTradingAccountsForUser,
  resolveDefaultTradingAccount,
  resolveDefaultTradingAccountId,
  updateTradingAccountForAdmin,
} from './trading-account.service.js';

function tradingAccount(
  overrides: Partial<TradingAccount> = {},
): TradingAccount {
  return {
    activeLiveEntryArmingId: null,
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
    mocks.accountSubscriptionUpdateMany.mockResolvedValue({ count: 0 });
    mocks.queryRaw.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
    mocks.orderIntentUpdateMany.mockResolvedValue({ count: 0 });
    mocks.systemEventCreate.mockResolvedValue({ id: 100 });
    mocks.userFindUnique.mockResolvedValue({ id: 1, enabled: true });
    mocks.tradingAccountCreate.mockResolvedValue({ id: 10 });
    mocks.transaction.mockImplementation((operation) =>
      operation({
        user: { findUnique: mocks.userFindUnique },
        tradingAccount: {
          findFirst: mocks.tradingAccountFindFirst,
          create: mocks.tradingAccountCreate,
        },
      }),
    );
  });

  it('resolves the configured default trading account id first', async () => {
    mocks.env.DEFAULT_TRADING_ACCOUNT_ID = 7;
    const account = tradingAccount({
      id: 7,
      displayName: 'Configured Account',
    });
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
      'Default trading account could not be resolved',
    );
    await expect(resolveDefaultTradingAccount()).rejects.toThrow(
      'scripts/bootstrap-default-trading-account.ts',
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
      'must-not-leak',
    );
  });

  it('returns a safe empty credential summary when no credential exists', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      ...tradingAccount({ maxDeployableNotional: 20_000 }),
      accountHolder: { name: 'Bobby W' },
      credential: null,
      liveEntryArmings: [{
        id: 9,
        entryApprovalRevision: 2,
        tradingAccountSubscriptionId: 4,
        entryApprovalExpiresAt: new Date('2026-08-18T20:00:00.000Z'),
        armedAt: new Date('2026-08-18T19:00:00.000Z'),
        terminations: [{ type: 'CONSUMED', occurredAt: new Date('2026-08-18T19:05:00.000Z') }],
      }],
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
        latestLiveEntryArming: expect.objectContaining({ id: 9, terminations: [expect.objectContaining({ type: 'CONSUMED' })] }),
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
      }),
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
      {
        ...tradingAccount({ id: 1, displayName: 'Bobby Paper' }),
        accountHolder: { name: 'Bobby W' },
        credential: null,
      },
      {
        ...tradingAccount({ id: 2, displayName: 'Bobby Live' }),
        accountHolder: { name: 'Bobby W' },
        credential: null,
      },
    ]);

    await expect(
      listTradingAccountsForUser({
        userId: 42,
        isSystemOwner: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 1, displayName: 'Bobby Paper' }),
      expect.objectContaining({ id: 2, displayName: 'Bobby Live' }),
    ]);

    expect(mocks.tradingAccountMembershipFindMany).not.toHaveBeenCalled();
  });

  it('filters trading account lists to memberships for non-owner users', async () => {
    mocks.tradingAccountFindMany.mockResolvedValue([
      {
        ...tradingAccount({ id: 1, displayName: 'Bobby Paper' }),
        accountHolder: { name: 'Bobby W' },
        credential: null,
      },
      {
        ...tradingAccount({ id: 2, displayName: 'Unassigned Account' }),
        accountHolder: { name: null },
        credential: null,
      },
    ]);
    mocks.tradingAccountMembershipFindMany.mockResolvedValue([
      { tradingAccountId: 1 },
    ]);

    await expect(
      listTradingAccountsForUser({
        userId: 42,
        isSystemOwner: false,
      }),
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
      estimatedTradingCapital: 25_000,
      maxDeployableNotional: 20_000,
      pausedReason: 'credential rotation',
      notes: null,
    });

    expect(mocks.tradingAccountUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        displayName: 'Updated Paper',
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
      }),
    );
  });

  describe('Live activation', () => {
    const updatedAt = new Date('2026-08-16T19:00:00.000Z');
    const fingerprints = {
      configurationFingerprint: 'a'.repeat(64),
      credentialFingerprint: 'b'.repeat(64),
      policyFingerprint: 'c'.repeat(64),
    };

    beforeEach(() => {
      Object.assign(mocks.env, {
        NODE_ENV: 'production',
        LIVE_WRITE_DEPLOYMENT_ROLE: 'PRODUCTION_EXECUTOR',
        ALLOW_LIVE_RISK_REDUCING_WRITES: true,
        ALLOW_LIVE_TRADING: false,
      });
      mocks.tradingAccountFindUnique.mockResolvedValue({
        ...tradingAccount({
          environment: TradingAccountEnvironment.LIVE,
          status: TradingAccountStatus.PAUSED,
          tradingEnabled: false,
          killSwitchEnabled: true,
          updatedAt,
        }),
        credential: {
          status: 'ACTIVE',
          revokedAt: null,
          verifiedAt: new Date(),
        },
        accountSubscriptions: [
          { id: 8, entriesEnabled: false, exitsEnabled: true },
        ],
      });
      mocks.readinessAssessmentFindFirst.mockResolvedValue({
        id: 12,
        result: 'PASSED',
        assessmentVersion: 1,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        ...fingerprints,
      });
      mocks.computeReadinessFingerprints.mockResolvedValue(fingerprints);
      mocks.getLiveWriteApprovalState.mockResolvedValue({
        capabilities: [
          {
            capability: 'RISK_REDUCING',
            effective: true,
            approval: { revision: 2 },
          },
          {
            capability: 'ENTRY',
            effective: false,
            reason: 'MISSING',
            approval: null,
          },
        ],
      });
    });

    it('activates only status while preserving disarmed latches and audit evidence', async () => {
      await expect(
        activateTradingAccountForAdmin(
          1,
          {
            readinessAssessmentId: 12,
            reason: 'First managed activation',
            typedConfirmation: 'ACTIVATE LIVE ACCOUNT',
            expectedUpdatedAt: updatedAt,
          },
          7,
        ),
      ).resolves.toMatchObject({
        outcome: 'activated',
        after: {
          status: 'ACTIVE',
          tradingEnabled: false,
          killSwitchEnabled: true,
        },
      });
      expect(mocks.tradingAccountUpdate).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          status: 'ACTIVE',
          tradingEnabled: false,
          killSwitchEnabled: true,
          pausedReason: null,
        },
      });
      expect(mocks.systemEventCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'trading_account.activated',
          payloadJson: expect.objectContaining({ readinessAssessmentId: 12 }),
        }),
      });
      expect(mocks.accountSubscriptionUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects stale readiness without changing account state', async () => {
      mocks.computeReadinessFingerprints.mockResolvedValue({
        ...fingerprints,
        policyFingerprint: 'd'.repeat(64),
      });
      await expect(
        activateTradingAccountForAdmin(
          1,
          {
            readinessAssessmentId: 12,
            reason: 'Activate',
            typedConfirmation: 'ACTIVATE LIVE ACCOUNT',
            expectedUpdatedAt: updatedAt,
          },
          7,
        ),
      ).rejects.toThrow('readiness evidence is stale');
      expect(mocks.tradingAccountUpdate).not.toHaveBeenCalled();
      expect(mocks.systemEventCreate).not.toHaveBeenCalled();
    });

    it('is idempotent without a duplicate activation audit event', async () => {
      mocks.tradingAccountFindUnique.mockResolvedValue({
        ...tradingAccount({
          environment: TradingAccountEnvironment.LIVE,
          status: TradingAccountStatus.ACTIVE,
          tradingEnabled: false,
          killSwitchEnabled: true,
          updatedAt,
        }),
        credential: null,
        accountSubscriptions: [],
      });
      const result = await activateTradingAccountForAdmin(
        1,
        {
          readinessAssessmentId: 12,
          reason: 'Retry',
          typedConfirmation: 'ACTIVATE LIVE ACCOUNT',
          expectedUpdatedAt: updatedAt,
        },
        7,
      );
      expect(result?.outcome).toBe('already_active_disarmed');
      expect(mocks.systemEventCreate).not.toHaveBeenCalled();
    });
  });

  describe('deactivation', () => {
    it('atomically pauses an active account and blocks only pending buy intents', async () => {
      mocks.tradingAccountFindUnique.mockResolvedValue({
        id: 1,
        environment: TradingAccountEnvironment.LIVE,
        status: TradingAccountStatus.ACTIVE,
        tradingEnabled: true,
        killSwitchEnabled: false,
      });
      mocks.orderIntentUpdateMany.mockResolvedValue({ count: 2 });
      mocks.accountSubscriptionUpdateMany.mockResolvedValue({ count: 3 });

      await expect(
        deactivateTradingAccountForAdmin(1, { reason: 'Emergency pause' }, 7),
      ).resolves.toEqual({
        before: {
          status: TradingAccountStatus.ACTIVE,
          tradingEnabled: true,
          killSwitchEnabled: false,
        },
        after: {
          status: TradingAccountStatus.PAUSED,
          tradingEnabled: false,
          killSwitchEnabled: true,
        },
        affectedPendingEntryIntentCount: 2,
        affectedEntryEnabledAssignmentCount: 3,
      });

      expect(mocks.tradingAccountUpdate).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          status: TradingAccountStatus.PAUSED,
          tradingEnabled: false,
          killSwitchEnabled: true,
        },
      });
      expect(mocks.orderIntentUpdateMany).toHaveBeenCalledWith({
        where: {
          tradingAccountId: 1,
          status: 'pending',
          side: 'buy',
        },
        data: {
          status: 'blocked',
          blockReason: 'Trading account deactivated: Emergency pause',
        },
      });
      expect(mocks.accountSubscriptionUpdateMany).toHaveBeenCalledWith({
        where: { tradingAccountId: 1, entriesEnabled: true },
        data: { entriesEnabled: false },
      });
      expect(mocks.systemEventCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'trading_account.deactivated',
          tradingAccountId: 1,
          actorUserId: 7,
          payloadJson: expect.objectContaining({
            affectedPendingEntryIntentCount: 2,
            affectedEntryEnabledAssignmentCount: 3,
          }),
        }),
      });
    });

    it('is idempotent for an already safely paused account', async () => {
      mocks.tradingAccountFindUnique.mockResolvedValue({
        id: 1,
        status: TradingAccountStatus.PAUSED,
        tradingEnabled: false,
        killSwitchEnabled: true,
      });

      const result = await deactivateTradingAccountForAdmin(
        1,
        { reason: 'Keep paused' },
        7,
      );

      expect(result?.before).toEqual(result?.after);
      expect(result?.affectedPendingEntryIntentCount).toBe(0);
      expect(mocks.systemEventCreate).toHaveBeenCalledOnce();
    });

    it('keeps deactivation state and audit writes in the same transaction', async () => {
      mocks.tradingAccountFindUnique.mockResolvedValue({
        id: 1,
        status: TradingAccountStatus.ACTIVE,
        tradingEnabled: true,
        killSwitchEnabled: false,
      });
      mocks.systemEventCreate.mockRejectedValue(
        new Error('audit insert failed'),
      );

      await expect(
        deactivateTradingAccountForAdmin(1, { reason: 'Pause' }, 7),
      ).rejects.toThrow('audit insert failed');
      expect(mocks.tradingAccountUpdate).toHaveBeenCalledOnce();
      expect(mocks.systemEventCreate).toHaveBeenCalledOnce();
    });
  });

  describe('creation', () => {
    function createdAccount(environment: TradingAccountEnvironment) {
      return {
        ...tradingAccount({
          id: 10,
          environment,
          status: TradingAccountStatus.NEEDS_CREDENTIALS,
          displayName:
            environment === TradingAccountEnvironment.PAPER
              ? 'Bobby Paper'
              : 'Bobby Live',
        }),
        accountHolder: { name: 'Bobby W' },
        credential: null,
        allocations: [],
      };
    }

    async function create(environment: TradingAccountEnvironment) {
      mocks.tradingAccountFindUnique.mockResolvedValue(
        createdAccount(environment),
      );
      return createTradingAccountForAdmin({
        accountHolderUserId: 1,
        displayName:
          environment === TradingAccountEnvironment.PAPER
            ? 'Bobby Paper'
            : 'Bobby Live',
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
          expect.objectContaining({
            environment,
            status: TradingAccountStatus.NEEDS_CREDENTIALS,
          }),
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
      },
    );

    it('rejects a missing account holder before creating anything', async () => {
      mocks.userFindUnique.mockResolvedValue(null);
      await expect(
        create(TradingAccountEnvironment.PAPER),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(mocks.tradingAccountCreate).not.toHaveBeenCalled();
    });

    it('rejects a disabled account holder before creating anything', async () => {
      mocks.userFindUnique.mockResolvedValue({ id: 1, enabled: false });
      await expect(
        create(TradingAccountEnvironment.PAPER),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.tradingAccountCreate).not.toHaveBeenCalled();
    });

    it('creates the account-holder membership atomically in the account transaction', async () => {
      await create(TradingAccountEnvironment.PAPER);
      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.tradingAccountCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memberships: { create: { userId: 1 } },
          }),
        }),
      );
    });

    it('propagates provisioning failures without returning a partially created account', async () => {
      mocks.tradingAccountCreate.mockRejectedValue(
        new Error('membership insert failed'),
      );
      await expect(create(TradingAccountEnvironment.PAPER)).rejects.toThrow(
        'membership insert failed',
      );
      expect(mocks.tradingAccountFindUnique).not.toHaveBeenCalled();
    });

    it.each([TradingAccountEnvironment.PAPER, TradingAccountEnvironment.LIVE])(
      'returns a readable conflict for a duplicate Alpaca %s account',
      async (environment) => {
        mocks.tradingAccountFindFirst.mockResolvedValue({ id: 9 });
        await expect(create(environment)).rejects.toMatchObject({
          statusCode: 409,
          message: expect.stringContaining(
            environment === TradingAccountEnvironment.PAPER ? 'Paper' : 'Live',
          ),
        });
        expect(mocks.tradingAccountCreate).not.toHaveBeenCalled();
      },
    );

    it('permits one Paper and one Live account for the same holder', async () => {
      await create(TradingAccountEnvironment.PAPER);
      await create(TradingAccountEnvironment.LIVE);
      expect(mocks.tradingAccountCreate).toHaveBeenCalledTimes(2);
      expect(
        mocks.tradingAccountFindFirst.mock.calls.map(
          ([query]) => query.where.environment,
        ),
      ).toEqual([
        TradingAccountEnvironment.PAPER,
        TradingAccountEnvironment.LIVE,
      ]);
    });

    it('checks holder identity rather than membership access for duplicates', async () => {
      await create(TradingAccountEnvironment.PAPER);
      expect(mocks.tradingAccountFindFirst).toHaveBeenCalledWith({
        where: {
          accountHolderUserId: 1,
          broker: TradingBroker.ALPACA,
          environment: TradingAccountEnvironment.PAPER,
        },
        select: { id: true },
      });
      expect(mocks.tradingAccountMembershipFindMany).not.toHaveBeenCalled();
    });

    it('translates a concurrent Prisma unique violation into the domain conflict', async () => {
      const error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '7.8.0',
          meta: { target: 'TradingAccount_holder_broker_environment_key' },
        },
      );
      mocks.tradingAccountCreate.mockRejectedValue(error);
      await expect(
        create(TradingAccountEnvironment.LIVE),
      ).rejects.toMatchObject({
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
      }),
    ).resolves.toBeNull();
    expect(mocks.tradingAccountUpdate).not.toHaveBeenCalled();
  });
});
