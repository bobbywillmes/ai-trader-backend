import crypto from 'node:crypto';
import { SystemEventSeverity, type Prisma, type PrismaClient } from '@prisma/client';

import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import type { BrokerWriteDeliveryClassification } from '../errors/broker-write-delivery-error.js';
import { getAlpacaOrderByClientOrderId, getCompleteOpenAlpacaBuyOrdersForSymbol } from '../integrations/alpaca/orders.adapter.js';
import { getAlpacaPositionBySymbol } from '../integrations/alpaca/positions.adapter.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';
import {
  appendEntryExposureClaimDiagnostic,
  releaseUnsubmittedEntryExposureClaim,
  transitionEntryExposureClaim,
} from './entry-exposure-claim.service.js';
import { createSystemEvent } from './system-event.service.js';

// Hermes HIGH-1: evidence-based recovery of EntryExposureClaim ownership after an entry dispatch
// may have started.
//
// A MarketPolicyBrokerDispatchConsumption or MarketPolicyBrokerUnenforcedDispatch (or best-effort
// dispatch telemetry) is durable evidence that a POST may have started. It is never deleted,
// relaxed or reused, and it permanently prohibits another POST for that OrderIntent. Such a claim
// is never released as "unsubmitted". Instead:
//
// 1. The delivery outcome is recorded immutably on the claim, which moves to UNRESOLVED
//    (non-executable, visible, never silently stuck in ENTRY_SUBMITTING).
// 2. A release is authorized only by a conclusive classification (adapter not invoked or failed
//    before fetch; or a definitive HTTP rejection after a settle window) plus fresh exact broker
//    verification (stable client-order-ID lookup, complete open-BUY inventory, position) and local
//    verification, revalidated under the entry-exposure lock and released compare-and-set.
// 3. Delivery uncertainty (5xx, network, unknown crash outcome) is never released on absence alone.
//    The claim stays UNRESOLVED for operator investigation; a later-discovered order stays
//    recoverable through the terminal broker-order remediation path.
//
// Nothing here places, cancels or requeues an order, or creates execution authority. A release only
// lets a later, genuinely new admission (new client-order ID) pass normal entry controls.

type Db = Prisma.TransactionClient | PrismaClient;

/** Minimum time between a definitive HTTP rejection and the verification that may release it. */
export const ENTRY_DISPATCH_REJECTION_SETTLE_MS = 60_000;
/** Minimum time between two recovery attempts for the same claim (bounds broker reads). */
export const ENTRY_DISPATCH_RECOVERY_RETRY_MS = 60_000;
export const ENTRY_DISPATCH_RECOVERY_BATCH_LIMIT = 3;
/**
 * HTTP rejections Alpaca returns before accepting an order (validation, authentication, buying
 * power/permissions, unknown route, rate limit). The status code alone never releases a claim; it
 * only qualifies the rejection for post-settle broker verification. Other 4xx codes (408, 409, ...)
 * are treated as delivery-uncertain.
 */
export const DEFINITIVE_BROKER_REJECTION_STATUS_CODES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422, 429]);
export const TERMINAL_ENTRY_INTENT_STATUSES = ['failed', 'blocked', 'rejected', 'canceled', 'cancelled', 'expired'] as const;

const DISPATCH_OPPORTUNITY_EVENT_TYPES = ['ADAPTER_DISPATCH_REACHED', 'BROKER_RESPONSE_CONFIRMED', 'BROKER_REJECTED', 'DELIVERY_UNCERTAIN'] as const;
const OUTCOME_EVENT_TYPES = ['DISPATCH_OUTCOME_RECORDED', 'BROKER_DELIVERY_UNCERTAIN'];
const RECOVERY_EVENT_TYPES = ['DISPATCH_OUTCOME_RECORDED', 'BROKER_DELIVERY_UNCERTAIN', 'DISPATCH_RECOVERY_RELEASE_BLOCKED', 'DISPATCH_RECOVERY_REVALIDATION_BLOCKED', 'DISPATCH_RECOVERY_ERROR', 'RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE'];
const TERMINAL_BROKER_ORDER_STATUSES = ['filled', 'canceled', 'cancelled', 'expired', 'rejected'];
const PRE_DISPATCH_CLAIM_STATUSES = ['ENTRY_PENDING', 'ENTRY_SUBMITTING'];

export type EntryDispatchOutcomeClassification =
  | 'NOT_SENT_LOCAL_BLOCKED'
  | 'NOT_SENT_LOCAL_RETRYABLE'
  | 'NOT_SENT_DISPATCH_RECORD_ACK_LOST'
  | 'BROKER_REJECTED'
  | 'DELIVERY_UNCERTAIN'
  | 'DISPATCH_OUTCOME_UNKNOWN';
export type EntryDispatchRecoverySource = 'WORKER' | 'STALE_RECOVERY' | 'TERMINAL_CLAIM_SWEEP';
export type DispatchReleaseBasis = 'DEFINITE_LOCAL_NON_SEND' | 'CONFIRMED_BROKER_REJECTION';
export type DispatchEvidenceConclusiveness = 'CONCLUSIVE' | 'PENDING' | 'AMBIGUOUS_ABSENCE' | 'CONTRADICTED';

