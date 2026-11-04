import type { AccountCycleLifecycle, ExecutionLifecycle, ExecutionLifecycleStage, TruncationMetadata } from './types';

type Rec = Record<string, unknown>;
const rec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const metadata = (value: unknown): value is TruncationMetadata => rec(value) && num(value.returned) && num(value.total) && typeof value.truncated === 'boolean';
const records = (value: unknown) => Array.isArray(value) && value.every(item => rec(item) && (num(item.id) || typeof item.id === 'string'));

function validAccountCycle(value: unknown): value is AccountCycleLifecycle {
  if (!rec(value) || !num(value.accountCycleId)) return false;
  const { lifecycle, readiness, evidence, recovery } = value;
  if (!rec(lifecycle) || typeof lifecycle.stage !== 'string' || typeof lifecycle.reasonCode !== 'string') return false;
  if (!rec(readiness) || typeof readiness.scope !== 'string' || !rec(readiness.frozenGeneration) || !rec(readiness.rolloutRelationship) || !rec(readiness.executionState) || !rec(readiness.dispatchState) || !rec(readiness.receipt) || typeof readiness.authorizationDeadlineStatus !== 'string') return false;
  if (!rec(evidence) || !rec(evidence.authorization) || typeof evidence.authorization.pairPresent !== 'boolean' || !rec(evidence.broker)) return false;
  if (typeof evidence.brokerSendPermissionEstablished !== 'boolean') return false;
  const broker = evidence.broker;
  if (!records(broker.orders) || !records(broker.activities) || !metadata(broker.ordersMetadata) || !metadata(broker.activitiesMetadata)) return false;
  if (!records(evidence.exposureEvents) || !metadata(evidence.exposureEventsMetadata)) return false;
  if (!rec(recovery) || typeof recovery.retainedExposureReviewRequired !== 'boolean' || typeof recovery.authoritativeReconciliationRequired !== 'boolean' || !num(recovery.unresolvedAuthoritativeOnlyCount) || !num(recovery.activeAttentionCount)) return false;
  return records(recovery.activeOperationalAttention) && records(recovery.operationalAttention) && metadata(recovery.activeOperationalAttentionMetadata) && metadata(recovery.operationalAttentionMetadata);
}

export type LifecycleParse = { status: 'absent' } | { status: 'invalid'; reason: string } | { status: 'ok'; value: ExecutionLifecycle };
/** Runtime shape check for the accepted C3B.3-1 projection; no cast is trusted without it. */
export function parseExecutionLifecycle(value: unknown): LifecycleParse {
  if (value === undefined || value === null) return { status: 'absent' };
  if (!rec(value) || typeof value.observedAt !== 'string' || !rec(value.capabilities) || !Array.isArray(value.accountCycles)) return { status: 'invalid', reason: 'Lifecycle envelope is malformed.' };
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
  CORRELATION_IN_PROGRESS: 'Correlation in progress',
  ADMISSION_AWAITING_PROCESSING: 'Admission awaiting processing',
  PENDING_MARKED_INTENT: 'Pending marked intent (awaiting C2 ownership)',
  C2_WORKER_CLAIMED: 'C2 worker claimed',
  AUTHORIZATION_COMMITTED: 'Authorization committed',
  POST_SUBMISSION_BROKER_LIFECYCLE: 'Post-submission broker lifecycle',
  BLOCKED_EXPIRED_OR_TERMINALIZED: 'Blocked, expired or terminalized',
  NOT_AN_EXECUTION_CANDIDATE: 'Not an execution candidate',
  MISSING_OR_INCONSISTENT_EVIDENCE: 'Missing or inconsistent evidence',
};
export const stageColors: Record<ExecutionLifecycleStage, string> = {
  CORRELATION_IN_PROGRESS: 'gray', ADMISSION_AWAITING_PROCESSING: 'blue', PENDING_MARKED_INTENT: 'blue', C2_WORKER_CLAIMED: 'indigo',
  AUTHORIZATION_COMMITTED: 'violet', POST_SUBMISSION_BROKER_LIFECYCLE: 'teal', BLOCKED_EXPIRED_OR_TERMINALIZED: 'gray',
  NOT_AN_EXECUTION_CANDIDATE: 'gray', MISSING_OR_INCONSISTENT_EVIDENCE: 'red',
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
