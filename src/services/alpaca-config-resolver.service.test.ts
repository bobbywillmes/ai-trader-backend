import {
  TradingAccountEnvironment,
  TradingAccountStatus,
  TradingBroker,
  type TradingAccount,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    ALPACA_API_KEY: 'legacy-key',
    ALPACA_API_SECRET: 'legacy-secret',
    ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
  },
  getTradingAccountById: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
  loadTradingAccountApiKeyCredential: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: mocks.env,
}));

vi.mock('./trading-account.service.js', () => ({
  getTradingAccountById: mocks.getTradingAccountById,
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

vi.mock('./trading-account-credential.service.js', () => ({
  loadTradingAccountApiKeyCredential: mocks.loadTradingAccountApiKeyCredential,
}));

import { resolveAlpacaConfigForTradingAccount } from './alpaca-config-resolver.service.js';

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

describe('Alpaca config resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.ALPACA_API_KEY = 'legacy-key';
    mocks.env.ALPACA_API_SECRET = 'legacy-secret';
    mocks.env.ALPACA_BASE_URL = 'https://paper-api.alpaca.markets';
    mocks.getTradingAccountById.mockResolvedValue(tradingAccount());
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.loadTradingAccountApiKeyCredential.mockResolvedValue(null);
  });

  it('uses active trading account credentials before legacy env fallback', async () => {
    mocks.getTradingAccountById.mockResolvedValue(
      tradingAccount({
        id: 2,
        displayName: 'Secondary Paper',
        environment: TradingAccountEnvironment.PAPER,
      })
    );
    mocks.loadTradingAccountApiKeyCredential.mockResolvedValue({
      credentialId: 11,
      tradingAccountId: 2,
      apiKey: 'scoped-key',
      apiSecret: 'scoped-secret',
      keyFingerprint: 'sha256:fingerprint',
      verifiedAt: new Date('2026-06-28T00:00:00.000Z'),
      lastUsedAt: null,
    });

    await expect(resolveAlpacaConfigForTradingAccount(2)).resolves.toEqual({
      tradingAccountId: 2,
      baseUrl: 'https://paper-api.alpaca.markets',
      apiKey: 'scoped-key',
      apiSecret: 'scoped-secret',
      source: 'trading_account_credential',
      credentialId: 11,
      keyFingerprint: 'sha256:fingerprint',
    });
    expect(mocks.resolveDefaultTradingAccountId).not.toHaveBeenCalled();
  });

  it('uses the live Alpaca base URL for live account-scoped credentials', async () => {
    mocks.getTradingAccountById.mockResolvedValue(
      tradingAccount({
        id: 3,
        environment: TradingAccountEnvironment.LIVE,
      })
    );
    mocks.loadTradingAccountApiKeyCredential.mockResolvedValue({
      credentialId: 12,
      tradingAccountId: 3,
      apiKey: 'live-key',
      apiSecret: 'live-secret',
      keyFingerprint: null,
      verifiedAt: null,
      lastUsedAt: null,
    });

    const config = await resolveAlpacaConfigForTradingAccount(3);

    expect(config).toMatchObject({
      tradingAccountId: 3,
      baseUrl: 'https://api.alpaca.markets',
      source: 'trading_account_credential',
      credentialId: 12,
    });
  });

  it('does not fall back to legacy env credentials for Bobby Paper', async () => {
    mocks.getTradingAccountById.mockResolvedValue(tradingAccount({ id: 1 }));

    await expect(resolveAlpacaConfigForTradingAccount(1)).rejects.toThrow(
      'Trading account 1 does not have active Alpaca credentials'
    );
  });

  it('throws a clear missing-credentials error for non-default accounts without active credentials', async () => {
    mocks.getTradingAccountById.mockResolvedValue(
      tradingAccount({
        id: 4,
        displayName: 'Secondary Paper',
      })
    );
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);

    await expect(resolveAlpacaConfigForTradingAccount(4)).rejects.toThrow(
      'Trading account 4 does not have active Alpaca credentials'
    );
  });

  it('throws a clear error when the trading account cannot be found', async () => {
    mocks.getTradingAccountById.mockResolvedValue(null);

    await expect(resolveAlpacaConfigForTradingAccount(404)).rejects.toThrow(
      'Trading account 404 could not be found'
    );
    expect(
      mocks.loadTradingAccountApiKeyCredential
    ).not.toHaveBeenCalled();
  });
});