const LOCAL_NON_SEND = new Set<string>(['NOT_SENT_LOCAL_BLOCKED', 'NOT_SENT_LOCAL_RETRYABLE', 'NOT_SENT_DISPATCH_RECORD_ACK_LOST']);
const CONTRADICTIONS = new Set([
  'IDENTITY_MISMATCH', 'LOCAL_BROKER_ORDER_PRESENT', 'LOCAL_BROKER_ACTIVITY_PRESENT', 'LOCAL_POSITION_PRESENT', 'LOCAL_EXECUTABLE_BUY_PRESENT',
  'UNATTRIBUTED_BUY_FILL_PRESENT', 'BROKER_ORDER_FOUND', 'BROKER_ORDER_IDENTITY_CONFLICT', 'BROKER_BUY_ORDER_PRESENT', 'BROKER_POSITION_PRESENT',
]);

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Maps the adapter's write classification for a failure after the dispatch record committed. */
export function entryDispatchOutcomeFor(classification: BrokerWriteDeliveryClassification | null): EntryDispatchOutcomeClassification {
  switch (classification) {
    case 'NOT_SENT_BLOCKED': return 'NOT_SENT_LOCAL_BLOCKED';
    case 'NOT_SENT_RETRYABLE': return 'NOT_SENT_LOCAL_RETRYABLE';
    case 'BROKER_REJECTED': return 'BROKER_REJECTED';
    default: return 'DELIVERY_UNCERTAIN';
  }
}

/** Durable evidence that a POST for this intent may have started. */
export async function loadEntryDispatchRecords(orderIntentId: number, db: Db = prisma) {
  const [consumption, unenforced, dispatchEvents] = await Promise.all([
    db.marketPolicyBrokerDispatchConsumption.findUnique({
      where: { orderIntentId },
      select: { id: true, clientOrderId: true, consumedAt: true, decision: { select: { id: true, outcome: true, orderIntentId: true, tradingAccountId: true, securityId: true, clientOrderId: true } } },
    }),
    db.marketPolicyBrokerUnenforcedDispatch.findUnique({
      where: { orderIntentId },
      select: { id: true, clientOrderId: true, tradingAccountId: true, securityId: true, basis: true, authorizedAt: true },
    }),
    db.orderIntentBrokerOpportunityEvent.count({ where: { orderIntentId, eventType: { in: [...DISPATCH_OPPORTUNITY_EVENT_TYPES] } } }),
  ]);
  return {
    consumption, unenforced, dispatchEvents,
    durable: Boolean(consumption || unenforced),
    present: Boolean(consumption || unenforced || dispatchEvents > 0),
    startedAt: consumption?.consumedAt ?? unenforced?.authorizedAt ?? null,
  };
}
export type EntryDispatchRecords = Awaited<ReturnType<typeof loadEntryDispatchRecords>>;

function recordIdentity(records: EntryDispatchRecords) {
  return {
    consumptionId: records.consumption?.id ?? null,
    dispatchDecisionId: records.consumption?.decision.id ?? null,
    dispatchDecisionOutcome: records.consumption?.decision.outcome ?? null,
    unenforcedDispatchId: records.unenforced?.id ?? null,
    unenforcedDispatchBasis: records.unenforced?.basis ?? null,
    dispatchOpportunityEvents: records.dispatchEvents,
  };
}

function deliveryProof(classification: EntryDispatchOutcomeClassification) {
  if (classification === 'NOT_SENT_DISPATCH_RECORD_ACK_LOST') return 'ADAPTER_NOT_INVOKED_BY_THIS_ATTEMPT';
  if (LOCAL_NON_SEND.has(classification)) return 'ADAPTER_FAILED_BEFORE_NETWORK_REQUEST';
  if (classification === 'BROKER_REJECTED') return 'HTTP_REJECTION_RESPONSE_REQUIRES_BROKER_VERIFICATION';
  return 'NONE_DELIVERY_UNCERTAIN';
}

/**
 * Records the immutable delivery classification of a failure after a dispatch record committed and
 * moves the claim to UNRESOLVED: ownership is retained, never executable, and visible. Repeated
 * observations with unchanged evidence append nothing.
 */
export async function recordEntryDispatchOutcome(args: {
  orderIntentId: number;
  classification: EntryDispatchOutcomeClassification;
  source: EntryDispatchRecoverySource;
  statusCode?: number | null;
  message?: string | null;
  records?: EntryDispatchRecords;
}) {
  const records = args.records ?? await loadEntryDispatchRecords(args.orderIntentId);
  const claim = await prisma.entryExposureClaim.findUnique({
    where: { orderIntentId: args.orderIntentId },
    include: { orderIntent: { select: { clientOrderId: true } } },
  });
  if (!claim || claim.releasedAt) return claim;
  const evidence = json({
    classification: args.classification, statusCode: args.statusCode ?? null, source: args.source,
    orderIntentId: args.orderIntentId, clientOrderId: claim.orderIntent?.clientOrderId ?? null, ...recordIdentity(records),
    message: args.message ? args.message.slice(0, 300) : null,
    deliveryProof: deliveryProof(args.classification),
    executionAuthority: 'NONE', originalIntentResubmission: 'PROHIBITED',
  });
  if (![...PRE_DISPATCH_CLAIM_STATUSES, 'UNRESOLVED'].includes(claim.status)) {
    // The claim already reflects broker exposure (an order or position); keep it and record why.
    await appendEntryExposureClaimDiagnostic(claim.id, 'DISPATCH_OUTCOME_NOT_APPLIED', json({ claimStatus: claim.status, outcome: evidence }));
    return claim;
  }
  const updated = await transitionEntryExposureClaim({ orderIntentId: args.orderIntentId, status: 'UNRESOLVED', eventType: 'DISPATCH_OUTCOME_RECORDED', evidence });
  if (claim.status !== 'UNRESOLVED') {
    await createSystemEvent({
      type: 'entry_exposure.dispatch_outcome_recorded', entityType: 'entryExposureClaim', entityId: claim.id, tradingAccountId: claim.tradingAccountId,
      severity: LOCAL_NON_SEND.has(args.classification) ? SystemEventSeverity.WARNING : SystemEventSeverity.ERROR,
      message: 'An entry failed after its dispatch record committed. The claim is retained as UNRESOLVED and the intent is never resent; evidence-based recovery decides any release.',
      payloadJson: evidence,
    }).catch(() => undefined);
  }
  return updated;
}

