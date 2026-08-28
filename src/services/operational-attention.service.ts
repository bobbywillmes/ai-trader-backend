import {
  OperationalAttentionEventRelationKind,
  OperationalAttentionResolutionMethod,
  OperationalAttentionResolutionPolicy,
  OperationalAttentionStatus,
  Prisma,
  SystemEventSeverity,
  type Prisma as PrismaTypes,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { createSystemEvent } from './system-event.service.js';

export const OPERATIONAL_ATTENTION_CODES = {
  EXIT_QUANTITY_MISMATCH: 'EXIT_QUANTITY_MISMATCH',
  BROKER_EXCESS_EXPOSURE: 'BROKER_EXCESS_EXPOSURE',
  BROKER_EXPOSURE_UNVERIFIABLE: 'BROKER_EXPOSURE_UNVERIFIABLE',
  PROTECTIVE_EXIT_UNAVAILABLE: 'PROTECTIVE_EXIT_UNAVAILABLE',
  LIFECYCLE_REVIEW_REQUIRED: 'LIFECYCLE_REVIEW_REQUIRED',
} as const;

export type OperationalAttentionCode =
  typeof OPERATIONAL_ATTENTION_CODES[keyof typeof OPERATIONAL_ATTENTION_CODES];

export const OPERATIONAL_ATTENTION_SOURCES = {
  EXIT_VERIFICATION: 'EXIT_VERIFICATION',
  RECONCILIATION: 'RECONCILIATION',
  WORKER: 'WORKER',
  MANUAL_DIAGNOSIS: 'MANUAL_DIAGNOSIS',
  SYSTEM: 'SYSTEM',
} as const;

export type OperationalAttentionSource =
  typeof OPERATIONAL_ATTENTION_SOURCES[keyof typeof OPERATIONAL_ATTENTION_SOURCES];

const severityRank: Record<SystemEventSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  ERROR: 2,
  CRITICAL: 3,
};

const SENSITIVE_KEY = /(authorization|password|secret|credential|api[_-]?key|token|cookie)/i;

export function sanitizeOperationalAttentionDetails(value: unknown): PrismaTypes.InputJsonValue {
  function sanitize(input: unknown, depth: number): unknown {
    if (depth > 8) return '[TRUNCATED]';
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
    if (Array.isArray(input)) return input.map((item) => sanitize(item, depth + 1));
    if (typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, depth + 1),
      ]));
    }
    return String(input);
  }
  return sanitize(value, 0) as PrismaTypes.InputJsonValue;
}

type LifecycleLinks = {
  trackedPositionId?: number | null;
  orderIntentId?: number | null;
  brokerOrderId?: number | null;
};

type OpenOrObserveArgs = LifecycleLinks & {
  tradingAccountId: number;
  code: OperationalAttentionCode;
  source: OperationalAttentionSource;
  severity: SystemEventSeverity;
  title: string;
  message: string;
  details: unknown;
  fingerprint: string;
  resolutionPolicy: OperationalAttentionResolutionPolicy;
  observedAt?: Date;
  observedSystemEventId?: number | null;
};

function requireText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new HttpError(400, `${label} is required.`);
  return normalized;
}

async function validateOwnership(
  tx: PrismaTypes.TransactionClient,
  tradingAccountId: number,
  links: LifecycleLinks,
) {
  const account = await tx.tradingAccount.findUnique({ where: { id: tradingAccountId }, select: { id: true } });
  if (!account) throw new HttpError(404, `TradingAccount ${tradingAccountId} was not found.`);

  const checks = await Promise.all([
    links.trackedPositionId ? tx.trackedPosition.findUnique({ where: { id: links.trackedPositionId }, select: { tradingAccountId: true } }) : null,
    links.orderIntentId ? tx.orderIntent.findUnique({ where: { id: links.orderIntentId }, select: { tradingAccountId: true } }) : null,
    links.brokerOrderId ? tx.brokerOrder.findUnique({ where: { id: links.brokerOrderId }, select: { tradingAccountId: true } }) : null,
  ]);
  const labels = ['TrackedPosition', 'OrderIntent', 'BrokerOrder'];
  const ids = [links.trackedPositionId, links.orderIntentId, links.brokerOrderId];
  checks.forEach((record, index) => {
    if (ids[index] && (!record || record.tradingAccountId !== tradingAccountId)) {
      throw new HttpError(409, `${labels[index]} ${ids[index]} does not belong to TradingAccount ${tradingAccountId}.`);
    }
  });
}

