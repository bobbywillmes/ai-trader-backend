import type { OrderIntent, Prisma, PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { getAlpacaOrderByClientOrderId, getAlpacaOrderById, getOpenAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';
import { getAlpacaPositionBySymbol } from '../integrations/alpaca/positions.adapter.js';
import { isTerminalBrokerOrderStatus } from './broker-order-lifecycle-status.service.js';
import {
  BROKER_ACTIVE_ENTRY_STATUSES,
  UNRESOLVED_ORDER_INTENT_STATUSES,
  canTransitionEntryExposureClaim,
  isEntryExposureClaimStatus,
} from './entry-lifecycle-status.service.js';

type Db = Prisma.TransactionClient | PrismaClient;

const ACTIVE_POSITION_STATUSES = ['open', 'closing'] as const;

function conflict(code: string, message: string, details: Record<string, unknown>) {
  return new HttpError(409, message, { code, ...details } as Prisma.InputJsonValue);
}

function sameEvidence(left: unknown, right: unknown) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

export async function previewEntryExposureClaimRemediation(claimId: number) {
  const claim = await prisma.entryExposureClaim.findUnique({
    where: { id: claimId },
    include: {
      security: { select: { id: true, symbol: true } },
      orderIntent: { select: { id: true, clientOrderId: true, blockReason: true } },
      trackedPosition: { select: { id: true, status: true } },
    },
  });
  if (!claim) throw new HttpError(404, `EntryExposureClaim ${claimId} was not found.`);
  const localOrder = claim.orderIntentId ? await prisma.brokerOrder.findFirst({
    where: { orderIntentId: claim.orderIntentId }, orderBy: { createdAt: 'desc' },
    select: { id: true, brokerOrderId: true, clientOrderId: true, status: true },
  }) : null;
  let brokerOrder = null;
  let brokerPosition = null;
  let openOrders: Awaited<ReturnType<typeof getOpenAlpacaOrders>> = [];
  let lookupError: string | null = null;
  try {
    brokerOrder = localOrder
      ? await getAlpacaOrderById(claim.tradingAccountId, localOrder.brokerOrderId, 'manual_admin_action')
      : claim.orderIntent?.clientOrderId
        ? await getAlpacaOrderByClientOrderId(claim.tradingAccountId, claim.orderIntent.clientOrderId, 'manual_admin_action')
        : null;
    [brokerPosition, openOrders] = await Promise.all([
      getAlpacaPositionBySymbol(claim.tradingAccountId, claim.security.symbol, 'manual_admin_action'),
      getOpenAlpacaOrders(claim.tradingAccountId, 'manual_admin_action'),
    ]);
  } catch (error) {
    lookupError = error instanceof Error ? error.message : 'Broker lookup failed.';
  }
  const fills = claim.orderIntentId ? await prisma.brokerActivity.findMany({
    where: { orderIntentId: claim.orderIntentId, activityType: 'FILL', side: 'buy' },
    select: { id: true, activityId: true, qty: true }, orderBy: { id: 'asc' },
  }) : [];
  const brokerFilled = Number(brokerOrder?.filled_qty ?? 0);
  const locallyAccounted = fills.reduce((sum, fill) => sum + Number(fill.qty ?? 0), 0);
  const relevantOpenOrders = openOrders.filter((order) =>
    order.symbol.toUpperCase() === claim.security.symbol.toUpperCase() &&
    order.side.toLowerCase() === 'buy' && !isTerminalBrokerOrderStatus(order.status));
  const positionOnlyRecovery = !claim.orderIntentId && claim.trackedPosition?.status === 'closed';
  const blockers = [
    ...(claim.releasedAt ? ['CLAIM_ALREADY_RELEASED'] : []),
    ...(lookupError ? ['BROKER_LOOKUP_FAILED'] : []),
    ...(!brokerOrder && !positionOnlyRecovery ? ['BROKER_ORDER_NOT_ESTABLISHED'] : []),
    ...(brokerOrder && !isTerminalBrokerOrderStatus(brokerOrder.status) ? ['BROKER_ORDER_NONTERMINAL'] : []),
    ...(brokerPosition ? ['BROKER_POSITION_PRESENT'] : []),
    ...(relevantOpenOrders.length ? ['BROKER_BUY_ORDER_PRESENT'] : []),
    ...(claim.orderIntent?.blockReason?.includes('DELIVERY_UNCERTAIN') ? ['DELIVERY_UNCERTAIN'] : []),
    ...(!Number.isFinite(brokerFilled) || locallyAccounted + 1e-9 < brokerFilled ? ['BROKER_FILLS_UNACCOUNTED'] : []),
  ];
  const evidence = {
    claim: { id: claim.id, status: claim.status, tradingAccountId: claim.tradingAccountId, securityId: claim.securityId,
      symbol: claim.security.symbol, orderIntentId: claim.orderIntentId, trackedPositionId: claim.trackedPositionId,
      trackedPositionStatus: claim.trackedPosition?.status ?? null },
    localOrder,
    brokerOrder: brokerOrder ? { id: brokerOrder.id, clientOrderId: brokerOrder.client_order_id, status: brokerOrder.status,
      qty: brokerOrder.qty, filledQty: brokerOrder.filled_qty ?? null } : null,
    brokerPosition: brokerPosition ? { symbol: brokerPosition.symbol, side: brokerPosition.side, qty: brokerPosition.qty } : null,
    relevantOpenOrders: relevantOpenOrders.map((order) => ({ id: order.id, clientOrderId: order.client_order_id, status: order.status, qty: order.qty, filledQty: order.filled_qty ?? null })),
    fills,
    locallyAccountedQuantity: locallyAccounted,
    lookupError,
    blockers,
  };
  return {
    ...evidence,
    eligible: blockers.length === 0,
    confirmationFingerprint: crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
  };
}

export async function releaseClosedAdoptedPositionClaim(args: { claimId: number; actorUserId: number }) {
  const claim = await prisma.entryExposureClaim.findUnique({
    where: { id: args.claimId }, include: { security: { select: { symbol: true } }, trackedPosition: { select: { status: true } } },
  });
  if (!claim || claim.releasedAt) return claim;
  if (claim.orderIntentId || !claim.trackedPositionId || claim.trackedPosition?.status !== 'closed') {
    throw conflict('ENTRY_EXPOSURE_UNRESOLVED', 'Position-only remediation requires an adopted closed position with no attributed entry intent.', { claimId: args.claimId });
  }
  const [brokerPosition, openOrders] = await Promise.all([
    getAlpacaPositionBySymbol(claim.tradingAccountId, claim.security.symbol, 'manual_admin_action'),
    getOpenAlpacaOrders(claim.tradingAccountId, 'manual_admin_action'),
  ]);
  const relevantOpenOrders = openOrders.filter((order) =>
    order.symbol.toUpperCase() === claim.security.symbol.toUpperCase() && order.side.toLowerCase() === 'buy' && !isTerminalBrokerOrderStatus(order.status));
  if (brokerPosition || relevantOpenOrders.length) {
    await markClaimUnresolved(claim.id, 'OPERATOR_POSITION_ONLY_RELEASE_REFUSED', {
      actorUserId: args.actorUserId, brokerPositionQuantity: brokerPosition?.qty ?? null,
      openBrokerBuyOrderIds: relevantOpenOrders.map((order) => order.id),
    }, prisma);
    return null;
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${claim.tradingAccountId}:${claim.securityId}`}, 0))`;
    const current = await tx.entryExposureClaim.findUnique({ where: { id: claim.id }, include: { trackedPosition: { select: { status: true } } } });
    if (!current || current.releasedAt) return current;
    const [activePosition, activeBuyOrder] = await Promise.all([
      tx.trackedPosition.count({ where: { tradingAccountId: claim.tradingAccountId, securityId: claim.securityId, status: { in: [...ACTIVE_POSITION_STATUSES] } } }),
      tx.brokerOrder.count({ where: { tradingAccountId: claim.tradingAccountId, securityId: claim.securityId, side: { equals: 'buy', mode: 'insensitive' }, status: { notIn: ['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'replaced', 'done_for_day', 'calculated'] } } }),
    ]);
    if (current.trackedPosition?.status !== 'closed' || activePosition || activeBuyOrder) return null;
    const now = new Date();
    return tx.entryExposureClaim.update({
      where: { id: claim.id },
      data: {
        status: 'RELEASED', releasedAt: now, releaseReason: 'OPERATOR_VERIFIED_CLOSED_ADOPTED_POSITION_NO_BROKER_EXPOSURE',
        events: { create: { eventType: 'RELEASED_OPERATOR_VERIFIED_POSITION_ONLY', evidenceJson: {
          actorUserId: args.actorUserId, trackedPositionId: claim.trackedPositionId,
          brokerPosition: null, openBrokerBuyOrders: [],
        } } },
      },
    });
  });
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
        { status: { in: [...UNRESOLVED_ORDER_INTENT_STATUSES] } },
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

  const activeBrokerOrder = await args.tx.brokerOrder.findFirst({
    where: {
      tradingAccountId: args.tradingAccountId,
      securityId: security.id,
      side: { equals: 'buy', mode: 'insensitive' },
      status: { in: [...BROKER_ACTIVE_ENTRY_STATUSES] },
      orderIntent: { entryExposureClaim: null },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, orderIntentId: true, brokerOrderId: true, status: true },
  });
  if (activeBrokerOrder) {
    throw conflict('ENTRY_EXPOSURE_UNRESOLVED',
      `Entry blocked because ${symbol} has an active pre-claim broker BUY.`, {
        tradingAccountId: args.tradingAccountId, symbol,
        brokerOrderRecordId: activeBrokerOrder.id,
        brokerOrderId: activeBrokerOrder.brokerOrderId,
        brokerOrderStatus: activeBrokerOrder.status,
        orderIntentId: activeBrokerOrder.orderIntentId,
        legacyExposureWithoutClaim: true,
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

export async function requireExecutableEntryExposureClaim(args: {
  orderIntentId: number;
  tradingAccountId: number;
  symbol: string;
  clientOrderId: string;
  db?: Db;
}) {
  const db = args.db ?? prisma;
  const claim = await requireEntryExposureClaim(args.orderIntentId, db);
  const intent = await db.orderIntent.findUnique({
    where: { id: args.orderIntentId },
    include: { tradingAccount: { select: { environment: true } } },
  });
  const security = await db.security.findUnique({
    where: { symbol: args.symbol.trim().toUpperCase() }, select: { id: true },
  });
  const mismatches = {
    intentMissing: !intent,
    account: intent?.tradingAccountId !== args.tradingAccountId || claim.tradingAccountId !== args.tradingAccountId,
    security: !security || claim.securityId !== security.id,
    symbol: intent?.symbol.trim().toUpperCase() !== args.symbol.trim().toUpperCase(),
    side: intent?.side.trim().toLowerCase() !== 'buy',
    clientOrderId: intent?.clientOrderId !== args.clientOrderId,
    intentStatus: intent?.status !== 'submitting',
    claimStatus: claim.status !== 'ENTRY_SUBMITTING',
    environment: intent?.tradingAccount?.environment !== 'PAPER' && intent?.tradingAccount?.environment !== 'LIVE',
  };
  if (Object.values(mismatches).some(Boolean)) {
    throw conflict('ENTRY_EXPOSURE_IDENTITY_MISMATCH', 'Entry broker-boundary identity does not match its active claim.', {
      orderIntentId: args.orderIntentId, claimId: claim.id, mismatches,
      expectedTradingAccountId: args.tradingAccountId,
      expectedSymbol: args.symbol.trim().toUpperCase(), expectedClientOrderId: args.clientOrderId,
    });
  }
  return { claim, intent: intent! };
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
  if (!isEntryExposureClaimStatus(args.status)) {
    throw conflict('INVALID_ENTRY_EXPOSURE_TRANSITION', 'Unknown entry exposure claim status.', {
      claimId: claim.id, currentStatus: claim.status, requestedStatus: args.status,
    });
  }
  if (claim.status === args.status) {
    const evidence = args.evidence ?? {};
    const prior = await db.entryExposureClaimEvent.findFirst({
      where: { claimId: claim.id, eventType: args.eventType },
      orderBy: { createdAt: 'desc' }, select: { evidenceJson: true },
    });
    if (prior && sameEvidence(prior.evidenceJson, evidence)) return claim;
    return db.entryExposureClaim.update({
      where: { id: claim.id },
      data: { events: { create: { eventType: args.eventType, evidenceJson: evidence } } },
    });
  }
  if (!canTransitionEntryExposureClaim(claim.status, args.status)) {
    throw conflict('INVALID_ENTRY_EXPOSURE_TRANSITION', 'Entry exposure claim transition is not permitted.', {
      claimId: claim.id, currentStatus: claim.status, requestedStatus: args.status,
      recoveryRequired: claim.status === 'UNRESOLVED',
    });
  }
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
    if (active.status === 'UNRESOLVED') {
      const evidence = {
        claimedTrackedPositionId: active.trackedPositionId,
        observedTrackedPositionId: args.trackedPositionId,
        tradingAccountId: args.tradingAccountId,
        securityId: args.securityId,
        symbol: args.symbol,
      };
      const prior = await args.tx.entryExposureClaimEvent.findFirst({
        where: { claimId: active.id, eventType: 'POSITION_ATTACHMENT_CONFLICT' },
        orderBy: { createdAt: 'desc' }, select: { evidenceJson: true },
      });
      if (!prior || !sameEvidence(prior.evidenceJson, evidence)) {
        return args.tx.entryExposureClaim.update({
          where: { id: active.id },
          data: { lastDiagnosedAt: new Date(), events: { create: { eventType: 'POSITION_ATTACHMENT_CONFLICT', evidenceJson: evidence } } },
        });
      }
      return active;
    }
    if (active.trackedPositionId === args.trackedPositionId && active.status === 'POSITION_OPEN') {
      return active;
    }
    if (active.trackedPositionId !== null && active.trackedPositionId !== args.trackedPositionId) {
      return args.tx.entryExposureClaim.update({
        where: { id: active.id },
        data: {
          status: 'UNRESOLVED', lastDiagnosedAt: new Date(),
          events: { create: {
            eventType: 'POSITION_ATTACHMENT_CONFLICT',
            evidenceJson: {
              claimedTrackedPositionId: active.trackedPositionId,
              observedTrackedPositionId: args.trackedPositionId,
              tradingAccountId: args.tradingAccountId,
              securityId: args.securityId,
              symbol: args.symbol,
            },
          } },
        },
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
      status: 'UNRESOLVED', lastDiagnosedAt: new Date(),
      events: { create: { eventType: 'OBSERVED_UNATTRIBUTED_BROKER_POSITION', evidenceJson: { trackedPositionId: args.trackedPositionId, symbol: args.symbol } } },
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
  if (!isTerminalBrokerOrderStatus(normalized)) return null;
  const claim = await db.entryExposureClaim.findUnique({
    where: { orderIntentId: args.orderIntentId },
    include: {
      security: { select: { symbol: true } },
      orderIntent: { select: { clientOrderId: true, blockReason: true } },
    },
  });
  if (!claim || claim.releasedAt) return claim;
  const localOrder = await db.brokerOrder.findFirst({
    where: { orderIntentId: args.orderIntentId }, orderBy: { createdAt: 'desc' },
  });
  let brokerOrder;
  let brokerPosition;
  try {
    brokerOrder = localOrder
      ? await getAlpacaOrderById(claim.tradingAccountId, localOrder.brokerOrderId, 'reconciliation_check')
      : claim.orderIntent?.clientOrderId
        ? await getAlpacaOrderByClientOrderId(claim.tradingAccountId, claim.orderIntent.clientOrderId, 'pending_order_idempotency_check')
        : null;
    brokerPosition = await getAlpacaPositionBySymbol(claim.tradingAccountId, claim.security.symbol, 'reconciliation_check');
  } catch {
    await markClaimUnresolved(claim.id, 'AUTHORITATIVE_RELEASE_LOOKUP_FAILED', { brokerStatus: normalized }, db);
    return null;
  }
  if (!brokerOrder || !isTerminalBrokerOrderStatus(brokerOrder.status) || brokerPosition) {
    await markClaimUnresolved(claim.id, 'AUTHORITATIVE_RELEASE_INCONCLUSIVE', {
      observedBrokerOrderStatus: brokerOrder?.status ?? null,
      brokerPositionQuantity: brokerPosition?.qty ?? null,
    }, db);
    return null;
  }
  const brokerFilled = Number(brokerOrder.filled_qty ?? 0);
  const activities = await db.brokerActivity.findMany({
    where: { orderIntentId: args.orderIntentId, activityType: 'FILL', side: 'buy' },
    select: { qty: true },
  });
  const locallyAccounted = activities.reduce((sum, activity) => sum + Number(activity.qty ?? 0), 0);
  if (!Number.isFinite(brokerFilled) || brokerFilled < 0 || locallyAccounted + 1e-9 < brokerFilled ||
      claim.orderIntent?.blockReason?.includes('DELIVERY_UNCERTAIN')) {
    await markClaimUnresolved(claim.id, 'AUTHORITATIVE_RELEASE_EXPOSURE_UNACCOUNTED', {
      brokerOrderId: brokerOrder.id, brokerOrderStatus: brokerOrder.status,
      brokerFilledQuantity: brokerOrder.filled_qty ?? null, locallyAccountedQuantity: locallyAccounted,
      deliveryUncertain: claim.orderIntent?.blockReason?.includes('DELIVERY_UNCERTAIN') ?? false,
    }, db);
    return null;
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${claim.tradingAccountId}:${claim.securityId}`}, 0))`;
    const current = await tx.entryExposureClaim.findUnique({ where: { id: claim.id } });
    if (!current || current.releasedAt) return current;
    const [activePosition, nonterminalOrder] = await Promise.all([
      tx.trackedPosition.count({ where: { tradingAccountId: claim.tradingAccountId, securityId: claim.securityId, status: { in: [...ACTIVE_POSITION_STATUSES] } } }),
      tx.brokerOrder.count({ where: { orderIntentId: args.orderIntentId, status: { notIn: ['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'replaced', 'done_for_day', 'calculated'] } } }),
    ]);
    if (activePosition || nonterminalOrder) {
      await markClaimUnresolved(claim.id, 'AUTHORITATIVE_RELEASE_REVALIDATION_FAILED', { activePosition, nonterminalOrder }, tx);
      return null;
    }
    const now = new Date();
    return tx.entryExposureClaim.update({
      where: { id: claim.id },
      data: {
        status: 'RELEASED', releasedAt: now, releaseReason: `BROKER_${String(brokerOrder.status).toUpperCase()}_NO_EXPOSURE`,
        events: { create: { eventType: 'RELEASED_AUTHORITATIVE_NO_EXPOSURE', evidenceJson: {
          brokerOrderId: brokerOrder.id, brokerOrderStatus: brokerOrder.status,
          brokerFilledQuantity: brokerOrder.filled_qty ?? null, locallyAccountedQuantity: locallyAccounted,
          brokerPosition: null,
        } } },
      },
    });
  });
}

async function markClaimUnresolved(
  claimId: number,
  eventType: string,
  evidence: Prisma.InputJsonValue,
  db: Db,
) {
  const current = await db.entryExposureClaim.findUnique({ where: { id: claimId } });
  if (!current || current.releasedAt) return current;
  const duplicate = await db.entryExposureClaimEvent.findFirst({
    where: { claimId, eventType }, orderBy: { createdAt: 'desc' }, select: { evidenceJson: true },
  });
  return db.entryExposureClaim.update({
    where: { id: claimId },
    data: {
      status: 'UNRESOLVED', lastDiagnosedAt: new Date(),
      ...(duplicate && sameEvidence(duplicate.evidenceJson, evidence) ? {} : { events: { create: { eventType, evidenceJson: evidence } } }),
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
  if (!claim.orderIntentId) {
    await markClaimUnresolved(claim.id, 'CLOSED_POSITION_REQUIRES_OPERATOR_REVIEW', {
      trackedPositionId: args.trackedPositionId,
      reason: 'No originating entry intent is available for exact broker-order verification.',
    }, db);
    return null;
  }
  return releaseConfirmedTerminalEntryClaim({
    orderIntentId: claim.orderIntentId,
    brokerStatus: 'filled',
    db,
  });
}
