import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

type AdminAuditEventInput = {
  eventType: string;
  entityType: string;
  entityId: string | number;
  message: string;
  payload: Prisma.InputJsonValue;
};

export async function createAdminAuditEvent(input: AdminAuditEventInput) {
  return prisma.systemEvent.create({
    data: {
      type: input.eventType,
      entityType: input.entityType,
      entityId: String(input.entityId),
      message: input.message,
      payloadJson: input.payload,
    },
  });
}

export function getChangedFields<T extends Record<string, unknown>>(
  before: T,
  after: T
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}