import {
  BrokerCredentialAuthType,
  BrokerCredentialStatus,
  type TradingAccountCredential,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { UpsertTradingAccountCredentialInput } from '../validators/trading-account.schema.js';
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
} from './trading-credential-crypto.service.js';

export type ActiveTradingAccountApiKeyCredential = {
  credentialId: number;
  tradingAccountId: number;
  apiKey: string;
  apiSecret: string;
  keyFingerprint: string | null;
  verifiedAt: Date | null;
  lastUsedAt: Date | null;
};

export type TradingAccountApiKeyCredential = ActiveTradingAccountApiKeyCredential;

function incompleteApiKeyCredentialError(tradingAccountId: number) {
  return new Error(
    `Trading account ${tradingAccountId} has an active API key credential record, but the encrypted API key and secret are not both present.`
  );
}

function unsupportedCredentialAuthTypeError(
  tradingAccountId: number,
  authType: BrokerCredentialAuthType
) {
  return new Error(
    `Trading account ${tradingAccountId} has active credentials with unsupported auth type ${authType}.`
  );
}

export async function getActiveTradingAccountCredential(
  tradingAccountId: number
): Promise<TradingAccountCredential | null> {
  return prisma.tradingAccountCredential.findFirst({
    where: {
      tradingAccountId,
      status: BrokerCredentialStatus.ACTIVE,
      revokedAt: null,
    },
    orderBy: {
      id: 'desc',
    },
  });
}

export async function loadTradingAccountApiKeyCredential(
  tradingAccountId: number,
  statuses: BrokerCredentialStatus[] = [BrokerCredentialStatus.ACTIVE]
): Promise<TradingAccountApiKeyCredential | null> {
  const credential = await prisma.tradingAccountCredential.findFirst({
    where: {
      tradingAccountId,
      status: {
        in: statuses,
      },
      revokedAt: null,
    },
    orderBy: {
      id: 'desc',
    },
  });

  if (!credential) {
    return null;
  }

  if (credential.authType !== BrokerCredentialAuthType.API_KEY) {
    throw unsupportedCredentialAuthTypeError(
      tradingAccountId,
      credential.authType
    );
  }

  if (!credential.apiKeyCiphertext || !credential.apiSecretCiphertext) {
    throw incompleteApiKeyCredentialError(tradingAccountId);
  }

  return {
    credentialId: credential.id,
    tradingAccountId: credential.tradingAccountId,
    apiKey: decryptSecret(credential.apiKeyCiphertext),
    apiSecret: decryptSecret(credential.apiSecretCiphertext),
    keyFingerprint: credential.keyFingerprint,
    verifiedAt: credential.verifiedAt,
    lastUsedAt: credential.lastUsedAt,
  };
}

export async function loadActiveTradingAccountApiKeyCredential(
  tradingAccountId: number
): Promise<ActiveTradingAccountApiKeyCredential | null> {
  return loadTradingAccountApiKeyCredential(tradingAccountId, [
    BrokerCredentialStatus.ACTIVE,
  ]);
}

export async function upsertTradingAccountApiKeyCredential(
  tradingAccountId: number,
  input: UpsertTradingAccountCredentialInput
) {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { id: true },
  });

  if (!account) {
    return null;
  }

  const apiKeyCiphertext = encryptSecret(input.apiKey);
  const apiSecretCiphertext = encryptSecret(input.apiSecret);
  const keyFingerprint = fingerprintSecret(input.apiKey);

  return prisma.tradingAccountCredential.upsert({
    where: { tradingAccountId },
    create: {
      tradingAccountId,
      authType: input.authType,
      status: BrokerCredentialStatus.NEEDS_VERIFICATION,
      apiKeyCiphertext,
      apiSecretCiphertext,
      keyFingerprint,
      encryptionVersion: 1,
      verifiedAt: null,
      lastFailedAt: null,
      revokedAt: null,
    },
    update: {
      authType: input.authType,
      status: BrokerCredentialStatus.NEEDS_VERIFICATION,
      apiKeyCiphertext,
      apiSecretCiphertext,
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      keyFingerprint,
      encryptionVersion: 1,
      verifiedAt: null,
      lastFailedAt: null,
      revokedAt: null,
    },
  });
}
