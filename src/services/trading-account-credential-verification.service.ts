import {
  BrokerCredentialStatus,
  Prisma,
  TradingAccountStatus,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { getNormalizedAccount } from './account.service.js';
import { getTradingAccountForAdmin } from './trading-account.service.js';
import type { TradingAccountAdminResponse } from './trading-account.service.js';
import { withAccountRiskConfigurationTransaction } from './trading-account-risk-configuration.service.js';

export type TradingAccountCredentialVerificationResult =
  | {
      ok: true;
      account: TradingAccountAdminResponse;
    }
  | {
      ok: false;
      message: string;
      account: TradingAccountAdminResponse | null;
    };

const VERIFICATION_CREDENTIAL_STATUSES = [
  BrokerCredentialStatus.NEEDS_VERIFICATION,
  BrokerCredentialStatus.INVALID,
  BrokerCredentialStatus.ACTIVE,
];

const SAFE_VERIFICATION_FAILURE_MESSAGE =
  'Broker credential verification failed. Check the submitted Alpaca credentials and account environment.';

function maskBrokerAccountNumber(accountNumber: string | null | undefined) {
  if (!accountNumber) {
    return null;
  }

  const suffix = accountNumber.slice(-4);
  return suffix ? `****${suffix}` : null;
}

export async function verifyTradingAccountCredential(
  tradingAccountId: number,
  actorUserId = -1
): Promise<TradingAccountCredentialVerificationResult | null> {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: {
      id: true,
      status: true,
      tradingEnabled: true,
      killSwitchEnabled: true,
      credential: {
        select: {
          id: true,
          status: true,
          keyFingerprint: true,
          revokedAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!account) {
    return null;
  }

  if (!account.credential || account.credential.revokedAt) {
    return {
      ok: false,
      message: 'Trading account does not have a credential to verify.',
      account: await getTradingAccountForAdmin(tradingAccountId),
    };
  }

  const credentialSnapshot = account.credential;
  const credentialId = credentialSnapshot.id;

  const brokerAccount = await getNormalizedAccount('manual_admin_action', {
    tradingAccountId,
    credentialStatuses: VERIFICATION_CREDENTIAL_STATUSES,
  }).catch(() => null);

  if (!brokerAccount) {
    const now = new Date();
    await withAccountRiskConfigurationTransaction(async (tx) => {
      const current = await tx.tradingAccount.findUnique({
        where: { id: tradingAccountId },
        select: {
          status: true,
          tradingEnabled: true,
          killSwitchEnabled: true,
          credential: {
            select: {
              id: true,
              status: true,
              keyFingerprint: true,
              updatedAt: true,
            },
          },
        },
      });
      if (
        !current?.credential ||
        current.credential.id !== credentialId ||
        current.credential.updatedAt.getTime() !==
          credentialSnapshot.updatedAt.getTime()
      ) {
        throw new HttpError(
          409,
          'Credential changed while verification was in progress. Verify the current credential again.'
        );
      }

      const before = {
        status: current.status,
        tradingEnabled: current.tradingEnabled,
        killSwitchEnabled: current.killSwitchEnabled,
      };
      const after = {
        status: TradingAccountStatus.ERROR,
        tradingEnabled: false,
        killSwitchEnabled: true,
      };
      await tx.tradingAccountCredential.update({
        where: { id: credentialId },
        data: {
          status: BrokerCredentialStatus.INVALID,
          lastFailedAt: now,
        },
      });
      await tx.tradingAccount.update({
        where: { id: tradingAccountId },
        data: after,
      });
      await tx.systemEvent.create({
        data: {
          type: 'trading_account.credential_verification_failed',
          entityType: 'tradingAccountCredential',
          entityId: String(credentialId),
          tradingAccountId,
          actorUserId: actorUserId > 0 ? actorUserId : null,
          message: `Trading account ${tradingAccountId} credential verification failed.`,
          payloadJson: {
            actorUserId,
            tradingAccountId,
            occurredAt: now.toISOString(),
            credentialId,
            keyFingerprint: current.credential.keyFingerprint,
            beforeCredentialStatus: current.credential.status,
            afterCredentialStatus: BrokerCredentialStatus.INVALID,
            before,
            after,
            changedFields: [
              'credential.status',
              'credential.lastFailedAt',
              ...Object.keys(after).filter(
                (field) =>
                  before[field as keyof typeof before] !==
                  after[field as keyof typeof after]
              ),
            ],
          } satisfies Prisma.InputJsonValue,
        },
      });
    });

    return {
      ok: false,
      message: SAFE_VERIFICATION_FAILURE_MESSAGE,
      account: await getTradingAccountForAdmin(tradingAccountId),
    };
  }

  const now = new Date();
  await withAccountRiskConfigurationTransaction(async (tx) => {
    const current = await tx.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: {
        status: true,
        tradingEnabled: true,
        killSwitchEnabled: true,
        credential: {
          select: {
            id: true,
            status: true,
            keyFingerprint: true,
            updatedAt: true,
          },
        },
      },
    });
    if (
      !current?.credential ||
      current.credential.id !== credentialId ||
      current.credential.updatedAt.getTime() !==
        credentialSnapshot.updatedAt.getTime()
    ) {
      throw new HttpError(
        409,
        'Credential changed while verification was in progress. Verify the current credential again.'
      );
    }

    const before = {
      status: current.status,
      tradingEnabled: current.tradingEnabled,
      killSwitchEnabled: current.killSwitchEnabled,
    };
    const after = {
      status: TradingAccountStatus.PAUSED,
      tradingEnabled: false,
      killSwitchEnabled: true,
    };
    await tx.tradingAccountCredential.update({
      where: { id: credentialId },
      data: {
        status: BrokerCredentialStatus.ACTIVE,
        verifiedAt: now,
        lastFailedAt: null,
        revokedAt: null,
      },
    });
    await tx.tradingAccount.update({
      where: { id: tradingAccountId },
      data: {
        ...after,
        brokerAccountId: brokerAccount.accountNumber ?? null,
        brokerAccountNumberMasked: maskBrokerAccountNumber(
          brokerAccount.accountNumber
        ),
        brokerAccountStatus: brokerAccount.status ?? null,
        lastBrokerSyncAt: now,
        lastCash: brokerAccount.cash,
        lastBuyingPower: brokerAccount.buyingPower,
        lastEquity: brokerAccount.equity,
        lastPortfolioValue: brokerAccount.portfolioValue,
        tradingBlocked: brokerAccount.tradingBlocked,
        baseCurrency: brokerAccount.currency ?? 'USD',
      },
    });
    await tx.systemEvent.create({
      data: {
        type: 'trading_account.credential_verified',
        entityType: 'tradingAccountCredential',
        entityId: String(credentialId),
        tradingAccountId,
        actorUserId: actorUserId > 0 ? actorUserId : null,
        message: `Trading account ${tradingAccountId} credential was verified.`,
        payloadJson: {
          actorUserId,
          tradingAccountId,
          occurredAt: now.toISOString(),
          credentialId,
          keyFingerprint: current.credential.keyFingerprint,
          beforeCredentialStatus: current.credential.status,
          afterCredentialStatus: BrokerCredentialStatus.ACTIVE,
          before,
          after,
          changedFields: [
            'credential.status',
            'credential.verifiedAt',
            'brokerAccountId',
            'brokerAccountStatus',
            'lastBrokerSyncAt',
            ...Object.keys(after).filter(
              (field) =>
                before[field as keyof typeof before] !==
                after[field as keyof typeof after]
            ),
          ],
        } satisfies Prisma.InputJsonValue,
      },
    });
  });

  const updatedAccount = await getTradingAccountForAdmin(tradingAccountId);

  if (!updatedAccount) {
    return null;
  }

  return {
    ok: true,
    account: updatedAccount,
  };
}
