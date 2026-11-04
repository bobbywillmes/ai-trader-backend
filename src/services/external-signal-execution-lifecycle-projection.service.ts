import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

type Db = typeof prisma;

export const EXTERNAL_SIGNAL_EXECUTION_CAPABILITIES = Object.freeze({
  finalizationScheduling: 'HARD_DISABLED_PRE_C3C',
  brokerPost: 'UNAVAILABLE_PRE_C3C',
  tradingViewSellExecution: 'UNAVAILABLE',
  tradingViewLiveExecution: 'UNAVAILABLE',
} as const);

export type ExecutionLifecycleStage =
  | 'CORRELATION_IN_PROGRESS'
  | 'ADMISSION_AWAITING_PROCESSING'
  | 'PENDING_MARKED_INTENT'
  | 'C2_WORKER_CLAIMED'
  | 'AUTHORIZATION_COMMITTED'
  | 'POST_SUBMISSION_BROKER_LIFECYCLE'
  | 'BLOCKED_EXPIRED_OR_TERMINALIZED'
  | 'NOT_AN_EXECUTION_CANDIDATE'
  | 'MISSING_OR_INCONSISTENT_EVIDENCE';

export type LifecycleClassificationInput = {
  accountCycleStatus: string;
  environment: string;
  signalEvent: string | null;
  correlationWorkStatus: string | null;
  orderIntentId: number | null;
  orderIntentStatus: string | null;
  executionObligationId: number | null;
  marketIntelligenceObligationId: number | null;
  exposureClaimId: number | null;
  exposureStatus: string | null;
  exposureReleasedAt: Date | string | null;
  workerClaimId: number | null;
  tradingViewConsumptionId: number | null;
  marketIntelligenceConsumptionId: number | null;
};

export function classifySourceExecutionLifecycle(input: { entrySignalPresent: boolean; correlationWorkStatus: string | null; accountCycleCount: number }) {
  if (!input.entrySignalPresent) return { stage: 'NOT_AN_EXECUTION_CANDIDATE' as const, reasonCode: 'NO_ENTRY_SIGNAL' };
  if (input.correlationWorkStatus !== 'COMPLETED') return { stage: 'CORRELATION_IN_PROGRESS' as const, reasonCode: `CORRELATION_${input.correlationWorkStatus ?? 'WORK_MISSING'}` };
  if (input.accountCycleCount === 0) return { stage: 'NOT_AN_EXECUTION_CANDIDATE' as const, reasonCode: 'NO_ELIGIBLE_ACCOUNT_ROUTE' };
  return { stage: 'ACCOUNT_LIFECYCLES_PROJECTED' as const, reasonCode: 'SEE_ACCOUNT_CYCLES' };
}