type RecordedOutcome = { eventId: number; classification: string; statusCode: number | null; recordedAt: Date };

async function readRecordedOutcomes(claimId: number, db: Db = prisma): Promise<RecordedOutcome[]> {
  const events = await db.entryExposureClaimEvent.findMany({
    where: { claimId, eventType: { in: OUTCOME_EVENT_TYPES } }, orderBy: { id: 'asc' },
    select: { id: true, eventType: true, evidenceJson: true, createdAt: true },
  });
  return events.map((event) => {
    const evidence = (event.evidenceJson ?? {}) as Record<string, unknown>;
    return {
      eventId: event.id,
      classification: event.eventType === 'BROKER_DELIVERY_UNCERTAIN' ? 'DELIVERY_UNCERTAIN' : String(evidence.classification ?? 'DISPATCH_OUTCOME_UNKNOWN'),
      statusCode: typeof evidence.statusCode === 'number' ? evidence.statusCode : null,
      recordedAt: event.createdAt,
    };
  });
}

/**
 * The release basis of recorded outcomes. Any uncertain outcome makes absence ambiguous, whatever a
 * later lookup returns. A rejection qualifies only with a definitive status code and only once its
 * settle window has elapsed (a minimum before verification, never a release trigger by itself).
 */
export function evaluateDispatchReleaseBasis(outcomes: Array<Pick<RecordedOutcome, 'classification' | 'statusCode' | 'recordedAt'>>, now: Date): {
  basis: DispatchReleaseBasis | null; conclusiveness: 'CONCLUSIVE' | 'PENDING' | 'AMBIGUOUS_ABSENCE'; blocker: string | null;
} {
  if (!outcomes.length) return { basis: null, conclusiveness: 'AMBIGUOUS_ABSENCE', blocker: 'DISPATCH_OUTCOME_NOT_RECORDED' };
  if (outcomes.some((outcome) => !LOCAL_NON_SEND.has(outcome.classification) && outcome.classification !== 'BROKER_REJECTED')) {
    return { basis: null, conclusiveness: 'AMBIGUOUS_ABSENCE', blocker: 'DELIVERY_OUTCOME_UNCERTAIN' };
  }
  const rejections = outcomes.filter((outcome) => outcome.classification === 'BROKER_REJECTED');
  if (!rejections.length) return { basis: 'DEFINITE_LOCAL_NON_SEND', conclusiveness: 'CONCLUSIVE', blocker: null };
  if (rejections.some((outcome) => outcome.statusCode === null || !DEFINITIVE_BROKER_REJECTION_STATUS_CODES.has(outcome.statusCode))) {
    return { basis: null, conclusiveness: 'AMBIGUOUS_ABSENCE', blocker: 'BROKER_REJECTION_NOT_DEFINITIVE' };
  }
  const lastRejection = Math.max(...rejections.map((outcome) => outcome.recordedAt.getTime()));
  if (now.getTime() - lastRejection < ENTRY_DISPATCH_REJECTION_SETTLE_MS) {
    return { basis: null, conclusiveness: 'PENDING', blocker: 'BROKER_REJECTION_SETTLING' };
  }
  return { basis: 'CONFIRMED_BROKER_REJECTION', conclusiveness: 'CONCLUSIVE', blocker: null };
}

async function localExposure(claim: { id: number; tradingAccountId: number; securityId: number; trackedPositionId: number | null }, orderIntentId: number, symbol: string, startedAt: Date | null, db: Db) {
  const [brokerOrders, brokerActivities, activePositions, localExecutableBuys, unattributedFills] = await Promise.all([
    db.brokerOrder.count({ where: { orderIntentId } }),
    db.brokerActivity.count({ where: { orderIntentId } }),
    db.trackedPosition.count({ where: { tradingAccountId: claim.tradingAccountId, securityId: claim.securityId, status: { in: ['open', 'closing'] } } }),
    db.brokerOrder.count({ where: {
      tradingAccountId: claim.tradingAccountId, securityId: claim.securityId, side: { equals: 'buy', mode: 'insensitive' },
      status: { notIn: TERMINAL_BROKER_ORDER_STATUSES },
    } }),
    // A BUY fill for this account and Security after dispatch may have started, not attributed to
    // any intent, could be this entry's.
    db.brokerActivity.count({ where: {
      tradingAccountId: claim.tradingAccountId, activityType: 'FILL', side: { equals: 'buy', mode: 'insensitive' },
      symbol: { equals: symbol, mode: 'insensitive' }, orderIntentId: null,
      ...(startedAt ? { OR: [{ transactionTime: null }, { transactionTime: { gte: new Date(startedAt.getTime() - 60_000) } }] } : {}),
    } }),
  ]);
  return { brokerOrders, brokerActivities, activePositions, localExecutableBuys, unattributedFills, trackedPositionAttached: claim.trackedPositionId !== null };
}

/**
 * Fresh, read-only assessment of whether a consumed or recorded dispatch can be released under the
 * evidence standard. Its fingerprint covers every fact the release relies on (and no clock values),
 * so an operator confirmation binds exactly the evidence they reviewed.
 */
