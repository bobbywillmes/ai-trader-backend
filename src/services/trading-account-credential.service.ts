import {
  BrokerCredentialAuthType,
  BrokerCredentialStatus,
  type TradingAccountCredential,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { decryptSecret } from './trading-credential-crypto.service.js';

export type ActiveTradingAccountApiKeyCredential = {
  credentialId: number;
  tradingAccountId: number;
  apiKey: string;
  apiSecret: string;
  keyFingerprint: string | null;
  verifiedAt: Date | null;
  lastUsedAt: Date | null;
};

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

export async function loadActiveTradingAccountApiKeyCredential(
  tradingAccountId: number
): Promise<ActiveTradingAccountApiKeyCredential | null> {
  const credential = await getActiveTradingAccountCredential(tradingAccountId);

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