export function classifyExecutionLifecycle(input: LifecycleClassificationInput): { stage: ExecutionLifecycleStage; reasonCode: string } {
  if (input.environment !== 'PAPER' || input.signalEvent !== 'ENTRY_LONG') return { stage: 'NOT_AN_EXECUTION_CANDIDATE', reasonCode: input.environment !== 'PAPER' ? 'NON_PAPER_ACCOUNT' : 'NON_ENTRY_SIGNAL' };
  if (input.correlationWorkStatus && input.correlationWorkStatus !== 'COMPLETED') return { stage: 'CORRELATION_IN_PROGRESS', reasonCode: `CORRELATION_${input.correlationWorkStatus}` };
  const pairCount = Number(input.tradingViewConsumptionId != null) + Number(input.marketIntelligenceConsumptionId != null);
  if (pairCount === 1) return { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'ATOMIC_AUTHORIZATION_PAIR_INCOMPLETE' };
  const exposureReleased = input.exposureReleasedAt != null || input.exposureStatus === 'RELEASED';
  if (pairCount === 2 && exposureReleased) return { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'AUTHORIZATION_COMMITTED_WITH_RELEASED_EXPOSURE' };
  if (input.workerClaimId != null && input.orderIntentId == null) return { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'WORKER_CLAIM_WITHOUT_INTENT' };
  if (input.orderIntentId != null && ['blocked', 'failed', 'canceled'].includes(input.orderIntentStatus ?? '')) return { stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED', reasonCode: `ORDER_INTENT_${input.orderIntentStatus!.toUpperCase()}` };
  if (exposureReleased || ['BLOCKED', 'TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED'].includes(input.accountCycleStatus)) return { stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED', reasonCode: exposureReleased ? 'EXPOSURE_RELEASED' : `ACCOUNT_CYCLE_${input.accountCycleStatus}` };
  if (input.orderIntentId != null && ['submitted', 'accepted', 'partially_filled', 'filled'].includes(input.orderIntentStatus ?? '')) return { stage: 'POST_SUBMISSION_BROKER_LIFECYCLE', reasonCode: `ORDER_INTENT_${input.orderIntentStatus!.toUpperCase()}` };
  if (input.orderIntentId != null && (!input.executionObligationId || !input.marketIntelligenceObligationId || !input.exposureClaimId)) return { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'MARKED_INTENT_REQUIRED_EVIDENCE_INCOMPLETE' };
  if (pairCount === 2) return { stage: 'AUTHORIZATION_COMMITTED', reasonCode: 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED' };
  if (input.workerClaimId != null && input.orderIntentStatus === 'submitting' && !exposureReleased) return { stage: 'C2_WORKER_CLAIMED', reasonCode: 'ACTIVE_C2_OWNERSHIP' };
  if (input.orderIntentStatus === 'submitting') return { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'SUBMITTING_WITHOUT_ACTIVE_C2_OWNERSHIP' };
  if (input.orderIntentId != null && ['received', 'pending'].includes(input.orderIntentStatus ?? '')) return { stage: 'PENDING_MARKED_INTENT', reasonCode: 'MARKED_INTENT_AWAITING_C2_OWNERSHIP' };
  if (input.orderIntentId != null) return { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'UNSUPPORTED_ORDER_INTENT_STATUS' };
  if (input.accountCycleStatus === 'ENTRY_EXECUTION_PROSPECTIVE') return { stage: 'ADMISSION_AWAITING_PROCESSING', reasonCode: 'DURABLE_EXECUTION_PROSPECTIVE_ADMISSION' };
  if (['ENTRY_ADMISSION_PENDING', 'ENTRY_SHADOW_ALLOWED', 'ENTRY_SUPPRESSED_BY_EXIT', 'ENTRY_ROUTE_PENDING', 'EXIT_PENDING'].includes(input.accountCycleStatus)) return { stage: 'NOT_AN_EXECUTION_CANDIDATE', reasonCode: input.accountCycleStatus };
  return { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'EXECUTION_PROSPECTIVE_EVIDENCE_MISSING' };
}

type CoreRow = Record<string, unknown> & { accountCycleId: number; environment: string; accountCycleStatus: string };
type RelatedRow = Record<string, unknown> & { accountCycleId: number; totalCount?: bigint | number; activeCount?: bigint | number; authoritativeOnlyCount?: bigint | number };

const dateIso = (value: unknown) => value instanceof Date ? value.toISOString() : value;
const presentRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, dateIso(value)]));

