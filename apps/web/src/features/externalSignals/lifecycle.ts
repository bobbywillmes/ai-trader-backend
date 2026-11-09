import type { AccountCycleLifecycle, ExecutionLifecycle, ExecutionLifecycleStage, TruncationMetadata } from './types';

type Rec = Record<string, unknown>;
const rec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: Rec, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const str = (value: unknown) => typeof value === 'string';
const bool = (value: unknown) => typeof value === 'boolean';
const nilStr = (value: unknown) => value === null || str(value);
const nilDate = (value: unknown) => value === null || str(value) && !Number.isNaN(Date.parse(value));
const nilNum = (value: unknown) => value === null || num(value);
const oneOf = (value: unknown, accepted: readonly string[]) => str(value) && accepted.includes(value);
const id = (value: unknown) => num(value) || str(value);
const metadata = (value: unknown): value is TruncationMetadata => rec(value) && num(value.returned) && num(value.total) && bool(value.truncated);
const nullable = (parent: Rec, key: string, validate: (value: Rec) => boolean) => own(parent, key) && (parent[key] === null || rec(parent[key]) && validate(parent[key]));
const arrayOf = (value: unknown, validate: (item: unknown) => boolean) => Array.isArray(value) && value.every(validate);

const lifecycleStages = ['CORRELATION_IN_PROGRESS', 'ADMISSION_AWAITING_PROCESSING', 'PENDING_MARKED_INTENT', 'C2_WORKER_CLAIMED', 'AUTHORIZATION_COMMITTED', 'POST_SUBMISSION_BROKER_LIFECYCLE', 'BLOCKED_EXPIRED_OR_TERMINALIZED', 'NOT_AN_EXECUTION_CANDIDATE', 'MISSING_OR_INCONSISTENT_EVIDENCE'] as const;
const sourceStages = ['NOT_AN_EXECUTION_CANDIDATE', 'CORRELATION_IN_PROGRESS', 'ACCOUNT_LIFECYCLES_PROJECTED'] as const;
const scopes = ['PAPER_BUY', 'NOT_APPLICABLE_NO_INTENT', 'OUT_OF_SCOPE'] as const;
const authorityStates = ['NOT_YET_FROZEN', 'FROZEN_EFFECTIVE', 'FROZEN_NOT_EFFECTIVE'] as const;
const deadlineStates = ['NOT_COMMITTED', 'OPEN', 'EXPIRED'] as const;
const receiptFreshness = ['FRESH', 'EXPIRED', 'HISTORICAL_NULL_RECEIPT', 'MISSING'] as const;

const validObligation = (v: Rec) => num(v.id) && nilStr(v.createdAt) && nilStr(v.executionEpochAt) && nilNum(v.authorizationId) && nilNum(v.rolloutGenerationId);
const validMarketObligation = (v: Rec) => num(v.id) && nilStr(v.frozenAt) && nilStr(v.validUntil);
const validIntent = (v: Rec) => num(v.id) && str(v.status) && nilStr(v.clientOrderId) && nilStr(v.createdAt) && nilStr(v.updatedAt) && nilStr(v.blockReason);
const validExposure = (v: Rec) => num(v.id) && str(v.status) && nilDate(v.acquiredAt) && nilDate(v.releasedAt) && nilStr(v.releaseReason) && bool(v.held)
  && !(v.held === false && v.releasedAt === null) && !(v.held === true && v.status === 'RELEASED');
const validClaim = (v: Rec) => num(v.id) && nilStr(v.claimedAt) && nilNum(v.dispatchStateVersion);
const validTvConsumption = (v: Rec) => num(v.id) && nilStr(v.authorizedAt) && nilStr(v.deadlineAt) && nilStr(v.consumedAt);
const validMiConsumption = (v: Rec) => num(v.id) && nilStr(v.consumedAt);
const validExposureEvent = (v: unknown) => rec(v) && id(v.id) && str(v.eventType) && nilStr(v.createdAt);
const validOrder = (v: unknown) => rec(v) && id(v.id) && nilStr(v.brokerOrderId) && nilStr(v.clientOrderId) && nilStr(v.side) && nilStr(v.status) && nilStr(v.createdAt) && nilStr(v.updatedAt);
const validActivity = (v: unknown) => rec(v) && id(v.id) && nilStr(v.activityId) && nilStr(v.activityType) && nilStr(v.activityCategory) && nilStr(v.orderId) && nilStr(v.transactionTime) && nilStr(v.createdAt);
const validAttention = (v: unknown) => rec(v) && id(v.id) && nilStr(v.code) && nilStr(v.source) && str(v.status) && nilStr(v.severity) && nilStr(v.title) && nilStr(v.resolutionPolicy) && nilStr(v.firstObservedAt) && nilStr(v.lastObservedAt) && nilStr(v.resolvedAt);

