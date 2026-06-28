import {
  Prisma,
  TradingAccountEnvironment,
  TradingAccountStatus,
  TradingBroker,
  type TradingAccount,
} from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { UpdateTradingAccountInput } from '../validators/trading-account.schema.js';

const LEGACY_DEFAULT_TRADING_ACCOUNT = {
  broker: TradingBroker.ALPACA,
  environment: TradingAccountEnvironment.PAPER,
  displayName: 'Bobby Paper',
} as const;

const TRADING_ACCOUNT_ADMIN_SELECT = {
  id: true,
  displayName: true,
  broker: true,
  environment: true,
  status: true,
  tradingEnabled: true,
  killSwitchEnabled: true,
  estimatedTradingCapital: true,
  baseCurrency: true,
  brokerAccountId: true,
  brokerAccountNumberMasked: true,
  brokerAccountStatus: true,
  lastBrokerSyncAt: true,
  lastCash: true,
  lastBuyingPower: true,
  lastEquity: true,
  lastPortfolioValue: true,
  pausedReason: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  credential: {
    select: {
      status: true,
      authType: true,
      keyFingerprint: true,
      verifiedAt: true,
      lastUsedAt: true,
      lastFailedAt: true,
      revokedAt: true,
    },
  },
} satisfies Prisma.TradingAccountSelect;

type TradingAccountAdminRecord = Prisma.TradingAccountGetPayload<{
  select: typeof TRADING_ACCOUNT_ADMIN_SELECT;
}>;

export type TradingAccountAdminResponse = ReturnType<
  typeof serializeTradingAccountForAdmin
>;

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

export function serializeTradingAccountForAdmin(
  account: TradingAccountAdminRecord
) {
  const credential = account.credential;

  return {
    id: account.id,
    displayName: account.displayName,
    broker: account.broker,
    environment: account.environment,
    status: account.status,
    tradingEnabled: account.tradingEnabled,
    killSwitchEnabled: account.killSwitchEnabled,
    estimatedTradingCapital: account.estimatedTradingCapital,
    baseCurrency: account.baseCurrency,
    brokerAccountId: account.brokerAccountId,
    brokerAccountNumberMasked: account.brokerAccountNumberMasked,
    brokerAccountStatus: account.brokerAccountStatus,
    lastBrokerSyncAt: account.lastBrokerSyncAt,
    lastCash: account.lastCash,
    lastBuyingPower: account.lastBuyingPower,
    lastEquity: account.lastEquity,
    lastPortfolioValue: account.lastPortfolioValue,
    pausedReason: account.pausedReason,
    notes: account.notes,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    credential: {
      exists: credential !== null,
      status: credential?.status ?? null,
      authType: credential?.authType ?? null,
      keyFingerprint: credential?.keyFingerprint ?? null,
      verifiedAt: credential?.verifiedAt ?? null,
      lastUsedAt: credential?.lastUsedAt ?? null,
      lastFailedAt: credential?.lastFailedAt ?? null,
      revokedAt: credential?.revokedAt ?? null,
    },
  };
}

export async function listTradingAccountsForAdmin() {
  const accounts = await prisma.tradingAccount.findMany({
    select: TRADING_ACCOUNT_ADMIN_SELECT,
    orderBy: {
      id: 'asc',
    },
  });

  return accounts.map(serializeTradingAccountForAdmin);
}

export async function getTradingAccountForAdmin(id: number) {
  const account = await prisma.tradingAccount.findUnique({
    where: { id },
    select: TRADING_ACCOUNT_ADMIN_SELECT,
  });

  return account ? serializeTradingAccountForAdmin(account) : null;
}

export async function updateTradingAccountForAdmin(
  id: number,
  input: UpdateTradingAccountInput
) {
  const existing = await prisma.tradingAccount.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) {
    return null;
  }

  const data: Prisma.TradingAccountUpdateInput = {
    ...(input.displayName !== undefined && { displayName: input.displayName }),
    ...(input.estimatedTradingCapital !== undefined && {
      estimatedTradingCapital: input.estimatedTradingCapital,
    }),
    ...(input.status !== undefined && { status: input.status }),
    ...(input.tradingEnabled !== undefined && {
      tradingEnabled: input.tradingEnabled,
    }),
    ...(input.killSwitchEnabled !== undefined && {
      killSwitchEnabled: input.killSwitchEnabled,
    }),
    ...(input.pausedReason !== undefined && {
      pausedReason: input.pausedReason,
    }),
    ...(input.notes !== undefined && { notes: input.notes }),
  };

  const account = await prisma.tradingAccount.update({
    where: { id },
    data,
    select: TRADING_ACCOUNT_ADMIN_SELECT,
  });

  return serializeTradingAccountForAdmin(account);
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
