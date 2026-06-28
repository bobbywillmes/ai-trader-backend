import {
  BrokerCredentialStatus,
  TradingAccountStatus,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getNormalizedAccount } from './account.service.js';
import { getTradingAccountForAdmin } from './trading-account.service.js';
import type { TradingAccountAdminResponse } from './trading-account.service.js';

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

function statusAfterSuccessfulVerification(status: TradingAccountStatus) {
  if (
    status === TradingAccountStatus.NEEDS_CREDENTIALS ||
    status === TradingAccountStatus.ERROR
  ) {
    return TradingAccountStatus.PAUSED;
  }

  return status;
}

export async function verifyTradingAccountCredential(
  tradingAccountId: number
): Promise<TradingAccountCredentialVerificationResult | null> {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: {
      id: true,
      status: true,
      credential: {
        select: {
          id: true,
          status: true,
          revokedAt: true,
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

  const credentialId = account.credential.id;

  const brokerAccount = await getNormalizedAccount('manual_admin_action', {
    tradingAccountId,
    credentialStatuses: VERIFICATION_CREDENTIAL_STATUSES,
  }).catch(async () => {
    const now = new Date();

    await prisma.$transaction([
      prisma.tradingAccountCredential.update({
        where: { id: credentialId },
        data: {
          status: BrokerCredentialStatus.INVALID,
          lastFailedAt: now,
        },
      }),
      prisma.tradingAccount.update({
        where: { id: tradingAccountId },
        data: {
          status: TradingAccountStatus.ERROR,
          tradingEnabled: false,
          killSwitchEnabled: true,
        },
      }),
    ]);

    return null;
  });

  if (!brokerAccount) {
    return {
      ok: false,
      message: SAFE_VERIFICATION_FAILURE_MESSAGE,
      account: await getTradingAccountForAdmin(tradingAccountId),
    };
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.tradingAccountCredential.update({
      where: { id: credentialId },
      data: {
        status: BrokerCredentialStatus.ACTIVE,
        verifiedAt: now,
        lastFailedAt: null,
        revokedAt: null,
      },
    }),
    prisma.tradingAccount.update({
      where: { id: tradingAccountId },
      data: {
        status: statusAfterSuccessfulVerification(account.status),
        tradingEnabled: false,
        killSwitchEnabled: true,
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
    }),
  ]);

  const updatedAccount = await getTradingAccountForAdmin(tradingAccountId);

  if (!updatedAccount) {
    return null;
  }

  return {
    ok: true,
    account: updatedAccount,
  };
}
