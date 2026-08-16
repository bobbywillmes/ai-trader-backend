import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { buildTradeCycleConfigSnapshot } from './trade-cycle-config-snapshot.service.js';
import { resolveExactBrokerOrderAttribution } from './attribution-evidence-resolver.service.js';
import { withTradingAccountWorkflowLock } from './trading-account-workflow-lock.service.js';
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES } from './trading-account-workflow-lock.service.js';
import { getLifecycleRepairHandlerMetadata } from './lifecycle-repair-registry.service.js';

export const POSITION_ATTRIBUTION_REPAIR_TYPE = 'RESOLVE_POSITION_ATTRIBUTION' as const;
export const POSITION_ATTRIBUTION_REPAIR_CONFIRMATION = 'APPLY POSITION ATTRIBUTION REPAIR';
export const LIFECYCLE_REPAIR_CASE_TTL_MS = 10 * 60_000;

const BROKER_IMPACT = {
  impact: 'LOCAL_ONLY',
  brokerWrites: 'NONE',
  ordersSubmitted: 'NONE',
  ordersCancelled: 'NONE',
  positionsClosed: 'NONE',
  laterWorkerWarning: 'After a successful repair, ordinary lifecycle workers may resume normal evaluation. On PAPER, subsequent exit evaluation may create broker actions if the repaired position independently satisfies its configured exit conditions.',
} as const;

