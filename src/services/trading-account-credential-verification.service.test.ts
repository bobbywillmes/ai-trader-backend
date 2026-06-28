import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrokerCredentialStatus,
  TradingAccountStatus,
} from '@prisma/client';

const mocks = vi.hoisted(() => ({
  tradingAccountFindUnique: vi.fn(),
  tradingAccountCredentialUpdate: vi.fn(),
  tradingAccountUpdate: vi.fn(),
  transaction: vi.fn(),
  getNormalizedAccount: vi.fn(),
  getTradingAccountForAdmin: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findUnique: mocks.tradingAccountFindUnique,
      update: mocks.tradingAccountUpdate,
    },
    tradingAccountCredential: {
      update: mocks.tradingAccountCredentialUpdate,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('./account.service.js', () => ({
  getNormalizedAccount: mocks.getNormalizedAccount,
}));

vi.mock('./trading-account.service.js', () => ({
  getTradingAccountForAdmin: mocks.getTradingAccountForAdmin,
}));

import { verifyTradingAccountCredential } from './trading-account-credential-verification.service.js';

describe('trading account credential verification service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      status: TradingAccountStatus.NEEDS_CREDENTIALS,
      credential: {
        id: 10,
        status: BrokerCredentialStatus.NEEDS_VERIFICATION,
        revokedAt: null,
      },
    });
    mocks.getNormalizedAccount.mockResolvedValue({
      broker: 'alpaca',
      mode: 'paper',
      status: 'ACTIVE',
      currency: 'USD',
      accountNumber: 'PA123456789',
      cash: 1000,
      buyingPower: 2000,
      equity: 3000,
      portfolioValue: 3000,
      lastEquity: 2900,
      longMarketValue: null,
      shortMarketValue: null,
      dayPnL: 100,
      dayPnLPct: 0.034,
      tradingBlocked: false,
    });
    mocks.getTradingAccountForAdmin.mockResolvedValue({ id: 1 });
    mocks.transaction.mockResolvedValue([]);
  });

  it('marks credentials active and syncs broker account metadata on success', async () => {
    await expect(verifyTradingAccountCredential(1)).resolves.toEqual({
      ok: true,
      account: { id: 1 },
    });

    expect(mocks.getNormalizedAccount).toHaveBeenCalledWith(
      'manual_admin_action',
      {
        tradingAccountId: 1,
        credentialStatuses: [
          BrokerCredentialStatus.NEEDS_VERIFICATION,
          BrokerCredentialStatus.INVALID,
          BrokerCredentialStatus.ACTIVE,
        ],
      }
    );
    expect(mocks.tradingAccountCredentialUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({
        status: BrokerCredentialStatus.ACTIVE,
        lastFailedAt: null,
        revokedAt: null,
      }),
    });
    expect(mocks.tradingAccountUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        status: TradingAccountStatus.PAUSED,
        tradingEnabled: false,
        killSwitchEnabled: true,
        brokerAccountId: 'PA123456789',
        brokerAccountNumberMasked: '****6789',
        brokerAccountStatus: 'ACTIVE',
        lastCash: 1000,
        lastBuyingPower: 2000,
        lastEquity: 3000,
        lastPortfolioValue: 3000,
        tradingBlocked: false,
        baseCurrency: 'USD',
      }),
    });
  });

  it('marks credentials invalid and keeps trading disabled on verification failure', async () => {
    mocks.getNormalizedAccount.mockRejectedValue(new Error('401 secret rejected'));
    mocks.getTradingAccountForAdmin.mockResolvedValue({ id: 1, status: 'ERROR' });

    await expect(verifyTradingAccountCredential(1)).resolves.toEqual({
      ok: false,
      message:
        'Broker credential verification failed. Check the submitted Alpaca credentials and account environment.',
      account: { id: 1, status: 'ERROR' },
    });

    expect(mocks.tradingAccountCredentialUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({
        status: BrokerCredentialStatus.INVALID,
      }),
    });
    expect(mocks.tradingAccountUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        status: TradingAccountStatus.ERROR,
        tradingEnabled: false,
        killSwitchEnabled: true,
      },
    });
  });

  it('returns null when the trading account is missing', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(verifyTradingAccountCredential(404)).resolves.toBeNull();
    expect(mocks.getNormalizedAccount).not.toHaveBeenCalled();
  });

  it('returns a safe failure when no credential exists', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      status: TradingAccountStatus.ACTIVE,
      credential: null,
    });
    mocks.getTradingAccountForAdmin.mockResolvedValue({ id: 1 });

    await expect(verifyTradingAccountCredential(1)).resolves.toEqual({
      ok: false,
      message: 'Trading account does not have a credential to verify.',
      account: { id: 1 },
    });
    expect(mocks.getNormalizedAccount).not.toHaveBeenCalled();
  });
});
