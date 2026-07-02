import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { TRADING_ACCOUNT_SUMMARY_SELECT } from './trading-account.service.js';

export async function createSystemEvent(args: {
  type: string;
  entityType: string;
  entityId: string | number;
  tradingAccountId?: number | null;
  message?: string;
  payloadJson: Prisma.InputJsonValue;
}) {
  console.log('Creating system event:', args.type, args.entityType, args.entityId);

  return prisma.systemEvent.create({
    data: {
      type: args.type,
      entityType: args.entityType,
      entityId: String(args.entityId),
      tradingAccountId: args.tradingAccountId ?? null,
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
