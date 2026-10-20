import type { Prisma, PrismaClient } from '@prisma/client';

// Structured, durable delivery evidence for an entry's EntryExposureClaim (Hermes Phase 3C.3 final
// closure). Every claim-release decision reads these append-only claim events; free text such as
// OrderIntent.blockReason is never the sole basis for releasing ownership.
//
// - NOT_SENT_EVIDENCE_RECORDED: written by the code path that knows no network request was issued
//   (a pre-dispatch failure, a broker-time refusal, or an adapter guard before fetch), atomically with
//   the intent's terminal state and before any release decision.
// - DISPATCH_OUTCOME_RECORDED: a failure after the adapter may have been reached (or an inferred,
//   unknown outcome). OBSERVED outcomes come from the worker that saw the failure; INFERRED outcomes
//   come from stale recovery or the terminal sweep and never claim that a POST did or did not occur.
// - ADAPTER_INVOCATION_STARTED: appended by submitOrderToBroker after the final dispatch
//   authorization and immediately before the adapter is invoked. A claim whose
//   WORKER_CLAIMED_FOR_SUBMISSION event carries ADAPTER_MARKER_V1 and that has no marker provably
//   never invoked the adapter in any attempt (the marker is written first, and a failed write sends
//   nothing); a marker without a later outcome or not-sent record (for example, a crash) is an
//   unknown outcome. This is the claim's own protocol, never an inference from a missing market-policy
//   dispatch record.

type Db = Prisma.TransactionClient | PrismaClient;

export const NOT_SENT_EVIDENCE_EVENT = 'NOT_SENT_EVIDENCE_RECORDED';
export const ADAPTER_INVOCATION_STARTED_EVENT = 'ADAPTER_INVOCATION_STARTED';
export const WORKER_CLAIMED_EVENT = 'WORKER_CLAIMED_FOR_SUBMISSION';
export const ADAPTER_MARKER_PROTOCOL = 'ADAPTER_MARKER_V1';
export const DISPATCH_OUTCOME_EVENT_TYPES = ['DISPATCH_OUTCOME_RECORDED', 'BROKER_DELIVERY_UNCERTAIN'] as const;
export const DELIVERY_EVIDENCE_EVENT_TYPES = [
  ...DISPATCH_OUTCOME_EVENT_TYPES, NOT_SENT_EVIDENCE_EVENT, ADAPTER_INVOCATION_STARTED_EVENT, WORKER_CLAIMED_EVENT,
] as const;

/** Classifications that prove no network request was issued for the claim's intent. */
export const LOCAL_NON_SEND_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'NOT_SENT_PRE_DISPATCH',
  'NOT_SENT_LOCAL_BLOCKED',
  'NOT_SENT_LOCAL_RETRYABLE',
  'NOT_SENT_DISPATCH_RECORD_ACK_LOST',
]);

export type NotSentClassification = 'NOT_SENT_PRE_DISPATCH' | 'NOT_SENT_LOCAL_BLOCKED' | 'NOT_SENT_LOCAL_RETRYABLE';
/** Known producers of proven non-dispatch, so recovery never depends on free-text reasons. */
export type NotSentProducer =
  | 'WORKER_RISK_RECHECK'
  | 'WORKER_PRE_BOUNDARY_FAILURE'
  | 'BROKER_BOUNDARY_NOT_DISPATCHED'
  | 'BROKER_TIME_MARKET_POLICY_REFUSAL'
  | 'ADAPTER_LOCAL_GUARD'
  | 'STALE_RECOVERY_ADAPTER_NOT_INVOKED'
  | 'TERMINAL_SWEEP_ADAPTER_NOT_INVOKED'
  | 'TERMINAL_SWEEP_RISK_EVALUATION_BLOCKED'
  | 'TERMINAL_SWEEP_LEGACY_LOCAL_CLASSIFICATION';
export type AdapterInvocation = 'NOT_INVOKED' | 'LOCAL_GUARD_BEFORE_REQUEST' | 'HTTP_RESPONSE_RECEIVED' | 'UNKNOWN';
export type OutcomeObservation = 'OBSERVED' | 'INFERRED';

export type DeliveryEvidenceEvent = { id: number; eventType: string; evidenceJson: Prisma.JsonValue; createdAt: Date };

export type DeliveryOutcome = {
  eventId: number;
  kind: 'OUTCOME' | 'NOT_SENT' | 'UNPAIRED_ADAPTER_MARKER';
  classification: string;
  statusCode: number | null;
  observation: OutcomeObservation;
  adapterInvocation: AdapterInvocation;
  source: string | null;
  recordedAt: Date;
};

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const record = (value: Prisma.JsonValue) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