function validAccountCycle(value: unknown): value is AccountCycleLifecycle {
  if (!rec(value) || !num(value.accountCycleId) || !rec(value.lifecycle) || !oneOf(value.lifecycle.stage, lifecycleStages) || !str(value.lifecycle.reasonCode)) return false;
  const { readiness, evidence, recovery } = value;
  if (!rec(readiness) || !oneOf(readiness.scope, scopes) || !rec(readiness.frozenGeneration) || !rec(readiness.rolloutRelationship) || !rec(readiness.executionState) || !rec(readiness.dispatchState) || !rec(readiness.receipt)) return false;
  const frozen = readiness.frozenGeneration, rollout = readiness.rolloutRelationship, execution = readiness.executionState, dispatch = readiness.dispatchState, receipt = readiness.receipt;
  if (!nilNum(frozen.id) || !nilNum(frozen.generation) || !(frozen.enabled === null || bool(frozen.enabled)) || !nilStr(frozen.authorityMode) || !nilStr(frozen.effectiveAt)) return false;
  if (!nilNum(rollout.activeExecutionGenerationId) || !nilNum(rollout.activeDispatchGenerationId) || !bool(rollout.matchesExecution) || !bool(rollout.matchesDispatch)) return false;
  if (!nilNum(execution.version) || !nilStr(execution.activatedAt) || !nilNum(dispatch.version) || !nilStr(dispatch.activatedAt)) return false;
  if (!bool(readiness.effectiveAssignmentAuthority) || own(readiness, 'assignmentAuthorityState') && !oneOf(readiness.assignmentAuthorityState, authorityStates) || !bool(readiness.accountOperational) || !bool(readiness.assignmentOperational) || !bool(readiness.c2WorkerClaimPresent) || !oneOf(readiness.authorizationDeadlineStatus, deadlineStates)) return false;
  if (!nilNum(receipt.signalId) || !nilStr(receipt.receivedAt) || !oneOf(receipt.freshness, receiptFreshness)) return false;

  if (!rec(evidence) || !nullable(evidence, 'executionObligation', validObligation) || !nullable(evidence, 'marketIntelligenceObligation', validMarketObligation) || !nullable(evidence, 'orderIntent', validIntent) || !nullable(evidence, 'exposure', validExposure) || !nullable(evidence, 'workerClaim', validClaim)) return false;
  if ((evidence.workerClaim !== null) !== readiness.c2WorkerClaimPresent || !rec(evidence.authorization) || !bool(evidence.brokerSendPermissionEstablished) || !rec(evidence.broker)) return false;
  const authorization = evidence.authorization, broker = evidence.broker;
  if (!bool(authorization.pairPresent) || !str(authorization.status) || !bool(authorization.expired) || !nullable(authorization, 'tradingViewConsumption', validTvConsumption) || !nullable(authorization, 'marketIntelligenceConsumption', validMiConsumption)) return false;
  const consumptionCount = Number(authorization.tradingViewConsumption !== null) + Number(authorization.marketIntelligenceConsumption !== null);
  if (authorization.pairPresent !== (consumptionCount === 2)) return false;
  if (value.lifecycle.stage === 'AUTHORIZATION_COMMITTED' && !authorization.pairPresent) return false;
  if (authorization.expired && readiness.authorizationDeadlineStatus !== 'EXPIRED') return false;
  if (broker.attributionProvenance !== 'DIRECT_LINKED_EVIDENCE_ONLY_PRE_C3C' || !bool(broker.absenceIsAuthoritativeNonDeliveryProof) || !bool(broker.orderEvidencePresent) || !bool(broker.activityEvidencePresent) || !arrayOf(broker.orders, validOrder) || !metadata(broker.ordersMetadata) || !arrayOf(broker.activities, validActivity) || !metadata(broker.activitiesMetadata)) return false;
  if (!arrayOf(evidence.exposureEvents, validExposureEvent) || !metadata(evidence.exposureEventsMetadata)) return false;

  if (!rec(recovery) || !bool(recovery.retainedExposureReviewRequired) || !nilStr(recovery.retainedExposureReasonCode) || !bool(recovery.authoritativeReconciliationRequired) || !num(recovery.unresolvedAuthoritativeOnlyCount) || !num(recovery.activeAttentionCount)) return false;
  return arrayOf(recovery.activeOperationalAttention, validAttention) && metadata(recovery.activeOperationalAttentionMetadata) && arrayOf(recovery.operationalAttention, validAttention) && metadata(recovery.operationalAttentionMetadata);
}

