import { PlatformRole, type Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { getNormalizedOpenOrders } from './orders.service.js';
import { getOpenTrackedPositionsForTradingAccount } from './position-tracking.service.js';

const OPERATIONAL_ACCOUNT_SELECT = {
  id: true,
  displayName: true,
  broker: true,
  environment: true,
  status: true,
  accountHolder: { select: { name: true, email: true } },
  credential: { select: { status: true } },
} satisfies Prisma.TradingAccountSelect;

type OperationalAccountRecord = Prisma.TradingAccountGetPayload<{
  select: typeof OPERATIONAL_ACCOUNT_SELECT;
}>;

export function operationalAccountIdentity(account: OperationalAccountRecord) {
  return {
    id: account.id,
    displayName: account.displayName,
    accountHolderName: account.accountHolder.name ?? account.accountHolder.email,
    broker: account.broker,
    environment: account.environment,
    status: account.status,
  };
}

function accessibleWhere(user: { id: number; platformRole: PlatformRole }) {
  return user.platformRole === PlatformRole.SYSTEM_OWNER
    ? {}
    : { memberships: { some: { userId: user.id } } };
}

export async function getOperationalAccount(tradingAccountId: number) {
  return prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: OPERATIONAL_ACCOUNT_SELECT,
  });
}

export async function listScopedOpenPositions(user: {
  id: number;
  platformRole: PlatformRole;
}) {
  const accounts = await prisma.tradingAccount.findMany({
    where: accessibleWhere(user),
    select: OPERATIONAL_ACCOUNT_SELECT,
    orderBy: { id: 'asc' },
  });
  const accountMap = new Map(
    accounts.map((account) => [account.id, operationalAccountIdentity(account)])
  );
  if (accounts.length === 0) return [];

  const positions = await prisma.trackedPosition.findMany({
    where: {
      tradingAccountId: { in: accounts.map((account) => account.id) },
      status: { in: ['open', 'closing'] },
    },
    orderBy: [{ tradingAccountId: 'asc' }, { symbol: 'asc' }],
    include: {
      exitState: true,
      subscription: { include: { strategy: true, exitProfile: true } },
    },
  });

  return positions.map((position) => ({
    ...position,
    tradingAccount:
      position.tradingAccountId === null
        ? null
        : accountMap.get(position.tradingAccountId) ?? null,
  }));
}

export async function listScopedOpenOrders(user: {
  id: number;
  platformRole: PlatformRole;
}) {
  const accounts = await prisma.tradingAccount.findMany({
    where: accessibleWhere(user),
    select: OPERATIONAL_ACCOUNT_SELECT,
    orderBy: { id: 'asc' },
  });

  const results = [];
  for (const account of accounts) {
    const identity = operationalAccountIdentity(account);
    if (account.credential?.status !== 'ACTIVE') {
      results.push({
        account: identity,
        availability: 'UNAVAILABLE' as const,
        reason: account.credential ? 'CREDENTIALS_UNUSABLE' as const : 'CREDENTIALS_MISSING' as const,
        message: account.credential
          ? `Broker credentials are ${account.credential.status.toLowerCase()}.`
          : 'Broker credentials are missing.',
        orders: null,
      });
      continue;
    }

    try {
      const orders = await getNormalizedOpenOrders(account.id, 'open_orders_sync');
      results.push({
        account: identity,
        availability: 'AVAILABLE' as const,
        reason: null,
        message: null,
        orders: orders.map((order) => ({
          ...order,
          tradingAccountId: account.id,
          tradingAccount: identity,
        })),
      });
    } catch (error) {
      results.push({
        account: identity,
        availability: 'UNAVAILABLE' as const,
        reason: 'BROKER_REQUEST_FAILED' as const,
        message: error instanceof Error ? error.message : 'Broker request failed.',
        orders: null,
      });
    }
  }
  return results;
}

export async function getScopedOpenPositionsForAccount(tradingAccountId: number) {
  const account = await getOperationalAccount(tradingAccountId);
  if (!account) throw new HttpError(404, 'Trading account not found.');
  const identity = operationalAccountIdentity(account);
  const positions = await getOpenTrackedPositionsForTradingAccount(tradingAccountId);
  return { account: identity, positions: positions.map((position) => ({ ...position, tradingAccount: identity })) };
}

export async function getScopedOpenOrdersForAccount(tradingAccountId: number) {
  const account = await getOperationalAccount(tradingAccountId);
  if (!account) throw new HttpError(404, 'Trading account not found.');
  const identity = operationalAccountIdentity(account);
  if (account.credential?.status !== 'ACTIVE') {
    return {
      account: identity,
      availability: 'UNAVAILABLE' as const,
      reason: account.credential ? 'CREDENTIALS_UNUSABLE' as const : 'CREDENTIALS_MISSING' as const,
      message: account.credential
        ? `Broker credentials are ${account.credential.status.toLowerCase()}.`
        : 'Broker credentials are missing.',
      orders: null,
    };
  }
  try {
    const orders = await getNormalizedOpenOrders(tradingAccountId, 'open_orders_sync');
    return {
      account: identity,
      availability: 'AVAILABLE' as const,
      reason: null,
      message: null,
      orders: orders.map((order) => ({ ...order, tradingAccountId, tradingAccount: identity })),
    };
  } catch (error) {
    return {
      account: identity,
      availability: 'UNAVAILABLE' as const,
      reason: 'BROKER_REQUEST_FAILED' as const,
      message: error instanceof Error ? error.message : 'Broker request failed.',
      orders: null,
    };
  }
}