export async function assessDispatchedEntryClaim(orderIntentId: number, options: { now?: Date; operation?: AlpacaApiOperation } = {}) {
  const now = options.now ?? new Date();
  const operation = options.operation ?? 'reconciliation_check';
  const claim = await prisma.entryExposureClaim.findUnique({
    where: { orderIntentId },
    include: {
      security: { select: { id: true, symbol: true } },
      orderIntent: { select: { id: true, tradingAccountId: true, symbol: true, side: true, status: true, clientOrderId: true, tradingAccount: { select: { environment: true } } } },
    },
  });
  if (!claim?.orderIntent) throw new HttpError(404, `No entry exposure claim exists for OrderIntent ${orderIntentId}.`);
  const intent = claim.orderIntent;
  const symbol = claim.security.symbol.trim().toUpperCase();
  const records = await loadEntryDispatchRecords(orderIntentId);
  const outcomes = await readRecordedOutcomes(claim.id);
  const basis = evaluateDispatchReleaseBasis(outcomes, now);
  const identityMismatches = [
    ...(intent.tradingAccountId !== claim.tradingAccountId ? ['ACCOUNT'] : []),
    ...(intent.symbol.trim().toUpperCase() !== symbol ? ['SECURITY'] : []),
    ...(intent.side.trim().toLowerCase() !== 'buy' ? ['SIDE'] : []),
    ...(!intent.clientOrderId ? ['CLIENT_ORDER_ID_MISSING'] : []),
    ...(records.consumption && (records.consumption.clientOrderId !== intent.clientOrderId || records.consumption.decision.clientOrderId !== intent.clientOrderId
      || records.consumption.decision.orderIntentId !== intent.id || records.consumption.decision.tradingAccountId !== claim.tradingAccountId
      || (records.consumption.decision.securityId !== null && records.consumption.decision.securityId !== claim.securityId)) ? ['CONSUMPTION'] : []),
    ...(records.unenforced && (records.unenforced.clientOrderId !== intent.clientOrderId || records.unenforced.tradingAccountId !== claim.tradingAccountId
      || records.unenforced.securityId !== claim.securityId) ? ['UNENFORCED_DISPATCH'] : []),
  ];
  const local = await localExposure(claim, orderIntentId, symbol, records.startedAt, prisma);

  let brokerOrder: Awaited<ReturnType<typeof getAlpacaOrderByClientOrderId>> = null;
  let openBuys: Awaited<ReturnType<typeof getCompleteOpenAlpacaBuyOrdersForSymbol>> = [];
  let brokerPosition: Awaited<ReturnType<typeof getAlpacaPositionBySymbol>> = null;
  let lookupError: string | null = null;
  if (intent.clientOrderId) {
    try {
      [brokerOrder, openBuys, brokerPosition] = await Promise.all([
        getAlpacaOrderByClientOrderId(claim.tradingAccountId, intent.clientOrderId, operation === 'manual_admin_action' ? 'manual_admin_action' : 'pending_order_idempotency_check'),
        getCompleteOpenAlpacaBuyOrdersForSymbol(claim.tradingAccountId, symbol, operation),
        getAlpacaPositionBySymbol(claim.tradingAccountId, symbol, operation),
      ]);
    } catch (error) {
      lookupError = message(error);
    }
  }
  const brokerOrderConflict = brokerOrder && (brokerOrder.client_order_id !== intent.clientOrderId
    || brokerOrder.symbol?.trim().toUpperCase() !== symbol || brokerOrder.side?.trim().toLowerCase() !== 'buy');
  const blockers = [
    ...(claim.releasedAt ? ['CLAIM_ALREADY_RELEASED'] : []),
    ...(!records.present ? ['NO_DISPATCH_RECORD'] : []),
    ...(basis.blocker ? [basis.blocker] : []),
    ...(claim.status !== 'UNRESOLVED' ? ['CLAIM_OUTCOME_NOT_RECORDED'] : []),
    ...(identityMismatches.length ? ['IDENTITY_MISMATCH'] : []),
    ...(!(TERMINAL_ENTRY_INTENT_STATUSES as readonly string[]).includes(intent.status) ? ['INTENT_NOT_TERMINAL'] : []),
    ...(local.brokerOrders ? ['LOCAL_BROKER_ORDER_PRESENT'] : []),
    ...(local.brokerActivities ? ['LOCAL_BROKER_ACTIVITY_PRESENT'] : []),
    ...(local.activePositions || local.trackedPositionAttached ? ['LOCAL_POSITION_PRESENT'] : []),
    ...(local.localExecutableBuys ? ['LOCAL_EXECUTABLE_BUY_PRESENT'] : []),
    ...(local.unattributedFills ? ['UNATTRIBUTED_BUY_FILL_PRESENT'] : []),
    ...(lookupError ? ['BROKER_LOOKUP_FAILED'] : []),
    ...(brokerOrder ? [brokerOrderConflict ? 'BROKER_ORDER_IDENTITY_CONFLICT' : 'BROKER_ORDER_FOUND'] : []),
    ...(openBuys.length ? ['BROKER_BUY_ORDER_PRESENT'] : []),
    ...(brokerPosition ? ['BROKER_POSITION_PRESENT'] : []),
  ];
  const conclusiveness: DispatchEvidenceConclusiveness = blockers.some((blocker) => CONTRADICTIONS.has(blocker))
    ? 'CONTRADICTED'
    : basis.conclusiveness === 'AMBIGUOUS_ABSENCE'
      ? 'AMBIGUOUS_ABSENCE'
      : blockers.length ? 'PENDING' : 'CONCLUSIVE';
  const evidence = {
    disposition: 'DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE',
    claim: { id: claim.id, status: claim.status, tradingAccountId: claim.tradingAccountId, securityId: claim.securityId, symbol, orderIntentId, trackedPositionId: claim.trackedPositionId },
    orderIntent: { id: intent.id, status: intent.status, clientOrderId: intent.clientOrderId, environment: intent.tradingAccount?.environment ?? null },
    dispatch: recordIdentity(records),
    recordedOutcomes: outcomes.map((outcome) => ({ eventId: outcome.eventId, classification: outcome.classification, statusCode: outcome.statusCode })),
    basis: basis.basis,
    conclusiveness,
    local,
    broker: {
      order: brokerOrder ? { id: brokerOrder.id, clientOrderId: brokerOrder.client_order_id, symbol: brokerOrder.symbol, side: brokerOrder.side, status: brokerOrder.status, filledQty: brokerOrder.filled_qty ?? null } : null,
      openBuyOrders: openBuys.map((order) => ({ id: order.id, clientOrderId: order.client_order_id, status: order.status, qty: order.qty ?? null })),
      position: brokerPosition ? { symbol: brokerPosition.symbol, side: brokerPosition.side, qty: brokerPosition.qty } : null,
      lookupError,
    },
    identityMismatches,
    blockers,
  };
  return {
    ...evidence,
    eligible: blockers.length === 0 && basis.basis !== null,
    outcomeEventCount: outcomes.length,
    dispatchStartedAt: records.startedAt,
    confirmationFingerprint: crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
  };
}
export type DispatchedEntryClaimAssessment = Awaited<ReturnType<typeof assessDispatchedEntryClaim>>;

