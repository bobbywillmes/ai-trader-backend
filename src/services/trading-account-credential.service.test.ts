import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrokerCredentialAuthType,
  BrokerCredentialStatus,
  TradingAccountStatus,
} from '@prisma/client';

const mocks = vi.hoisted(() => ({
  tradingAccountFindUnique: vi.fn(),
  tradingAccountCredentialFindFirst: vi.fn(),
  tradingAccountCredentialUpdate: vi.fn(),
  tradingAccountUpdate: vi.fn(),
  tradingAccountCredentialUpsert: vi.fn(),
  transaction: vi.fn(),
  decryptSecret: vi.fn(),
  encryptSecret: vi.fn(),
  fingerprintSecret: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findUnique: mocks.tradingAccountFindUnique,
      update: mocks.tradingAccountUpdate,
    },
    tradingAccountCredential: {
      findFirst: mocks.tradingAccountCredentialFindFirst,
      update: mocks.tradingAccountCredentialUpdate,
      upsert: mocks.tradingAccountCredentialUpsert,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock('./trading-credential-crypto.service.js', () => ({
  decryptSecret: mocks.decryptSecret,
  encryptSecret: mocks.encryptSecret,
  fingerprintSecret: mocks.fingerprintSecret,
}));

import {
  revokeTradingAccountCredential,
  upsertTradingAccountApiKeyCredential,
} from './trading-account-credential.service.js';

describe('trading account credential service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tradingAccountFindUnique.mockResolvedValue({ id: 1 });
    mocks.tradingAccountCredentialUpsert.mockResolvedValue({ id: 10 });
    mocks.transaction.mockResolvedValue([]);
    mocks.encryptSecret.mockImplementation((value: string) => `encrypted:${value}`);
    mocks.fingerprintSecret.mockImplementation(
      (value: string) => `fingerprint:${value}`
    );
  });

  it('upserts API key credentials encrypted and marked for verification', async () => {
    await expect(
      upsertTradingAccountApiKeyCredential(1, {
        authType: BrokerCredentialAuthType.API_KEY,
        apiKey: 'plain-key',
        apiSecret: 'plain-secret',
      })
    ).resolves.toEqual({ id: 10 });

    expect(mocks.tradingAccountCredentialUpsert).toHaveBeenCalledWith({
      where: { tradingAccountId: 1 },
      create: expect.objectContaining({
        tradingAccountId: 1,
        authType: BrokerCredentialAuthType.API_KEY,
        status: BrokerCredentialStatus.NEEDS_VERIFICATION,
        apiKeyCiphertext: 'encrypted:plain-key',
        apiSecretCiphertext: 'encrypted:plain-secret',
        keyFingerprint: 'fingerprint:plain-key',
        encryptionVersion: 1,
        verifiedAt: null,
        lastFailedAt: null,
        revokedAt: null,
      }),
      update: expect.objectContaining({
        authType: BrokerCredentialAuthType.API_KEY,
        status: BrokerCredentialStatus.NEEDS_VERIFICATION,
        apiKeyCiphertext: 'encrypted:plain-key',
        apiSecretCiphertext: 'encrypted:plain-secret',
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        keyFingerprint: 'fingerprint:plain-key',
        encryptionVersion: 1,
        verifiedAt: null,
        lastFailedAt: null,
        revokedAt: null,
      }),
    });
  });

  it('returns null without encrypting when the trading account is missing', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(
      upsertTradingAccountApiKeyCredential(404, {
        authType: BrokerCredentialAuthType.API_KEY,
        apiKey: 'plain-key',
        apiSecret: 'plain-secret',
      })
    ).resolves.toBeNull();

    expect(mocks.encryptSecret).not.toHaveBeenCalled();
    expect(mocks.tradingAccountCredentialUpsert).not.toHaveBeenCalled();
  });

  it('revokes credentials and forces conservative trading account state', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      credential: {
        id: 10,
      },
    });

    await expect(revokeTradingAccountCredential(1)).resolves.toEqual({
      revoked: true,
    });

    expect(mocks.tradingAccountCredentialUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({
        status: BrokerCredentialStatus.REVOKED,
        revokedAt: expect.any(Date),
      }),
    });
    expect(mocks.tradingAccountUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        status: TradingAccountStatus.NEEDS_CREDENTIALS,
        tradingEnabled: false,
        killSwitchEnabled: true,
      },
    });
  });

  it('returns no-op revoke result when the trading account has no credential', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      credential: null,
    });

    await expect(revokeTradingAccountCredential(1)).resolves.toEqual({
      revoked: false,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('returns null when revoking credentials for a missing trading account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(revokeTradingAccountCredential(404)).resolves.toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