export type LifecycleParse = { status: 'absent' } | { status: 'invalid'; reason: string } | { status: 'ok'; value: ExecutionLifecycle };
/** Runtime shape check for the accepted C3B.3-1 projection; no cast is trusted without it. */
export function parseExecutionLifecycle(value: unknown): LifecycleParse {
  if (value === undefined || value === null) return { status: 'absent' };
  if (!rec(value) || !str(value.observedAt) || !bool(value.readinessMayChangeAfterObservation) || !rec(value.capabilities) || !Array.isArray(value.accountCycles)) return { status: 'invalid', reason: 'Lifecycle envelope is malformed.' };
  const capabilities = value.capabilities;
  if (capabilities.finalizationScheduling !== 'HARD_DISABLED_PRE_C3C' || capabilities.brokerPost !== 'UNAVAILABLE_PRE_C3C' || capabilities.tradingViewSellExecution !== 'UNAVAILABLE' || capabilities.tradingViewLiveExecution !== 'UNAVAILABLE') return { status: 'invalid', reason: 'Lifecycle capabilities are malformed.' };
  if (own(value, 'sourceLifecycle') && value.sourceLifecycle !== undefined && (!rec(value.sourceLifecycle) || !oneOf(value.sourceLifecycle.stage, sourceStages) || !str(value.sourceLifecycle.reasonCode))) return { status: 'invalid', reason: 'Source lifecycle is malformed.' };
  const index = value.accountCycles.findIndex(item => !validAccountCycle(item));
  if (index >= 0) return { status: 'invalid', reason: `Lifecycle entry ${index + 1} is malformed.` };
  return { status: 'ok', value: value as unknown as ExecutionLifecycle };
}

/** Matches strictly by accountCycleId; never by position or symbol. Duplicate ids are surfaced, not guessed. */
export function matchLifecycles(accountCycleIds: number[], lifecycle: ExecutionLifecycle) {
  const byId = new Map<number, AccountCycleLifecycle[]>();
  for (const item of lifecycle.accountCycles) byId.set(item.accountCycleId, [...(byId.get(item.accountCycleId) ?? []), item]);
  const known = new Set(accountCycleIds);
  return { byId, unmatched: lifecycle.accountCycles.filter(item => !known.has(item.accountCycleId)) };
}

export const stageLabels: Record<ExecutionLifecycleStage, string> = {
  CORRELATION_IN_PROGRESS: 'Correlation in progress', ADMISSION_AWAITING_PROCESSING: 'Admission awaiting processing', PENDING_MARKED_INTENT: 'Pending marked intent (awaiting C2 ownership)', C2_WORKER_CLAIMED: 'C2 worker claimed', AUTHORIZATION_COMMITTED: 'Authorization committed', POST_SUBMISSION_BROKER_LIFECYCLE: 'Post-submission broker lifecycle', BLOCKED_EXPIRED_OR_TERMINALIZED: 'Blocked, expired or terminalized', NOT_AN_EXECUTION_CANDIDATE: 'Not an execution candidate', MISSING_OR_INCONSISTENT_EVIDENCE: 'Missing or inconsistent evidence',
};
export const stageColors: Record<ExecutionLifecycleStage, string> = {
  CORRELATION_IN_PROGRESS: 'gray', ADMISSION_AWAITING_PROCESSING: 'blue', PENDING_MARKED_INTENT: 'blue', C2_WORKER_CLAIMED: 'indigo', AUTHORIZATION_COMMITTED: 'violet', POST_SUBMISSION_BROKER_LIFECYCLE: 'teal', BLOCKED_EXPIRED_OR_TERMINALIZED: 'gray', NOT_AN_EXECUTION_CANDIDATE: 'gray', MISSING_OR_INCONSISTENT_EVIDENCE: 'red',
};
export const stageLabel = (stage: string) => stageLabels[stage as ExecutionLifecycleStage] ?? stage;
export const stageColor = (stage: string) => stageColors[stage as ExecutionLifecycleStage] ?? 'gray';

/** "Not applicable" vs "not yet created" for absent evidence. */
export function absence(stage: string): 'Not applicable' | 'Not yet created' | 'Not recorded' {
  if (stage === 'NOT_AN_EXECUTION_CANDIDATE') return 'Not applicable';
  if (['CORRELATION_IN_PROGRESS', 'ADMISSION_AWAITING_PROCESSING', 'PENDING_MARKED_INTENT', 'C2_WORKER_CLAIMED', 'AUTHORIZATION_COMMITTED'].includes(stage)) return 'Not yet created';
  return 'Not recorded';
}
export const truncationNotice = (meta: TruncationMetadata) => meta.truncated ? `Showing ${meta.returned} of ${meta.total} records.` : `${meta.total} record${meta.total === 1 ? '' : 's'}.`;
