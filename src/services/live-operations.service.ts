import { LiveWriteCapability, PlatformRole, TradingAccountEnvironment } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { getLiveWriteApprovalState } from './live-write-approval.service.js';
import { deriveTradingAccountWorkerStatus } from './trading-account-worker-health.service.js';
import { getWorkerDefinition, type WorkerKey } from '../workers/worker-health.definitions.js';

export type OperationalHealth = 'HEALTHY' | 'DEGRADED' | 'ACTION_REQUIRED' | 'UNKNOWN';
export type CapabilityState = 'READY' | 'NOT_AUTHORIZED' | 'BLOCKED' | 'NOT_APPLICABLE';
export type EvidenceFreshness = 'CURRENT' | 'STALE' | 'EXPIRED';

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

export async function getLiveOperations(args: { userId: number; role: PlatformRole; tradingAccountId?: number }, now = new Date()) {
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
      const reasons: string[] = [];
      if (!attributed) reasons.push('Position assignment or subscription attribution is missing or inconsistent.');
      if (!profile) reasons.push('No resolved exit profile is available.');
      if (exitWorker.freshness !== 'CURRENT') reasons.push('Exit-evaluation evidence is not current.');
      if (position.exitState?.attentionRequired) reasons.push(position.exitState.attentionMessage ?? position.exitState.attentionCode ?? 'Exit state requires attention.');
      if (actionDue && !riskApproval?.effective) reasons.push('A risk-reducing action is waiting without effective RISK_REDUCING authorization.');
      return {
        id: position.id, symbol: position.symbol, qty: position.qty, avgEntryPrice: position.avgEntryPrice,
        status: position.status, lastSyncedAt: position.lastSyncedAt.toISOString(), brokerLocalAgreement: freshness(position.lastSyncedAt, getWorkerDefinition('tracked_position_sync').staleAfterMs, now) === 'CURRENT' ? 'ALIGNED' : 'UNKNOWN',
        attribution: { resolved: attributed, assignmentId: assignment?.id ?? null, assignmentKey: assignment?.subscription.key ?? position.subscription?.key ?? null, subscriptionId: position.subscriptionId },
        exitProfile: profile ? { id: profile.id, key: profile.key, name: profile.name, mode: profile.exitMode } : null,
        exitEvaluation: { applicable: Boolean(profile), eligible: Boolean(profile && assignment?.enabled && assignment.exitsEnabled), health: exitWorker.status, lastSuccessAt: exitWorker.evidenceAt, freshness: exitWorker.freshness },
        actionDue, activeOrderIntent: activeIntent ? { id: activeIntent.id, status: activeIntent.status, blockReason: activeIntent.blockReason, brokerOrder: activeIntent.brokerOrders[0] ? { id: activeIntent.brokerOrders[0].id, status: activeIntent.brokerOrders[0].status } : null } : null,
        expectation: actionDue ? 'An exit action is active or due.' : profile ? 'No exit order is currently expected; the strategy remains under evaluation.' : 'Exit expectation cannot be derived without a resolved profile.',
        attentionReasons: reasons,
      };
    });
    const actionDue = positions.some((position) => position.actionDue);
    const positionHealth: OperationalHealth = positions.some((p) => p.attentionReasons.length > 0 && (p.actionDue || !p.attribution.resolved || !p.exitProfile)) ? 'ACTION_REQUIRED' : positions.some((p) => p.attentionReasons.length > 0) ? 'DEGRADED' : 'HEALTHY';
    const workerHealth: OperationalHealth = workers.some((w) => ['FAILING', 'STALE'].includes(w.status) || w.freshness !== 'CURRENT') ? (positions.length ? 'ACTION_REQUIRED' : 'DEGRADED') : workers.some((w) => !['HEALTHY', 'DORMANT'].includes(w.status)) ? 'DEGRADED' : 'HEALTHY';
    const findingCount = typeof reconciliationWorker.summary === 'object' && reconciliationWorker.summary && 'findingCount' in reconciliationWorker.summary ? Number((reconciliationWorker.summary as { findingCount?: unknown }).findingCount ?? 0) : null;
    const reconciliationHealth: OperationalHealth = reconciliationWorker.freshness !== 'CURRENT' ? (positions.length ? 'ACTION_REQUIRED' : 'DEGRADED') : findingCount === null ? 'UNKNOWN' : findingCount > 0 ? 'ACTION_REQUIRED' : 'HEALTHY';
    const environmentAllowsRiskWrites = env.NODE_ENV === 'production' && env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR' && env.ALLOW_LIVE_RISK_REDUCING_WRITES;
    const riskCapability: CapabilityState = !positions.length ? 'NOT_APPLICABLE' : !environmentAllowsRiskWrites ? 'BLOCKED' : !riskApproval?.effective ? 'NOT_AUTHORIZED' : 'READY';
    const authorizationHealth: OperationalHealth = actionDue && riskCapability !== 'READY' ? 'ACTION_REQUIRED' : 'HEALTHY';
    const health = worst([positionHealth, workerHealth, reconciliationHealth, authorizationHealth]);
    const attentionReasons = [...new Set(positions.flatMap((p) => p.attentionReasons))];
    if (reconciliationHealth !== 'HEALTHY') attentionReasons.push('Reconciliation evidence is stale, unknown, or contains discrepancies.');
    if (workerHealth !== 'HEALTHY') attentionReasons.push('One or more account-scoped lifecycle workers require attention.');
    return {
      account: { id: account.id, displayName: account.displayName, broker: account.broker, environment: account.environment, status: account.status },
      generatedAt: now.toISOString(), health,
      summary: positions.length === 0 ? 'No open Live exposure. Monitoring remains read-only.' : `${positions.length} open Live position${positions.length === 1 ? '' : 's'}. ${health === 'HEALTHY' ? 'Monitoring, lifecycle, and reconciliation evidence are current.' : 'One or more operational capabilities require attention.'}`,
      exposure: { openPositionCount: positions.length }, positions,
      positionLifecycle: { health: positionHealth },
      exitCapability: { state: riskCapability, actionDue, strategyResolved: positions.every((p) => p.exitProfile !== null), evaluatorHealth: exitWorker.status, authorizationActive: Boolean(riskApproval?.effective), environmentWritePolicy: environmentAllowsRiskWrites ? 'ALLOWED' : 'BLOCKED' },
      reconciliation: { health: reconciliationHealth, findingCount, freshness: reconciliationWorker.freshness, evidenceAt: reconciliationWorker.evidenceAt },
      workers: { health: workerHealth, items: workers },
      entryPosture: { state: account.activeLiveEntryArming ? 'ARMED' : 'DISARMED', authorizationActive: Boolean(entryApproval?.effective), armingId: account.activeLiveEntryArming?.id ?? null },
      safetyPosture: { tradingEnabled: account.tradingEnabled, killSwitchEnabled: account.killSwitchEnabled, riskReducingAuthorization: riskApproval?.effective ? 'ACTIVE' : 'INACTIVE', entryAuthorization: entryApproval?.effective ? 'ACTIVE' : 'INACTIVE', deploymentRole: env.LIVE_WRITE_DEPLOYMENT_ROLE, liveRiskReducingWritesAllowed: env.ALLOW_LIVE_RISK_REDUCING_WRITES, exclusiveWriterOwnershipProven: false },
      completedCanary: account.liveEntryAcceptanceRuns[0] ? { id: account.liveEntryAcceptanceRuns[0].id, completedAt: account.liveEntryAcceptanceRuns[0].terminalAt?.toISOString() ?? null } : null,
      attentionReasons,
      nextOperatorAction: health === 'HEALTHY' ? { code: 'MONITORING', message: positions.length ? 'No action required. Continue monitoring the open position.' : 'No action required. Continue monitoring this Live account.' } : { code: 'ATTENTION_REQUIRED', message: attentionReasons[0] ?? 'Review the account-scoped operational evidence.' },
    };
  }));
  const worstHealth = snapshots.length ? worst(snapshots.map((item) => item.health)) : 'HEALTHY';
  return { generatedAt: now.toISOString(), summary: { liveAccountCount: snapshots.length, accountsWithExposure: snapshots.filter((s) => s.exposure.openPositionCount > 0).length, openPositionCount: snapshots.reduce((n, s) => n + s.exposure.openPositionCount, 0), accountsRequiringAttention: snapshots.filter((s) => s.health === 'ACTION_REQUIRED').length, accountsDegradedOrStale: snapshots.filter((s) => ['DEGRADED', 'UNKNOWN'].includes(s.health)).length, accountsWithActiveEntryArming: snapshots.filter((s) => s.entryPosture.state === 'ARMED').length, health: worstHealth }, accounts: snapshots };
}
