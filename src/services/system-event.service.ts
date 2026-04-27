import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export async function createSystemEvent(args: {
  type: string;
  entityType: string;
  entityId: string | number;
  payloadJson: Prisma.InputJsonValue;
}) {
  console.log('Creating system event:', args.type, args.entityType, args.entityId);
  return prisma.systemEvent.create({
    data: {
      type: args.type,
      entityType: args.entityType,
      entityId: String(args.entityId),
      payloadJson: args.payloadJson,
      processed: false
    }
  });
}

export async function getRecentSystemEvents(limit = 50) {
  return prisma.systemEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit
  });
}