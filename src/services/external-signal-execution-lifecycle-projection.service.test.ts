import { describe, expect, it, vi } from 'vitest';
import {
  EXTERNAL_SIGNAL_EXECUTION_CAPABILITIES,
  classifyExecutionLifecycle,
  classifySourceExecutionLifecycle,
  readinessScope,
  assignmentAuthorityState,
  projectExternalSignalExecutionLifecycle,
} from './external-signal-execution-lifecycle-projection.service.js';

const base = {
  accountCycleStatus: 'ENTRY_INTENT_CREATED', environment: 'PAPER', signalEvent: 'ENTRY_LONG', correlationWorkStatus: 'COMPLETED',
  orderIntentId: 7, orderIntentStatus: 'pending', executionObligationId: 8, marketIntelligenceObligationId: 9,
  exposureClaimId: 10, exposureStatus: 'ENTRY_PENDING', exposureReleasedAt: null, workerClaimId: null, tradingViewConsumptionId: null, marketIntelligenceConsumptionId: null,
};

describe('external signal execution lifecycle classification', () => {
  it('distinguishes source correlation from a completed correlation with no eligible route', () => {
    expect(classifySourceExecutionLifecycle({ entrySignalPresent: true, correlationWorkStatus: 'PENDING', accountCycleCount: 0 })).toMatchObject({ stage: 'CORRELATION_IN_PROGRESS' });
    expect(classifySourceExecutionLifecycle({ entrySignalPresent: true, correlationWorkStatus: 'COMPLETED', accountCycleCount: 0 })).toEqual({ stage: 'NOT_AN_EXECUTION_CANDIDATE', reasonCode: 'NO_ELIGIBLE_ACCOUNT_ROUTE' });
  });
  it('requires durable account-cycle evidence for admission pending', () => {
    expect(classifyExecutionLifecycle({ ...base, accountCycleStatus: 'ENTRY_EXECUTION_PROSPECTIVE', orderIntentId: null, orderIntentStatus: null, executionObligationId: null, marketIntelligenceObligationId: null, exposureClaimId: null, exposureStatus: null })).toMatchObject({ stage: 'ADMISSION_AWAITING_PROCESSING' });
    expect(classifyExecutionLifecycle({ ...base, accountCycleStatus: 'ENTRY_ADMISSION_PENDING', orderIntentId: null, orderIntentStatus: null, executionObligationId: null, marketIntelligenceObligationId: null, exposureClaimId: null, exposureStatus: null })).toMatchObject({ stage: 'NOT_AN_EXECUTION_CANDIDATE' });
    expect(classifySourceExecutionLifecycle({ entrySignalPresent: true, correlationWorkStatus: 'COMPLETED', accountCycleCount: 0 })).not.toMatchObject({ stage: 'ADMISSION_AWAITING_PROCESSING' });
  });
  it('projects a pending marked PAPER BUY separately from C2 ownership', () => {
    expect(classifyExecutionLifecycle(base)).toEqual({ stage: 'PENDING_MARKED_INTENT', reasonCode: 'MARKED_INTENT_AWAITING_C2_OWNERSHIP' });
    expect(classifyExecutionLifecycle({ ...base, orderIntentStatus: 'submitting', workerClaimId: 11 })).toMatchObject({ stage: 'C2_WORKER_CLAIMED' });
  });
  it('labels an atomic pair as authorization only, including after its deadline', () => {
    expect(classifyExecutionLifecycle({ ...base, workerClaimId: 11, tradingViewConsumptionId: 12, marketIntelligenceConsumptionId: 13 }))
      .toEqual({ stage: 'AUTHORIZATION_COMMITTED', reasonCode: 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED' });
  });
  it('fails diagnostic classification closed for incomplete and contradictory evidence', () => {
    expect(classifyExecutionLifecycle({ ...base, marketIntelligenceObligationId: null })).toMatchObject({ stage: 'MISSING_OR_INCONSISTENT_EVIDENCE' });
    expect(classifyExecutionLifecycle({ ...base, tradingViewConsumptionId: 12 })).toEqual({ stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'ATOMIC_AUTHORIZATION_PAIR_INCOMPLETE' });
  });
  it.each([['LIVE', 'ENTRY_LONG'], ['PAPER', 'EXIT_LONG']] as const)('never classifies %s/%s as an execution candidate', (environment, signalEvent) => {
    expect(classifyExecutionLifecycle({ ...base, environment, signalEvent })).toMatchObject({ stage: 'NOT_AN_EXECUTION_CANDIDATE' });
  });
  it('classifies blocked and released terminal work without treating it as pending', () => {
    expect(classifyExecutionLifecycle({ ...base, orderIntentStatus: 'blocked', workerClaimId: 11, exposureStatus: 'RELEASED', exposureReleasedAt: new Date() })).toMatchObject({ stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED' });
    expect(classifyExecutionLifecycle({ ...base, accountCycleStatus: 'TERMINAL_NO_EXPOSURE', orderIntentId: null, orderIntentStatus: null, executionObligationId: null, marketIntelligenceObligationId: null, exposureClaimId: null, exposureStatus: null })).toMatchObject({ stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED' });
    expect(classifyExecutionLifecycle({ ...base, orderIntentStatus: 'accepted', workerClaimId: null })).toMatchObject({ stage: 'POST_SUBMISSION_BROKER_LIFECYCLE' });
    expect(classifyExecutionLifecycle({ ...base, orderIntentStatus: 'submitting', workerClaimId: null })).toMatchObject({ stage: 'MISSING_OR_INCONSISTENT_EVIDENCE' });
    expect(classifyExecutionLifecycle({ ...base, tradingViewConsumptionId: 12, marketIntelligenceConsumptionId: 13, exposureStatus: 'RELEASED', exposureReleasedAt: new Date() })).toEqual({ stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'AUTHORIZATION_COMMITTED_WITH_RELEASED_EXPOSURE' });
  });
  it('fails closed for terminal work retaining exposure, terminal authorization, and nonterminal released exposure', () => {
    expect(classifyExecutionLifecycle({ ...base, orderIntentStatus: 'blocked', workerClaimId: 11, exposureStatus: 'ENTRY_SUBMITTING' }))
      .toEqual({ stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'TERMINAL_LIFECYCLE_WITH_RETAINED_EXPOSURE' });
    expect(classifyExecutionLifecycle({ ...base, orderIntentStatus: 'failed', exposureStatus: 'UNRESOLVED' }))
      .toEqual({ stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'TERMINAL_LIFECYCLE_WITH_UNRESOLVED_EXPOSURE' });
    expect(classifyExecutionLifecycle({ ...base, orderIntentStatus: 'blocked', tradingViewConsumptionId: 12, marketIntelligenceConsumptionId: 13 }))
      .toEqual({ stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'TERMINAL_LIFECYCLE_WITH_AUTHORIZATION_COMMITTED' });
    expect(classifyExecutionLifecycle({ ...base, exposureStatus: 'RELEASED', exposureReleasedAt: new Date() }))
      .toEqual({ stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'NONTERMINAL_LIFECYCLE_WITH_RELEASED_EXPOSURE' });
    expect(classifyExecutionLifecycle({ ...base, accountCycleStatus: 'BLOCKED', orderIntentId: null, orderIntentStatus: null, executionObligationId: null, marketIntelligenceObligationId: null, exposureClaimId: null, exposureStatus: null }))
      .toEqual({ stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED', reasonCode: 'ACCOUNT_CYCLE_BLOCKED' });
  });
});

describe('external signal execution lifecycle read boundary', () => {
  it('returns immutable pre-C3C capabilities and performs only bounded reads for an empty cycle', async () => {
    const query = vi.fn().mockResolvedValueOnce([{ observedAt: new Date('2026-11-04T18:00:00Z') }]);
    const db = { $queryRaw: query } as never;
    const result = await projectExternalSignalExecutionLifecycle(4, [], db);
    expect(result).toMatchObject({ capabilities: EXTERNAL_SIGNAL_EXECUTION_CAPABILITIES, accountCycles: [], readinessMayChangeAfterObservation: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(Object.keys(db)).toEqual(['$queryRaw']);
  });
  it('does not import or invoke either executable C2 lifecycle entry point', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./external-signal-execution-lifecycle-projection.service.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/from ['"].*external-signal-broker-worker/);
    expect(source).not.toContain('finalizeTradingViewDispatch(');
    expect(source).not.toContain('processTradingViewOrderIntentForC2(');
  });
  it('keeps authorization, broker evidence, retained exposure, historical receipt and attention independent', async () => {
    const core = {
      accountCycleId: 20, accountCycleStatus: 'ENTRY_INTENT_CREATED', environment: 'PAPER', signalEvent: 'ENTRY_LONG', correlationWorkStatus: 'COMPLETED',
      orderIntentId: 7, orderIntentStatus: 'submitting', orderIntentSide: 'buy', executionObligationId: 8, marketIntelligenceObligationId: 9,
      exposureClaimId: 10, exposureStatus: 'UNRESOLVED', exposureReleasedAt: null, workerClaimId: 11,
      tradingViewConsumptionId: 12, marketIntelligenceConsumptionId: 13, authorizationDeadlineStatus: 'EXPIRED',
      signalReceivedAt: null, receiptFreshness: 'HISTORICAL_NULL_RECEIPT', effectiveFrozenAssignmentAuthority: false,
      accountOperational: false, assignmentOperational: false,
    };
    const attention = { accountCycleId: 20, id: 17, status: 'OPEN', resolutionPolicy: 'AUTHORITATIVE_ONLY', totalCount: 101n, activeCount: 1n, authoritativeOnlyCount: 1n };
    const released = { ...core, accountCycleId: 21, accountCycleStatus: 'TERMINAL_NO_EXPOSURE', orderIntentStatus: 'blocked', workerClaimId: null, tradingViewConsumptionId: null, marketIntelligenceConsumptionId: null, authorizationDeadlineStatus: 'NOT_COMMITTED', exposureStatus: 'RELEASED', exposureReleasedAt: new Date('2026-11-04T17:58:00Z') };
    const query = vi.fn()
      .mockResolvedValueOnce([{ observedAt: new Date('2026-11-04T18:00:00Z') }])
      .mockResolvedValueOnce([core, released])
      .mockResolvedValueOnce([{ accountCycleId: 20, id: 14, eventType: 'DISPATCH_OUTCOME_RECORDED', createdAt: new Date('2026-11-04T17:59:00Z') }])
      .mockResolvedValueOnce([{ accountCycleId: 20, id: 15, brokerOrderId: 'broker-1', status: 'accepted' }])
      .mockResolvedValueOnce([{ accountCycleId: 20, id: 16, activityId: 'activity-1', activityType: 'FILL' }])
      .mockResolvedValueOnce([attention]);
    const result = await projectExternalSignalExecutionLifecycle(4, [20, 21], { $queryRaw: query } as never);
    const projected = result.accountCycles[0]!;
    expect(projected.lifecycle).toEqual({ stage: 'AUTHORIZATION_COMMITTED', reasonCode: 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED' });
    expect(projected.readiness).toMatchObject({ receipt: { receivedAt: null, freshness: 'HISTORICAL_NULL_RECEIPT' }, effectiveAssignmentAuthority: false, accountOperational: false, authorizationDeadlineStatus: 'EXPIRED' });
    expect(projected.evidence).toMatchObject({ authorization: { pairPresent: true, expired: true, status: 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED' }, brokerSendPermissionEstablished: false, exposure: { held: true }, broker: { orderEvidencePresent: true, activityEvidencePresent: true } });
    expect(projected.recovery).toMatchObject({ authoritativeReconciliationRequired: true, unresolvedAuthoritativeOnlyCount: 1, activeAttentionCount: 1, activeOperationalAttention: [{ id: 17 }], operationalAttentionMetadata: { returned: 1, total: 101, truncated: true } });
    expect(result.accountCycles[1]).toMatchObject({ lifecycle: { stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED' }, evidence: { exposure: { held: false, status: 'RELEASED' } } });
    expect(query).toHaveBeenCalledTimes(6);
  });
  it('LOW-1: retained exposure reason is derived from exposure state even when a committed pair coexists', async () => {
    const base = { accountCycleId: 30, accountCycleStatus: 'TERMINAL_NO_EXPOSURE', environment: 'PAPER', signalEvent: 'ENTRY_LONG', correlationWorkStatus: 'COMPLETED', orderIntentId: 7, orderIntentStatus: 'blocked', orderIntentSide: 'buy', executionObligationId: 8, marketIntelligenceObligationId: 9, exposureClaimId: 10, exposureReleasedAt: null, workerClaimId: 11, tradingViewConsumptionId: 12, marketIntelligenceConsumptionId: 13 };
    const run = async (rows: Record<string, unknown>[]) => projectExternalSignalExecutionLifecycle(4, rows.map(row => row.accountCycleId as number), { $queryRaw: vi.fn().mockResolvedValueOnce([{ observedAt: new Date() }]).mockResolvedValueOnce(rows).mockResolvedValue([]) } as never);
    const result = await run([{ ...base, exposureStatus: 'UNRESOLVED' }, { ...base, accountCycleId: 31, exposureStatus: 'HELD' }]);
    expect(result.accountCycles[0]!.lifecycle.reasonCode).toBe('TERMINAL_LIFECYCLE_WITH_AUTHORIZATION_COMMITTED');
    expect(result.accountCycles[0]!.recovery).toMatchObject({ retainedExposureReviewRequired: true, retainedExposureReasonCode: 'TERMINAL_LIFECYCLE_WITH_UNRESOLVED_EXPOSURE' });
    expect(result.accountCycles[1]!.recovery).toMatchObject({ retainedExposureReviewRequired: true, retainedExposureReasonCode: 'TERMINAL_LIFECYCLE_WITH_RETAINED_EXPOSURE' });
    const released = await run([{ ...base, exposureStatus: 'RELEASED', exposureReleasedAt: new Date() }]);
    expect(released.accountCycles[0]!.recovery).toMatchObject({ retainedExposureReviewRequired: false, retainedExposureReasonCode: null });
  });
  it('LOW-2: readiness scope never defaults a missing intent to PAPER BUY', () => {
    expect(readinessScope('PAPER', null, null)).toBe('NOT_APPLICABLE_NO_INTENT');
    expect(readinessScope('PAPER', null, 'buy')).toBe('NOT_APPLICABLE_NO_INTENT');
    expect(readinessScope('PAPER', 7, 'BUY')).toBe('PAPER_BUY');
    expect(readinessScope('PAPER', 7, 'sell')).toBe('OUT_OF_SCOPE');
    expect(readinessScope('PAPER', 7, null)).toBe('OUT_OF_SCOPE');
    expect(readinessScope('LIVE', 7, 'buy')).toBe('OUT_OF_SCOPE');
  });
  it('distinguishes not-yet-frozen authority from frozen-but-ineffective, diagnostically only', () => {
    expect(assignmentAuthorityState(null, false)).toBe('NOT_YET_FROZEN');
    expect(assignmentAuthorityState(null, true)).toBe('NOT_YET_FROZEN');
    expect(assignmentAuthorityState(5, false)).toBe('FROZEN_NOT_EFFECTIVE');
    expect(assignmentAuthorityState(5, null)).toBe('FROZEN_NOT_EFFECTIVE');
    expect(assignmentAuthorityState(5, true)).toBe('FROZEN_EFFECTIVE');
  });
});
