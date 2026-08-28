import { Prisma, SystemEventSeverity } from '@prisma/client';
import { createSystemEvent } from './system-event.service.js';

type AdminAuditEventInput = {
  eventType: string;
  entityType: string;
  entityId: string | number;
  message: string;
  payload: Prisma.InputJsonValue;
  severity?: SystemEventSeverity;
  tradingAccountId?: number | null;
  actorUserId?: number | null;
};

export async function createAdminAuditEvent(input: AdminAuditEventInput) {
  return createSystemEvent({
    type: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    message: input.message,
    severity: input.severity ?? SystemEventSeverity.INFO,
    tradingAccountId: input.tradingAccountId ?? null,
    actorUserId: input.actorUserId ?? null,
    payloadJson: input.payload,
  });
}

export function getChangedFields<T extends Record<string, unknown>>(
  before: T,
  after: T
) {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}
