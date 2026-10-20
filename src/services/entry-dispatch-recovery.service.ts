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
  appendNotSentEvidence,
  blockReasonDeliveryClassification,
  DELIVERY_EVIDENCE_EVENT_TYPES,
  evaluateNeverSubmittedRelease,
  LOCAL_NON_SEND_CLASSIFICATIONS,
  summarizeDeliveryEvidence,
  type AdapterInvocation,
  type DeliveryEvidenceEvent,
  type DeliveryEvidenceSummary,
  type NotSentClassification,
  type NotSentProducer,
  type OutcomeObservation,
} from './entry-delivery-evidence.service.js';
import {
  appendEntryExposureClaimDiagnostic,
  releasedByThisCall,
  releaseUnsubmittedEntryExposureClaim,
  transitionEntryExposureClaim,
} from './entry-exposure-claim.service.js';
import { createSystemEvent } from './system-event.service.js';

// Hermes HIGH-1 / Phase 3C.3 closure: evidence-based recovery of EntryExposureClaim ownership.
//
// Ordering invariant: no claim-release decision runs before the delivery classification it depends on
// is durable. The worker persists NOT_SENT_EVIDENCE_RECORDED or DISPATCH_OUTCOME_RECORDED atomically
// with the intent's terminal state and only then decides; if that persistence fails, the claim keeps
// ownership. A broker-exposed or delivery-uncertain claim never uses the never-submitted path.
//
// A durable dispatch record (MarketPolicyBrokerDispatchConsumption, MarketPolicyBrokerUnenforcedDispatch,
// a consumed one-shot LIVE arming, or dispatch telemetry) or an OBSERVED post-boundary outcome means a
// POST may have started. Such a claim is released only by this module's evidence standard:
//
// 1. A conclusive basis: recorded proof that no request was issued (DEFINITE_LOCAL_NON_SEND), or an
//    HTTP rejection with a definitive status code (400/401/403/404/422/429) after a settle window
//    (CONFIRMED_BROKER_REJECTION). Status codes never release by themselves.
// 2. Fresh exact broker verification (stable client-order-ID lookup, complete open-BUY inventory,
//    position) and local verification (orders, activities, positions, unattributed BUY fills).
// 3. A final revalidation under the entry-exposure lock and a compare-and-set release.
//
// Delivery uncertainty (408, 409, other non-definitive 4xx, 5xx, network failure, unknown or inferred
// outcomes, an unclosed boundary marker) is never released on absence. The claim stays UNRESOLVED for
// operator investigation; only positive broker evidence (the exact order found and terminal) releases
// it, through the terminal broker-order remediation. There is no force or time-based release.
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
 * HTTP rejections Alpaca returns before accepting an order: 400 malformed request, 401
 * authentication, 403 forbidden (buying power, permissions, restricted account), 404 unknown
 * route/asset, 422 validation, 429 rate limit. They only qualify a rejection for post-settle broker
 * verification; they never release a claim by themselves. 408 (timeout) and 409 (conflict, which can
 * mean the client order ID already exists) and every other 4xx are delivery-uncertain.
 */
export const DEFINITIVE_BROKER_REJECTION_STATUS_CODES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422, 429]);
export const TERMINAL_ENTRY_INTENT_STATUSES = ['failed', 'blocked', 'rejected', 'canceled', 'cancelled', 'expired'] as const;

const DISPATCH_OPPORTUNITY_EVENT_TYPES = ['ADAPTER_DISPATCH_REACHED', 'BROKER_RESPONSE_CONFIRMED', 'BROKER_REJECTED', 'DELIVERY_UNCERTAIN'] as const;
/** Recovery attempt results, newest first wins in readiness. */
const ATTEMPT_RESULT_EVENTS: Record<string, 'BLOCKED_BY_EVIDENCE' | 'TECHNICAL_FAILURE' | 'REFUSED'> = {
  DISPATCH_RECOVERY_RELEASE_BLOCKED: 'BLOCKED_BY_EVIDENCE',
  DISPATCH_RECOVERY_REVALIDATION_BLOCKED: 'BLOCKED_BY_EVIDENCE',
  DISPATCH_RECOVERY_ERROR: 'TECHNICAL_FAILURE',
  RECOVERY_ATTEMPT_FAILED: 'TECHNICAL_FAILURE',
  UNSUBMITTED_RELEASE_REFUSED: 'REFUSED',
  PRE_BOUNDARY_FAILURE_WITH_PRIOR_DISPATCH_RECORD: 'REFUSED',
};
const TERMINAL_BROKER_ORDER_STATUSES = ['filled', 'canceled', 'cancelled', 'expired', 'rejected'];
const PRE_DISPATCH_CLAIM_STATUSES = ['ENTRY_PENDING', 'ENTRY_SUBMITTING', 'ADMISSION_BLOCKED'];
const RECOVERABLE_CLAIM_STATUSES = [...PRE_DISPATCH_CLAIM_STATUSES, 'UNRESOLVED'];

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

const CONTRADICTIONS = new Set([
  'IDENTITY_MISMATCH', 'LOCAL_BROKER_ORDER_PRESENT', 'LOCAL_BROKER_ACTIVITY_PRESENT', 'LOCAL_POSITION_PRESENT', 'LOCAL_EXECUTABLE_BUY_PRESENT',
  'UNATTRIBUTED_BUY_FILL_PRESENT', 'BROKER_ORDER_FOUND', 'BROKER_ORDER_IDENTITY_CONFLICT', 'BROKER_BUY_ORDER_PRESENT', 'BROKER_POSITION_PRESENT',
]);

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Maps the adapter's write classification for a failure after the broker boundary. */
export function entryDispatchOutcomeFor(classification: BrokerWriteDeliveryClassification | null): EntryDispatchOutcomeClassification {
  switch (classification) {
    case 'NOT_SENT_BLOCKED': return 'NOT_SENT_LOCAL_BLOCKED';
    case 'NOT_SENT_RETRYABLE': return 'NOT_SENT_LOCAL_RETRYABLE';
    case 'BROKER_REJECTED': return 'BROKER_REJECTED';
    default: return 'DELIVERY_UNCERTAIN';
  }
}

function adapterInvocationFor(classification: EntryDispatchOutcomeClassification): AdapterInvocation {
  if (classification === 'NOT_SENT_DISPATCH_RECORD_ACK_LOST') return 'NOT_INVOKED';
  if (classification === 'NOT_SENT_LOCAL_BLOCKED' || classification === 'NOT_SENT_LOCAL_RETRYABLE') return 'LOCAL_GUARD_BEFORE_REQUEST';
  if (classification === 'BROKER_REJECTED') return 'HTTP_RESPONSE_RECEIVED';
  return 'UNKNOWN';
}

