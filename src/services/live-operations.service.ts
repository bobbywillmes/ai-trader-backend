import { LiveWriteCapability, PlatformRole, TradingAccountEnvironment } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { getLiveWriteApprovalState } from './live-write-approval.service.js';
import { deriveTradingAccountWorkerStatus } from './trading-account-worker-health.service.js';
import { getWorkerDefinition, type WorkerKey } from '../workers/worker-health.definitions.js';

export type OperationalHealth = 'HEALTHY' | 'DEGRADED' | 'ACTION_REQUIRED' | 'UNKNOWN';
export type CapabilityState = 'READY' | 'NOT_AUTHORIZED' | 'BLOCKED' | 'NOT_APPLICABLE';
export type EvidenceFreshness = 'CURRENT' | 'STALE' | 'EXPIRED';
export type LiveOperationsEnvironmentInput = Pick<typeof env,
  'NODE_ENV' | 'LIVE_WRITE_DEPLOYMENT_ROLE' | 'ALLOW_LIVE_TRADING' |
  'ALLOW_LIVE_RISK_REDUCING_WRITES'>;

export function deriveLiveOperationsEnvironmentContext(
  config: LiveOperationsEnvironmentInput = env
) {
  const authoritativeExecutor = config.NODE_ENV === 'production' &&
    config.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR';
  return {
    applicationEnvironment: config.NODE_ENV,
    deploymentRole: config.LIVE_WRITE_DEPLOYMENT_ROLE,
    operationalAuthority: authoritativeExecutor
      ? 'AUTHORITATIVE_EXECUTOR' as const : 'OBSERVATION_ONLY' as const,
    healthScope: 'CURRENT_ENVIRONMENT_ONLY' as const,
    liveEntryWritePolicy: authoritativeExecutor && config.ALLOW_LIVE_TRADING &&
      config.ALLOW_LIVE_RISK_REDUCING_WRITES ? 'ALLOWED' as const :
      'OBSERVATION_ONLY' as const,
    liveRiskReducingWritePolicy: authoritativeExecutor &&
      config.ALLOW_LIVE_RISK_REDUCING_WRITES ? 'ALLOWED' as const :
      'OBSERVATION_ONLY' as const,
  };
}

const REQUIRED_WORKERS = ['tracked_position_sync', 'exit_evaluation', 'broker_activity_sync', 'submitted_order_sync', 'scheduled_reconciliation'] as const;
const NONTERMINAL_INTENTS = ['pending', 'submitting', 'submitted'];

function severityRank(value: OperationalHealth) {
  return { HEALTHY: 0, UNKNOWN: 1, DEGRADED: 2, ACTION_REQUIRED: 3 }[value];
}

function worst(values: OperationalHealth[]): OperationalHealth {
  return values.reduce((result, value) => severityRank(value) > severityRank(result) ? value : result, 'HEALTHY');
}

function freshness(at: Date | null, staleAfterMs: number, now: Date): EvidenceFreshness {
  if (!at) return 'EXPIRED';
  const age = now.getTime() - at.getTime();
  return age > staleAfterMs * 2 ? 'EXPIRED' : age > staleAfterMs ? 'STALE' : 'CURRENT';
}

