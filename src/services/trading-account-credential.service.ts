import {
  BrokerCredentialAuthType,
  BrokerCredentialStatus,
  Prisma,
  TradingAccountStatus,
  type TradingAccountCredential,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type { UpsertTradingAccountCredentialInput } from '../validators/trading-account.schema.js';
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
} from './trading-credential-crypto.service.js';
import { withAccountRiskConfigurationTransaction } from './trading-account-risk-configuration.service.js';
import { invalidateLiveWriteApprovals, LiveWriteCapability } from './live-write-approval.service.js';

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

const SAFE_CREDENTIAL_ACCOUNT_STATE = {
  status: TradingAccountStatus.NEEDS_CREDENTIALS,
  tradingEnabled: false,
  killSwitchEnabled: true,
} as const;

const OPERATIONAL_STATE_SELECT = {
  status: true,
  tradingEnabled: true,
  killSwitchEnabled: true,
} satisfies Prisma.TradingAccountSelect;

function operationalState(account: {
  status: TradingAccountStatus;
  tradingEnabled: boolean;
  killSwitchEnabled: boolean;
}) {
  return {
    status: account.status,
    tradingEnabled: account.tradingEnabled,
    killSwitchEnabled: account.killSwitchEnabled,
  };
}

function operationalChangedFields(
  before: ReturnType<typeof operationalState>,
  after: ReturnType<typeof operationalState>
) {
  return (Object.keys(after) as Array<keyof typeof after>).filter(
    (field) => before[field] !== after[field]
  );
}

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
  input: UpsertTradingAccountCredentialInput,
  actorUserId = -1
) {
  return withAccountRiskConfigurationTransaction(async (tx) => {
    const account = await tx.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: {
        id: true,
        ...OPERATIONAL_STATE_SELECT,
        credential: {
          select: {
            id: true,
            keyFingerprint: true,
            status: true,
          },
        },
      },
    });

    if (!account) {
      return null;
    }

    if (account.status === TradingAccountStatus.ACTIVE) {
      throw new HttpError(
        409,
        'Active trading accounts must be deactivated before credentials can be created or replaced.'
      );
    }

    const apiKeyCiphertext = encryptSecret(input.apiKey);
    const apiSecretCiphertext = encryptSecret(input.apiSecret);
    const keyFingerprint = fingerprintSecret(input.apiKey);
    const before = operationalState(account);
    const credential = await tx.tradingAccountCredential.upsert({
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
        lastUsedAt: null,
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
        lastUsedAt: null,
        lastFailedAt: null,
        revokedAt: null,
      },
    });

    await tx.tradingAccount.update({
      where: { id: tradingAccountId },
      data: SAFE_CREDENTIAL_ACCOUNT_STATE,
    });
    await invalidateLiveWriteApprovals(tx, tradingAccountId,
      [LiveWriteCapability.RISK_REDUCING, LiveWriteCapability.ENTRY], 'Broker credentials were created or replaced.');

    const after = { ...SAFE_CREDENTIAL_ACCOUNT_STATE };
    const replaced = account.credential !== null;
    const occurredAt = new Date();
    await tx.systemEvent.create({
      data: {
        type: replaced
          ? 'trading_account.credential_replaced'
          : 'trading_account.credential_saved',
        entityType: 'tradingAccountCredential',
        entityId: String(credential.id),
        tradingAccountId,
        actorUserId: actorUserId > 0 ? actorUserId : null,
        message: `Trading account ${tradingAccountId} credential was ${
          replaced ? 'replaced' : 'saved'
        } and requires verification.`,
        payloadJson: {
          actorUserId,
          tradingAccountId,
          occurredAt: occurredAt.toISOString(),
          credentialId: credential.id,
          credential: {
            beforeStatus: account.credential?.status ?? null,
            afterStatus: BrokerCredentialStatus.NEEDS_VERIFICATION,
            beforeKeyFingerprint: account.credential?.keyFingerprint ?? null,
            afterKeyFingerprint: keyFingerprint,
          },
          before,
          after,
          changedFields: [
            ...operationalChangedFields(before, after),
            'credential.status',
            'credential.keyFingerprint',
          ],
        },
      },
    });

    return credential;
  });
}

export async function revokeTradingAccountCredential(
  tradingAccountId: number,
  actorUserId = -1
) {
  return withAccountRiskConfigurationTransaction(async (tx) => {
    const account = await tx.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: {
        id: true,
        ...OPERATIONAL_STATE_SELECT,
        credential: {
          select: {
            id: true,
            keyFingerprint: true,
            status: true,
          },
        },
      },
    });

    if (!account) {
      return null;
    }

    if (!account.credential) {
      return {
        revoked: false,
      };
    }

    const before = operationalState(account);
    const now = new Date();
    await tx.tradingAccountCredential.update({
      where: { id: account.credential.id },
      data: {
        status: BrokerCredentialStatus.REVOKED,
        revokedAt: now,
      },
    });
    await tx.tradingAccount.update({
      where: { id: tradingAccountId },
      data: SAFE_CREDENTIAL_ACCOUNT_STATE,
    });
    await invalidateLiveWriteApprovals(tx, tradingAccountId,
      [LiveWriteCapability.RISK_REDUCING, LiveWriteCapability.ENTRY], 'Broker credentials were revoked.');

    const after = { ...SAFE_CREDENTIAL_ACCOUNT_STATE };
    await tx.systemEvent.create({
      data: {
        type: 'trading_account.credential_revoked',
        entityType: 'tradingAccountCredential',
        entityId: String(account.credential.id),
        tradingAccountId,
        actorUserId: actorUserId > 0 ? actorUserId : null,
        message: `Trading account ${tradingAccountId} credential was revoked.`,
        payloadJson: {
          actorUserId,
          tradingAccountId,
          occurredAt: now.toISOString(),
          credentialId: account.credential.id,
          keyFingerprint: account.credential.keyFingerprint,
          beforeCredentialStatus: account.credential.status,
          afterCredentialStatus: BrokerCredentialStatus.REVOKED,
          before,
          after,
          changedFields: [
            ...operationalChangedFields(before, after),
            'credential.status',
            'credential.revokedAt',
          ],
        },
      },
    });

    return {
      revoked: true,
    };
  });
}