function outcomeOf(event: DeliveryEvidenceEvent): DeliveryOutcome {
  const evidence = record(event.evidenceJson);
  if (event.eventType === NOT_SENT_EVIDENCE_EVENT) {
    return {
      eventId: event.id, kind: 'NOT_SENT', classification: String(evidence.classification ?? 'NOT_SENT_PRE_DISPATCH'),
      statusCode: null, observation: 'OBSERVED',
      adapterInvocation: evidence.adapterInvocation === 'LOCAL_GUARD_BEFORE_REQUEST' ? 'LOCAL_GUARD_BEFORE_REQUEST' : 'NOT_INVOKED',
      source: typeof evidence.source === 'string' ? evidence.source : null, recordedAt: event.createdAt,
    };
  }
  const legacyUncertain = event.eventType === 'BROKER_DELIVERY_UNCERTAIN';
  const classification = legacyUncertain ? 'DELIVERY_UNCERTAIN' : String(evidence.classification ?? 'DISPATCH_OUTCOME_UNKNOWN');
  const source = typeof evidence.source === 'string' ? evidence.source : legacyUncertain ? 'WORKER' : null;
  // Events written before the observation field existed: the worker observed its own failure;
  // stale recovery and the sweep only inferred.
  const observation: OutcomeObservation = evidence.observation === 'INFERRED' || evidence.observation === 'OBSERVED'
    ? evidence.observation
    : source === 'WORKER' ? 'OBSERVED' : 'INFERRED';
  const adapterInvocation: AdapterInvocation = typeof evidence.adapterInvocation === 'string'
    ? evidence.adapterInvocation as AdapterInvocation
    : classification === 'BROKER_REJECTED' ? 'HTTP_RESPONSE_RECEIVED'
      : classification === 'NOT_SENT_DISPATCH_RECORD_ACK_LOST' ? 'NOT_INVOKED'
        : classification.startsWith('NOT_SENT_LOCAL') ? 'LOCAL_GUARD_BEFORE_REQUEST' : 'UNKNOWN';
  return {
    eventId: event.id, kind: 'OUTCOME', classification,
    statusCode: typeof evidence.statusCode === 'number' ? evidence.statusCode : null,
    observation, adapterInvocation, source, recordedAt: event.createdAt,
  };
}

/** Pure summary of a claim's delivery evidence events (any order; any superset of event types). */
export function summarizeDeliveryEvidence(events: DeliveryEvidenceEvent[]) {
  const sorted = [...events].sort((left, right) => left.id - right.id);
  const recorded = sorted.filter((event) => (DISPATCH_OUTCOME_EVENT_TYPES as readonly string[]).includes(event.eventType) || event.eventType === NOT_SENT_EVIDENCE_EVENT).map(outcomeOf);
  const markers = sorted.filter((event) => event.eventType === ADAPTER_INVOCATION_STARTED_EVENT);
  // Each adapter invocation must be closed by an outcome or not-sent record from that same attempt
  // (before the next invocation); an unclosed one (for example, a crash) is an unknown outcome.
  const unpaired = markers.filter((marker, index) => {
    const next = markers[index + 1]?.id ?? Number.POSITIVE_INFINITY;
    return !recorded.some((outcome) => outcome.eventId > marker.id && outcome.eventId < next);
  }).map((marker): DeliveryOutcome => ({
    eventId: marker.id, kind: 'UNPAIRED_ADAPTER_MARKER', classification: 'DISPATCH_OUTCOME_UNKNOWN', statusCode: null,
    observation: 'INFERRED', adapterInvocation: 'UNKNOWN', source: 'ADAPTER_INVOCATION_MARKER', recordedAt: marker.createdAt,
  }));
  const outcomes = [...recorded, ...unpaired].sort((left, right) => left.eventId - right.eventId);
  const ambiguous = outcomes.filter((outcome) => !LOCAL_NON_SEND_CLASSIFICATIONS.has(outcome.classification));
  return {
    outcomes,
    notSent: outcomes.filter((outcome) => outcome.kind === 'NOT_SENT'),
    dispatchOutcomes: outcomes.filter((outcome) => outcome.kind !== 'NOT_SENT'),
    ambiguous,
    adapterMarkers: markers.length,
    markerProtocol: sorted.some((event) => event.eventType === WORKER_CLAIMED_EVENT && record(event.evidenceJson).markerProtocol === ADAPTER_MARKER_PROTOCOL),
    /** The worker saw a failure after the adapter may have issued a request. */
    adapterRequestObserved: outcomes.some((outcome) => outcome.observation === 'OBSERVED' && ['HTTP_RESPONSE_RECEIVED', 'UNKNOWN'].includes(outcome.adapterInvocation)),
  };
}
export type DeliveryEvidenceSummary = ReturnType<typeof summarizeDeliveryEvidence>;