export async function getLiveOperations(
  args: { userId: number; role: PlatformRole; tradingAccountId?: number },
  now = new Date(),
  environmentConfig: LiveOperationsEnvironmentInput = env
) {
  const environmentContext = deriveLiveOperationsEnvironmentContext(environmentConfig);
  const authoritativeExecutor = environmentContext.operationalAuthority ===
    'AUTHORITATIVE_EXECUTOR';
  const accountWhere = args.role === PlatformRole.SYSTEM_OWNER
    ? {}
    : { memberships: { some: { userId: args.userId } } };
  const accounts = await prisma.tradingAccount.findMany({
    where: { ...accountWhere, environment: TradingAccountEnvironment.LIVE, ...(args.tradingAccountId ? { id: args.tradingAccountId } : {}) },
    orderBy: { id: 'asc' },
    include: {
      activeLiveEntryArming: { select: { id: true, armedAt: true, entryApprovalExpiresAt: true } },
      trackedPositions: {
        where: { status: { in: ['open', 'closing'] } }, orderBy: { id: 'asc' },
        include: {
          exitState: true,
          subscription: { include: { exitProfile: true } },
          tradingAccountSubscription: { include: { subscription: { include: { exitProfile: true } } } },
          orderIntents: { where: { status: { in: NONTERMINAL_INTENTS } }, orderBy: { createdAt: 'desc' }, take: 1, include: { brokerOrders: { orderBy: { createdAt: 'desc' }, take: 1 } } },
        },
      },
      workerHealthStates: { where: { workerKey: { in: [...REQUIRED_WORKERS] } } },
      liveEntryAcceptanceRuns: { where: { terminalOutcome: 'CANARY_COMPLETE' }, orderBy: { terminalAt: 'desc' }, take: 1, select: { id: true, terminalAt: true } },
    },
  });

  const snapshots = await Promise.all(accounts.map(async (account) => {
    const approvalState = await getLiveWriteApprovalState(account.id);
    const riskApproval = approvalState.capabilities.find((item) => item.capability === LiveWriteCapability.RISK_REDUCING);
    const entryApproval = approvalState.capabilities.find((item) => item.capability === LiveWriteCapability.ENTRY);
    const workerByKey = new Map(account.workerHealthStates.map((state) => [state.workerKey, state]));
    const workers = REQUIRED_WORKERS.map((key) => {
      const state = workerByKey.get(key);
      const definition = getWorkerDefinition(key as WorkerKey);
      const status = state ? deriveTradingAccountWorkerStatus(state, definition, now) : 'STARTING';
      const evidenceAt = state?.lastSucceededAt ?? state?.lastTickCompletedAt ?? null;
      return { key, status, freshness: freshness(evidenceAt, definition.staleAfterMs, now), evidenceAt: evidenceAt?.toISOString() ?? null, reason: state?.lastError ?? state?.lastSkipReason ?? null, summary: state?.lastSummaryJson ?? null };
    });
    const exitWorker = workers.find((item) => item.key === 'exit_evaluation')!;
    const reconciliationWorker = workers.find((item) => item.key === 'scheduled_reconciliation')!;
    const positions = account.trackedPositions.map((position) => {
      const assignment = position.tradingAccountSubscription;
      const attributed = Boolean(assignment && position.subscriptionId && assignment.subscriptionId === position.subscriptionId);
      const profile = assignment?.subscription.exitProfile ?? position.subscription?.exitProfile ?? null;
      const activeIntent = position.orderIntents[0] ?? null;
      const actionDue = position.status === 'closing' || Boolean(activeIntent) || Boolean(position.exitState?.targetUnlocked && !position.exitState.trailBrokerOrderId);
      const configSnapshotPresent = position.configSnapshotJson !== null;
      const brokerQtyRaw = typeof position.rawPositionJson === 'object' &&
        position.rawPositionJson && 'qty' in position.rawPositionJson
        ? Number((position.rawPositionJson as { qty?: unknown }).qty) : null;
      const brokerLocalAgreement = brokerQtyRaw !== null &&
        Number.isFinite(brokerQtyRaw)
        ? Math.abs(brokerQtyRaw) === Math.abs(position.qty) ? 'ALIGNED' :
          'QUANTITY_MISMATCH'
        : freshness(position.lastSyncedAt,
            getWorkerDefinition('tracked_position_sync').staleAfterMs, now) ===
          'CURRENT' ? 'ALIGNED' : 'UNKNOWN';
      const expectedObserverLimitation = !authoritativeExecutor &&
        (!attributed || !configSnapshotPresent || !profile);
      const reasons: string[] = [];
      if (!expectedObserverLimitation && !attributed) reasons.push('Position assignment or subscription attribution is missing or inconsistent.');
      if (!expectedObserverLimitation && !configSnapshotPresent) reasons.push('Frozen entry-time configuration evidence is missing.');
      if (!expectedObserverLimitation && !profile) reasons.push('No resolved exit profile is available.');
      if (!expectedObserverLimitation && exitWorker.freshness !== 'CURRENT') reasons.push('Exit-evaluation evidence is not current.');
      if (brokerLocalAgreement === 'QUANTITY_MISMATCH') reasons.push('Broker and local position quantities disagree.');
      const attentionCode = position.exitState?.attentionCode ?? '';
      const observerLifecycleAttention = expectedObserverLimitation &&
        ['ATTRIBUTION', 'SUBSCRIPTION', 'CONFIG', 'EXIT_PROFILE']
          .some((token) => attentionCode.includes(token));
      if (position.exitState?.attentionRequired && !observerLifecycleAttention)
        reasons.push((position.exitState.attentionMessage ?? attentionCode) ||
          'Exit state requires attention.');
      if (actionDue && !riskApproval?.effective) reasons.push('A risk-reducing action is waiting without effective RISK_REDUCING authorization.');
      return {
        id: position.id, symbol: position.symbol, qty: position.qty, avgEntryPrice: position.avgEntryPrice,
        status: position.status, lastSyncedAt: position.lastSyncedAt.toISOString(), brokerLocalAgreement,
        lifecycleState: expectedObserverLimitation ? 'UNAVAILABLE_LOCALLY' :
          reasons.length ? 'ACTION_REQUIRED' : 'AVAILABLE',
        productionHealth: authoritativeExecutor ? 'CURRENT_ENVIRONMENT' :
          'UNKNOWN_FROM_THIS_ENVIRONMENT',
        observerLimitation: expectedObserverLimitation ? {
          code: 'EXPECTED_OBSERVATION_LIMITATION' as const,
          title: 'Lifecycle evidence unavailable locally',
          message: 'This Live position originated outside this environment. Local assignment, subscription, and entry-time configuration evidence are not expected here. No local repair is required; verify authoritative lifecycle health in production.',
          causalChain: [
            'Local attribution is unavailable.',
            'Therefore no local exit profile can be resolved.',
            'Therefore local exit evaluation cannot manage this position.',
          ],
        } : null,
        attribution: { resolved: attributed, finding: expectedObserverLimitation ?
          'EXPECTED_OBSERVATION_LIMITATION' : attributed ? 'RESOLVED' :
          'ACTION_REQUIRED', assignmentId: assignment?.id ?? null,
          assignmentKey: assignment?.subscription.key ?? position.subscription?.key ?? null,
          subscriptionId: position.subscriptionId, configSnapshotPresent },
        exitProfile: profile ? { id: profile.id, key: profile.key, name: profile.name, mode: profile.exitMode } : null,
        exitEvaluation: { applicable: Boolean(profile), eligible: Boolean(profile && assignment?.enabled && assignment.exitsEnabled), health: exitWorker.status, lastSuccessAt: exitWorker.evidenceAt, freshness: exitWorker.freshness },
        actionDue, activeOrderIntent: activeIntent ? { id: activeIntent.id, status: activeIntent.status, blockReason: activeIntent.blockReason, brokerOrder: activeIntent.brokerOrders[0] ? { id: activeIntent.brokerOrders[0].id, status: activeIntent.brokerOrders[0].status } : null } : null,
        expectation: expectedObserverLimitation ? 'Exit management is not authoritative in this environment.' : actionDue ? 'An exit action is active or due.' : profile ? 'No exit order is currently expected; the strategy remains under evaluation.' : 'Exit expectation cannot be derived without a resolved profile.',
        attentionReasons: reasons,
      };
    });
    const actionDue = positions.some((position) => position.actionDue);
    const hasObserverLimitation = positions.some((p) => p.observerLimitation);
    const positionHealth: OperationalHealth = positions.some((p) => p.attentionReasons.length > 0 && (p.actionDue || !p.attribution.resolved || !p.exitProfile || p.brokerLocalAgreement === 'QUANTITY_MISMATCH')) ? 'ACTION_REQUIRED' : positions.some((p) => p.attentionReasons.length > 0) ? 'DEGRADED' : hasObserverLimitation ? 'UNKNOWN' : 'HEALTHY';
    const severityWorkers = workers.filter((worker) =>
      !(hasObserverLimitation && ['exit_evaluation', 'scheduled_reconciliation']
        .includes(worker.key)));
    const workerHealth: OperationalHealth = severityWorkers.some((w) => ['FAILING', 'STALE'].includes(w.status) || w.freshness !== 'CURRENT') ? (positions.length ? 'ACTION_REQUIRED' : 'DEGRADED') : severityWorkers.some((w) => !['HEALTHY', 'DORMANT'].includes(w.status)) ? 'DEGRADED' : hasObserverLimitation ? 'UNKNOWN' : 'HEALTHY';
    const findingCount = typeof reconciliationWorker.summary === 'object' && reconciliationWorker.summary && 'findingCount' in reconciliationWorker.summary ? Number((reconciliationWorker.summary as { findingCount?: unknown }).findingCount ?? 0) : null;
    const reconciliationHealth: OperationalHealth = hasObserverLimitation ?
      'UNKNOWN' : reconciliationWorker.freshness !== 'CURRENT' ?
      (positions.length ? 'ACTION_REQUIRED' : 'DEGRADED') : findingCount === null ?
      'UNKNOWN' : findingCount > 0 ? 'ACTION_REQUIRED' : 'HEALTHY';
    const environmentAllowsRiskWrites = environmentContext.liveRiskReducingWritePolicy === 'ALLOWED';
    const riskCapability: CapabilityState | 'OBSERVATION_ONLY' =
      !authoritativeExecutor ? 'OBSERVATION_ONLY' : !positions.length ?
      'NOT_APPLICABLE' : !environmentAllowsRiskWrites ? 'BLOCKED' :
      !riskApproval?.effective ? 'NOT_AUTHORIZED' : 'READY';
    const authorizationHealth: OperationalHealth = actionDue && riskCapability !== 'READY' ? 'ACTION_REQUIRED' : 'HEALTHY';
    const health = worst([positionHealth, workerHealth, reconciliationHealth, authorizationHealth]);
    const attentionReasons = [...new Set(positions.flatMap((p) => p.attentionReasons))];
    if (!hasObserverLimitation && reconciliationHealth !== 'HEALTHY') attentionReasons.push('Reconciliation evidence is stale, unknown, or contains discrepancies.');
    if (!hasObserverLimitation && workerHealth !== 'HEALTHY') attentionReasons.push('One or more account-scoped lifecycle workers require attention.');
    return {
      account: { id: account.id, displayName: account.displayName, broker: account.broker, environment: account.environment, status: account.status },
      generatedAt: now.toISOString(), health,
      operationalState: hasObserverLimitation && health !== 'ACTION_REQUIRED' ?
        'OBSERVATION_ONLY' : health,
      summary: hasObserverLimitation && health !== 'ACTION_REQUIRED' ? `${positions.length} broker-observed Live position${positions.length === 1 ? '' : 's'}. Lifecycle evidence is unavailable locally; production health is unknown from this environment.` : positions.length === 0 ? 'No open Live exposure. Monitoring remains read-only.' : `${positions.length} open Live position${positions.length === 1 ? '' : 's'}. ${health === 'HEALTHY' ? 'Monitoring, lifecycle, and reconciliation evidence are current.' : 'One or more operational capabilities require attention.'}`,
      exposure: { openPositionCount: positions.length }, positions,
      positionLifecycle: { health: positionHealth, state: hasObserverLimitation ? 'UNAVAILABLE_LOCALLY' : positionHealth },
      exitCapability: { state: riskCapability, actionDue, strategyResolved: positions.every((p) => p.exitProfile !== null), evaluatorHealth: exitWorker.status, authorizationActive: Boolean(riskApproval?.effective), environmentWritePolicy: authoritativeExecutor ? environmentAllowsRiskWrites ? 'ALLOWED' : 'BLOCKED' : 'OBSERVATION_ONLY' },
      reconciliation: { health: reconciliationHealth, state: hasObserverLimitation ? 'NOT_AUTHORITATIVE' : reconciliationHealth, findingCount, freshness: reconciliationWorker.freshness, evidenceAt: reconciliationWorker.evidenceAt, context: hasObserverLimitation ? 'Raw local findings remain available, but expected missing production-owned lifecycle evidence does not certify production unhealthy or require local repair.' : null },
      workers: { health: workerHealth, items: workers },
      entryPosture: { state: account.activeLiveEntryArming ? 'ARMED' : 'DISARMED', authorizationActive: Boolean(entryApproval?.effective), armingId: account.activeLiveEntryArming?.id ?? null },
      safetyPosture: { tradingEnabled: account.tradingEnabled, killSwitchEnabled: account.killSwitchEnabled, riskReducingAuthorization: riskApproval?.effective ? 'ACTIVE' : 'INACTIVE', entryAuthorization: entryApproval?.effective ? 'ACTIVE' : 'INACTIVE', deploymentRole: environmentContext.deploymentRole, liveRiskReducingWritesAllowed: environmentAllowsRiskWrites, exclusiveWriterOwnershipProven: false },
      completedCanary: account.liveEntryAcceptanceRuns[0] ? { id: account.liveEntryAcceptanceRuns[0].id, completedAt: account.liveEntryAcceptanceRuns[0].terminalAt?.toISOString() ?? null } : null,
      attentionReasons,
      nextOperatorAction: hasObserverLimitation && attentionReasons.length === 0 ? { code: 'VERIFY_IN_PRODUCTION', message: 'No local repair or Live-management action is required. Verify canonical lifecycle health in the production executor.' } : health === 'HEALTHY' ? { code: 'MONITORING', message: positions.length ? 'No action required. Continue monitoring the open position.' : 'No action required. Continue monitoring this Live account.' } : { code: 'ATTENTION_REQUIRED', message: attentionReasons[0] ?? 'Review the account-scoped operational evidence.' },
    };
  }));
  const worstHealth = snapshots.length ? worst(snapshots.map((item) => item.health)) : 'HEALTHY';
  return { generatedAt: now.toISOString(), environmentContext, summary: { liveAccountCount: snapshots.length, accountsWithExposure: snapshots.filter((s) => s.exposure.openPositionCount > 0).length, openPositionCount: snapshots.reduce((n, s) => n + s.exposure.openPositionCount, 0), accountsRequiringAttention: snapshots.filter((s) => s.health === 'ACTION_REQUIRED').length, accountsDegradedOrStale: snapshots.filter((s) => ['DEGRADED'].includes(s.health)).length, accountsObservationLimited: snapshots.filter((s) => s.operationalState === 'OBSERVATION_ONLY').length, accountsWithActiveEntryArming: snapshots.filter((s) => s.entryPosture.state === 'ARMED').length, health: worstHealth }, accounts: snapshots };
}