export type DispatchedEntryReleaseResult = { released: boolean; reason: string; assessment: DispatchedEntryClaimAssessment | null };

/**
 * Releases a dispatched entry's claim when, and only when, the evidence standard holds: fresh
 * verification, an exact operator fingerprint (OPERATOR mode), and a final revalidation under the
 * account/Security entry-exposure lock, then a compare-and-set release with immutable evidence.
 */
export async function releaseDispatchedEntryExposureClaim(args: {
  orderIntentId: number;
  mode: 'SYSTEM' | 'OPERATOR';
  actorUserId?: number;
  confirmationFingerprint?: string;
  now?: Date;
}): Promise<DispatchedEntryReleaseResult> {
  const assessment = await assessDispatchedEntryClaim(args.orderIntentId, { ...(args.now ? { now: args.now } : {}), operation: args.mode === 'OPERATOR' ? 'manual_admin_action' : 'reconciliation_check' });
  const claimId = assessment.claim.id;
  if (args.mode === 'OPERATOR' && (!args.actorUserId || args.confirmationFingerprint !== assessment.confirmationFingerprint)) {
    return { released: false, reason: 'CONFIRMATION_FINGERPRINT_MISMATCH', assessment };
  }
  if (!assessment.eligible) {
    if (!assessment.blockers.includes('CLAIM_ALREADY_RELEASED')) {
      await appendEntryExposureClaimDiagnostic(claimId, 'DISPATCH_RECOVERY_RELEASE_BLOCKED', json({
        mode: args.mode, actorUserId: args.actorUserId ?? null, basis: assessment.basis, conclusiveness: assessment.conclusiveness,
        blockers: assessment.blockers, brokerOrder: assessment.broker.order, brokerPosition: assessment.broker.position,
        openBuyOrderIds: assessment.broker.openBuyOrders.map((order) => order.id), lookupFailed: assessment.broker.lookupError !== null,
      }));
    }
    return { released: false, reason: assessment.blockers.join(',') || 'NO_RELEASE_BASIS', assessment };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${assessment.claim.tradingAccountId}:${assessment.claim.securityId}`}, 0))::text`;
    const current = await tx.entryExposureClaim.findUnique({ where: { id: claimId }, include: { orderIntent: { select: { status: true } } } });
    if (!current || current.releasedAt) return 'CLAIM_ALREADY_RELEASED';
    const local = await localExposure(current, args.orderIntentId, assessment.claim.symbol, assessment.dispatchStartedAt, tx);
    const outcomeEvents = await tx.entryExposureClaimEvent.count({ where: { claimId, eventType: { in: OUTCOME_EVENT_TYPES } } });
    const revalidation = [
      ...(current.status !== 'UNRESOLVED' ? ['CLAIM_STATUS_CHANGED'] : []),
      ...(!current.orderIntent || !(TERMINAL_ENTRY_INTENT_STATUSES as readonly string[]).includes(current.orderIntent.status) ? ['INTENT_NOT_TERMINAL'] : []),
      ...(local.brokerOrders ? ['LOCAL_BROKER_ORDER_PRESENT'] : []),
      ...(local.brokerActivities ? ['LOCAL_BROKER_ACTIVITY_PRESENT'] : []),
      ...(local.activePositions || local.trackedPositionAttached ? ['LOCAL_POSITION_PRESENT'] : []),
      ...(local.localExecutableBuys ? ['LOCAL_EXECUTABLE_BUY_PRESENT'] : []),
      ...(local.unattributedFills ? ['UNATTRIBUTED_BUY_FILL_PRESENT'] : []),
      ...(outcomeEvents !== assessment.outcomeEventCount ? ['DISPATCH_OUTCOME_CHANGED'] : []),
    ];
    if (revalidation.length) {
      await appendEntryExposureClaimDiagnostic(claimId, 'DISPATCH_RECOVERY_REVALIDATION_BLOCKED', json({ mode: args.mode, revalidation }), tx);
      return revalidation.join(',');
    }
    if (args.mode === 'OPERATOR') {
      await tx.entryExposureClaimEvent.create({ data: { claimId, eventType: 'OPERATOR_REMEDIATION_AUTHORIZED', evidenceJson: json({
        actorUserId: args.actorUserId, confirmationFingerprint: args.confirmationFingerprint, disposition: assessment.disposition, evidence: assessment,
      }) } });
    }
    const released = await tx.entryExposureClaim.updateMany({
      where: { id: claimId, status: 'UNRESOLVED', releasedAt: null },
      data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: `VERIFIED_DISPATCH_NO_EXPOSURE:${assessment.basis}` },
    });
    if (released.count !== 1) return 'CLAIM_STATUS_CHANGED';
    await tx.entryExposureClaimEvent.create({ data: { claimId, eventType: 'RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE', evidenceJson: json({
      mode: args.mode, actorUserId: args.actorUserId ?? null, basis: assessment.basis, confirmationFingerprint: assessment.confirmationFingerprint,
      evidence: assessment, executionAuthority: 'NONE', originalIntentResubmission: 'PROHIBITED', dispatchRecord: 'RETAINED_IMMUTABLE',
    }) } });
    return 'RELEASED';
  });
  if (outcome !== 'RELEASED') return { released: false, reason: outcome, assessment };
  await createSystemEvent({
    type: 'entry_exposure.dispatch_claim_released', entityType: 'entryExposureClaim', entityId: claimId, tradingAccountId: assessment.claim.tradingAccountId,
    actorUserId: args.actorUserId ?? null, severity: SystemEventSeverity.INFO,
    message: 'A dispatched entry claim was released after conclusive evidence of no broker exposure. The original intent is never resent.',
    payloadJson: json({ orderIntentId: args.orderIntentId, mode: args.mode, basis: assessment.basis, ...assessment.dispatch, confirmationFingerprint: assessment.confirmationFingerprint }),
  }).catch(() => undefined);
  return { released: true, reason: `VERIFIED_DISPATCH_NO_EXPOSURE:${assessment.basis}`, assessment };
}