export async function projectExternalSignalExecutionLifecycle(sourceCycleId: number, accountCycleIds: number[], db: Db = prisma) {
  const [clock] = await db.$queryRaw<Array<{ observedAt: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "observedAt"`);
  const observedAt = clock?.observedAt ?? new Date();
  if (accountCycleIds.length === 0) return { observedAt: observedAt.toISOString(), readinessMayChangeAfterObservation: true, capabilities: EXTERNAL_SIGNAL_EXECUTION_CAPABILITIES, accountCycles: [] };

  const ids = accountCycleIds;
  const [core, claimEvents, brokerOrders, brokerActivities, attentions] = await Promise.all([
    db.$queryRaw<CoreRow[]>(Prisma.sql`
      SELECT ac.id AS "accountCycleId", ac.status::text AS "accountCycleStatus", ac."entryRolloutGenerationId",
        ac."terminalAt", ac."terminalReasonCode", ac."noExposureProof"::text,
        ta.environment::text, ta.status::text AS "accountStatus", ta."tradingEnabled", ta."killSwitchEnabled", ta."tradingBlocked",
        tas.enabled AS "assignmentEnabled", tas."entriesEnabled", a.enabled AS "allocationEnabled",
        s.enabled AS "subscriptionEnabled", sec.enabled AS "securityEnabled", st.enabled AS "strategyEnabled", ep.enabled AS "exitProfileEnabled",
        sig.id AS "entrySignalId", sig.event::text AS "signalEvent", sig."receivedAt" AS "signalReceivedAt",
        CASE WHEN sig."receivedAt" IS NULL THEN 'HISTORICAL_NULL_RECEIPT'
             WHEN sig."receivedAt" + interval '120 seconds' > clock_timestamp() THEN 'FRESH'
             ELSE 'EXPIRED' END AS "receiptFreshness",
        cw.status::text AS "correlationWorkStatus",
        oi.id AS "orderIntentId", oi.status AS "orderIntentStatus", oi.side AS "orderIntentSide", oi."clientOrderId", oi."createdAt" AS "orderIntentCreatedAt", oi."updatedAt" AS "orderIntentUpdatedAt", oi."blockReason",
        eo.id AS "executionObligationId", eo."createdAt" AS "executionObligationCreatedAt", eo."executionEpochAt", eo."rolloutGenerationId" AS "frozenRolloutGenerationId", eo."authorizationId" AS "executionAuthorizationId",
        mio.id AS "marketIntelligenceObligationId", mio."frozenAt" AS "marketIntelligenceObligationFrozenAt", mio."validUntil" AS "marketIntelligenceObligationValidUntil",
        ec.id AS "exposureClaimId", ec.status AS "exposureStatus", ec."acquiredAt" AS "exposureAcquiredAt", ec."releasedAt" AS "exposureReleasedAt", ec."releaseReason",
        wc.id AS "workerClaimId", wc."claimedAt", wc."dispatchStateVersion" AS "claimedDispatchStateVersion",
        tv.id AS "tradingViewConsumptionId", tv."authorizedAt", tv."authorizationDeadlineAt", tv."consumedAt" AS "tradingViewConsumedAt", tv."dispatchStateVersion" AS "authorizedDispatchStateVersion",
        mi.id AS "marketIntelligenceConsumptionId", mi."consumedAt" AS "marketIntelligenceConsumedAt",
        er.id AS "frozenGenerationId", er.generation AS "frozenGeneration", er.enabled AS "frozenGenerationEnabled", er."authorityMode"::text AS "frozenGenerationAuthorityMode", er."effectiveAt" AS "frozenGenerationEffectiveAt",
        auth.status::text AS "executionAuthorizationStatus", auth."authorizedAt" AS "executionAuthorizedAt", auth."revokedAt" AS "executionAuthorizationRevokedAt", auth."invalidatedAt" AS "executionAuthorizationInvalidatedAt",
        ers.version AS "executionStateVersion", ers."activeRolloutGenerationId" AS "activeExecutionGenerationId", ers."activatedAt" AS "executionActivatedAt",
        bds.version AS "dispatchStateVersion", bds."activeRolloutGenerationId" AS "activeDispatchGenerationId", bds."activatedAt" AS "dispatchActivatedAt",
        (auth.status='AUTHORIZED' AND auth."rolloutGenerationId"=eo."rolloutGenerationId" AND auth."tradingAccountId"=ac."tradingAccountId" AND auth."tradingAccountSubscriptionId"=ac."tradingAccountSubscriptionId" AND auth."subscriptionId"=ac."subscriptionId" AND auth."securityId"=ac."securityId"
          AND auth."signalSourceId"=sig."signalSourceId" AND auth."strategySignalBindingId"=sig."strategySignalBindingId" AND auth."strategySignalRevisionId"=sig."strategySignalRevisionId"
          AND src.enabled AND bind.enabled AND rev.status='ACTIVE' AND rev."authorityMode"='TRADE_ELIGIBLE') AS "effectiveFrozenAssignmentAuthority",
        (ta.status='ACTIVE' AND ta."tradingEnabled" AND NOT ta."killSwitchEnabled" AND ta."tradingBlocked" IS NOT TRUE) AS "accountOperational",
        (tas.enabled AND tas."entriesEnabled" AND a.enabled AND s.enabled AND sec.enabled AND st.enabled AND ep.enabled) AS "assignmentOperational",
        CASE WHEN tv.id IS NULL THEN 'NOT_COMMITTED' WHEN tv."authorizationDeadlineAt" > clock_timestamp() THEN 'OPEN' ELSE 'EXPIRED' END AS "authorizationDeadlineStatus"
      FROM "ExternalSignalTradeCycleAccount" ac
      JOIN "TradingAccount" ta ON ta.id=ac."tradingAccountId"
      JOIN "TradingAccountSubscription" tas ON tas.id=ac."tradingAccountSubscriptionId"
      LEFT JOIN "TradingAccountAllocation" a ON a.id=tas."allocationId" AND a."tradingAccountId"=tas."tradingAccountId"
      JOIN "Subscription" s ON s.id=ac."subscriptionId"
      JOIN "Security" sec ON sec.id=ac."securityId"
      JOIN "Strategy" st ON st.id=s."strategyId"
      JOIN "ExitProfile" ep ON ep.id=s."exitProfileId"
      JOIN "SignalRoute" sr ON sr.id=ac."entrySignalRouteId"
      JOIN "SignalRoutingRun" rr ON rr.id=sr."signalRoutingRunId"
      JOIN "Signal" sig ON sig.id=rr."signalId" AND sig."externalSignalTradeCycleId"=${sourceCycleId}
      LEFT JOIN "ExternalSignalCorrelationWork" cw ON cw."signalId"=sig.id
      LEFT JOIN "OrderIntent" oi ON oi."externalSignalAccountCycleId"=ac.id
      LEFT JOIN "ExternalSignalEntryExecutionObligation" eo ON eo."accountCycleId"=ac.id AND eo."orderIntentId"=oi.id
      LEFT JOIN "OrderIntentMarketPolicyEnforcementObligation" mio ON mio."orderIntentId"=oi.id
      LEFT JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=oi.id AND ec."tradingAccountId"=ac."tradingAccountId" AND ec."securityId"=ac."securityId"
      LEFT JOIN "ExternalSignalBrokerWorkerClaim" wc ON wc."accountCycleId"=ac.id AND wc."orderIntentId"=oi.id
      LEFT JOIN "ExternalSignalBrokerDispatchConsumption" tv ON tv."orderIntentId"=oi.id AND tv."workerClaimId"=wc.id
      LEFT JOIN "MarketPolicyBrokerDispatchConsumption" mi ON mi."orderIntentId"=oi.id
      LEFT JOIN "ExternalSignalExecutionRolloutGeneration" er ON er.id=eo."rolloutGenerationId"
      LEFT JOIN "ExternalSignalEntryExecutionAuthorization" auth ON auth.id=eo."authorizationId"
      LEFT JOIN "ExternalSignalSource" src ON src.id=auth."signalSourceId"
      LEFT JOIN "StrategySignalBinding" bind ON bind.id=auth."strategySignalBindingId"
      LEFT JOIN "StrategySignalRevision" rev ON rev.id=auth."strategySignalRevisionId"
      LEFT JOIN "ExternalSignalExecutionRolloutState" ers ON ers.id=1
      LEFT JOIN "ExternalSignalBrokerDispatchState" bds ON bds.id=1
      WHERE ac."externalSignalTradeCycleId"=${sourceCycleId} AND ac.id IN (${Prisma.join(ids)})
      ORDER BY ac.id`),
    db.$queryRaw<RelatedRow[]>(Prisma.sql`SELECT * FROM (SELECT ac.id AS "accountCycleId", e.id, e."eventType", e."createdAt", e."evidenceJson", count(*) OVER (PARTITION BY ac.id) AS "totalCount", row_number() OVER (PARTITION BY ac.id ORDER BY e.id DESC) AS rn FROM "ExternalSignalTradeCycleAccount" ac JOIN "OrderIntent" oi ON oi."externalSignalAccountCycleId"=ac.id JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=oi.id JOIN "EntryExposureClaimEvent" e ON e."claimId"=ec.id WHERE ac."externalSignalTradeCycleId"=${sourceCycleId} AND ac.id IN (${Prisma.join(ids)})) q WHERE rn<=100 ORDER BY "accountCycleId",id`),
    db.$queryRaw<RelatedRow[]>(Prisma.sql`SELECT * FROM (SELECT ac.id AS "accountCycleId", bo.id, bo."brokerOrderId", bo."clientOrderId", bo.side, bo.status, bo."createdAt", bo."updatedAt", count(*) OVER (PARTITION BY ac.id) AS "totalCount", row_number() OVER (PARTITION BY ac.id ORDER BY bo.id DESC) AS rn FROM "ExternalSignalTradeCycleAccount" ac JOIN "OrderIntent" oi ON oi."externalSignalAccountCycleId"=ac.id JOIN "BrokerOrder" bo ON bo."orderIntentId"=oi.id AND bo."tradingAccountId"=ac."tradingAccountId" WHERE ac."externalSignalTradeCycleId"=${sourceCycleId} AND ac.id IN (${Prisma.join(ids)})) q WHERE rn<=100 ORDER BY "accountCycleId",id`),
    db.$queryRaw<RelatedRow[]>(Prisma.sql`SELECT * FROM (SELECT ac.id AS "accountCycleId", ba.id, ba."activityId", ba."activityType", ba."activityCategory", ba."orderId", ba."transactionTime", ba."createdAt", count(*) OVER (PARTITION BY ac.id) AS "totalCount", row_number() OVER (PARTITION BY ac.id ORDER BY ba.id DESC) AS rn FROM "ExternalSignalTradeCycleAccount" ac JOIN "OrderIntent" oi ON oi."externalSignalAccountCycleId"=ac.id JOIN "BrokerActivity" ba ON ba."orderIntentId"=oi.id AND ba."tradingAccountId"=ac."tradingAccountId" WHERE ac."externalSignalTradeCycleId"=${sourceCycleId} AND ac.id IN (${Prisma.join(ids)})) q WHERE rn<=100 ORDER BY "accountCycleId",id`),
    db.$queryRaw<RelatedRow[]>(Prisma.sql`SELECT * FROM (SELECT associated.*, count(*) OVER (PARTITION BY "accountCycleId") AS "totalCount", count(*) FILTER (WHERE status<>'RESOLVED') OVER (PARTITION BY "accountCycleId") AS "activeCount", count(*) FILTER (WHERE status<>'RESOLVED' AND "resolutionPolicy"='AUTHORITATIVE_ONLY') OVER (PARTITION BY "accountCycleId") AS "authoritativeOnlyCount", row_number() OVER (PARTITION BY "accountCycleId" ORDER BY (status<>'RESOLVED') DESC,id DESC) AS rn FROM (SELECT ac.id AS "accountCycleId", oa.id, oa.code, oa.source, oa.status::text, oa.severity::text, oa.title, oa."resolutionPolicy"::text, oa."firstObservedAt", oa."lastObservedAt", oa."resolvedAt" FROM "ExternalSignalTradeCycleAccount" ac JOIN "OrderIntent" oi ON oi."externalSignalAccountCycleId"=ac.id JOIN "OperationalAttention" oa ON oa."tradingAccountId"=ac."tradingAccountId" AND oa."orderIntentId"=oi.id WHERE ac."externalSignalTradeCycleId"=${sourceCycleId} AND ac.id IN (${Prisma.join(ids)}) UNION SELECT ac.id, oa.id, oa.code, oa.source, oa.status::text, oa.severity::text, oa.title, oa."resolutionPolicy"::text, oa."firstObservedAt", oa."lastObservedAt", oa."resolvedAt" FROM "ExternalSignalTradeCycleAccount" ac JOIN "OrderIntent" oi ON oi."externalSignalAccountCycleId"=ac.id JOIN "BrokerOrder" bo ON bo."orderIntentId"=oi.id AND bo."tradingAccountId"=ac."tradingAccountId" JOIN "OperationalAttention" oa ON oa."tradingAccountId"=ac."tradingAccountId" AND oa."brokerOrderId"=bo.id WHERE ac."externalSignalTradeCycleId"=${sourceCycleId} AND ac.id IN (${Prisma.join(ids)})) associated) q WHERE rn<=100 ORDER BY "accountCycleId",rn`),
  ]);

  const related = (rows: RelatedRow[], accountCycleId: number) => {
    const selected = rows.filter(row => row.accountCycleId === accountCycleId);
    const total = Number(selected[0]?.totalCount ?? selected.length);
    const records = selected.map(({ accountCycleId: _id, rn: _rank, totalCount: _total, activeCount: _active, authoritativeOnlyCount: _authoritative, ...row }) => presentRow(row));
    return { records, metadata: { returned: records.length, total, truncated: records.length < total }, activeCount: Number(selected[0]?.activeCount ?? 0), authoritativeOnlyCount: Number(selected[0]?.authoritativeOnlyCount ?? 0) };
  };
  return {
    observedAt: observedAt.toISOString(),
    readinessMayChangeAfterObservation: true,
    capabilities: EXTERNAL_SIGNAL_EXECUTION_CAPABILITIES,
    accountCycles: core.map(row => {
      const value = row as Record<string, unknown>;
      const lifecycle = classifyExecutionLifecycle({
        accountCycleStatus: String(value.accountCycleStatus), environment: String(value.environment), signalEvent: value.signalEvent == null ? null : String(value.signalEvent),
        correlationWorkStatus: value.correlationWorkStatus == null ? null : String(value.correlationWorkStatus), orderIntentId: value.orderIntentId as number | null,
        orderIntentStatus: value.orderIntentStatus == null ? null : String(value.orderIntentStatus), executionObligationId: value.executionObligationId as number | null,
        marketIntelligenceObligationId: value.marketIntelligenceObligationId as number | null, exposureClaimId: value.exposureClaimId as number | null,
        exposureStatus: value.exposureStatus == null ? null : String(value.exposureStatus), exposureReleasedAt: value.exposureReleasedAt as Date | null,
        workerClaimId: value.workerClaimId as number | null, tradingViewConsumptionId: value.tradingViewConsumptionId as number | null,
        marketIntelligenceConsumptionId: value.marketIntelligenceConsumptionId as number | null,
      });
      const claimEventHistory = related(claimEvents, row.accountCycleId), brokerOrderHistory = related(brokerOrders, row.accountCycleId), brokerActivityHistory = related(brokerActivities, row.accountCycleId), attentionHistory = related(attentions, row.accountCycleId);
      const authorizationPairPresent = value.tradingViewConsumptionId != null && value.marketIntelligenceConsumptionId != null;
      return {
        accountCycleId: row.accountCycleId,
        lifecycle,
        readiness: {
          scope: value.environment === 'PAPER' && String(value.orderIntentSide ?? 'buy').toLowerCase() === 'buy' ? 'PAPER_BUY' : 'OUT_OF_SCOPE',
          frozenGeneration: { id: value.frozenGenerationId ?? null, generation: value.frozenGeneration ?? null, enabled: value.frozenGenerationEnabled ?? null, authorityMode: value.frozenGenerationAuthorityMode ?? null, effectiveAt: dateIso(value.frozenGenerationEffectiveAt) ?? null },
          rolloutRelationship: { activeExecutionGenerationId: value.activeExecutionGenerationId ?? null, activeDispatchGenerationId: value.activeDispatchGenerationId ?? null, matchesExecution: value.frozenGenerationId != null && value.frozenGenerationId === value.activeExecutionGenerationId, matchesDispatch: value.frozenGenerationId != null && value.frozenGenerationId === value.activeDispatchGenerationId },
          executionState: { version: value.executionStateVersion ?? null, activatedAt: dateIso(value.executionActivatedAt) ?? null },
          dispatchState: { version: value.dispatchStateVersion ?? null, activatedAt: dateIso(value.dispatchActivatedAt) ?? null },
          effectiveAssignmentAuthority: value.effectiveFrozenAssignmentAuthority ?? false,
          accountOperational: value.accountOperational ?? false,
          assignmentOperational: value.assignmentOperational ?? false,
          receipt: { signalId: value.entrySignalId ?? null, receivedAt: dateIso(value.signalReceivedAt) ?? null, freshness: value.receiptFreshness ?? 'MISSING' },
          c2WorkerClaimPresent: value.workerClaimId != null,
          authorizationDeadlineStatus: value.authorizationDeadlineStatus ?? 'NOT_COMMITTED',
        },
        evidence: {
          executionObligation: value.executionObligationId == null ? null : { id: value.executionObligationId, createdAt: dateIso(value.executionObligationCreatedAt), executionEpochAt: dateIso(value.executionEpochAt), authorizationId: value.executionAuthorizationId, rolloutGenerationId: value.frozenRolloutGenerationId },
          marketIntelligenceObligation: value.marketIntelligenceObligationId == null ? null : { id: value.marketIntelligenceObligationId, frozenAt: dateIso(value.marketIntelligenceObligationFrozenAt), validUntil: dateIso(value.marketIntelligenceObligationValidUntil) },
          orderIntent: value.orderIntentId == null ? null : { id: value.orderIntentId, status: value.orderIntentStatus, clientOrderId: value.clientOrderId, createdAt: dateIso(value.orderIntentCreatedAt), updatedAt: dateIso(value.orderIntentUpdatedAt), blockReason: value.blockReason },
          exposure: value.exposureClaimId == null ? null : { id: value.exposureClaimId, status: value.exposureStatus, acquiredAt: dateIso(value.exposureAcquiredAt), releasedAt: dateIso(value.exposureReleasedAt), releaseReason: value.releaseReason, held: value.exposureReleasedAt == null },
          workerClaim: value.workerClaimId == null ? null : { id: value.workerClaimId, claimedAt: dateIso(value.claimedAt), dispatchStateVersion: value.claimedDispatchStateVersion },
          authorization: { pairPresent: authorizationPairPresent, status: authorizationPairPresent ? 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED' : 'NOT_COMMITTED', expired: value.authorizationDeadlineStatus === 'EXPIRED', tradingViewConsumption: value.tradingViewConsumptionId == null ? null : { id: value.tradingViewConsumptionId, authorizedAt: dateIso(value.authorizedAt), deadlineAt: dateIso(value.authorizationDeadlineAt), consumedAt: dateIso(value.tradingViewConsumedAt) }, marketIntelligenceConsumption: value.marketIntelligenceConsumptionId == null ? null : { id: value.marketIntelligenceConsumptionId, consumedAt: dateIso(value.marketIntelligenceConsumedAt) } },
          brokerSendPermissionEstablished: false,
          broker: { attributionProvenance: 'DIRECT_LINKED_EVIDENCE_ONLY_PRE_C3C', absenceIsAuthoritativeNonDeliveryProof: false, orderEvidencePresent: brokerOrderHistory.metadata.total > 0, activityEvidencePresent: brokerActivityHistory.metadata.total > 0, orders: brokerOrderHistory.records, ordersMetadata: brokerOrderHistory.metadata, activities: brokerActivityHistory.records, activitiesMetadata: brokerActivityHistory.metadata },
          exposureEvents: claimEventHistory.records,
          exposureEventsMetadata: claimEventHistory.metadata,
        },
        recovery: { authoritativeReconciliationRequired: attentionHistory.authoritativeOnlyCount > 0, unresolvedAuthoritativeOnlyCount: attentionHistory.authoritativeOnlyCount, activeAttentionCount: attentionHistory.activeCount, activeOperationalAttention: attentionHistory.records.filter(item => item.status !== 'RESOLVED'), activeOperationalAttentionMetadata: { returned: attentionHistory.records.filter(item => item.status !== 'RESOLVED').length, total: attentionHistory.activeCount, truncated: attentionHistory.records.filter(item => item.status !== 'RESOLVED').length < attentionHistory.activeCount }, operationalAttention: attentionHistory.records, operationalAttentionMetadata: attentionHistory.metadata },
      };
    }),
  };
}