const DELIVERY_BLOCK_REASON = /BROKER_WRITE_DELIVERY:(NOT_SENT_RETRYABLE|NOT_SENT_BLOCKED|BROKER_REJECTED|DELIVERY_UNCERTAIN)/;
const UNKNOWN_OUTCOME_BLOCK_REASON = /^(DISPATCH_STARTED_OUTCOME_UNKNOWN|STALE_SUBMISSION_OUTCOME_UNKNOWN)/;

export function blockReasonDeliveryClassification(blockReason: string | null | undefined) {
  return blockReason?.match(DELIVERY_BLOCK_REASON)?.[1] ?? null;
}

/** True when a block reason already carries delivery uncertainty that later text must not replace. */
export function blockReasonCarriesDeliveryUncertainty(blockReason: string | null | undefined) {
  const classification = blockReasonDeliveryClassification(blockReason);
  return classification === 'BROKER_REJECTED' || classification === 'DELIVERY_UNCERTAIN' || UNKNOWN_OUTCOME_BLOCK_REASON.test(blockReason ?? '');
}

/** Keeps stronger existing delivery evidence in the block reason instead of overwriting it. */
export function preserveBlockReason(prior: string | null | undefined, next: string) {
  return blockReasonCarriesDeliveryUncertainty(prior) ? prior! : next;
}

/**
 * Whether the never-submitted release may run for a claim. Only recorded, structured evidence or the
 * claim state machine (an ENTRY_PENDING/ADMISSION_BLOCKED claim can never cross the broker boundary,
 * which requires ENTRY_SUBMITTING) proves non-dispatch. Missing dispatch records never do.
 */
export function evaluateNeverSubmittedRelease(args: { claimStatus: string; summary: DeliveryEvidenceSummary; blockReason: string | null | undefined }) {
  if (args.summary.ambiguous.length) return { proven: false as const, basis: null, blocker: 'DELIVERY_EVIDENCE_AMBIGUOUS' };
  if (blockReasonCarriesDeliveryUncertainty(args.blockReason)) return { proven: false as const, basis: null, blocker: 'BLOCK_REASON_DELIVERY_UNCERTAIN' };
  if (['ENTRY_PENDING', 'ADMISSION_BLOCKED'].includes(args.claimStatus) && args.summary.adapterMarkers === 0) {
    return { proven: true as const, basis: 'CLAIM_NEVER_REACHED_BROKER_BOUNDARY', blocker: null };
  }
  if (args.summary.notSent.length) return { proven: true as const, basis: 'RECORDED_NOT_SENT_EVIDENCE', blocker: null };
  return { proven: false as const, basis: null, blocker: 'NOT_SENT_EVIDENCE_NOT_RECORDED' };
}

/**
 * The adapter-invocation marker. Written in its own statement before the adapter call; if it fails,
 * the adapter is never invoked.
 */
export async function recordAdapterInvocationStarted(db: Db, args: { claimId: number; orderIntentId: number; clientOrderId: string }) {
  return db.entryExposureClaimEvent.create({ data: { claimId: args.claimId, eventType: ADAPTER_INVOCATION_STARTED_EVENT, evidenceJson: json({
    protocol: ADAPTER_MARKER_PROTOCOL, orderIntentId: args.orderIntentId, clientOrderId: args.clientOrderId,
  }) } });
}

export async function loadDeliveryEvidenceEvents(claimId: number, db: Db) {
  return db.entryExposureClaimEvent.findMany({
    where: { claimId, eventType: { in: [...DELIVERY_EVIDENCE_EVENT_TYPES] } },
    select: { id: true, eventType: true, evidenceJson: true, createdAt: true },
    orderBy: { id: 'asc' },
  });
}

/** Appends structured proof that no network request was issued. Caller owns the transaction. */
export async function appendNotSentEvidence(db: Db, args: {
  claimId: number;
  orderIntentId: number;
  classification: NotSentClassification;
  producer: NotSentProducer;
  source: string;
  reason: string;
  message?: string | null;
}) {
  return db.entryExposureClaimEvent.create({ data: { claimId: args.claimId, eventType: NOT_SENT_EVIDENCE_EVENT, evidenceJson: json({
    classification: args.classification, producer: args.producer, source: args.source, orderIntentId: args.orderIntentId,
    adapterInvocation: args.classification === 'NOT_SENT_PRE_DISPATCH' ? 'NOT_INVOKED' : 'LOCAL_GUARD_BEFORE_REQUEST',
    networkRequestIssued: false, reason: args.reason, message: args.message ? args.message.slice(0, 300) : null,
    executionAuthority: 'NONE',
  }) } });
}
