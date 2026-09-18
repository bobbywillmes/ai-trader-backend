import type { Prisma, SignalEvaluationGateResult, SignalEvaluationOutcome } from '@prisma/client';
import { prisma } from '../db/prisma.js';

// Read-only trading context; the only write capabilities are evidence and diagnostics.
type EvaluationDb = Pick<Prisma.TransactionClient, '$queryRaw'> & {
  signalRoute: Pick<Prisma.TransactionClient['signalRoute'], 'findUnique'>;
  signalEvaluation: Pick<Prisma.TransactionClient['signalEvaluation'], 'findUnique' | 'create'>;
  tradingAccountSubscription: Pick<Prisma.TransactionClient['tradingAccountSubscription'], 'findUnique'>;
  trackedPosition: Pick<Prisma.TransactionClient['trackedPosition'], 'findMany'>;
  systemEvent: Pick<Prisma.TransactionClient['systemEvent'], 'create'>;
};
export const evaluationInclude = { gates: { orderBy: { sequence: 'asc' as const } } };

export async function evaluateSignalRouteInTransaction(signalRouteId: number, db: EvaluationDb) {
  await db.$queryRaw`SELECT id FROM "SignalRoute" WHERE id = ${signalRouteId} FOR UPDATE`;
  const existing = await db.signalEvaluation.findUnique({ where: { signalRouteId }, include: evaluationInclude });
  if (existing) return existing;
  const route = await db.signalRoute.findUnique({ where: { id: signalRouteId }, include: { routingRun: { include: { signal: true } } } });
  if (!route || route.evaluationVersion === null) return null;
  const startedAt = new Date();
  const signal = route.routingRun.signal;
  const entry = signal.event === 'ENTRY_LONG';
  const gates: Prisma.SignalEvaluationGateCreateWithoutEvaluationInput[] = [];
  let prospectiveExitManagementMode: 'BACKEND_MANAGED' | 'EXTERNAL_SIGNAL' | null = null;
  let positionExitManagementMode: 'BACKEND_MANAGED' | 'EXTERNAL_SIGNAL' | null = null;
  let trackedPositionId: number | null = null;
  let positionExitStateId: number | null = null;
  function gate(gateKey: string, result: SignalEvaluationGateResult, reasonCode: string | null = null,
    evidenceJson?: Prisma.InputJsonObject) {
    gates.push({ sequence: gates.length + 1, gateKey, result, reasonCode, evaluatedAt: new Date(),
      ...(evidenceJson ? { evidenceJson } : {}) });
  }
  async function finish(outcome: SignalEvaluationOutcome | null, reasonCode: string | null = null) {
    const evaluation = await db.signalEvaluation.create({ data: {
      signalRouteId, evaluationVersion: route!.evaluationVersion!, event: signal.event,
      intent: entry ? 'ENTRY' : 'EXIT', riskDirection: entry ? 'RISK_INCREASING' : 'RISK_REDUCING',
      status: outcome === null ? 'FAILED' : 'COMPLETED', outcome, reasonCode,
      prospectiveExitManagementMode, positionExitManagementMode, trackedPositionId, positionExitStateId,
      gateCount: gates.length, startedAt, completedAt: new Date(), gates: { create: gates },
    }, include: evaluationInclude });
    if (outcome === null) await db.systemEvent.create({ data: {
      type: 'external_signal_evaluation_failed', entityType: 'signal_evaluation', entityId: String(evaluation.id),
      tradingAccountId: route!.tradingAccountId, severity: 'ERROR',
      message: 'External signal evaluation failed closed.', payloadJson: { signalRouteId, reasonCode },
    } });
    return evaluation;
  }
  const assignment = await db.tradingAccountSubscription.findUnique({ where: { id: route.tradingAccountSubscriptionId },
    select: { id: true, tradingAccountId: true, subscriptionId: true, enabled: true, entriesEnabled: true, exitsEnabled: true,
      subscription: { select: { id: true, strategyId: true, securityId: true, enabled: true, exitManagementMode: true } } } });
  if (route.evaluationVersion !== 1 || !assignment || assignment.tradingAccountId !== route.tradingAccountId ||
    assignment.subscriptionId !== route.subscriptionId || assignment.subscription.strategyId !== signal.strategyId ||
    assignment.subscription.securityId !== signal.securityId) {
    gate('ROUTE_TARGET', 'FAILED', 'ROUTE_TARGET_INTEGRITY');
    return finish(null, 'ROUTE_TARGET_INTEGRITY');
  }
  gate('ROUTE_TARGET', 'PASS', null, { tradingAccountId: route.tradingAccountId,
    tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId,
    strategyId: signal.strategyId, securityId: signal.securityId });
  if (entry) prospectiveExitManagementMode = assignment.subscription.exitManagementMode;
  if (!assignment.enabled) {
    gate('SUBSCRIPTION_ACTIVE', 'BLOCKED', 'SUBSCRIPTION_INACTIVE',
      { assignmentEnabled: false, subscriptionEnabled: assignment.subscription.enabled });
    return finish('BLOCKED', 'SUBSCRIPTION_INACTIVE');
  }
  if (!assignment.subscription.enabled) {
    gate('SUBSCRIPTION_ACTIVE', 'BLOCKED', 'SUBSCRIPTION_CATALOG_DISABLED',
      { assignmentEnabled: true, subscriptionEnabled: false });
    return finish('BLOCKED', 'SUBSCRIPTION_CATALOG_DISABLED');
  }
  gate('SUBSCRIPTION_ACTIVE', 'PASS', null, { assignmentEnabled: true, subscriptionEnabled: true });
  if (entry) {
    if (!assignment.entriesEnabled) {
      gate('ALLOW_NEW_ENTRIES', 'BLOCKED', 'NEW_ENTRIES_DISABLED', { entriesEnabled: false });
      return finish('BLOCKED', 'NEW_ENTRIES_DISABLED');
    }
    gate('ALLOW_NEW_ENTRIES', 'PASS', null, { entriesEnabled: true });
    gate('ENTRY_APPLICABILITY', 'PASS', null, { event: signal.event, prospectiveExitManagementMode });
    return finish('ELIGIBLE');
  }
  if (!assignment.exitsEnabled) {
    gate('ALLOW_EXIT_MANAGEMENT', 'BLOCKED', 'EXIT_MANAGEMENT_DISABLED', { exitsEnabled: false });
    return finish('BLOCKED', 'EXIT_MANAGEMENT_DISABLED');
  }
  gate('ALLOW_EXIT_MANAGEMENT', 'PASS', null, { exitsEnabled: true });
  const positions = await db.trackedPosition.findMany({ where: {
    tradingAccountId: route.tradingAccountId, tradingAccountSubscriptionId: route.tradingAccountSubscriptionId,
    subscriptionId: route.subscriptionId, securityId: signal.securityId, side: 'long', status: 'open',
  }, select: { id: true, exitState: { select: { id: true, exitManagementModeSnapshot: true, exitOwnershipProvenance: true } } },
  orderBy: { id: 'asc' }, take: 2 });
  if (positions.length === 0) {
    gate('MATCHING_POSITION', 'NO_ACTION', 'NO_MATCHING_OPEN_POSITION', { matchCount: 0 });
    return finish('NO_ACTION', 'NO_MATCHING_OPEN_POSITION');
  }
  if (positions.length !== 1) {
    gate('MATCHING_POSITION', 'FAILED', 'AMBIGUOUS_MATCHING_POSITIONS', { positionIds: positions.map(p => p.id) });
    return finish(null, 'AMBIGUOUS_MATCHING_POSITIONS');
  }
  const position = positions[0]!;
  trackedPositionId = position.id;
  gate('MATCHING_POSITION', 'PASS', null, { trackedPositionId });
  if (!position.exitState) {
    gate('EXIT_MANAGEMENT_MODE', 'FAILED', 'MISSING_POSITION_EXIT_SNAPSHOT');
    return finish(null, 'MISSING_POSITION_EXIT_SNAPSHOT');
  }
  positionExitStateId = position.exitState.id;
  positionExitManagementMode = position.exitState.exitManagementModeSnapshot;
  const external = positionExitManagementMode === 'EXTERNAL_SIGNAL';
  if (external) {
    const provenance = position.exitState.exitOwnershipProvenance as Prisma.JsonObject | null;
    if (!provenance || provenance.tradingAccountId !== route.tradingAccountId ||
      provenance.tradingAccountSubscriptionId !== route.tradingAccountSubscriptionId ||
      provenance.subscriptionId !== route.subscriptionId || provenance.strategyId !== signal.strategyId ||
      provenance.securityId !== signal.securityId) {
      gate('EXIT_MANAGEMENT_MODE', 'FAILED', 'POSITION_ORIGIN_INTEGRITY');
      return finish(null, 'POSITION_ORIGIN_INTEGRITY');
    }
  }
  gate('EXIT_MANAGEMENT_MODE', external ? 'PASS' : 'NO_ACTION', external ? null : 'EXTERNAL_EXIT_NOT_APPLICABLE',
    { positionExitStateId, exitManagementModeSnapshot: positionExitManagementMode });
  return finish(external ? 'ELIGIBLE' : 'NO_ACTION', external ? null : 'EXTERNAL_EXIT_NOT_APPLICABLE');
}