/**
 * Worker routing for a failure after the dispatch record committed (or whose record committed with
 * a lost acknowledgement). Records the outcome, then attempts an immediate verified release only for
 * a definite local non-send; a rejection waits for its settle window and the recovery sweep.
 */
export async function routeEntryDispatchFailure(args: {
  orderIntentId: number;
  classification: EntryDispatchOutcomeClassification;
  source: EntryDispatchRecoverySource;
  statusCode?: number | null;
  message?: string | null;
  records?: EntryDispatchRecords;
  now?: Date;
}): Promise<DispatchedEntryReleaseResult> {
  await recordEntryDispatchOutcome(args);
  if (!LOCAL_NON_SEND.has(args.classification)) return { released: false, reason: 'AWAITING_EVIDENCE_BASED_RECOVERY', assessment: null };
  try {
    return await releaseDispatchedEntryExposureClaim({ orderIntentId: args.orderIntentId, mode: 'SYSTEM', ...(args.now ? { now: args.now } : {}) });
  } catch (error) {
    await recordRecoveryError(args.orderIntentId, args.source, error);
    return { released: false, reason: 'RECOVERY_ERROR', assessment: null };
  }
}

async function recordRecoveryError(orderIntentId: number, source: string, error: unknown) {
  logger.warn({ orderIntentId, error }, 'Dispatched entry claim recovery failed; the claim is retained and will be retried.');
  const claim = await prisma.entryExposureClaim.findUnique({ where: { orderIntentId }, select: { id: true } }).catch(() => null);
  if (claim) await appendEntryExposureClaimDiagnostic(claim.id, 'DISPATCH_RECOVERY_ERROR', json({ source, error: message(error) })).catch(() => undefined);
}

/**
 * Release path for a failure proven to precede any dispatch by this attempt. The never-submitted
 * checks still decide; a refusal is never swallowed. `dispatchAttempted` is true only when this
 * attempt reached the final dispatch authorization after confirming no prior dispatch record: a
 * durable record found then committed with a lost acknowledgement and goes to evidence-based
 * recovery. A record from an earlier attempt keeps its own recorded outcome.
 */
export async function releaseUnsubmittedOrRouteToRecovery(args: {
  orderIntentId: number;
  reason: string;
  source: EntryDispatchRecoverySource;
  dispatchAttempted: boolean;
  message?: string | null;
}) {
  try {
    await releaseUnsubmittedEntryExposureClaim({ orderIntentId: args.orderIntentId, reason: args.reason });
    return { released: true as const };
  } catch (error) {
    const records = await loadEntryDispatchRecords(args.orderIntentId).catch(() => null);
    if (records?.durable && args.dispatchAttempted) {
      await routeEntryDispatchFailure({
        orderIntentId: args.orderIntentId, classification: 'NOT_SENT_DISPATCH_RECORD_ACK_LOST', source: args.source,
        message: args.message ?? args.reason, records,
      }).catch((routeError) => recordRecoveryError(args.orderIntentId, args.source, routeError));
      return { released: false as const, routed: true as const };
    }
    if (records?.present) {
      // An earlier attempt's dispatch record: its outcome is recorded (or inferred by the terminal
      // sweep); this pre-boundary failure adds no delivery classification.
      const claim = await prisma.entryExposureClaim.findUnique({ where: { orderIntentId: args.orderIntentId }, select: { id: true, releasedAt: true } }).catch(() => null);
      if (claim && !claim.releasedAt) {
        await appendEntryExposureClaimDiagnostic(claim.id, 'PRE_BOUNDARY_FAILURE_WITH_PRIOR_DISPATCH_RECORD', json({ reason: args.reason, source: args.source, refusal: message(error) }))
          .catch((diagnosticError) => recordRecoveryError(args.orderIntentId, args.source, diagnosticError));
      }
      return { released: false as const, routed: false as const };
    }
    const claim = await prisma.entryExposureClaim.findUnique({ where: { orderIntentId: args.orderIntentId } }).catch(() => null);
    if (claim && !claim.releasedAt) {
      const details = error instanceof HttpError ? error.details : null;
      await transitionEntryExposureClaim({
        orderIntentId: args.orderIntentId, status: 'UNRESOLVED', eventType: 'UNSUBMITTED_RELEASE_REFUSED',
        evidence: json({ reason: args.reason, source: args.source, refusal: message(error), details, executionAuthority: 'NONE' }),
      }).catch((transitionError) => recordRecoveryError(args.orderIntentId, args.source, transitionError));
      if (claim.status !== 'UNRESOLVED') {
        await createSystemEvent({
          type: 'entry_exposure.unsubmitted_release_refused', entityType: 'entryExposureClaim', entityId: claim.id, tradingAccountId: claim.tradingAccountId,
          severity: SystemEventSeverity.ERROR,
          message: 'A pre-dispatch entry failure could not release its claim as unsubmitted; ownership is retained as UNRESOLVED for review.',
          payloadJson: json({ orderIntentId: args.orderIntentId, reason: args.reason, refusal: message(error) }),
        }).catch(() => undefined);
      }
    }
    logger.warn({ orderIntentId: args.orderIntentId, error }, 'Unsubmitted entry claim release was refused; ownership retained as UNRESOLVED.');
    return { released: false as const, routed: false as const };
  }
}

