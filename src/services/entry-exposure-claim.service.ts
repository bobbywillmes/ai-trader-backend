import type { OrderIntent, Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

type Db = Prisma.TransactionClient | PrismaClient;

const ACTIVE_INTENT_STATUSES = ['received', 'pending', 'submitting', 'submitted'] as const;
const ACTIVE_POSITION_STATUSES = ['open', 'closing'] as const;

function conflict(code: string, message: string, details: Record<string, unknown>) {
  return new HttpError(409, message, { code, ...details } as Prisma.InputJsonValue);
}

export async function acquireEntryExposureClaim(args: {
  tx: Prisma.TransactionClient;
  tradingAccountId: number;
  symbol: string;
  ownerKey: string;
  createIntent: () => Promise<OrderIntent>;
}): Promise<{ intent: OrderIntent; duplicate: boolean; claimId: number }> {
  const symbol = args.symbol.trim().toUpperCase();
  const security = await args.tx.security.findUnique({ where: { symbol }, select: { id: true, symbol: true } });
  if (!security) {
    throw conflict('SECURITY_NOT_FOUND', `Security ${symbol} is not registered.`, { symbol });
  }

  await args.tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${args.tradingAccountId}:${security.id}`}, 0))`;

  const priorOwner = await args.tx.entryExposureClaim.findUnique({
    where: { ownerKey: args.ownerKey },
    include: { orderIntent: true },
  });
  if (priorOwner?.orderIntent) {
    return { intent: priorOwner.orderIntent, duplicate: true, claimId: priorOwner.id };
  }

  const activeClaim = await args.tx.entryExposureClaim.findFirst({
    where: { tradingAccountId: args.tradingAccountId, securityId: security.id, releasedAt: null },
    include: { orderIntent: true, trackedPosition: true },
  });
  if (activeClaim) {
    if (activeClaim.ownerKey === args.ownerKey && activeClaim.orderIntent) {
      return { intent: activeClaim.orderIntent, duplicate: true, claimId: activeClaim.id };
    }
    const code = activeClaim.trackedPosition?.status === 'closing'
      ? 'POSITION_CLOSING'
      : activeClaim.trackedPosition
        ? 'ALREADY_IN_POSITION'
        : activeClaim.status === 'UNRESOLVED'
          ? 'ENTRY_EXPOSURE_UNRESOLVED'
          : 'ENTRY_ALREADY_PENDING';
    throw conflict(code, `Entry exposure for ${symbol} is already owned by another lifecycle.`, {
      tradingAccountId: args.tradingAccountId,
      symbol,
      claimId: activeClaim.id,
      claimStatus: activeClaim.status,
      orderIntentId: activeClaim.orderIntentId,
      trackedPositionId: activeClaim.trackedPositionId,
    });
  }

  const activePosition = await args.tx.trackedPosition.findFirst({
    where: { tradingAccountId: args.tradingAccountId, securityId: security.id, status: { in: [...ACTIVE_POSITION_STATUSES] } },
    select: { id: true, status: true },
  });
  if (activePosition) {
    throw conflict(activePosition.status === 'closing' ? 'POSITION_CLOSING' : 'ALREADY_IN_POSITION',
      `Entry blocked because ${symbol} already has an active tracked position.`, {
        tradingAccountId: args.tradingAccountId, symbol, trackedPositionId: activePosition.id,
        trackedPositionStatus: activePosition.status, legacyExposureWithoutClaim: true,
      });
  }

  const activeIntent = await args.tx.orderIntent.findFirst({
    where: {
      tradingAccountId: args.tradingAccountId,
      symbol,
      side: 'buy',
      OR: [
        { status: { in: [...ACTIVE_INTENT_STATUSES] } },
        { status: 'filled', trackedPositionId: null },
      ],
      entryExposureClaim: null,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, clientOrderId: true },
  });
  if (activeIntent) {
    throw conflict('ENTRY_EXPOSURE_UNRESOLVED',
      `Entry blocked because ${symbol} has unresolved pre-claim entry evidence.`, {
        tradingAccountId: args.tradingAccountId, symbol, orderIntentId: activeIntent.id,
        orderIntentStatus: activeIntent.status, legacyExposureWithoutClaim: true,
      });
  }

  const intent = await args.createIntent();
  const claim = await args.tx.entryExposureClaim.create({
    data: {
      tradingAccountId: args.tradingAccountId,
      securityId: security.id,
      orderIntentId: intent.id,
      ownerKey: args.ownerKey,
      events: { create: { eventType: 'ACQUIRED', evidenceJson: { orderIntentId: intent.id, symbol } } },
    },
  });
  return { intent, duplicate: false, claimId: claim.id };
}

export async function requireEntryExposureClaim(
  orderIntentId: number,
  db: Db = prisma,
  options: { allowUnresolved?: boolean } = {},
) {
  const claim = await db.entryExposureClaim.findUnique({ where: { orderIntentId } });
  if (!claim || claim.releasedAt) {
    throw conflict('ENTRY_EXPOSURE_UNRESOLVED', 'Executable entry has no active exposure claim.', {
      orderIntentId, claimId: claim?.id ?? null, releasedAt: claim?.releasedAt?.toISOString() ?? null,
    });
  }
  if (claim.status === 'UNRESOLVED' && !options.allowUnresolved) {
    throw conflict('ENTRY_EXPOSURE_UNRESOLVED', 'Entry exposure ownership is unresolved and cannot cross the broker boundary.', {
      orderIntentId, claimId: claim.id, claimStatus: claim.status,
    });
  }
  return claim;
}

export async function transitionEntryExposureClaim(args: {
  orderIntentId: number;
  status: string;
  eventType: string;
  evidence?: Prisma.InputJsonValue;
  db?: Db;
}) {
  const db = args.db ?? prisma;
  const claim = await requireEntryExposureClaim(args.orderIntentId, db, { allowUnresolved: true });
  return db.entryExposureClaim.update({
    where: { id: claim.id },
    data: {
      status: args.status,
      events: { create: { eventType: args.eventType, evidenceJson: args.evidence ?? {} } },
    },
  });
}

export async function releaseUnsubmittedEntryExposureClaim(args: {
  orderIntentId: number;
  reason: string;
  db?: Db;
}) {
  const db = args.db ?? prisma;
  const claim = await db.entryExposureClaim.findUnique({ where: { orderIntentId: args.orderIntentId } });
  if (!claim || claim.releasedAt) return claim;
  if (!['ENTRY_PENDING', 'ENTRY_SUBMITTING', 'ADMISSION_BLOCKED'].includes(claim.status)) {
    throw conflict('ENTRY_EXPOSURE_UNRESOLVED', 'A broker-exposed claim cannot be released by the admission path.', {
      orderIntentId: args.orderIntentId, claimId: claim.id, claimStatus: claim.status,
    });
  }
  const [brokerOrders, brokerActivities, position] = await Promise.all([
    db.brokerOrder.count({ where: { orderIntentId: args.orderIntentId } }),
    db.brokerActivity.count({ where: { orderIntentId: args.orderIntentId } }),
    claim.trackedPositionId
      ? db.trackedPosition.findUnique({ where: { id: claim.trackedPositionId }, select: { status: true } })
      : null,
  ]);
  if (brokerOrders > 0 || brokerActivities > 0 || (position && position.status !== 'closed')) {
    throw conflict('ENTRY_EXPOSURE_UNRESOLVED', 'Claim has broker or position evidence and cannot be released as unsubmitted.', {
      orderIntentId: args.orderIntentId, claimId: claim.id, brokerOrders, brokerActivities,
      trackedPositionStatus: position?.status ?? null,
    });
  }
  const now = new Date();
  return db.entryExposureClaim.update({
    where: { id: claim.id },
    data: {
      status: 'RELEASED', releasedAt: now, releaseReason: args.reason,
      events: { create: { eventType: 'RELEASED_NO_BROKER_EXPOSURE', evidenceJson: { reason: args.reason } } },
    },
  });
}

export async function attachEntryExposureClaimToPosition(args: {
  tx: Prisma.TransactionClient;
  tradingAccountId: number;
  securityId: number;
  trackedPositionId: number;
  symbol: string;
}) {
  await args.tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${args.tradingAccountId}:${args.securityId}`}, 0))`;
  const active = await args.tx.entryExposureClaim.findFirst({
    where: { tradingAccountId: args.tradingAccountId, securityId: args.securityId, releasedAt: null },
  });
  if (active) {
    if (active.trackedPositionId === args.trackedPositionId && active.status === 'POSITION_OPEN') {
      return active;
    }
    if (active.trackedPositionId !== null && active.trackedPositionId !== args.trackedPositionId) {
      throw conflict('ENTRY_EXPOSURE_UNRESOLVED', 'Active claim is linked to a different tracked position.', {
        claimId: active.id,
        claimedTrackedPositionId: active.trackedPositionId,
        observedTrackedPositionId: args.trackedPositionId,
        tradingAccountId: args.tradingAccountId,
        symbol: args.symbol,
      });
    }
    return args.tx.entryExposureClaim.update({
      where: { id: active.id },
      data: {
        trackedPositionId: args.trackedPositionId, status: 'POSITION_OPEN',
        events: { create: { eventType: 'POSITION_ATTACHED', evidenceJson: { trackedPositionId: args.trackedPositionId } } },
      },
    });
  }
  return args.tx.entryExposureClaim.create({
    data: {
      tradingAccountId: args.tradingAccountId, securityId: args.securityId,
      trackedPositionId: args.trackedPositionId,
      ownerKey: `broker-position:${args.tradingAccountId}:${args.trackedPositionId}`,
      status: 'POSITION_OPEN',
      events: { create: { eventType: 'ADOPTED_AUTHORITATIVE_POSITION', evidenceJson: { trackedPositionId: args.trackedPositionId, symbol: args.symbol } } },
    },
  });
}

export async function releaseConfirmedTerminalEntryClaim(args: {
  orderIntentId: number;
  brokerStatus: string;
  db?: Db;
}) {
  const db = args.db ?? prisma;
  const normalized = args.brokerStatus.toLowerCase() === 'cancelled' ? 'canceled' : args.brokerStatus.toLowerCase();
  if (!['canceled', 'expired', 'rejected'].includes(normalized)) return null;
  const claim = await db.entryExposureClaim.findUnique({ where: { orderIntentId: args.orderIntentId } });
  if (!claim || claim.releasedAt) return claim;
  const [fillCount, activePosition] = await Promise.all([
    db.brokerActivity.count({ where: { orderIntentId: args.orderIntentId, activityType: 'FILL' } }),
    db.trackedPosition.count({
      where: { tradingAccountId: claim.tradingAccountId, securityId: claim.securityId, status: { in: [...ACTIVE_POSITION_STATUSES] } },
    }),
  ]);
  if (fillCount > 0 || activePosition > 0 || claim.trackedPositionId !== null) {
    await db.entryExposureClaim.update({
      where: { id: claim.id },
      data: {
        status: 'UNRESOLVED', lastDiagnosedAt: new Date(),
        events: { create: { eventType: 'TERMINAL_ORDER_WITH_EXPOSURE_EVIDENCE', evidenceJson: { brokerStatus: normalized, fillCount, activePosition } } },
      },
    });
    return null;
  }
  const now = new Date();
  return db.entryExposureClaim.update({
    where: { id: claim.id },
    data: {
      status: 'RELEASED', releasedAt: now, releaseReason: `BROKER_${normalized.toUpperCase()}_NO_FILL`,
      events: { create: { eventType: 'RELEASED_CONFIRMED_TERMINAL_NO_FILL', evidenceJson: { brokerStatus: normalized } } },
    },
  });
}

export async function releaseEntryExposureClaimForClosedPosition(args: {
  trackedPositionId: number;
  db?: Db;
}) {
  const db = args.db ?? prisma;
  const claim = await db.entryExposureClaim.findUnique({ where: { trackedPositionId: args.trackedPositionId } });
  if (!claim || claim.releasedAt) return claim;
  const position = await db.trackedPosition.findUnique({ where: { id: args.trackedPositionId }, select: { status: true } });
  if (position?.status !== 'closed') {
    throw conflict('ENTRY_EXPOSURE_UNRESOLVED', 'Position claim cannot be released before confirmed closure.', {
      trackedPositionId: args.trackedPositionId, claimId: claim.id, positionStatus: position?.status ?? null,
    });
  }
  const now = new Date();
  return db.entryExposureClaim.update({
    where: { id: claim.id },
    data: {
      status: 'RELEASED', releasedAt: now, releaseReason: 'CONFIRMED_POSITION_CLOSED',
      events: { create: { eventType: 'RELEASED_CONFIRMED_POSITION_CLOSED', evidenceJson: { trackedPositionId: args.trackedPositionId } } },
    },
  });
}
