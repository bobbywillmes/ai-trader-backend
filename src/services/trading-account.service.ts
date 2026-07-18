import {
  Prisma,
  TradingAccountEnvironment,
  TradingAccountStatus,
  TradingBroker,
  type TradingAccount,
} from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { CreateTradingAccountInput, UpdateTradingAccountInput } from '../validators/trading-account.schema.js';
import { HttpError } from '../errors/http-error.js';
import {
  assertAccountRiskConfiguration,
  withAccountRiskConfigurationTransaction,
} from './trading-account-risk-configuration.service.js';

const LEGACY_DEFAULT_TRADING_ACCOUNT = {
  broker: TradingBroker.ALPACA,
  environment: TradingAccountEnvironment.PAPER,
  displayName: 'Bobby Paper',
} as const;

const ACTIVE_POSITION_STATUSES = ['open', 'closing'];

const TRADING_ACCOUNT_ADMIN_SELECT = {
  id: true,
  accountHolderUserId: true,
  displayName: true,
  broker: true,
  environment: true,
  status: true,
  tradingEnabled: true,
  killSwitchEnabled: true,
  estimatedTradingCapital: true,
  maxDeployableNotional: true,
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
  allocations: {
    where: { enabled: true },
    select: { maxAllocatedNotional: true },
  },
} satisfies Prisma.TradingAccountSelect;

export const TRADING_ACCOUNT_SUMMARY_SELECT = {
  id: true,
  displayName: true,
  broker: true,
  environment: true,
  status: true,
} satisfies Prisma.TradingAccountSelect;

type TradingAccountAdminRecord = Prisma.TradingAccountGetPayload<{
  select: typeof TRADING_ACCOUNT_ADMIN_SELECT;
}>;

type TradingAccountOpenPositionExposure = {
  tradingAccountId: number | null;
  marketValue: number;
  costBasis: number;
};