/** Durable evidence that a POST for this intent may have started. */
export async function loadEntryDispatchRecords(orderIntentId: number, db: Db = prisma) {
  const [consumption, unenforced, dispatchEvents, liveArming] = await Promise.all([
    db.marketPolicyBrokerDispatchConsumption.findUnique({
      where: { orderIntentId },
      select: { id: true, clientOrderId: true, consumedAt: true, decision: { select: { id: true, outcome: true, orderIntentId: true, tradingAccountId: true, securityId: true, clientOrderId: true } } },
    }),
    db.marketPolicyBrokerUnenforcedDispatch.findUnique({
      where: { orderIntentId },
      select: { id: true, clientOrderId: true, tradingAccountId: true, securityId: true, basis: true, authorizedAt: true },
    }),
    db.orderIntentBrokerOpportunityEvent.count({ where: { orderIntentId, eventType: { in: [...DISPATCH_OPPORTUNITY_EVENT_TYPES] } } }),
    db.liveEntryArmingTermination.findFirst({
      where: { orderIntentId, type: 'CONSUMED' }, select: { id: true, liveEntryArmingId: true, clientOrderId: true, occurredAt: true },
    }),
  ]);
  return {
    consumption, unenforced, dispatchEvents, liveArming,
    /** A market-policy dispatch record whose commit may have lost its acknowledgement. */
    durable: Boolean(consumption || unenforced),
    present: Boolean(consumption || unenforced || liveArming || dispatchEvents > 0),
    startedAt: consumption?.consumedAt ?? unenforced?.authorizedAt ?? liveArming?.occurredAt ?? null,
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
    liveArmingTerminationId: records.liveArming?.id ?? null,
    dispatchOpportunityEvents: records.dispatchEvents,
  };
}

function deliveryProof(classification: EntryDispatchOutcomeClassification) {
  if (classification === 'NOT_SENT_DISPATCH_RECORD_ACK_LOST') return 'ADAPTER_NOT_INVOKED_BY_THIS_ATTEMPT';
  if (LOCAL_NON_SEND_CLASSIFICATIONS.has(classification)) return 'ADAPTER_FAILED_BEFORE_NETWORK_REQUEST';
  if (classification === 'BROKER_REJECTED') return 'HTTP_REJECTION_RESPONSE_REQUIRES_BROKER_VERIFICATION';
  return 'NONE_DELIVERY_UNCERTAIN';
}

export type RecordEntryDispatchOutcomeArgs = {
  orderIntentId: number;
  classification: EntryDispatchOutcomeClassification;
  source: EntryDispatchRecoverySource;
  /** OBSERVED: the worker saw this failure. INFERRED: recovery could not observe the attempt. */
  observation?: OutcomeObservation;
  statusCode?: number | null;
  message?: string | null;
  records?: EntryDispatchRecords;
  db?: Db;
};

/**
 * Records the immutable delivery classification of a failure after the broker boundary (or an
 * inferred, unknown outcome) and moves the claim to UNRESOLVED: ownership is retained, never
 * executable, and visible. Repeated observations with unchanged evidence append nothing. With `db`
 * it runs inside the caller's transaction and the caller emits the system event after commit.
 */
export async function recordEntryDispatchOutcome(args: RecordEntryDispatchOutcomeArgs) {
  const db = args.db ?? prisma;
  const records = args.records ?? await loadEntryDispatchRecords(args.orderIntentId, db);
  const claim = await db.entryExposureClaim.findUnique({
    where: { orderIntentId: args.orderIntentId },
    include: { orderIntent: { select: { clientOrderId: true } } },
  });
  if (!claim || claim.releasedAt) return { claim, newlyUnresolved: false, evidence: null };
  const observation = args.observation ?? (args.source === 'WORKER' ? 'OBSERVED' : 'INFERRED');
  const evidence = json({
    classification: args.classification, statusCode: args.statusCode ?? null, source: args.source, observation,
    adapterInvocation: adapterInvocationFor(args.classification), dispatchRecordPresent: records.present,
    orderIntentId: args.orderIntentId, clientOrderId: claim.orderIntent?.clientOrderId ?? null, ...recordIdentity(records),
    message: args.message ? args.message.slice(0, 300) : null,
    deliveryProof: deliveryProof(args.classification),
    executionAuthority: 'NONE', originalIntentResubmission: 'PROHIBITED',
  });
  if (!RECOVERABLE_CLAIM_STATUSES.includes(claim.status)) {
    // The claim already reflects broker exposure (an order or position); keep it and record why.
    await appendEntryExposureClaimDiagnostic(claim.id, 'DISPATCH_OUTCOME_NOT_APPLIED', json({ claimStatus: claim.status, outcome: evidence }), db);
    return { claim, newlyUnresolved: false, evidence };
  }
  const updated = await transitionEntryExposureClaim({ orderIntentId: args.orderIntentId, status: 'UNRESOLVED', eventType: 'DISPATCH_OUTCOME_RECORDED', evidence, db });
  const result = { claim: updated, newlyUnresolved: claim.status !== 'UNRESOLVED', evidence, claimId: claim.id, tradingAccountId: claim.tradingAccountId, records };
  if (!args.db) await emitDispatchOutcomeRecorded(result, args.classification);
  return result;
}

/** Post-commit system event for a newly recorded outcome; describes the evidence actually present. */
export async function emitDispatchOutcomeRecorded(
  result: { newlyUnresolved: boolean; evidence: Prisma.InputJsonValue | null; claimId?: number; tradingAccountId?: number; records?: EntryDispatchRecords },
  classification: EntryDispatchOutcomeClassification,
) {
  if (!result.newlyUnresolved || !result.claimId || !result.evidence) return;
  const withRecord = Boolean(result.records?.present);
  await createSystemEvent({
    type: 'entry_exposure.dispatch_outcome_recorded', entityType: 'entryExposureClaim', entityId: result.claimId, tradingAccountId: result.tradingAccountId ?? null,
    severity: LOCAL_NON_SEND_CLASSIFICATIONS.has(classification) ? SystemEventSeverity.WARNING : SystemEventSeverity.ERROR,
    message: withRecord
      ? 'An entry failed after its durable dispatch record committed. The claim is retained as UNRESOLVED and the intent is never resent; evidence-based recovery decides any release.'
      : 'An entry has no durable dispatch record and no proof that its request was not issued. The claim is retained as UNRESOLVED and the intent is never resent; evidence-based recovery or operator investigation decides any release.',
    payloadJson: result.evidence,
  }).catch(() => undefined);
}

/**
 * The release basis of recorded outcomes. Any uncertain outcome makes absence ambiguous, whatever a
 * later lookup returns. A rejection qualifies only with a definitive status code and only once its
 * settle window has elapsed (a minimum before verification, never a release trigger by itself).
 */
export function evaluateDispatchReleaseBasis(outcomes: Array<{ classification: string; statusCode: number | null; recordedAt: Date }>, now: Date): {
  basis: DispatchReleaseBasis | null; conclusiveness: 'CONCLUSIVE' | 'PENDING' | 'AMBIGUOUS_ABSENCE'; blocker: string | null;
} {
  if (!outcomes.length) return { basis: null, conclusiveness: 'AMBIGUOUS_ABSENCE', blocker: 'DISPATCH_OUTCOME_NOT_RECORDED' };
  if (outcomes.some((outcome) => !LOCAL_NON_SEND_CLASSIFICATIONS.has(outcome.classification) && outcome.classification !== 'BROKER_REJECTED')) {
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
    // A BUY fill for this account and Security after dispatch may have started (or at any time when
    // the start is unknown), not attributed to any intent, could be this entry's.
    db.brokerActivity.count({ where: {
      tradingAccountId: claim.tradingAccountId, activityType: 'FILL', side: { equals: 'buy', mode: 'insensitive' },
      symbol: { equals: symbol, mode: 'insensitive' }, orderIntentId: null,
      ...(startedAt ? { OR: [{ transactionTime: null }, { transactionTime: { gte: new Date(startedAt.getTime() - 60_000) } }] } : {}),
    } }),
  ]);
  return { brokerOrders, brokerActivities, activePositions, localExecutableBuys, unattributedFills, trackedPositionAttached: claim.trackedPositionId !== null };
}

