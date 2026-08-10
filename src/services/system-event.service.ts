import { PlatformRole, type Prisma } from '@prisma/client';
import { HttpError } from '../errors/http-error.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { TRADING_ACCOUNT_SUMMARY_SELECT } from './trading-account.service.js';

export async function createSystemEvent(args: {
  type: string;
  entityType: string;
  entityId: string | number;
  tradingAccountId?: number | null;
  actorUserId?: number | null;
  message?: string;
  payloadJson: Prisma.InputJsonValue;
}) {
  logger.trace({
    eventType: args.type,
    entityType: args.entityType,
    entityId: args.entityId,
  }, 'Creating system event.');

  return prisma.systemEvent.create({
    data: {
      type: args.type,
      entityType: args.entityType,
      entityId: String(args.entityId),
      tradingAccountId: args.tradingAccountId ?? null,
      actorUserId: args.actorUserId ?? null,
      message: args.message ?? null,
      payloadJson: args.payloadJson,
      processed: false,
    },
  });
}

export async function getRecentSystemEvents(limit = 50) {
  return prisma.systemEvent.findMany({
    include: {
      tradingAccount: {
        select: TRADING_ACCOUNT_SUMMARY_SELECT,
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit
  });
}

export async function getAccessibleSystemEvents(
  user: { id: number; platformRole: PlatformRole },
  accountId: number | null,
  filters: { limit?: number; type?: string; search?: string } = {}
) {
  if (user.platformRole === PlatformRole.ACCOUNT_USER) {
    throw new HttpError(403, 'Admin-console system events are not available to account portal users.');
  }
  let accountScope: Prisma.SystemEventWhereInput;
  if (accountId !== null) {
    if (user.platformRole !== PlatformRole.SYSTEM_OWNER) {
      const membership = await prisma.tradingAccountMembership.findUnique({
        where: { tradingAccountId_userId: { tradingAccountId: accountId, userId: user.id } },
        select: { id: true },
      });
      if (!membership) throw new HttpError(403, 'Access to this trading account is not permitted.');
    }
    accountScope = { tradingAccountId: accountId };
  } else if (user.platformRole === PlatformRole.SYSTEM_OWNER) {
    accountScope = {};
  } else {
    accountScope = { tradingAccount: { memberships: { some: { userId: user.id } } } };
  }
  const search = filters.search?.trim();
  return prisma.systemEvent.findMany({
    where: {
      ...accountScope,
      ...(filters.type ? { type: filters.type } : {}),
      ...(search ? { OR: [
        { type: { contains: search, mode: 'insensitive' } },
        { entityType: { contains: search, mode: 'insensitive' } },
        { entityId: { contains: search, mode: 'insensitive' } },
        { message: { contains: search, mode: 'insensitive' } },
      ] } : {}),
    },
    include: { tradingAccount: { select: TRADING_ACCOUNT_SUMMARY_SELECT } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(filters.limit ?? 100, 500),
  });
}

export async function getSecurityActivity(symbol: string, limit = 10) {
  const normalizedSymbol = symbol.trim().toUpperCase();

  return prisma.systemEvent.findMany({
    where: {
      OR: [
        {
          entityType: 'security',
          entityId: normalizedSymbol,
        },
        {
          entityType: 'subscription',
          payloadJson: {
            path: ['symbol'],
            equals: normalizedSymbol,
          },
        },
      ],
    },
    include: {
      tradingAccount: {
        select: TRADING_ACCOUNT_SUMMARY_SELECT,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: limit,
  });
}
