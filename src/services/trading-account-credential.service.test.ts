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
  systemEventCreate: vi.fn(),
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
    systemEvent: {
      create: mocks.systemEventCreate,
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
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      status: TradingAccountStatus.PAUSED,
      tradingEnabled: false,
      killSwitchEnabled: true,
      credential: null,
    });
    mocks.tradingAccountCredentialUpsert.mockResolvedValue({ id: 10 });
    mocks.tradingAccountUpdate.mockResolvedValue({ id: 1 });
    mocks.systemEventCreate.mockResolvedValue({ id: 100 });
    mocks.transaction.mockImplementation(
      (operation: (tx: unknown) => Promise<unknown>) =>
        operation({
          tradingAccount: {
            findUnique: mocks.tradingAccountFindUnique,
            update: mocks.tradingAccountUpdate,
          },
          tradingAccountCredential: {
            update: mocks.tradingAccountCredentialUpdate,
            upsert: mocks.tradingAccountCredentialUpsert,
          },
          systemEvent: {
            create: mocks.systemEventCreate,
          },
        })
    );
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
        lastUsedAt: null,
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
        lastUsedAt: null,
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

  it('rejects credential replacement while the account is active', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      status: TradingAccountStatus.ACTIVE,
      tradingEnabled: true,
      killSwitchEnabled: false,
      credential: {
        id: 10,
        keyFingerprint: 'fingerprint:old-key',
        status: BrokerCredentialStatus.ACTIVE,
      },
    });

    await expect(
      upsertTradingAccountApiKeyCredential(
        1,
        {
          authType: BrokerCredentialAuthType.API_KEY,
          apiKey: 'new-key',
          apiSecret: 'new-secret',
        },
        7
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.tradingAccountCredentialUpsert).not.toHaveBeenCalled();
  });

  it('replaces credentials safely after deactivation and emits no secret material', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      status: TradingAccountStatus.PAUSED,
      tradingEnabled: false,
      killSwitchEnabled: true,
      credential: {
        id: 10,
        keyFingerprint: 'fingerprint:old-key',
        status: BrokerCredentialStatus.ACTIVE,
      },
    });

    await upsertTradingAccountApiKeyCredential(
      1,
      {
        authType: BrokerCredentialAuthType.API_KEY,
        apiKey: 'new-key',
        apiSecret: 'new-secret',
      },
      7
    );

    expect(mocks.tradingAccountUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        status: TradingAccountStatus.NEEDS_CREDENTIALS,
        tradingEnabled: false,
        killSwitchEnabled: true,
      },
    });
    const auditCall = mocks.systemEventCreate.mock.calls[0]?.[0];
    expect(auditCall.data.type).toBe('trading_account.credential_replaced');
    expect(JSON.stringify(auditCall)).not.toContain('new-secret');
    expect(JSON.stringify(auditCall)).not.toContain('encrypted:new-secret');
    expect(auditCall.data.payloadJson).not.toHaveProperty('apiKey');
    expect(auditCall.data.payloadJson).not.toHaveProperty('apiSecret');
    expect(auditCall.data.payloadJson).not.toHaveProperty('apiKeyCiphertext');
    expect(auditCall.data.payloadJson).not.toHaveProperty(
      'apiSecretCiphertext'
    );
  });

  it('fails the credential mutation when its audit event cannot be written', async () => {
    mocks.systemEventCreate.mockRejectedValue(new Error('audit insert failed'));

    await expect(
      upsertTradingAccountApiKeyCredential(
        1,
        {
          authType: BrokerCredentialAuthType.API_KEY,
          apiKey: 'plain-key',
          apiSecret: 'plain-secret',
        },
        7
      )
    ).rejects.toThrow('audit insert failed');
    expect(mocks.tradingAccountCredentialUpsert).toHaveBeenCalledOnce();
    expect(mocks.tradingAccountUpdate).toHaveBeenCalledOnce();
  });

  it('revokes credentials and forces conservative trading account state', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      status: TradingAccountStatus.PAUSED,
      tradingEnabled: false,
      killSwitchEnabled: true,
      credential: {
        id: 10,
        keyFingerprint: 'fingerprint:key',
        status: BrokerCredentialStatus.ACTIVE,
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
      status: TradingAccountStatus.PAUSED,
      tradingEnabled: false,
      killSwitchEnabled: true,
      credential: null,
    });

    await expect(revokeTradingAccountCredential(1)).resolves.toEqual({
      revoked: false,
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.systemEventCreate).not.toHaveBeenCalled();
  });

  it('returns null when revoking credentials for a missing trading account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(revokeTradingAccountCredential(404)).resolves.toBeNull();
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
});