function outcomeView(summary: DeliveryEvidenceSummary) {
  return summary.outcomes.map((outcome) => ({
    eventId: outcome.eventId, kind: outcome.kind, classification: outcome.classification, statusCode: outcome.statusCode,
    observation: outcome.observation, adapterInvocation: outcome.adapterInvocation,
  }));
}

/**
 * Fresh, read-only assessment of whether an entry claim can be released under the evidence
 * standard, with or without a durable dispatch record. Its fingerprint covers every fact the release
 * relies on (and no clock values), so an operator confirmation binds exactly the evidence reviewed.
 */
export async function assessEntryClaimRelease(orderIntentId: number, options: { now?: Date; operation?: AlpacaApiOperation } = {}) {
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
  const events = await prisma.entryExposureClaimEvent.findMany({
    where: { claimId: claim.id, eventType: { in: [...DELIVERY_EVIDENCE_EVENT_TYPES] } },
    select: { id: true, eventType: true, evidenceJson: true, createdAt: true }, orderBy: { id: 'asc' },
  });
  const summary = summarizeDeliveryEvidence(events);
  const basis = evaluateDispatchReleaseBasis(summary.outcomes, now);
  const dispatchEvidence = records.present || summary.dispatchOutcomes.length > 0;
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
    ...(records.liveArming && records.liveArming.clientOrderId !== null && records.liveArming.clientOrderId !== intent.clientOrderId ? ['LIVE_ARMING'] : []),
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
    ...(!summary.outcomes.length && !records.present ? ['NO_DELIVERY_EVIDENCE'] : []),
    ...(basis.blocker && (summary.outcomes.length || records.present) ? [basis.blocker] : []),
    ...(!RECOVERABLE_CLAIM_STATUSES.includes(claim.status) ? ['CLAIM_STATUS_NOT_RECOVERABLE']
      : dispatchEvidence && claim.status !== 'UNRESOLVED' ? ['CLAIM_OUTCOME_NOT_RECORDED'] : []),
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
    disposition: records.present ? 'DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE' : 'NO_DISPATCH_RECORD_VERIFIED_NO_EXPOSURE',
    claim: { id: claim.id, status: claim.status, tradingAccountId: claim.tradingAccountId, securityId: claim.securityId, symbol, orderIntentId, trackedPositionId: claim.trackedPositionId },
    orderIntent: { id: intent.id, status: intent.status, clientOrderId: intent.clientOrderId, environment: intent.tradingAccount?.environment ?? null },
    dispatch: recordIdentity(records),
    dispatchRecordPresent: records.present,
    recordedOutcomes: outcomeView(summary),
    adapterMarkers: summary.adapterMarkers,
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
    evidenceEventCount: events.length,
    dispatchStartedAt: records.startedAt,
    confirmationFingerprint: crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
  };
}
export type EntryClaimReleaseAssessment = Awaited<ReturnType<typeof assessEntryClaimRelease>>;
/** @deprecated Name kept for existing callers; covers claims with and without dispatch records. */
export const assessDispatchedEntryClaim = assessEntryClaimRelease;
export type DispatchedEntryClaimAssessment = EntryClaimReleaseAssessment;

export type DispatchedEntryReleaseResult = { released: boolean; reason: string; assessment: EntryClaimReleaseAssessment | null };

/**
 * Releases an entry claim when, and only when, the evidence standard holds: fresh verification, an
 * exact operator fingerprint (OPERATOR mode), and a final revalidation under the account/Security
 * entry-exposure lock, then a compare-and-set release with immutable evidence.
 */
export async function releaseVerifiedEntryExposureClaim(args: {
  orderIntentId: number;
  mode: 'SYSTEM' | 'OPERATOR';
  actorUserId?: number;
  confirmationFingerprint?: string;
  now?: Date;
}): Promise<DispatchedEntryReleaseResult> {
  const assessment = await assessEntryClaimRelease(args.orderIntentId, { ...(args.now ? { now: args.now } : {}), operation: args.mode === 'OPERATOR' ? 'manual_admin_action' : 'reconciliation_check' });
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

  const releaseReason = `${assessment.dispatchRecordPresent ? 'VERIFIED_DISPATCH_NO_EXPOSURE' : 'VERIFIED_NO_DISPATCH_RECORD_NO_EXPOSURE'}:${assessment.basis}`;
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${assessment.claim.tradingAccountId}:${assessment.claim.securityId}`}, 0))::text`;
    const current = await tx.entryExposureClaim.findUnique({ where: { id: claimId }, include: { orderIntent: { select: { status: true } } } });
    if (!current || current.releasedAt) return 'CLAIM_ALREADY_RELEASED';
    const [local, evidenceEvents, records] = await Promise.all([
      localExposure(current, args.orderIntentId, assessment.claim.symbol, assessment.dispatchStartedAt, tx),
      tx.entryExposureClaimEvent.count({ where: { claimId, eventType: { in: [...DELIVERY_EVIDENCE_EVENT_TYPES] } } }),
      loadEntryDispatchRecords(args.orderIntentId, tx),
    ]);
    const revalidation = [
      ...(current.status !== assessment.claim.status ? ['CLAIM_STATUS_CHANGED'] : []),
      ...(!current.orderIntent || !(TERMINAL_ENTRY_INTENT_STATUSES as readonly string[]).includes(current.orderIntent.status) ? ['INTENT_NOT_TERMINAL'] : []),
      ...(local.brokerOrders ? ['LOCAL_BROKER_ORDER_PRESENT'] : []),
      ...(local.brokerActivities ? ['LOCAL_BROKER_ACTIVITY_PRESENT'] : []),
      ...(local.activePositions || local.trackedPositionAttached ? ['LOCAL_POSITION_PRESENT'] : []),
      ...(local.localExecutableBuys ? ['LOCAL_EXECUTABLE_BUY_PRESENT'] : []),
      ...(local.unattributedFills ? ['UNATTRIBUTED_BUY_FILL_PRESENT'] : []),
      ...(evidenceEvents !== assessment.evidenceEventCount ? ['DISPATCH_OUTCOME_CHANGED'] : []),
      ...(records.present !== assessment.dispatchRecordPresent ? ['DISPATCH_RECORD_CHANGED'] : []),
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
      where: { id: claimId, status: assessment.claim.status, releasedAt: null },
      data: { status: 'RELEASED', releasedAt: new Date(), releaseReason },
    });
    if (released.count !== 1) return 'CLAIM_STATUS_CHANGED';
    await tx.entryExposureClaimEvent.create({ data: { claimId, eventType: 'RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE', evidenceJson: json({
      mode: args.mode, actorUserId: args.actorUserId ?? null, basis: assessment.basis, confirmationFingerprint: assessment.confirmationFingerprint,
      evidence: assessment, executionAuthority: 'NONE', originalIntentResubmission: 'PROHIBITED',
      dispatchRecord: assessment.dispatchRecordPresent ? 'RETAINED_IMMUTABLE' : 'NONE',
    }) } });
    return 'RELEASED';
  });
  if (outcome !== 'RELEASED') return { released: false, reason: outcome, assessment };
  await createSystemEvent({
    type: 'entry_exposure.dispatch_claim_released', entityType: 'entryExposureClaim', entityId: claimId, tradingAccountId: assessment.claim.tradingAccountId,
    actorUserId: args.actorUserId ?? null, severity: SystemEventSeverity.INFO,
    message: 'An entry claim was released after conclusive evidence of no broker exposure. The original intent is never resent.',
    payloadJson: json({ orderIntentId: args.orderIntentId, mode: args.mode, basis: assessment.basis, ...assessment.dispatch, confirmationFingerprint: assessment.confirmationFingerprint }),
  }).catch(() => undefined);
  return { released: true, reason: releaseReason, assessment };
}
/** @deprecated Name kept for existing callers. */
export const releaseDispatchedEntryExposureClaim = releaseVerifiedEntryExposureClaim;