export function evaluateSignalRoute(signalRouteId: number, client = prisma) {
  return client.$transaction(db => evaluateNewSignalRoute(signalRouteId, db));
}

// An ingress evaluation error must not discard successfully normalized transport
// evidence. Savepoints also recover PostgreSQL's aborted-statement transaction state.
export async function evaluateNewSignalRoute(signalRouteId: number, db: Prisma.TransactionClient) {
  const startedAt = new Date();
  // Keep serialization even when the evaluation savepoint is rolled back.
  await db.$queryRaw`SELECT id FROM "SignalRoute" WHERE id = ${signalRouteId} FOR UPDATE`;
  await db.$executeRawUnsafe('SAVEPOINT external_signal_evaluation');
  try {
    const result = await evaluateSignalRouteInTransaction(signalRouteId, db);
    await db.$executeRawUnsafe('RELEASE SAVEPOINT external_signal_evaluation');
    return result;
  } catch {
    await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT external_signal_evaluation');
    const route = await db.signalRoute.findUniqueOrThrow({ where: { id: signalRouteId }, include: { routingRun: { include: { signal: true } } } });
    if (route.evaluationVersion === null) throw new Error('Historical routes cannot be evaluated.');
    const event = route.routingRun.signal.event;
    const completedAt = new Date();
    const reasonCode = 'EVALUATION_PROCESSING_FAILED';
    const result = await db.signalEvaluation.create({ data: {
      signalRouteId, evaluationVersion: route.evaluationVersion, event,
      intent: event === 'ENTRY_LONG' ? 'ENTRY' : 'EXIT',
      riskDirection: event === 'ENTRY_LONG' ? 'RISK_INCREASING' : 'RISK_REDUCING',
      status: 'FAILED', reasonCode, gateCount: 1, startedAt, completedAt,
      gates: { create: { sequence: 1, gateKey: 'PROCESSING', result: 'FAILED', reasonCode, evaluatedAt: completedAt } },
    }, include: evaluationInclude });
    await db.systemEvent.create({ data: {
      type: 'external_signal_evaluation_failed', entityType: 'signal_evaluation', entityId: String(result.id),
      tradingAccountId: route.tradingAccountId, severity: 'ERROR',
      message: 'External signal evaluation processing failed; normalized evidence was preserved.',
      payloadJson: { signalRouteId, reasonCode },
    } });
    await db.$executeRawUnsafe('RELEASE SAVEPOINT external_signal_evaluation');
    return result;
  }
}
