import {
  TradingAccountEnvironment,
  TradingAccountStatus,
  TradingBroker,
  type TradingAccount,
} from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';

const LEGACY_DEFAULT_TRADING_ACCOUNT = {
  broker: TradingBroker.ALPACA,
  environment: TradingAccountEnvironment.PAPER,
  displayName: 'Bobby Paper',
} as const;

function missingDefaultTradingAccountError() {
  return new Error(
    'Default trading account could not be resolved. Set DEFAULT_TRADING_ACCOUNT_ID to a valid TradingAccount id or run scripts/bootstrap-default-trading-account.ts to create the Bobby Paper default account.'
  );
}

export async function getTradingAccountById(id: number) {
  return prisma.tradingAccount.findUnique({
    where: { id },
  });
}

export async function resolveDefaultTradingAccount(): Promise<TradingAccount> {
  if (env.DEFAULT_TRADING_ACCOUNT_ID !== undefined) {
    const configured = await getTradingAccountById(env.DEFAULT_TRADING_ACCOUNT_ID);

    if (!configured) {
      throw missingDefaultTradingAccountError();
    }

    return configured;
  }

  const fallback = await prisma.tradingAccount.findFirst({
    where: {
      ...LEGACY_DEFAULT_TRADING_ACCOUNT,
      status: TradingAccountStatus.ACTIVE,
    },
    orderBy: {
      id: 'asc',
    },
  });

  if (!fallback) {
    throw missingDefaultTradingAccountError();
  }

  return fallback;
}

export async function resolveDefaultTradingAccountId() {
  const account = await resolveDefaultTradingAccount();
  return account.id;
}