/**
 * Worker release attempt after the outcome is already durable: a definite local non-send is verified
 * and released immediately when provable; anything else waits for the terminal sweep.
 */
export async function attemptReleaseAfterRecordedOutcome(args: {
  orderIntentId: number;
  classification: EntryDispatchOutcomeClassification;
  source: EntryDispatchRecoverySource;
  now?: Date;
}): Promise<DispatchedEntryReleaseResult> {
  if (!LOCAL_NON_SEND_CLASSIFICATIONS.has(args.classification)) return { released: false, reason: 'AWAITING_EVIDENCE_BASED_RECOVERY', assessment: null };
  try {
    return await releaseVerifiedEntryExposureClaim({ orderIntentId: args.orderIntentId, mode: 'SYSTEM', ...(args.now ? { now: args.now } : {}) });
  } catch (error) {
    await recordRecoveryError(args.orderIntentId, args.source, error);
    return { released: false, reason: 'RECOVERY_ERROR', assessment: null };
  }
}

/** Records an outcome and then attempts the release it allows (outside any caller transaction). */
export async function routeEntryDispatchFailure(args: RecordEntryDispatchOutcomeArgs & { now?: Date }): Promise<DispatchedEntryReleaseResult> {
  const standalone: RecordEntryDispatchOutcomeArgs = { ...args };
  delete standalone.db;
  await recordEntryDispatchOutcome(standalone);
  return attemptReleaseAfterRecordedOutcome(args);
}

function errorCode(error: unknown) {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; name?: unknown };
    if (typeof value.code === 'string') return value.code;
    if (typeof value.name === 'string') return value.name;
  }
  return 'UNKNOWN_ERROR';
}

async function recordRecoveryError(orderIntentId: number, source: string, error: unknown) {
  logger.warn({ orderIntentId, error }, 'Entry claim recovery failed; the claim is retained and will be retried after the bounded interval.');
  const claim = await prisma.entryExposureClaim.findUnique({ where: { orderIntentId }, select: { id: true } }).catch(() => null);
  // Deduplicated by stable evidence (no raw message or clock), so a persistent failure appends once.
  if (claim) await appendEntryExposureClaimDiagnostic(claim.id, 'DISPATCH_RECOVERY_ERROR', json({ source, failureClass: 'TECHNICAL', errorCode: errorCode(error) })).catch(() => undefined);
}

export type UnsubmittedReleaseResult = {
  released: boolean;
  outcome: 'RELEASED' | 'ALREADY_RELEASED' | 'NOT_RELEASED' | 'ROUTED_TO_EVIDENCE_RECOVERY' | 'REFUSED_RETAINED' | 'RETRYABLE_FAILURE';
  routed?: boolean;
  retryable?: boolean;
  /** For a retryable failure: whether the attempt was durably recorded (advancing its retry time). */
  attemptRecorded?: boolean;
  claimStatus?: string | null;
};

/**
 * Never-submitted release for a claim whose non-dispatch evidence is already durable. A domain
 * refusal is recorded (UNRESOLVED) rather than swallowed. A technical failure keeps the prior
 * recoverable state and records a deduplicated attempt diagnostic that advances the retry time; if
 * even that cannot be written, the claim simply stays held. `dispatchAttempted` is true only when
 * this attempt reached the final dispatch authorization after confirming no prior dispatch record: a
 * durable record found then committed with a lost acknowledgement and goes to evidence-based recovery.
 */