export type TradingAccountSummaryResponse = Prisma.TradingAccountGetPayload<{
  select: typeof TRADING_ACCOUNT_SUMMARY_SELECT;
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
  account: TradingAccountAdminRecord,
  totalOpenPositionNotional = 0
) {
  const credential = account.credential;
  const enabledAllocatedNotional = (account.allocations ?? []).reduce(
    (total, allocation) => total + (allocation.maxAllocatedNotional ?? 0),
    0
  );
  const remainingDeployableNotional =
    account.maxDeployableNotional === null
      ? null
      : account.maxDeployableNotional - enabledAllocatedNotional;

  return {
    id: account.id,
    accountHolderUserId: account.accountHolderUserId,
    displayName: account.displayName,
    broker: account.broker,
    environment: account.environment,
    status: account.status,
    tradingEnabled: account.tradingEnabled,
    killSwitchEnabled: account.killSwitchEnabled,
    estimatedTradingCapital: account.estimatedTradingCapital,
    maxDeployableNotional: account.maxDeployableNotional,
    enabledAllocatedNotional,
    remainingDeployableNotional,
    baseCurrency: account.baseCurrency,
    brokerAccountId: account.brokerAccountId,
    brokerAccountNumberMasked: account.brokerAccountNumberMasked,
    brokerAccountStatus: account.brokerAccountStatus,
    lastBrokerSyncAt: account.lastBrokerSyncAt,
    lastCash: account.lastCash,
    lastBuyingPower: account.lastBuyingPower,
    lastEquity: account.lastEquity,
    lastPortfolioValue: account.lastPortfolioValue,
    totalOpenPositionNotional,
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

function duplicateTradingAccountError(environment: TradingAccountEnvironment) {
  return new HttpError(409, `The selected User already has an Alpaca ${environment === TradingAccountEnvironment.PAPER ? 'Paper' : 'Live'} Trading Account.`);
}

export async function createTradingAccountForAdmin(input: CreateTradingAccountInput) {
  try {
    const accountId = await prisma.$transaction(async (tx) => {
      const holder = await tx.user.findUnique({ where: { id: input.accountHolderUserId }, select: { id: true, enabled: true } });
      if (!holder) throw new HttpError(404, 'Account holder User not found.');
      if (!holder.enabled) throw new HttpError(400, 'Account holder User must be enabled.');

      const duplicate = await tx.tradingAccount.findFirst({
        where: { accountHolderUserId: input.accountHolderUserId, broker: TradingBroker.ALPACA, environment: input.environment },
        select: { id: true },
      });
      if (duplicate) throw duplicateTradingAccountError(input.environment);

      const created = await tx.tradingAccount.create({
        data: {
          accountHolderUserId: input.accountHolderUserId,
          displayName: input.displayName,
          broker: TradingBroker.ALPACA,
          environment: input.environment,
          status: TradingAccountStatus.NEEDS_CREDENTIALS,
          tradingEnabled: false,
          killSwitchEnabled: true,
          baseCurrency: 'USD',
          ...(input.estimatedTradingCapital !== undefined && { estimatedTradingCapital: input.estimatedTradingCapital }),
          ...(input.maxDeployableNotional !== undefined && { maxDeployableNotional: input.maxDeployableNotional }),
          ...(input.notes !== undefined && { notes: input.notes }),
          memberships: { create: { userId: input.accountHolderUserId } },
        },
        select: { id: true },
      });
      return created.id;
    });
    const account = await getTradingAccountForAdmin(accountId);
    if (!account) throw new Error('Created Trading Account could not be loaded.');
    return account;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw duplicateTradingAccountError(input.environment);
    }
    throw error;
  }
}

function getPositionExposure(position: {
  marketValue: number;
  costBasis: number;
}) {
  const exposure = position.marketValue || position.costBasis || 0;
  return Math.abs(exposure);
}

function sumOpenPositionNotional(
  positions: TradingAccountOpenPositionExposure[]
) {
  return positions.reduce(
    (total, position) => total + getPositionExposure(position),
    0
  );
}

async function getOpenPositionNotionalByTradingAccountId(
  tradingAccountIds: number[]
) {
  if (tradingAccountIds.length === 0) {
    return new Map<number, number>();
  }

  const positions = await prisma.trackedPosition.findMany({
    where: {
      tradingAccountId: {
        in: tradingAccountIds,
      },
      status: {
        in: ACTIVE_POSITION_STATUSES,
      },
    },
    select: {
      tradingAccountId: true,
      marketValue: true,
      costBasis: true,
    },
  });

  const totals = new Map<number, number>();

  for (const position of positions) {
    if (position.tradingAccountId === null) {
      continue;
    }

    totals.set(
      position.tradingAccountId,
      (totals.get(position.tradingAccountId) ?? 0) +
        getPositionExposure(position)
    );
  }

  return totals;
}

export async function listTradingAccountsForAdmin() {
  const accounts = await prisma.tradingAccount.findMany({
    select: TRADING_ACCOUNT_ADMIN_SELECT,
    orderBy: {
      id: 'asc',
    },
  });
  const openPositionNotionalByAccount =
    await getOpenPositionNotionalByTradingAccountId(
      accounts.map((account) => account.id)
    );

  return accounts.map((account) =>
    serializeTradingAccountForAdmin(
      account,
      openPositionNotionalByAccount.get(account.id) ?? 0
    )
  );
}

export async function listTradingAccountsForUser(args: {
  userId: number;
  isSystemOwner: boolean;
}) {
  const accounts = await listTradingAccountsForAdmin();

  // System owners, including the static admin context, can see all accounts.
  if (args.isSystemOwner) {
    return accounts;
  }

  const memberships = await prisma.tradingAccountMembership.findMany({
    where: {
      userId: args.userId,
    },
    select: {
      tradingAccountId: true,
    },
  });

  const allowedAccountIds = new Set(
    memberships.map((membership) => membership.tradingAccountId)
  );

  return accounts.filter((account) => allowedAccountIds.has(account.id));
}

export async function getTradingAccountForAdmin(id: number) {
  const [account, positions] = await Promise.all([
    prisma.tradingAccount.findUnique({
      where: { id },
      select: TRADING_ACCOUNT_ADMIN_SELECT,
    }),
    prisma.trackedPosition.findMany({
      where: {
        tradingAccountId: id,
        status: {
          in: ACTIVE_POSITION_STATUSES,
        },
      },
      select: {
        tradingAccountId: true,
        marketValue: true,
        costBasis: true,
      },
    }),
  ]);

  return account
    ? serializeTradingAccountForAdmin(
        account,
        sumOpenPositionNotional(positions)
      )
    : null;
}

export async function getTradingAccountSummaryById(id: number) {
  return prisma.tradingAccount.findUnique({
    where: { id },
    select: TRADING_ACCOUNT_SUMMARY_SELECT,
  });
}

export async function updateTradingAccountForAdmin(
  id: number,
  input: UpdateTradingAccountInput
) {
  const data: Prisma.TradingAccountUpdateInput = {
    ...(input.displayName !== undefined && { displayName: input.displayName }),
    ...(input.estimatedTradingCapital !== undefined && {
      estimatedTradingCapital: input.estimatedTradingCapital,
    }),
    ...(input.maxDeployableNotional !== undefined && {
      maxDeployableNotional: input.maxDeployableNotional,
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

  return withAccountRiskConfigurationTransaction(async (tx) => {
    const existing = await tx.tradingAccount.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) return null;

    if (input.maxDeployableNotional !== undefined) {
      await assertAccountRiskConfiguration(tx, id, {
        account: { maxDeployableNotional: input.maxDeployableNotional },
      });
    }

    const account = await tx.tradingAccount.update({
      where: { id },
      data,
      select: TRADING_ACCOUNT_ADMIN_SELECT,
    });
    return serializeTradingAccountForAdmin(account);
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