function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function getFrozenPositionAttributionAssessedAt(
  proposedMutationsJson: unknown
): Date {
  const root = objectValue(proposedMutationsJson);
  const trackedPosition = objectValue(root?.trackedPosition);
  const capturedAt = objectValue(trackedPosition?.configSnapshotCapturedAt);
  const value = capturedAt?.after;
  if (typeof value !== 'string') {
    throw new HttpError(409, 'Lifecycle repair case has no valid frozen snapshot timestamp.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new HttpError(409, 'Lifecycle repair case has an invalid frozen snapshot timestamp.');
  }
  return parsed;
}

export function positionAttributionRevalidationMatches(args: {
  rechecked: {
    executable: boolean;
    localLifecycleFingerprint: string;
    configurationFingerprint: string | null;
    proposed: unknown;
    evidence: unknown;
  };
  frozen: {
    localLifecycleFingerprint: string;
    configurationFingerprint: string | null;
    proposedMutationsJson: unknown;
    evidenceJson: unknown;
  };
}): boolean {
  return args.rechecked.executable &&
    args.rechecked.localLifecycleFingerprint === args.frozen.localLifecycleFingerprint &&
    args.rechecked.configurationFingerprint === args.frozen.configurationFingerprint &&
    stable(args.rechecked.proposed) === stable(args.frozen.proposedMutationsJson) &&
    stable(args.rechecked.evidence) === stable(args.frozen.evidenceJson);
}

const positionInclude = {
  tradingAccount: { select: { id: true, displayName: true, environment: true, broker: true } },
  security: true,
  exitState: true,
  orderIntents: { select: { id: true, subscriptionId: true, tradingAccountSubscriptionId: true, clientOrderId: true } },
  brokerOrders: { select: { id: true, brokerOrderId: true, clientOrderId: true } },
  brokerActivities: { select: { id: true, activityId: true, orderId: true, trackedPositionId: true, brokerOrderRecordId: true, orderIntentId: true } },
} satisfies Prisma.TrackedPositionInclude;

function localState(position: any) {
  return {
    id: position.id, tradingAccountId: position.tradingAccountId, securityId: position.securityId,
    broker: position.broker, symbol: position.symbol, side: position.side, qty: position.qty,
    avgEntryPrice: position.avgEntryPrice, openedAt: position.openedAt.toISOString(), status: position.status,
    subscriptionId: position.subscriptionId,
    tradingAccountSubscriptionId: position.tradingAccountSubscriptionId,
    configSnapshotJson: position.configSnapshotJson,
    configSnapshotCapturedAt: position.configSnapshotCapturedAt?.toISOString() ?? null,
    exitState: position.exitState ? {
      id: position.exitState.id, status: position.exitState.status,
      targetUnlocked: position.exitState.targetUnlocked,
      targetUnlockedAt: position.exitState.targetUnlockedAt?.toISOString() ?? null,
      targetUnlockedPrice: position.exitState.targetUnlockedPrice,
      targetUnlockedPnlPct: position.exitState.targetUnlockedPnlPct,
      highWaterMark: position.exitState.highWaterMark,
      trailStopPrice: position.exitState.trailStopPrice,
      exitProfileKey: position.exitState.exitProfileKey,
      exitMode: position.exitState.exitMode,
      takeProfitBehavior: position.exitState.takeProfitBehavior,
      targetPct: position.exitState.targetPct,
      trailingStopPct: position.exitState.trailingStopPct,
      trailBroker: position.exitState.trailBroker,
      trailBrokerOrderId: position.exitState.trailBrokerOrderId,
      trailClientOrderId: position.exitState.trailClientOrderId,
      trailOrderStatus: position.exitState.trailOrderStatus,
    } : null,
    lifecycleLinks: {
      orderIntents: position.orderIntents,
      brokerOrders: position.brokerOrders,
      brokerActivities: position.brokerActivities,
    },
  };
}

export function isPristinePositionExitState(state: any) {
  return !state || (
    state.status === 'watching' && !state.targetUnlocked &&
    state.targetUnlockedAt === null && state.targetUnlockedPrice === null &&
    state.targetUnlockedPnlPct === null && state.highWaterMark === null &&
    state.trailStopPrice === null && state.trailBroker === null &&
    state.trailBrokerOrderId === null && state.trailClientOrderId === null &&
    state.trailOrderStatus === null
  );
}

function caseProjection(row: any, superseded = false) {
  const successful = row.executions?.find((execution: any) => execution.result === 'SUCCEEDED') ?? null;
  const derived = deriveLifecycleRepairCaseState({
    executableAtCreation: row.executableAtCreation,
    expiresAt: row.expiresAt,
    superseded,
    successfulExecution: successful,
  });
  return {
    ...row,
    ...derived,
    successfulExecution: successful,
  };
}

export function deriveLifecycleRepairCaseState(args: {
  executableAtCreation: boolean;
  expiresAt: Date;
  superseded: boolean;
  successfulExecution: unknown | null;
  now?: Date;
}) {
  const expired = args.expiresAt <= (args.now ?? new Date());
  const executed = args.successfulExecution !== null;
  return {
    expired, superseded: args.superseded, executed,
    executable: args.executableAtCreation && !expired && !executed && !args.superseded,
  };
}

async function buildDiagnosis(args: { tradingAccountId: number; trackedPositionId: number; assessedAt: Date }) {
  const position = await prisma.trackedPosition.findFirst({
    where: { id: args.trackedPositionId, tradingAccountId: args.tradingAccountId },
    include: positionInclude,
  });
  if (!position) throw new HttpError(404, 'TrackedPosition was not found in the selected TradingAccount.');
  if (!position.tradingAccount) throw new HttpError(409, 'TrackedPosition has no TradingAccount attribution.');
  const before = localState(position);
  const localLifecycleFingerprint = fingerprint(before);
  const nonExecutableReasons: Array<{ code: string; message: string }> = [];

  if (position.subscriptionId !== null || position.tradingAccountSubscriptionId !== null || position.configSnapshotJson !== null) {
    nonExecutableReasons.push({ code: 'ATTRIBUTION_ALREADY_PRESENT_OR_PARTIAL', message: 'Phase 1 refuses to overwrite or complete conflicting non-null position attribution.' });
  }
  if (!isPristinePositionExitState(position.exitState)) {
    nonExecutableReasons.push({ code: 'EXIT_STATE_NOT_PRISTINE', message: 'Meaningful exit lifecycle progress exists. A future RESOLVE_POSITION_EXIT_CONFIG repair is required.' });
  }

  const evidence = await resolveExactBrokerOrderAttribution({
    tradingAccountId: args.tradingAccountId, broker: position.broker,
    symbol: position.symbol, side: position.side, qty: position.qty,
    avgEntryPrice: position.avgEntryPrice, openedAt: position.openedAt,
    mode: position.tradingAccount.environment.toLowerCase(),
    policy: 'ALLOW_EXACT_ORDER_ID_READ',
  });
  const confidence = evidence?.confidence ?? 'INSUFFICIENT';
  if (confidence !== 'DETERMINISTIC' || !evidence?.assignment) {
    nonExecutableReasons.push({ code: 'EVIDENCE_NOT_DETERMINISTIC', message: evidence?.reason ?? 'No exact broker-order attribution evidence is available.' });
  }

  let snapshot: Prisma.InputJsonValue | null = null;
  let configFingerprint: string | null = null;
  let proposed: Record<string, unknown> = {};
  if (evidence?.assignment) {
    const assignment = await prisma.tradingAccountSubscription.findUnique({
      where: { id: evidence.assignment.id },
      include: { subscription: { include: { exitProfile: true, strategy: true, security: true } } },
    });
    if (!assignment) throw new HttpError(409, 'Resolved assignment disappeared during diagnosis.');
    snapshot = await buildTradeCycleConfigSnapshot({
      broker: position.broker, symbol: position.symbol, securityId: position.securityId,
      subscriptionId: assignment.subscriptionId, tradingAccountId: args.tradingAccountId,
      source: 'subscription_recovered', subscriptionResolutionSource: 'broker_client_order_id',
      capturedAt: args.assessedAt,
    });
    configFingerprint = fingerprint({
      assignment: {
        id: assignment.id, tradingAccountId: assignment.tradingAccountId,
        subscriptionId: assignment.subscriptionId, enabled: assignment.enabled,
        exitsEnabled: assignment.exitsEnabled,
      },
      snapshot,
    });
    const exitProfile = assignment.subscription.exitProfile;
    proposed = {
      trackedPosition: {
        subscriptionId: { before: position.subscriptionId, after: assignment.subscriptionId },
        tradingAccountSubscriptionId: { before: position.tradingAccountSubscriptionId, after: assignment.id },
        configSnapshotJson: { before: position.configSnapshotJson, after: snapshot },
        configSnapshotCapturedAt: { before: position.configSnapshotCapturedAt, after: args.assessedAt.toISOString() },
      },
      positionExitState: {
        action: position.exitState ? 'HYDRATE' : 'CREATE',
        id: position.exitState?.id ?? null,
        after: {
          status: 'watching', exitProfileKey: exitProfile.key, exitMode: exitProfile.exitMode,
          takeProfitBehavior: exitProfile.takeProfitBehavior,
          targetPct: exitProfile.targetPct, trailingStopPct: exitProfile.trailingStopPct,
        },
      },
    };
  }

  return {
    position, before, localLifecycleFingerprint, configurationFingerprint: configFingerprint,
    evidence, confidence, snapshot, proposed, nonExecutableReasons,
    executable: confidence === 'DETERMINISTIC' && nonExecutableReasons.length === 0,
  };
}

export async function diagnosePositionAttributionRepair(args: {
  tradingAccountId: number;
  trackedPositionId: number;
  actorUserId: number;
  source?: 'MANUAL_DIAGNOSIS' | 'RECONCILIATION' | 'WORKER_FAILURE';
}) {
  const assessedAt = new Date();
  const handler = getLifecycleRepairHandlerMetadata(POSITION_ATTRIBUTION_REPAIR_TYPE);
  const diagnosis = await buildDiagnosis({ ...args, assessedAt });
  const diagnosticFingerprint = fingerprint({
    repairVersion: 1, assessedAt: assessedAt.toISOString(),
    local: diagnosis.localLifecycleFingerprint,
    configuration: diagnosis.configurationFingerprint,
    evidence: diagnosis.evidence,
  });
  const row = await prisma.lifecycleRepairCase.create({
    data: {
      repairType: POSITION_ATTRIBUTION_REPAIR_TYPE, repairVersion: handler.version, impact: handler.impact,
      source: args.source ?? 'MANUAL_DIAGNOSIS', tradingAccountId: args.tradingAccountId,
      targetType: 'TrackedPosition', targetId: String(args.trackedPositionId),
      confidence: diagnosis.confidence, resolutionSource: diagnosis.evidence?.resolutionSource ?? null,
      diagnosticFingerprint, localLifecycleFingerprint: diagnosis.localLifecycleFingerprint,
      configurationFingerprint: diagnosis.configurationFingerprint,
      evidenceJson: json(diagnosis.evidence ?? { reason: 'no_exact_order_evidence' }),
      candidateResolutionsJson: json(diagnosis.evidence?.candidates ?? []),
      rejectedAlternativesJson: json(diagnosis.evidence?.rejectedAlternatives ?? []),
      beforeJson: json(diagnosis.before), proposedMutationsJson: json(diagnosis.proposed),
      preconditionsJson: json({ positionAttributionMustRemainNull: true, exitStateMustRemainPristine: true, localLifecycleFingerprint: diagnosis.localLifecycleFingerprint, configurationFingerprint: diagnosis.configurationFingerprint }),
      brokerImpactJson: json(BROKER_IMPACT), executableAtCreation: diagnosis.executable,
      nonExecutableReasonsJson: json(diagnosis.nonExecutableReasons), createdByUserId: args.actorUserId,
      expiresAt: new Date(assessedAt.getTime() + LIFECYCLE_REPAIR_CASE_TTL_MS),
    },
    include: { tradingAccount: { select: { id: true, displayName: true, environment: true } }, executions: { orderBy: { executedAt: 'desc' } } },
  });
  return caseProjection(row);
}

export async function listLifecycleRepairCases(tradingAccountId?: number) {
  const rows = await prisma.lifecycleRepairCase.findMany({
    ...(tradingAccountId ? { where: { tradingAccountId } } : {}),
    include: { tradingAccount: { select: { id: true, displayName: true, environment: true } }, executions: { orderBy: { executedAt: 'desc' } } },
    orderBy: { createdAt: 'desc' }, take: 100,
  });
  return rows.map((row) => caseProjection(row, rows.some((other) =>
    other.id !== row.id && other.repairType === row.repairType &&
    other.targetType === row.targetType && other.targetId === row.targetId &&
    other.createdAt > row.createdAt
  )));
}

export async function getLifecycleRepairCase(id: number) {
  const row = await prisma.lifecycleRepairCase.findUnique({
    where: { id },
    include: { tradingAccount: { select: { id: true, displayName: true, environment: true } }, createdByUser: { select: { id: true, name: true, email: true } }, executions: { include: { executedByUser: { select: { id: true, name: true, email: true } } }, orderBy: { executedAt: 'desc' } } },
  });
  if (!row) throw new HttpError(404, 'Lifecycle repair case not found.');
  const newer = await prisma.lifecycleRepairCase.findFirst({
    where: { repairType: row.repairType, targetType: row.targetType, targetId: row.targetId, createdAt: { gt: row.createdAt } },
    select: { id: true },
  });
  return caseProjection(row, Boolean(newer));
}

function transactionAfter(position: any, exitState: any) {
  return { trackedPosition: localState({ ...position, exitState, orderIntents: [], brokerOrders: [], brokerActivities: [] }), positionExitState: exitState };
}

export async function applyPositionAttributionRepair(args: {
  caseId: number;
  actorUserId: number;
  reason: string;
  confirmation: string;
  attemptKey: string;
}) {
  if (args.confirmation !== POSITION_ATTRIBUTION_REPAIR_CONFIRMATION) throw new HttpError(400, 'Invalid lifecycle repair confirmation.');
  const existingAttempt = await prisma.lifecycleRepairExecution.findUnique({ where: { attemptKey: args.attemptKey } });
  if (existingAttempt) {
    if (existingAttempt.caseId !== args.caseId) throw new HttpError(409, 'Attempt key is already associated with another repair case.');
    return { case: await getLifecycleRepairCase(args.caseId), execution: existingAttempt, idempotent: true };
  }
  const repairCase = await prisma.lifecycleRepairCase.findUnique({ where: { id: args.caseId }, include: { tradingAccount: true, executions: true } });
  if (!repairCase) throw new HttpError(404, 'Lifecycle repair case not found.');
  let handler;
  try { handler = getLifecycleRepairHandlerMetadata(repairCase.repairType); }
  catch { throw new HttpError(409, 'Unknown or unsupported repair type or impact.'); }
  if (repairCase.impact !== handler.impact) throw new HttpError(409, 'Unknown or unsupported repair impact.');
  if (repairCase.tradingAccount.environment !== 'PAPER') throw new HttpError(409, 'Lifecycle repair Apply is PAPER-only. LIVE diagnosis remains read-only.');
  if (repairCase.expiresAt <= new Date()) throw new HttpError(409, 'Lifecycle repair case expired. Diagnose again.');
  const newerCase = await prisma.lifecycleRepairCase.findFirst({ where: { repairType: repairCase.repairType, targetType: repairCase.targetType, targetId: repairCase.targetId, createdAt: { gt: repairCase.createdAt } }, select: { id: true } });
  if (newerCase) throw new HttpError(409, 'Lifecycle repair case was superseded by a newer diagnosis.');
  if (!repairCase.executableAtCreation || repairCase.confidence !== 'DETERMINISTIC') throw new HttpError(409, 'Automatic repair unavailable — manual review required.');
  const prior = repairCase.executions.find((row) => row.result === 'SUCCEEDED');
  if (prior) return { case: await getLifecycleRepairCase(args.caseId), execution: prior, idempotent: true };

  const runId = randomUUID();
  const lock = await withTradingAccountWorkflowLock({
    tradingAccountId: repairCase.tradingAccountId,
    workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.EXIT_EVALUATION,
    processInstanceId: runId,
    execute: async () => {
      const frozenAssessedAt = getFrozenPositionAttributionAssessedAt(
        repairCase.proposedMutationsJson
      );
      const rechecked = await buildDiagnosis({ tradingAccountId: repairCase.tradingAccountId, trackedPositionId: Number(repairCase.targetId), assessedAt: frozenAssessedAt });
      if (!positionAttributionRevalidationMatches({
        rechecked,
        frozen: {
          localLifecycleFingerprint: repairCase.localLifecycleFingerprint,
          configurationFingerprint: repairCase.configurationFingerprint,
          proposedMutationsJson: repairCase.proposedMutationsJson,
          evidenceJson: repairCase.evidenceJson,
        },
      })) {
        throw new HttpError(409, 'Lifecycle repair case is superseded because target, configuration, or authoritative evidence changed.');
      }
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "TrackedPosition" WHERE id = ${Number(repairCase.targetId)} FOR UPDATE`;
        const current = await tx.trackedPosition.findFirst({ where: { id: Number(repairCase.targetId), tradingAccountId: repairCase.tradingAccountId }, include: positionInclude });
        if (!current || fingerprint(localState(current)) !== repairCase.localLifecycleFingerprint) throw new HttpError(409, 'Lifecycle repair target changed after final validation.');
        const proposal = repairCase.proposedMutationsJson as any;
        const assignmentId = proposal.trackedPosition.tradingAccountSubscriptionId.after as number;
        const subscriptionId = proposal.trackedPosition.subscriptionId.after as number;
        const updatedCount = await tx.trackedPosition.updateMany({
          where: { id: current.id, tradingAccountId: repairCase.tradingAccountId, subscriptionId: null, tradingAccountSubscriptionId: null, configSnapshotJson: { equals: Prisma.DbNull } },
          data: { subscriptionId, tradingAccountSubscriptionId: assignmentId, configSnapshotJson: proposal.trackedPosition.configSnapshotJson.after, configSnapshotCapturedAt: new Date(proposal.trackedPosition.configSnapshotCapturedAt.after) },
        });
        if (updatedCount.count !== 1) throw new HttpError(409, 'Lifecycle repair target changed during apply.');
        const exitAfter = proposal.positionExitState.after;
        let exitState;
        if (current.exitState) {
          if (!isPristinePositionExitState(current.exitState)) throw new HttpError(409, 'Position exit state is no longer pristine.');
          exitState = await tx.positionExitState.update({ where: { id: current.exitState.id }, data: exitAfter });
        } else {
          exitState = await tx.positionExitState.create({ data: { trackedPositionId: current.id, ...exitAfter } });
        }
        const updated = await tx.trackedPosition.findUniqueOrThrow({ where: { id: current.id }, include: positionInclude });
        const validation = {
          valid: updated.subscriptionId === subscriptionId && updated.tradingAccountSubscriptionId === assignmentId && stable(updated.configSnapshotJson) === stable(proposal.trackedPosition.configSnapshotJson.after) && exitState.exitProfileKey === exitAfter.exitProfileKey,
          checks: { attribution: true, frozenSnapshot: true, exitStateHydrated: true, brokerMutationPerformed: false },
        };
        if (!validation.valid) throw new Error('Post-repair structural validation failed.');
        const after = transactionAfter(updated, exitState);
        const execution = await tx.lifecycleRepairExecution.create({ data: {
          caseId: repairCase.id, attemptKey: args.attemptKey, result: 'SUCCEEDED',
          executedByUserId: args.actorUserId, reason: args.reason,
          confirmation: args.confirmation, diagnosticFingerprint: repairCase.diagnosticFingerprint,
          beforeJson: json(repairCase.beforeJson), afterJson: json(after), validationJson: json(validation),
        } });
        await tx.systemEvent.create({ data: {
          type: 'lifecycle_repair.position_attribution_resolved', entityType: 'trackedPosition', entityId: repairCase.targetId,
          tradingAccountId: repairCase.tradingAccountId, actorUserId: args.actorUserId,
          message: `Applied deterministic local position-attribution repair for ${updated.symbol}.`,
          payloadJson: json({ caseId: repairCase.id, executionId: execution.id, repairType: repairCase.repairType, impact: 'LOCAL_ONLY', confidence: repairCase.confidence, resolutionSource: repairCase.resolutionSource, diagnosticFingerprint: repairCase.diagnosticFingerprint, brokerImpact: BROKER_IMPACT }),
        } });
        return execution;
      });
    },
  });
  if (lock.outcome !== 'ACQUIRED_AND_COMPLETED') {
    const error = lock.outcome === 'WORKFLOW_ERROR' || lock.outcome === 'LOCK_ERROR' ? lock.error : new HttpError(409, 'Exit-evaluation lock is busy; retry the repair.');
    try {
      await prisma.lifecycleRepairExecution.create({ data: {
        caseId: repairCase.id, attemptKey: args.attemptKey, result: 'FAILED', executedByUserId: args.actorUserId,
        reason: args.reason, confirmation: args.confirmation, diagnosticFingerprint: repairCase.diagnosticFingerprint,
        beforeJson: json(repairCase.beforeJson), failureJson: json({ message: error instanceof Error ? error.message : 'Repair failed.', code: error instanceof HttpError ? error.statusCode : 500 }),
      } });
    } catch { /* A concurrent retry may already own the attempt key. */ }
    throw error;
  }
  return { case: await getLifecycleRepairCase(args.caseId), execution: lock.value, idempotent: false };
}