export async function releaseUnsubmittedOrRouteToRecovery(args: {
  orderIntentId: number;
  reason: string;
  source: EntryDispatchRecoverySource;
  dispatchAttempted: boolean;
  message?: string | null;
}): Promise<UnsubmittedReleaseResult> {
  try {
    const claim = await releaseUnsubmittedEntryExposureClaim({ orderIntentId: args.orderIntentId, reason: args.reason });
    if (releasedByThisCall(claim, args.reason)) return { released: true, outcome: 'RELEASED', claimStatus: claim?.status ?? null };
    // A compare-and-set miss or a release by another path is reported as it actually committed.
    return { released: false, outcome: claim?.releasedAt ? 'ALREADY_RELEASED' : 'NOT_RELEASED', claimStatus: claim?.status ?? null };
  } catch (error) {
    const details = error instanceof HttpError && error.details && typeof error.details === 'object'
      ? error.details as Record<string, unknown>
      : null;
    const domainEvidenceConflict = error instanceof HttpError && error.statusCode === 409 && [
      'ENTRY_EXPOSURE_UNRESOLVED',
      'INVALID_ENTRY_EXPOSURE_TRANSITION',
      'ENTRY_EXPOSURE_STALE_TRANSITION',
    ].includes(String(details?.code ?? ''));
    if (!domainEvidenceConflict) {
      // Infrastructure and unknown failures do not prove an ownership contradiction. Keep the
      // recoverable state and its recorded evidence; advance the retry time when the database allows.
      logger.warn({ orderIntentId: args.orderIntentId, error }, 'Unsubmitted entry claim release failed without a domain evidence conflict; prior claim state retained for retry.');
      let attemptRecorded = false;
      try {
        const claim = await prisma.entryExposureClaim.findUnique({ where: { orderIntentId: args.orderIntentId }, select: { id: true } });
        if (claim) {
          await appendEntryExposureClaimDiagnostic(claim.id, 'RECOVERY_ATTEMPT_FAILED', json({
            source: args.source, reason: args.reason, failureClass: 'TECHNICAL', errorCode: errorCode(error), automaticRetry: 'SCHEDULED',
          }));
          attemptRecorded = true;
        }
      } catch (diagnosticError) {
        logger.warn({ orderIntentId: args.orderIntentId, error: diagnosticError }, 'Recovery attempt could not be recorded; the claim stays held and is not reported as attempted.');
      }
      return { released: false, outcome: 'RETRYABLE_FAILURE', routed: false, retryable: true, attemptRecorded };
    }
    const records = await loadEntryDispatchRecords(args.orderIntentId).catch(() => null);
    if (records?.durable && args.dispatchAttempted) {
      await routeEntryDispatchFailure({
        orderIntentId: args.orderIntentId, classification: 'NOT_SENT_DISPATCH_RECORD_ACK_LOST', source: args.source, observation: 'OBSERVED',
        message: args.message ?? args.reason, records,
      }).catch((routeError) => recordRecoveryError(args.orderIntentId, args.source, routeError));
      return { released: false, outcome: 'ROUTED_TO_EVIDENCE_RECOVERY', routed: true };
    }
    if (records?.present) {
      // An earlier attempt's dispatch record: its outcome is recorded (or inferred by the terminal
      // sweep); this pre-boundary failure adds no delivery classification.
      const claim = await prisma.entryExposureClaim.findUnique({ where: { orderIntentId: args.orderIntentId }, select: { id: true, releasedAt: true } }).catch(() => null);
      if (claim && !claim.releasedAt) {
        await appendEntryExposureClaimDiagnostic(claim.id, 'PRE_BOUNDARY_FAILURE_WITH_PRIOR_DISPATCH_RECORD', json({ reason: args.reason, source: args.source, refusal: message(error) }))
          .catch((diagnosticError) => recordRecoveryError(args.orderIntentId, args.source, diagnosticError));
      }
      return { released: false, outcome: 'REFUSED_RETAINED', routed: false };
    }
    const claim = await prisma.entryExposureClaim.findUnique({ where: { orderIntentId: args.orderIntentId } }).catch(() => null);
    if (claim && !claim.releasedAt) {
      await transitionEntryExposureClaim({
        orderIntentId: args.orderIntentId, status: 'UNRESOLVED', eventType: 'UNSUBMITTED_RELEASE_REFUSED',
        evidence: json({ reason: args.reason, source: args.source, refusal: message(error), details, executionAuthority: 'NONE' }),
      }).catch((transitionError) => recordRecoveryError(args.orderIntentId, args.source, transitionError));
      if (claim.status !== 'UNRESOLVED') {
        await createSystemEvent({
          type: 'entry_exposure.unsubmitted_release_refused', entityType: 'entryExposureClaim', entityId: claim.id, tradingAccountId: claim.tradingAccountId,
          severity: SystemEventSeverity.ERROR,
          message: 'An entry failure could not release its claim as unsubmitted; ownership is retained as UNRESOLVED for review.',
          payloadJson: json({ orderIntentId: args.orderIntentId, reason: args.reason, refusal: message(error) }),
        }).catch(() => undefined);
      }
    }
    logger.warn({ orderIntentId: args.orderIntentId, error }, 'Unsubmitted entry claim release was refused; ownership retained as UNRESOLVED.');
    return { released: false, outcome: 'REFUSED_RETAINED', routed: false };
  }
}