function eventPayload(attention: {
  id: number;
  tradingAccountId: number;
  code: string;
  source: string;
  status: OperationalAttentionStatus;
  severity: SystemEventSeverity;
  revision: number;
  trackedPositionId: number | null;
  orderIntentId: number | null;
  brokerOrderId: number | null;
}, extra: Record<string, unknown> = {}) {
  return sanitizeOperationalAttentionDetails({
    operationalAttentionId: attention.id,
    tradingAccountId: attention.tradingAccountId,
    code: attention.code,
    source: attention.source,
    status: attention.status,
    severity: attention.severity,
    revision: attention.revision,
    trackedPositionId: attention.trackedPositionId,
    orderIntentId: attention.orderIntentId,
    brokerOrderId: attention.brokerOrderId,
    ...extra,
  });
}

async function createTransitionEvidence(args: {
  tx: PrismaTypes.TransactionClient;
  attention: Parameters<typeof eventPayload>[0];
  type: string;
  relationKind: OperationalAttentionEventRelationKind;
  message: string;
  severity: SystemEventSeverity;
  actorUserId?: number | null;
  extra?: Record<string, unknown>;
}) {
  const event = await createSystemEvent({
    type: args.type,
    entityType: 'operationalAttention',
    entityId: args.attention.id,
    tradingAccountId: args.attention.tradingAccountId,
    actorUserId: args.actorUserId ?? null,
    message: args.message,
    severity: args.severity,
    payloadJson: eventPayload(args.attention, args.extra),
  }, args.tx);
  await args.tx.operationalAttentionSystemEvent.create({
    data: {
      operationalAttentionId: args.attention.id,
      systemEventId: event.id,
      relationKind: args.relationKind,
    },
  });
  return event;
}