/** Infers the outcome of a terminal intent whose claim predates outcome recording. */
export function inferEntryDispatchOutcome(blockReason: string | null): { classification: EntryDispatchOutcomeClassification; statusCode: number | null } {
  const reason = blockReason ?? '';
  const write = reason.match(/BROKER_WRITE_DELIVERY:(NOT_SENT_RETRYABLE|NOT_SENT_BLOCKED|BROKER_REJECTED|DELIVERY_UNCERTAIN)/)?.[1] ?? null;
  if (write) {
    const statusCode = write === 'BROKER_REJECTED' ? Number(reason.match(/status (\d{3})/)?.[1] ?? NaN) : NaN;
    return { classification: entryDispatchOutcomeFor(write as BrokerWriteDeliveryClassification), statusCode: Number.isFinite(statusCode) ? statusCode : null };
  }
  // These failures were classified in-process as preceding the adapter call.
  if (/^(MARKET_POLICY_BROKER_TIME:[A-Z_]+:DEFINITELY_NOT_SENT|ENTRY_DISPATCH_RECORDED_NOT_SENT|LOCAL_PRE_DISPATCH_FAILURE)/.test(reason)) {
    return { classification: 'NOT_SENT_DISPATCH_RECORD_ACK_LOST', statusCode: null };
  }
  return { classification: 'DISPATCH_OUTCOME_UNKNOWN', statusCode: null };
}

/**
 * Bounded, starvation-resistant sweep of terminal entry intents whose claims are still held: never
 * submitted claims go through the never-submitted release; dispatched ones get an outcome recorded
 * (if missing) and an evidence-based release attempt. Each attempt marks the claim diagnosed, so a
 * claim is retried at most once per ENTRY_DISPATCH_RECOVERY_RETRY_MS and the oldest go first.
 * Caller holds the account lifecycle-mutation lock.
 */