/** Infers the outcome of a terminal intent with a dispatch record but no recorded outcome. */
export function inferEntryDispatchOutcome(blockReason: string | null): { classification: EntryDispatchOutcomeClassification; statusCode: number | null } {
  const reason = blockReason ?? '';
  const write = blockReasonDeliveryClassification(reason);
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

// ---------------------------------------------------------------------------------------------
// Terminal-claim recovery state: one definition shared by the sweep, account enumeration and readiness.
// ---------------------------------------------------------------------------------------------

export type TerminalClaimRecoveryState =
  /** Proven never sent (structured evidence or claim state); retry the never-submitted release. */
  | 'AUTOMATIC_NEVER_SUBMITTED_RELEASE'
  /** Legacy claim with code-classified non-dispatch evidence; record it structurally, then release. */
  | 'AUTOMATIC_NOT_SENT_EVIDENCE_RECORDING'
  /** Dispatch evidence without a recorded outcome, or no evidence either way: record it (UNRESOLVED). */
  | 'AUTOMATIC_OUTCOME_RECORDING'
  /** UNRESOLVED with a conclusive or settling basis: evidence-verified release. */
  | 'AUTOMATIC_VERIFIED_RELEASE'
  /** Uncertain, unknown or contradicted delivery: no automatic release; operator investigation. */
  | 'OPERATOR_INVESTIGATION'
  /** A local broker order exists: order sync and terminal broker-order remediation own the claim. */
  | 'PROTECTED_EXPOSURE';

const AUTOMATIC_STATES: ReadonlySet<TerminalClaimRecoveryState> = new Set([
  'AUTOMATIC_NEVER_SUBMITTED_RELEASE', 'AUTOMATIC_NOT_SENT_EVIDENCE_RECORDING', 'AUTOMATIC_OUTCOME_RECORDING', 'AUTOMATIC_VERIFIED_RELEASE',
]);

const LEGACY_NOT_SENT_BLOCK_REASON = /^(MARKET_POLICY_BROKER_TIME:[A-Z_]+:DEFINITELY_NOT_SENT|LOCAL_PRE_DISPATCH_FAILURE:)/;

export type TerminalClaimCandidate = {
  id: number;
  status: string;
  tradingAccountId: number;
  securityId: number;
  symbol: string;
  lastDiagnosedAt: Date | null;
  trackedPositionId: number | null;
  orderIntent: {
    id: number; status: string; clientOrderId: string | null; blockReason: string | null; rawRequestJson: Prisma.JsonValue;
    consumptionId: number | null; dispatchDecisionId: number | null; dispatchDecisionOutcome: string | null;
    unenforcedDispatchId: number | null; unenforcedDispatchBasis: string | null; dispatchOpportunityEvents: number; brokerOrders: number;
  };
  liveArmingConsumed: boolean;
  events: DeliveryEvidenceEvent[];
};

function legacyNotSentEvidence(candidate: TerminalClaimCandidate): { classification: NotSentClassification; producer: NotSentProducer } | null {
  const intent = candidate.orderIntent;
  const local = blockReasonDeliveryClassification(intent.blockReason);
  if (local === 'NOT_SENT_BLOCKED' || local === 'NOT_SENT_RETRYABLE') {
    return { classification: local === 'NOT_SENT_BLOCKED' ? 'NOT_SENT_LOCAL_BLOCKED' : 'NOT_SENT_LOCAL_RETRYABLE', producer: 'TERMINAL_SWEEP_LEGACY_LOCAL_CLASSIFICATION' };
  }
  if (LEGACY_NOT_SENT_BLOCK_REASON.test(intent.blockReason ?? '')) return { classification: 'NOT_SENT_PRE_DISPATCH', producer: 'TERMINAL_SWEEP_LEGACY_LOCAL_CLASSIFICATION' };
  // The structured risk evaluation the worker records before blocking: a blocked intent whose block
  // reason is exactly that evaluation's refusal never reached the broker boundary.
  const raw = intent.rawRequestJson && typeof intent.rawRequestJson === 'object' && !Array.isArray(intent.rawRequestJson) ? intent.rawRequestJson as Record<string, unknown> : {};
  const risk = raw.riskEvaluation && typeof raw.riskEvaluation === 'object' ? raw.riskEvaluation as Record<string, unknown> : null;
  if (risk && risk.allowed === false && intent.status === 'blocked' && typeof risk.reason === 'string' && risk.reason === intent.blockReason) {
    return { classification: 'NOT_SENT_PRE_DISPATCH', producer: 'TERMINAL_SWEEP_RISK_EVALUATION_BLOCKED' };
  }
  return null;
}

/** Pure classification of a terminal entry claim's recovery state. */
export function classifyTerminalEntryClaim(candidate: TerminalClaimCandidate, now: Date) {
  const summary = summarizeDeliveryEvidence(candidate.events);
  const intent = candidate.orderIntent;
  const recordsPresent = Boolean(intent.consumptionId || intent.unenforcedDispatchId || intent.dispatchOpportunityEvents > 0 || candidate.liveArmingConsumed);
  const basis = evaluateDispatchReleaseBasis(summary.outcomes, now);
  const result = (state: TerminalClaimRecoveryState, blocker: string | null, extra: { notSent?: ReturnType<typeof legacyNotSentEvidence> } = {}) => ({
    state, automatic: AUTOMATIC_STATES.has(state), blocker, summary, basis, recordsPresent, ...extra,
  });
  if (intent.brokerOrders > 0 || candidate.trackedPositionId !== null) return result('PROTECTED_EXPOSURE', 'BROKER_ORDER_OR_POSITION_EVIDENCE');
  if (PRE_DISPATCH_CLAIM_STATUSES.includes(candidate.status)) {
    if (recordsPresent || summary.dispatchOutcomes.length) return result('AUTOMATIC_OUTCOME_RECORDING', 'DISPATCH_OUTCOME_NOT_RECORDED');
    if (evaluateNeverSubmittedRelease({ claimStatus: candidate.status, summary, blockReason: intent.blockReason }).proven) {
      return result('AUTOMATIC_NEVER_SUBMITTED_RELEASE', null);
    }
    if (candidate.status === 'ENTRY_SUBMITTING' && summary.markerProtocol && summary.adapterMarkers === 0) {
      return result('AUTOMATIC_NOT_SENT_EVIDENCE_RECORDING', null, { notSent: { classification: 'NOT_SENT_PRE_DISPATCH', producer: 'TERMINAL_SWEEP_ADAPTER_NOT_INVOKED' } });
    }
    const legacy = summary.adapterMarkers === 0 ? legacyNotSentEvidence(candidate) : null;
    if (legacy) return result('AUTOMATIC_NOT_SENT_EVIDENCE_RECORDING', null, { notSent: legacy });
    // Neither a record nor proof of non-dispatch: record an explicit unknown and retain ownership.
    return result('AUTOMATIC_OUTCOME_RECORDING', 'DELIVERY_OUTCOME_UNKNOWN_NO_DISPATCH_RECORD');
  }
  if (candidate.status !== 'UNRESOLVED') return result('PROTECTED_EXPOSURE', 'CLAIM_STATUS_NOT_RECOVERABLE');
  if (!summary.outcomes.length) {
    // A dispatch record without a recorded outcome is recorded first; no evidence at all is
    // operator-only (absence of a record never proves that no request was issued).
    return recordsPresent
      ? result('AUTOMATIC_OUTCOME_RECORDING', 'DISPATCH_OUTCOME_NOT_RECORDED')
      : result('OPERATOR_INVESTIGATION', 'NO_DELIVERY_EVIDENCE');
  }
  if (basis.conclusiveness === 'AMBIGUOUS_ABSENCE') {
    return result('OPERATOR_INVESTIGATION', !recordsPresent && basis.blocker === 'DELIVERY_OUTCOME_UNCERTAIN' && !summary.adapterRequestObserved
      ? 'DELIVERY_OUTCOME_UNKNOWN_NO_DISPATCH_RECORD'
      : basis.blocker);
  }
  return result('AUTOMATIC_VERIFIED_RELEASE', basis.blocker);
}
export type TerminalClaimClassification = ReturnType<typeof classifyTerminalEntryClaim>;

/** Unreleased, position-free claims of terminal entry intents, with all recovery inputs. */
export async function loadTerminalClaimCandidates(args: { db?: PrismaClient; tradingAccountIds?: number[] | undefined; attemptEvents?: boolean; includePositionAttached?: boolean } = {}) {
  const db = args.db ?? prisma;
  const claims = await db.entryExposureClaim.findMany({
    where: {
      releasedAt: null, ...(args.includePositionAttached ? {} : { trackedPositionId: null }),
      orderIntent: { status: { in: [...TERMINAL_ENTRY_INTENT_STATUSES] } },
      ...(args.tradingAccountIds?.length ? { tradingAccountId: { in: args.tradingAccountIds } } : {}),
    },
    select: {
      id: true, status: true, tradingAccountId: true, securityId: true, lastDiagnosedAt: true, trackedPositionId: true,
      security: { select: { symbol: true } },
      orderIntent: { select: {
        id: true, status: true, clientOrderId: true, blockReason: true, rawRequestJson: true,
        marketPolicyBrokerDispatchConsumption: { select: { id: true, decision: { select: { id: true, outcome: true } } } },
        marketPolicyBrokerUnenforcedDispatch: { select: { id: true, basis: true } },
        _count: { select: { brokerOrders: true, brokerOpportunityEvents: { where: { eventType: { in: [...DISPATCH_OPPORTUNITY_EVENT_TYPES] } } } } },
      } },
      events: {
        where: { eventType: { in: [...DELIVERY_EVIDENCE_EVENT_TYPES, ...(args.attemptEvents ? [...Object.keys(ATTEMPT_RESULT_EVENTS), 'DISPATCH_OUTCOME_NOT_APPLIED'] : [])] } },
        orderBy: { id: 'asc' }, select: { id: true, eventType: true, evidenceJson: true, createdAt: true },
      },
    },
    orderBy: { id: 'asc' },
  });
  const intentIds = claims.map((claim) => claim.orderIntent!.id);
  const armed = intentIds.length
    ? new Set((await db.liveEntryArmingTermination.findMany({ where: { orderIntentId: { in: intentIds }, type: 'CONSUMED' }, select: { orderIntentId: true } })).map((row) => row.orderIntentId))
    : new Set<number | null>();
  return claims.map((claim): TerminalClaimCandidate & { attemptEvents: DeliveryEvidenceEvent[] } => {
    const intent = claim.orderIntent!;
    return {
      id: claim.id, status: claim.status, tradingAccountId: claim.tradingAccountId, securityId: claim.securityId,
      symbol: claim.security.symbol, lastDiagnosedAt: claim.lastDiagnosedAt, trackedPositionId: claim.trackedPositionId,
      orderIntent: {
        id: intent.id, status: intent.status, clientOrderId: intent.clientOrderId, blockReason: intent.blockReason, rawRequestJson: intent.rawRequestJson,
        consumptionId: intent.marketPolicyBrokerDispatchConsumption?.id ?? null,
        dispatchDecisionId: intent.marketPolicyBrokerDispatchConsumption?.decision.id ?? null,
        dispatchDecisionOutcome: intent.marketPolicyBrokerDispatchConsumption?.decision.outcome ?? null,
        unenforcedDispatchId: intent.marketPolicyBrokerUnenforcedDispatch?.id ?? null,
        unenforcedDispatchBasis: intent.marketPolicyBrokerUnenforcedDispatch?.basis ?? null,
        dispatchOpportunityEvents: intent._count.brokerOpportunityEvents, brokerOrders: intent._count.brokerOrders,
      },
      liveArmingConsumed: armed.has(intent.id),
      events: claim.events.filter((event) => (DELIVERY_EVIDENCE_EVENT_TYPES as readonly string[]).includes(event.eventType)),
      attemptEvents: claim.events.filter((event) => !(DELIVERY_EVIDENCE_EVENT_TYPES as readonly string[]).includes(event.eventType)),
    };
  });
}

function isDue(candidate: { lastDiagnosedAt: Date | null }, now: Date) {
  return !candidate.lastDiagnosedAt || candidate.lastDiagnosedAt.getTime() <= now.getTime() - ENTRY_DISPATCH_RECOVERY_RETRY_MS;
}

/**
 * Per-account recovery work, from the same classification the sweep uses: account enumeration
 * schedules only actionable, due claims, while operator-only and protected claims stay visible as
 * held exposure (so credential-unavailable exposure is never hidden from worker health).
 */
export async function summarizeTerminalClaimRecoveryByAccount(args: { now?: Date; tradingAccountIds?: number[] | undefined; db?: PrismaClient } = {}) {
  const now = args.now ?? new Date();
  const candidates = await loadTerminalClaimCandidates({ ...(args.db ? { db: args.db } : {}), tradingAccountIds: args.tradingAccountIds });
  const byAccount = new Map<number, { actionableDue: number; actionableWaiting: number; operatorInvestigation: number; protectedExposure: number; held: number }>();
  for (const candidate of candidates) {
    const entry = byAccount.get(candidate.tradingAccountId) ?? { actionableDue: 0, actionableWaiting: 0, operatorInvestigation: 0, protectedExposure: 0, held: 0 };
    const { state, automatic } = classifyTerminalEntryClaim(candidate, now);
    entry.held += 1;
    if (automatic) {
      if (isDue(candidate, now)) entry.actionableDue += 1; else entry.actionableWaiting += 1;
    } else if (state === 'OPERATOR_INVESTIGATION') entry.operatorInvestigation += 1;
    else entry.protectedExposure += 1;
    byAccount.set(candidate.tradingAccountId, entry);
  }
  return byAccount;
}

/** Leases a claim for one attempt: advances lastDiagnosedAt only if it is still due and held. */
async function leaseRecoveryAttempt(claimId: number, now: Date) {
  const leased = await prisma.entryExposureClaim.updateMany({
    where: {
      id: claimId, releasedAt: null,
      OR: [{ lastDiagnosedAt: null }, { lastDiagnosedAt: { lte: new Date(now.getTime() - ENTRY_DISPATCH_RECOVERY_RETRY_MS) } }],
    },
    data: { lastDiagnosedAt: now },
  });
  return leased.count === 1;
}

async function recordNotSentEvidenceAndRelease(candidate: TerminalClaimCandidate, notSent: { classification: NotSentClassification; producer: NotSentProducer }, source: EntryDispatchRecoverySource) {
  const recorded = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${candidate.tradingAccountId}:${candidate.securityId}`}, 0))::text`;
    const current = await tx.entryExposureClaim.findUnique({ where: { id: candidate.id }, select: { status: true, releasedAt: true } });
    const events = await tx.entryExposureClaimEvent.count({ where: { claimId: candidate.id, eventType: { in: [...DELIVERY_EVIDENCE_EVENT_TYPES] } } });
    // Recorded only against exactly the evidence that was classified.
    if (!current || current.releasedAt || current.status !== candidate.status || events !== candidate.events.length) return false;
    await appendNotSentEvidence(tx, {
      claimId: candidate.id, orderIntentId: candidate.orderIntent.id, classification: notSent.classification, producer: notSent.producer,
      source, reason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED', message: candidate.orderIntent.blockReason,
    });
    return true;
  });
  if (!recorded) return { released: false, outcome: 'NOT_RELEASED' as const };
  return releaseUnsubmittedOrRouteToRecovery({ orderIntentId: candidate.orderIntent.id, reason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED', source, dispatchAttempted: false });
}

/**
 * Bounded, starvation-resistant sweep of terminal entry intents whose claims are still held. It
 * selects only actionable claims (the account enumeration's definition), oldest attempt first, at
 * most ENTRY_DISPATCH_RECOVERY_BATCH_LIMIT per tick, and leases each before attempting it so every
 * attempt, whatever its result, waits ENTRY_DISPATCH_RECOVERY_RETRY_MS before the next. A claim whose
 * lease cannot be written (database outage) is not attempted. Caller holds the account
 * lifecycle-mutation lock.
 */
export async function recoverTerminalEntryClaimsForAccount(tradingAccountId: number, now = new Date()) {
  const candidates = (await loadTerminalClaimCandidates({ tradingAccountIds: [tradingAccountId] }))
    .filter((candidate) => candidate.tradingAccountId === tradingAccountId)
    .map((candidate) => ({ candidate, classification: classifyTerminalEntryClaim(candidate, now) }))
    .filter(({ candidate, classification }) => classification.automatic && isDue(candidate, now))
    .sort((left, right) => (left.candidate.lastDiagnosedAt?.getTime() ?? -Infinity) - (right.candidate.lastDiagnosedAt?.getTime() ?? -Infinity) || left.candidate.id - right.candidate.id)
    .slice(0, ENTRY_DISPATCH_RECOVERY_BATCH_LIMIT);
  let released = 0;
  let retained = 0;
  let recorded = 0;
  const attempted: number[] = [];
  const failures: Array<{ claimId: number; error: string }> = [];
  for (const { candidate, classification } of candidates) {
    const orderIntentId = candidate.orderIntent.id;
    try {
      if (!await leaseRecoveryAttempt(candidate.id, now)) continue;
    } catch (error) {
      failures.push({ claimId: candidate.id, error: message(error) });
      continue;
    }
    attempted.push(candidate.id);
    try {
      if (classification.state === 'AUTOMATIC_NEVER_SUBMITTED_RELEASE') {
        const result = await releaseUnsubmittedOrRouteToRecovery({ orderIntentId, reason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED', source: 'TERMINAL_CLAIM_SWEEP', dispatchAttempted: false });
        if (result.released) released += 1; else retained += 1;
        if (result.outcome === 'RETRYABLE_FAILURE') failures.push({ claimId: candidate.id, error: 'RETRYABLE_RELEASE_FAILURE' });
      } else if (classification.state === 'AUTOMATIC_NOT_SENT_EVIDENCE_RECORDING') {
        const result = await recordNotSentEvidenceAndRelease(candidate, classification.notSent!, 'TERMINAL_CLAIM_SWEEP');
        recorded += 1;
        if (result.released) released += 1; else retained += 1;
        if (result.outcome === 'RETRYABLE_FAILURE') failures.push({ claimId: candidate.id, error: 'RETRYABLE_RELEASE_FAILURE' });
      } else if (classification.state === 'AUTOMATIC_OUTCOME_RECORDING') {
        // An outcome already recorded (whose claim transition did not complete) is kept as is; a
        // dispatch record is classified from the worker's block reason; otherwise the outcome is unknown.
        const prior = [...classification.summary.outcomes].reverse().find((outcome) => outcome.kind === 'OUTCOME');
        const inferred = prior
          ? { classification: prior.classification as EntryDispatchOutcomeClassification, statusCode: prior.statusCode }
          : classification.recordsPresent ? inferEntryDispatchOutcome(candidate.orderIntent.blockReason) : { classification: 'DISPATCH_OUTCOME_UNKNOWN' as const, statusCode: null };
        await recordEntryDispatchOutcome({
          orderIntentId, ...inferred, source: 'TERMINAL_CLAIM_SWEEP', observation: 'INFERRED',
          message: classification.recordsPresent
            ? candidate.orderIntent.blockReason
            : `No durable dispatch record and no structured not-sent evidence; delivery is unknown. Block reason: ${candidate.orderIntent.blockReason ?? 'none'}`,
        });
        recorded += 1;
        const result = classification.recordsPresent ? await releaseVerifiedEntryExposureClaim({ orderIntentId, mode: 'SYSTEM', now }) : { released: false };
        if (result.released) released += 1; else retained += 1;
      } else {
        const result = await releaseVerifiedEntryExposureClaim({ orderIntentId, mode: 'SYSTEM', now });
        if (result.released) released += 1; else retained += 1;
      }
    } catch (error) {
      retained += 1;
      failures.push({ claimId: candidate.id, error: message(error) });
      await recordRecoveryError(orderIntentId, 'TERMINAL_CLAIM_SWEEP', error);
    }
    // Diagnostics use the wall clock; the attempt time stays the sweep's clock (never regressed).
    await prisma.entryExposureClaim.updateMany({ where: { id: candidate.id, releasedAt: null, lastDiagnosedAt: { lt: now } }, data: { lastDiagnosedAt: now } }).catch(() => undefined);
  }
  return { examined: candidates.length, attempted, released, retained, recorded, failures };
}
/** @deprecated Name kept for existing callers. */
export const recoverDispatchedEntryClaimsForAccount = recoverTerminalEntryClaimsForAccount;

/**
 * Read-only description of terminal entry intents whose claims remain unreleased, for readiness. It
 * uses only recorded evidence plus the caller's broker snapshot; remediation re-verifies fresh.
 */
export async function describeUnreleasedTerminalEntryClaims(args: {
  db?: PrismaClient;
  tradingAccountIds?: number[] | undefined;
  now?: Date;
  brokerExposure?: (tradingAccountId: number, symbol: string) => boolean;
} = {}) {
  const now = args.now ?? new Date();
  const candidates = await loadTerminalClaimCandidates({ ...(args.db ? { db: args.db } : {}), tradingAccountIds: args.tradingAccountIds, attemptEvents: true, includePositionAttached: true });
  return candidates.map((candidate) => {
    const intent = candidate.orderIntent;
    const classification = classifyTerminalEntryClaim(candidate, now);
    const { summary, basis, recordsPresent } = classification;
    const brokerExposure = args.brokerExposure?.(candidate.tradingAccountId, candidate.symbol) ?? false;
    const lastAttemptEvent = [...candidate.attemptEvents].reverse().find((event) => ATTEMPT_RESULT_EVENTS[event.eventType]) ?? null;
    const lastAttemptResult = lastAttemptEvent ? ATTEMPT_RESULT_EVENTS[lastAttemptEvent.eventType]! : null;
    const attempted = candidate.lastDiagnosedAt !== null || lastAttemptEvent !== null;
    const nextAttemptDueAt = classification.automatic
      ? new Date(Math.max(now.getTime(), (candidate.lastDiagnosedAt?.getTime() ?? 0) + ENTRY_DISPATCH_RECOVERY_RETRY_MS))
      : null;
    const systemRecovery = classification.automatic
      ? !attempted ? 'AWAITING_FIRST_ATTEMPT'
        : lastAttemptResult === 'TECHNICAL_FAILURE' ? 'TECHNICAL_FAILURE_RETRY_SCHEDULED' : 'RETRY_SCHEDULED'
      : classification.state === 'OPERATOR_INVESTIGATION' ? 'OPERATOR_INVESTIGATION_REQUIRED' : 'PROTECTED_BY_EXPOSURE_WORKFLOW';
    const blockerReason = brokerExposure && classification.state !== 'PROTECTED_EXPOSURE' ? 'BROKER_EXPOSURE_PRESENT' : classification.blocker;
    const operatorRemediation = brokerExposure || classification.state === 'PROTECTED_EXPOSURE'
      ? 'BLOCKED'
      : classification.state === 'OPERATOR_INVESTIGATION'
        ? 'INVESTIGATION_REQUIRED'
        : classification.state === 'AUTOMATIC_VERIFIED_RELEASE' && basis.conclusiveness === 'CONCLUSIVE'
          ? 'ELIGIBLE_AFTER_FRESH_VERIFICATION'
          : 'PENDING';
    return {
      tradingAccountId: candidate.tradingAccountId, securityId: candidate.securityId, symbol: candidate.symbol,
      orderIntentId: intent.id, intentStatus: intent.status, clientOrderId: intent.clientOrderId,
      claimId: candidate.id, claimStatus: candidate.status,
      consumptionId: intent.consumptionId, dispatchDecisionId: intent.dispatchDecisionId, dispatchDecisionOutcome: intent.dispatchDecisionOutcome,
      unenforcedDispatchId: intent.unenforcedDispatchId, unenforcedDispatchBasis: intent.unenforcedDispatchBasis,
      liveArmingConsumed: candidate.liveArmingConsumed,
      dispatchStarted: recordsPresent,
      deliveryEvidence: recordsPresent ? 'DISPATCH_RECORD' : summary.notSent.length ? 'STRUCTURED_NOT_SENT' : summary.outcomes.length ? 'OUTCOME_WITHOUT_DISPATCH_RECORD' : 'NONE',
      recordedDeliveryClassification: summary.outcomes.length ? [...new Set(summary.outcomes.map((outcome) => outcome.classification))].join(',') : null,
      releaseBasis: basis.basis,
      evidenceConclusiveness: summary.outcomes.length || recordsPresent ? basis.conclusiveness : null,
      recoveryState: classification.state,
      automaticRecoveryPossible: classification.automatic,
      recoveryAttempted: attempted,
      lastAttemptAt: candidate.lastDiagnosedAt,
      lastRecoveryResult: lastAttemptEvent ? {
        eventType: lastAttemptEvent.eventType, result: lastAttemptResult, at: lastAttemptEvent.createdAt,
        blockers: ((lastAttemptEvent.evidenceJson ?? {}) as Record<string, unknown>).blockers ?? null,
      } : null,
      nextAttemptDueAt,
      lastDiagnosedAt: candidate.lastDiagnosedAt,
      systemRecovery,
      operatorRemediation,
      blockerReason,
    };
  });
}
