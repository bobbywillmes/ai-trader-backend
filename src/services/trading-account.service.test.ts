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
  tradingAccountFindUnique: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: mocks.env,
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findFirst: mocks.tradingAccountFindFirst,
      findUnique: mocks.tradingAccountFindUnique,
    },
  },
}));

import {
  resolveDefaultTradingAccount,
  resolveDefaultTradingAccountId,
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
    mocks.tradingAccountFindUnique.mockResolvedValue(null);
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
});