async function openOrObserveTransaction(args: OpenOrObserveArgs) {
  return prisma.$transaction(async (tx) => {
    if (args.severity === SystemEventSeverity.INFO) {
      throw new HttpError(400, 'Active operational attention must be at least WARNING severity.');
    }
    await validateOwnership(tx, args.tradingAccountId, args);
    const now = args.observedAt ?? new Date();
    const fingerprint = requireText(args.fingerprint, 'Attention fingerprint');
    const title = requireText(args.title, 'Attention title');
    const message = requireText(args.message, 'Attention message');
    const detailsJson = sanitizeOperationalAttentionDetails(args.details);
    const existing = await tx.operationalAttention.findUnique({ where: { activeKey: fingerprint } });
    if (existing) {
      if (
        existing.tradingAccountId !== args.tradingAccountId ||
        existing.fingerprint !== fingerprint ||
        existing.code !== args.code ||
        existing.source !== args.source ||
        existing.trackedPositionId !== (args.trackedPositionId ?? null) ||
        existing.orderIntentId !== (args.orderIntentId ?? null) ||
        existing.brokerOrderId !== (args.brokerOrderId ?? null)
      ) {
        throw new HttpError(409, 'Active attention key conflicts with a different condition.');
      }
      const escalated = severityRank[args.severity] > severityRank[existing.severity];
      const updated = await tx.operationalAttention.update({
        where: { id: existing.id },
        data: {
          occurrenceCount: { increment: 1 },
          lastObservedAt: now,
          detailsJson,
          title,
          message,
          revision: { increment: 1 },
          ...(escalated ? { severity: args.severity } : {}),
          ...(escalated && existing.status === OperationalAttentionStatus.ACKNOWLEDGED
            ? {
                status: OperationalAttentionStatus.OPEN,
                acknowledgedAt: null,
                acknowledgedByUserId: null,
                acknowledgedByUserIdSnapshot: null,
              }
            : {}),
        },
      });
      if (args.observedSystemEventId) {
        await tx.operationalAttentionSystemEvent.upsert({
          where: { operationalAttentionId_systemEventId: { operationalAttentionId: updated.id, systemEventId: args.observedSystemEventId } },
          create: { operationalAttentionId: updated.id, systemEventId: args.observedSystemEventId, relationKind: OperationalAttentionEventRelationKind.OBSERVED },
          update: {},
        });
      }
      if (escalated) {
        await createTransitionEvidence({
          tx,
          attention: updated,
          type: 'operational_attention.escalated',
          relationKind: OperationalAttentionEventRelationKind.ESCALATED,
          message: `${updated.title} escalated to ${updated.severity}.`,
          severity: updated.severity,
          extra: { previousSeverity: existing.severity, observedAt: now, details: detailsJson },
        });
      }
      return { attention: updated, created: false, escalated };
    }

    const created = await tx.operationalAttention.create({
      data: {
        tradingAccountId: args.tradingAccountId,
        code: args.code,
        source: args.source,
        status: OperationalAttentionStatus.OPEN,
        severity: args.severity,
        title,
        message,
        detailsJson,
        fingerprint,
        activeKey: fingerprint,
        occurrenceCount: 1,
        firstObservedAt: now,
        lastObservedAt: now,
        revision: 1,
        resolutionPolicy: args.resolutionPolicy,
        trackedPositionId: args.trackedPositionId ?? null,
        orderIntentId: args.orderIntentId ?? null,
        brokerOrderId: args.brokerOrderId ?? null,
      },
    });
    await createTransitionEvidence({
      tx,
      attention: created,
      type: 'operational_attention.opened',
      relationKind: OperationalAttentionEventRelationKind.OPENED,
      message: created.message,
      severity: created.severity,
      extra: { observedAt: now, details: detailsJson },
    });
    if (args.observedSystemEventId) {
      await tx.operationalAttentionSystemEvent.upsert({
        where: { operationalAttentionId_systemEventId: { operationalAttentionId: created.id, systemEventId: args.observedSystemEventId } },
        create: { operationalAttentionId: created.id, systemEventId: args.observedSystemEventId, relationKind: OperationalAttentionEventRelationKind.OBSERVED },
        update: {},
      });
    }
    return { attention: created, created: true, escalated: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function openOrObserveOperationalAttention(args: OpenOrObserveArgs) {
  try {
    return await openOrObserveTransaction(args);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return openOrObserveTransaction(args);
    }
    throw error;
  }
}

async function loadLockedAttention(tx: PrismaTypes.TransactionClient, id: number) {
  await tx.$queryRaw`SELECT id FROM "OperationalAttention" WHERE id = ${id} FOR UPDATE`;
  const attention = await tx.operationalAttention.findUnique({ where: { id } });
  if (!attention) throw new HttpError(404, `OperationalAttention ${id} was not found.`);
  return attention;
}

export async function acknowledgeOperationalAttention(args: {
  id: number;
  actorUserId: number;
  expectedRevision: number;
  acknowledgedAt?: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const existing = await loadLockedAttention(tx, args.id);
    if (existing.revision !== args.expectedRevision) throw new HttpError(409, 'Operational attention revision is stale.');
    if (existing.status !== OperationalAttentionStatus.OPEN) throw new HttpError(409, 'Only open operational attention can be acknowledged.');
    const now = args.acknowledgedAt ?? new Date();
    const updated = await tx.operationalAttention.update({
      where: { id: existing.id },
      data: { status: OperationalAttentionStatus.ACKNOWLEDGED, acknowledgedAt: now, acknowledgedByUserId: args.actorUserId, acknowledgedByUserIdSnapshot: args.actorUserId, revision: { increment: 1 } },
    });
    await createTransitionEvidence({
      tx, attention: updated, type: 'operational_attention.acknowledged',
      relationKind: OperationalAttentionEventRelationKind.ACKNOWLEDGED,
      message: `${updated.title} was acknowledged.`, severity: SystemEventSeverity.INFO,
      ...(args.actorUserId !== undefined ? { actorUserId: args.actorUserId } : {}),
      extra: { previousStatus: existing.status, acknowledgedAt: now, actorUserId: args.actorUserId },
    });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function resolveOperationalAttention(args: {
  id: number;
  expectedRevision: number;
  method: OperationalAttentionResolutionMethod;
  reason: string;
  evidence: unknown;
  actorUserId?: number | null;
  resolvedAt?: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const existing = await loadLockedAttention(tx, args.id);
    if (existing.revision !== args.expectedRevision) throw new HttpError(409, 'Operational attention revision is stale.');
    if (existing.status === OperationalAttentionStatus.RESOLVED) throw new HttpError(409, 'Resolved operational attention cannot be reopened or resolved again.');
    if (args.method === OperationalAttentionResolutionMethod.MANUAL && existing.resolutionPolicy !== OperationalAttentionResolutionPolicy.MANUAL_ALLOWED) {
      throw new HttpError(409, 'This operational attention requires authoritative resolution.');
    }
    const reason = requireText(args.reason, 'Resolution reason');
    if (args.method === OperationalAttentionResolutionMethod.MANUAL && !args.actorUserId) throw new HttpError(400, 'Manual resolution requires an actor.');
    if (
      args.method === OperationalAttentionResolutionMethod.AUTHORITATIVE &&
      (!args.evidence || typeof args.evidence !== 'object' || Object.keys(args.evidence as object).length === 0)
    ) {
      throw new HttpError(400, 'Authoritative resolution requires evidence.');
    }
    const resolvedAt = args.resolvedAt ?? new Date();
    const evidence = sanitizeOperationalAttentionDetails(args.evidence);
    const updated = await tx.operationalAttention.update({
      where: { id: existing.id },
      data: {
        status: OperationalAttentionStatus.RESOLVED,
        activeKey: null,
        resolvedAt,
        resolvedByUserId: args.actorUserId ?? null,
        resolvedByUserIdSnapshot: args.actorUserId ?? null,
        resolutionMethod: args.method,
        resolutionReason: reason,
        detailsJson: evidence,
        revision: { increment: 1 },
      },
    });
    await createTransitionEvidence({
      tx, attention: updated,
      type: args.method === OperationalAttentionResolutionMethod.MANUAL ? 'operational_attention.manually_resolved' : 'operational_attention.resolved',
      relationKind: OperationalAttentionEventRelationKind.RESOLVED,
      message: `${updated.title} was resolved.`, severity: SystemEventSeverity.INFO,
      ...(args.actorUserId !== undefined ? { actorUserId: args.actorUserId } : {}),
      extra: { previousStatus: existing.status, resolutionMethod: args.method, resolutionReason: reason, resolvedAt, actorUserId: args.actorUserId ?? null, evidence },
    });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function resolveOperationalAttentionAuthoritatively(args: {
  id: number;
  expectedRevision: number;
  reason: string;
  evidence: unknown;
  resolvedAt?: Date;
}) {
  return resolveOperationalAttention({ ...args, method: OperationalAttentionResolutionMethod.AUTHORITATIVE });
}

export function resolveOperationalAttentionManually(args: {
  id: number;
  expectedRevision: number;
  actorUserId: number;
  reason: string;
  evidence?: unknown;
  resolvedAt?: Date;
}) {
  return resolveOperationalAttention({ ...args, evidence: args.evidence ?? {}, method: OperationalAttentionResolutionMethod.MANUAL });
}
