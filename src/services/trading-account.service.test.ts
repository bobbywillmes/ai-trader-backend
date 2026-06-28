import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
}));

vi.mock('../config/env.js', () => ({
  env: mocks.env,
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findFirst: mocks.tradingAccountFindFirst,
      findMany: mocks.tradingAccountFindMany,
      findUnique: mocks.tradingAccountFindUnique,
      update: mocks.tradingAccountUpdate,
    },
  },
}));

import {
  getTradingAccountForAdmin,
  listTradingAccountsForAdmin,
  resolveDefaultTradingAccount,
  resolveDefaultTradingAccountId,
  updateTradingAccountForAdmin,
} from './trading-account.service.js';

function tradingAccount(overrides: Partial<TradingAccount> = {}): TradingAccount {
  return {
    id: 1,
    ownerAdminUserId: 1,
    displayName: 'Bobby Paper',
    broker: TradingBroker.ALPACA,
    environment: TradingAccountEnvironment.PAPER,
    status: TradingAccountStatus.ACTIVE,
    tradingEnabled: false,
    killSwitchEnabled: true,
    estimatedTradingCapital: null,
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

    await expect(listTradingAccountsForAdmin()).resolves.toEqual([
      expect.objectContaining({
        id: 1,
        brokerAccountId: 'account-1',
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
    expect(JSON.stringify(await listTradingAccountsForAdmin())).not.toContain(
      'must-not-leak'
    );
  });

  it('returns a safe empty credential summary when no credential exists', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      ...tradingAccount(),
      credential: null,
    });

    await expect(getTradingAccountForAdmin(1)).resolves.toEqual(
      expect.objectContaining({
        id: 1,
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

  it('updates only safe admin trading account fields', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({ id: 1 });
    mocks.tradingAccountUpdate.mockResolvedValue({
      ...tradingAccount({
        displayName: 'Updated Paper',
        status: TradingAccountStatus.PAUSED,
        tradingEnabled: false,
        killSwitchEnabled: true,
        estimatedTradingCapital: 25_000,
        pausedReason: 'credential rotation',
        notes: null,
      }),
      credential: null,
    });

    const result = await updateTradingAccountForAdmin(1, {
      displayName: 'Updated Paper',
      status: TradingAccountStatus.PAUSED,
      tradingEnabled: false,
      killSwitchEnabled: true,
      estimatedTradingCapital: 25_000,
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