export async function recoverDispatchedEntryClaimsForAccount(tradingAccountId: number, now = new Date()) {
  const due = new Date(now.getTime() - ENTRY_DISPATCH_RECOVERY_RETRY_MS);
  const dispatchedIntent = { OR: [
    { marketPolicyBrokerDispatchConsumption: { isNot: null } },
    { marketPolicyBrokerUnenforcedDispatch: { isNot: null } },
    { brokerOpportunityEvents: { some: { eventType: { in: [...DISPATCH_OPPORTUNITY_EVENT_TYPES] } } } },
  ] } satisfies Prisma.OrderIntentWhereInput;
  const claims = await prisma.entryExposureClaim.findMany({
    where: {
      tradingAccountId, releasedAt: null, trackedPositionId: null,
      orderIntent: { status: { in: [...TERMINAL_ENTRY_INTENT_STATUSES] } },
      AND: [
        { OR: [{ lastDiagnosedAt: null }, { lastDiagnosedAt: { lte: due } }] },
        { OR: [{ status: { in: PRE_DISPATCH_CLAIM_STATUSES } }, { status: 'UNRESOLVED', orderIntent: dispatchedIntent }] },
      ],
    },
    select: { id: true, status: true, orderIntentId: true, orderIntent: { select: { blockReason: true } } },
    orderBy: [{ lastDiagnosedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: ENTRY_DISPATCH_RECOVERY_BATCH_LIMIT,
  });
  let released = 0;
  let retained = 0;
  let recorded = 0;
  const failures: Array<{ claimId: number; error: string }> = [];
  for (const claim of claims) {
    const orderIntentId = claim.orderIntentId!;
    try {
      const records = await loadEntryDispatchRecords(orderIntentId);
      if (claim.status !== 'UNRESOLVED') {
        if (!records.present) {
          const result = await releaseUnsubmittedOrRouteToRecovery({ orderIntentId, reason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED', source: 'TERMINAL_CLAIM_SWEEP', dispatchAttempted: false });
          if (result.released) released += 1; else retained += 1;
          continue;
        }
        const inferred = inferEntryDispatchOutcome(claim.orderIntent?.blockReason ?? null);
        await recordEntryDispatchOutcome({ orderIntentId, ...inferred, source: 'TERMINAL_CLAIM_SWEEP', message: claim.orderIntent?.blockReason ?? null, records });
        recorded += 1;
      }
      const result = await releaseDispatchedEntryExposureClaim({ orderIntentId, mode: 'SYSTEM', now });
      if (result.released) released += 1; else retained += 1;
    } catch (error) {
      retained += 1;
      failures.push({ claimId: claim.id, error: message(error) });
      await recordRecoveryError(orderIntentId, 'TERMINAL_CLAIM_SWEEP', error);
    }
  }
  return { examined: claims.length, released, retained, recorded, failures };
}

/**
 * Read-only description of terminal entry intents whose claims remain unreleased, for readiness.
 * It uses only recorded evidence plus the caller's broker snapshot; remediation re-verifies fresh.
 */
export async function describeUnreleasedTerminalEntryClaims(args: {
  db?: PrismaClient;
  tradingAccountIds?: number[] | undefined;
  now?: Date;
  brokerExposure?: (tradingAccountId: number, symbol: string) => boolean;
} = {}) {
  const db = args.db ?? prisma;
  const now = args.now ?? new Date();
  const claims = await db.entryExposureClaim.findMany({
    where: {
      releasedAt: null, orderIntent: { status: { in: [...TERMINAL_ENTRY_INTENT_STATUSES] } },
      ...(args.tradingAccountIds?.length ? { tradingAccountId: { in: args.tradingAccountIds } } : {}),
    },
    select: {
      id: true, status: true, tradingAccountId: true, securityId: true, trackedPositionId: true, lastDiagnosedAt: true,
      security: { select: { symbol: true } },
      orderIntent: { select: {
        id: true, status: true, clientOrderId: true, blockReason: true,
        marketPolicyBrokerDispatchConsumption: { select: { id: true, decision: { select: { id: true, outcome: true } } } },
        marketPolicyBrokerUnenforcedDispatch: { select: { id: true, basis: true } },
        _count: { select: { brokerOrders: true, brokerOpportunityEvents: { where: { eventType: { in: [...DISPATCH_OPPORTUNITY_EVENT_TYPES] } } } } },
      } },
      events: { where: { eventType: { in: RECOVERY_EVENT_TYPES } }, orderBy: { id: 'asc' }, select: { id: true, eventType: true, evidenceJson: true, createdAt: true } },
    },
    orderBy: { id: 'asc' },
  });
  return claims.map((claim) => {
    const intent = claim.orderIntent!;
    const consumption = intent.marketPolicyBrokerDispatchConsumption;
    const unenforced = intent.marketPolicyBrokerUnenforcedDispatch;
    const dispatched = Boolean(consumption || unenforced || intent._count.brokerOpportunityEvents);
    const outcomes = claim.events.filter((event) => OUTCOME_EVENT_TYPES.includes(event.eventType)).map((event) => {
      const evidence = (event.evidenceJson ?? {}) as Record<string, unknown>;
      return {
        classification: event.eventType === 'BROKER_DELIVERY_UNCERTAIN' ? 'DELIVERY_UNCERTAIN' : String(evidence.classification ?? 'DISPATCH_OUTCOME_UNKNOWN'),
        statusCode: typeof evidence.statusCode === 'number' ? evidence.statusCode : null, recordedAt: event.createdAt,
      };
    });
    const basis = evaluateDispatchReleaseBasis(outcomes, now);
    const last = claim.events.at(-1) ?? null;
    const brokerExposure = args.brokerExposure?.(claim.tradingAccountId, claim.security.symbol) ?? false;
    const blockerReason = !dispatched
      ? claim.status === 'UNRESOLVED' ? 'UNRESOLVED_WITHOUT_DISPATCH_RECORD' : null
      : claim.trackedPositionId || intent._count.brokerOrders ? 'BROKER_ORDER_OR_POSITION_EVIDENCE'
        : brokerExposure ? 'BROKER_EXPOSURE_PRESENT'
          : claim.status !== 'UNRESOLVED' ? 'DISPATCH_OUTCOME_NOT_RECORDED' : basis.blocker;
    const operatorRemediation = blockerReason === null
      ? 'ELIGIBLE_AFTER_FRESH_VERIFICATION'
      : blockerReason === 'BROKER_REJECTION_SETTLING' || blockerReason === 'DISPATCH_OUTCOME_NOT_RECORDED' ? 'PENDING' : 'BLOCKED';
    return {
      tradingAccountId: claim.tradingAccountId, securityId: claim.securityId, symbol: claim.security.symbol,
      orderIntentId: intent.id, intentStatus: intent.status, clientOrderId: intent.clientOrderId,
      claimId: claim.id, claimStatus: claim.status,
      consumptionId: consumption?.id ?? null, dispatchDecisionId: consumption?.decision.id ?? null, dispatchDecisionOutcome: consumption?.decision.outcome ?? null,
      unenforcedDispatchId: unenforced?.id ?? null, unenforcedDispatchBasis: unenforced?.basis ?? null,
      dispatchStarted: dispatched,
      recordedDeliveryClassification: outcomes.length ? [...new Set(outcomes.map((outcome) => outcome.classification))].join(',') : null,
      releaseBasis: basis.basis,
      evidenceConclusiveness: dispatched ? basis.conclusiveness : null,
      lastRecoveryResult: last ? { eventType: last.eventType, at: last.createdAt, blockers: ((last.evidenceJson ?? {}) as Record<string, unknown>).blockers ?? null } : null,
      lastDiagnosedAt: claim.lastDiagnosedAt,
      systemRecovery: dispatched || PRE_DISPATCH_CLAIM_STATUSES.includes(claim.status) ? 'SWEPT' : 'NOT_APPLICABLE',
      operatorRemediation,
      blockerReason,
    };
  });
}
