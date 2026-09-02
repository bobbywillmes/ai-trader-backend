import { createHash } from 'node:crypto';
import {
  LifecycleRepairActionStatus,
  LifecycleRepairActionType,
  LifecycleRepairConfidence,
  LifecycleRepairExecutionResult,
  Prisma,
  SystemEventSeverity,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import {
  assessHistoricalFullFillEvidence,
  diagnoseHistoricalOrderLifecycle,
} from './historical-order-lifecycle-diagnostic.service.js';
import { isTerminalBrokerOrderStatus } from './broker-order-lifecycle-status.service.js';
import { withTradingAccountWorkflowLock } from './trading-account-workflow-lock.service.js';
import { createSystemEvent } from './system-event.service.js';

export const HISTORICAL_ENTRY_REPAIR_TYPE = 'REPAIR_HISTORICAL_ENTRY_LIFECYCLE' as const;
export const TERMINALIZE_CONFIRMATION = 'TERMINALIZE HISTORICAL ORDER LIFECYCLE';
export const LINK_CONFIRMATION = 'LINK HISTORICAL ENTRY LIFECYCLE';
const CASE_TTL_MS = 10 * 60_000;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}

const orderInclude = {
  tradingAccount: { select: { id: true, displayName: true, environment: true } },
  orderIntent: true,
  brokerActivities: { orderBy: { transactionTime: 'asc' as const } },
  trackedPosition: true,
} satisfies Prisma.BrokerOrderInclude;

function lifecycleState(order: any) {
  return {
    brokerOrder: {
      id: order.id, tradingAccountId: order.tradingAccountId, broker: order.broker,
      brokerOrderId: order.brokerOrderId, clientOrderId: order.clientOrderId,
      symbol: order.symbol, side: order.side, status: order.status,
      trackedPositionId: order.trackedPositionId,
    },
    orderIntent: {
      id: order.orderIntent.id, tradingAccountId: order.orderIntent.tradingAccountId,
      status: order.orderIntent.status, qty: order.orderIntent.qty,
      subscriptionId: order.orderIntent.subscriptionId,
      tradingAccountSubscriptionId: order.orderIntent.tradingAccountSubscriptionId,
      trackedPositionId: order.orderIntent.trackedPositionId,
    },
    activities: order.brokerActivities.map((activity: any) => ({
      id: activity.id, activityId: activity.activityId, broker: activity.broker,
      orderId: activity.orderId, activityType: activity.activityType,
      tradingAccountId: activity.tradingAccountId,
      brokerOrderRecordId: activity.brokerOrderRecordId,
      orderIntentId: activity.orderIntentId, trackedPositionId: activity.trackedPositionId,
      qty: activity.qty, cumQty: activity.cumQty, leavesQty: activity.leavesQty,
      price: activity.price, transactionTime: activity.transactionTime?.toISOString() ?? null,
    })),
  };
}

async function buildPreviewEvidence(attentionId: number) {
  const attention = await prisma.operationalAttention.findUnique({ where: { id: attentionId } });
  if (!attention || attention.code !== 'HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE' || !attention.brokerOrderId) {
    throw new HttpError(404, 'Historical lifecycle Operational Attention was not found.');
  }
  const order = await prisma.brokerOrder.findFirst({
    where: { id: attention.brokerOrderId, tradingAccountId: attention.tradingAccountId },
    include: orderInclude,
  });
  if (!order || order.side.toLowerCase() !== 'buy') throw new HttpError(409, 'Historical entry lifecycle is no longer eligible.');

  const assessment = assessHistoricalFullFillEvidence({
    orderQty: order.orderIntent.qty,
    tradingAccountId: attention.tradingAccountId,
    brokerOrderRecordId: order.id,
    brokerOrderId: order.brokerOrderId,
    activities: order.brokerActivities,
  });
  const diagnostic = await diagnoseHistoricalOrderLifecycle({
    tradingAccountId: attention.tradingAccountId,
    openOrders: [], lookupBudget: 0, includeTerminalMissingPositionLinks: true,
  });
  const row = diagnostic.candidates.find((candidate) => candidate.brokerOrderRecordId === order.id);
  if (!row || assessment.summary.classification !== 'full') throw new HttpError(409, 'Conclusive local full-fill evidence is no longer present.');

  const evaluations = row.candidatePositionEvaluations;
  const priceOnly = evaluations.filter((item) => item.rejectionReasons.length === 1 && item.rejectionReasons[0] === 'price_outside_tolerance');
  const candidateIds = [...new Set([...evaluations.map((item) => item.trackedPositionId), ...row.candidateTrackedPositionIds])];
  const positions = candidateIds.length ? await prisma.trackedPosition.findMany({
    where: { id: { in: candidateIds }, tradingAccountId: attention.tradingAccountId },
    include: { brokerActivities: true, orderIntents: true, brokerOrders: true },
  }) : [];
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const compelling = priceOnly.length === 1 ? positionById.get(priceOnly[0]!.trackedPositionId) : null;
  const completionTime = row.fillEvidence.completionTime ? new Date(row.fillEvidence.completionTime) : null;
  const competingOrders = completionTime ? await prisma.brokerOrder.count({
    where: {
      id: { not: order.id }, tradingAccountId: attention.tradingAccountId,
      symbol: order.symbol, side: { equals: 'buy', mode: 'insensitive' },
      createdAt: { gte: new Date(completionTime.getTime() - 5_000), lte: new Date(completionTime.getTime() + 5_000) },
    },
  }) : 1;
  const preceding = compelling ? await prisma.trackedPosition.findFirst({
    where: {
      id: { not: compelling.id }, tradingAccountId: attention.tradingAccountId,
      broker: order.broker, symbol: order.symbol, status: 'closed',
      closedAt: { lte: compelling.openedAt },
    }, orderBy: { closedAt: 'desc' },
  }) : null;
  const exitEvidence = compelling?.brokerActivities.some((activity) => activity.side?.toLowerCase() === 'sell' && activity.activityType.toUpperCase() === 'FILL') ?? false;
  const linkConflicts = new Set([
    order.trackedPositionId, order.orderIntent.trackedPositionId,
    ...order.brokerActivities.map((activity) => activity.trackedPositionId),
  ].filter((id): id is number => id !== null));
  const candidateApplicable = Boolean(
    compelling && compelling.status === 'closed' && compelling.closedAt && preceding && exitEvidence &&
    competingOrders === 0 && linkConflicts.size === 0
  );
  const unresolvedComponents = [
    ...(!isTerminalBrokerOrderStatus(order.status) || !isTerminalBrokerOrderStatus(order.orderIntent.status) ? ['STALE_ORDER_STATUS'] : []),
    ...(linkConflicts.size === 0 ? ['MISSING_POSITION_LINK'] : []),
  ];
  const evidence = {
    attention: { id: attention.id, revision: attention.revision, fingerprint: attention.fingerprint },
    unresolvedComponents,
    lifecycle: lifecycleState(order), fillAssessment: assessment,
    positionCandidates: evaluations.map((evaluation) => ({
      ...evaluation,
      position: positionById.get(evaluation.trackedPositionId) ? {
        id: positionById.get(evaluation.trackedPositionId)!.id,
        status: positionById.get(evaluation.trackedPositionId)!.status,
        qty: positionById.get(evaluation.trackedPositionId)!.qty,
        avgEntryPrice: positionById.get(evaluation.trackedPositionId)!.avgEntryPrice,
        openedAt: positionById.get(evaluation.trackedPositionId)!.openedAt.toISOString(),
        closedAt: positionById.get(evaluation.trackedPositionId)!.closedAt?.toISOString() ?? null,
      } : null,
    })),
    compellingCandidate: compelling ? {
      id: compelling.id, closed: compelling.status === 'closed', precedingClosedPositionId: preceding?.id ?? null,
      subsequentExitEvidence: exitEvidence, competingOpeningOrderCount: competingOrders,
      fillPrice: row.fillEvidence.weightedAveragePrice, brokerAverageEntryPrice: compelling.avgEntryPrice,
      priceDifference: row.fillEvidence.weightedAveragePrice === null ? null : compelling.avgEntryPrice - row.fillEvidence.weightedAveragePrice,
      arithmeticCorroboration: { authoritative: false, explanation: 'Broker average arithmetic is displayed only as corroboration and never changes either stored price.' },
    } : null,
    candidateApplicable,
  };
  return { attention, order, row, assessment, evidence, compelling, unresolvedComponents };
}

export async function previewHistoricalEntryLifecycleRepair(args: { attentionId: number; actorUserId: number }) {
  const built = await buildPreviewEvidence(args.attentionId);
  const before = lifecycleState(built.order);
  const diagnosticFingerprint = hash(built.evidence);
  const expiresAt = new Date(Date.now() + CASE_TTL_MS);
  const proposals: Array<{
    actionType: LifecycleRepairActionType;
    classification: 'DETERMINISTIC' | 'OPERATOR_CONFIRMATION_REQUIRED';
    mutations: unknown; preconditions: unknown; evidence: unknown;
  }> = [];
  if (built.unresolvedComponents.includes('STALE_ORDER_STATUS') && built.assessment.deterministic) {
    proposals.push({
      actionType: LifecycleRepairActionType.TERMINALIZE_ORDER_LIFECYCLE,
      classification: 'DETERMINISTIC',
      mutations: { brokerOrder: { id: built.order.id, status: { before: built.order.status, after: 'filled' } }, orderIntent: { id: built.order.orderIntentId, status: { before: built.order.orderIntent.status, after: 'filled' } } },
      preconditions: { fullFillEvidenceMustRemainDeterministic: true, noBrokerWrite: true },
      evidence: built.assessment,
    });
  }
  if (built.unresolvedComponents.includes('MISSING_POSITION_LINK') && built.evidence.candidateApplicable && built.compelling) {
    proposals.push({
      actionType: LifecycleRepairActionType.LINK_ENTRY_LIFECYCLE_TO_POSITION,
      classification: 'OPERATOR_CONFIRMATION_REQUIRED',
      mutations: {
        trackedPositionId: built.compelling.id,
        orderIntentId: built.order.orderIntentId,
        brokerOrderRecordId: built.order.id,
        brokerActivityIds: built.assessment.ownedActivityIds,
      },
      preconditions: { candidateMustRemainClosed: true, linksMustRemainNull: true, strictPriceMismatchIsNotOverridden: true, noBrokerWrite: true },
      evidence: built.evidence.compellingCandidate,
    });
  }
  const repairCase = await prisma.$transaction(async (tx) => {
    const prior = await tx.lifecycleRepairCase.findMany({
      where: { repairType: HISTORICAL_ENTRY_REPAIR_TYPE, targetType: 'BrokerOrder', targetId: String(built.order.id) },
      include: { actions: true },
    });
    await tx.lifecycleRepairAction.updateMany({
      where: { caseId: { in: prior.map((item) => item.id) }, status: { in: ['PROPOSED', 'APPROVED', 'FAILED'] } },
      data: { status: 'SUPERSEDED', decidedAt: new Date(), decisionReason: 'Superseded by freshly validated evidence.', revision: { increment: 1 } },
    });
    return tx.lifecycleRepairCase.create({
      data: {
        repairType: HISTORICAL_ENTRY_REPAIR_TYPE, repairVersion: 1, impact: 'LOCAL_ONLY', source: 'RECONCILIATION',
        tradingAccountId: built.order.tradingAccountId!, targetType: 'BrokerOrder', targetId: String(built.order.id),
        confidence: proposals.some((item) => item.classification === 'OPERATOR_CONFIRMATION_REQUIRED') ? LifecycleRepairConfidence.STRONG : LifecycleRepairConfidence.DETERMINISTIC,
        resolutionSource: 'local_full_fill_evidence', diagnosticFingerprint,
        localLifecycleFingerprint: hash(before), evidenceJson: json(built.evidence),
        candidateResolutionsJson: json(built.evidence.positionCandidates), rejectedAlternativesJson: json([]),
        beforeJson: json(before), proposedMutationsJson: json(proposals.map((item) => item.mutations)),
        preconditionsJson: json({ attentionRevision: built.attention.revision, noBrokerImpact: true }),
        brokerImpactJson: json({ impact: 'LOCAL_ONLY', brokerCalls: 'NONE', brokerWrites: 'NONE', exposureChanges: 'NONE', financialValueChanges: 'NONE' }),
        executableAtCreation: proposals.length > 0, nonExecutableReasonsJson: json(proposals.length ? [] : ['no_safe_action']),
        createdByUserId: args.actorUserId, expiresAt,
        actions: { create: proposals.map((proposal, ordinal) => ({
          actionType: proposal.actionType, ordinal, classification: proposal.classification,
          actionFingerprint: hash({ diagnosticFingerprint, actionType: proposal.actionType, proposal: proposal.mutations }),
          proposedMutationsJson: json(proposal.mutations), preconditionsJson: json(proposal.preconditions),
          evidenceJson: json(proposal.evidence), beforeJson: json(before),
        })) },
      }, include: { tradingAccount: true, actions: { include: { executions: true } }, executions: true },
    });
  });
  return repairCase;
}

export async function decideHistoricalLifecycleAction(args: {
  actionId: number; actorUserId: number; expectedRevision: number; decision: 'APPROVE' | 'REFUSE'; reason: string;
}) {
  if (!args.reason.trim()) throw new HttpError(400, 'Decision reason is required.');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "LifecycleRepairAction" WHERE id = ${args.actionId} FOR UPDATE`;
    const action = await tx.lifecycleRepairAction.findUnique({ where: { id: args.actionId }, include: { repairCase: true } });
    if (!action) throw new HttpError(404, 'Lifecycle repair action not found.');
    if (action.repairCase.repairType !== HISTORICAL_ENTRY_REPAIR_TYPE) throw new HttpError(409, 'Action belongs to a different repair handler.');
    if (action.revision !== args.expectedRevision || action.status !== LifecycleRepairActionStatus.PROPOSED) throw new HttpError(409, 'Lifecycle repair action is stale or already decided.');
    const status = args.decision === 'APPROVE' ? LifecycleRepairActionStatus.APPROVED : LifecycleRepairActionStatus.REFUSED;
    const updated = await tx.lifecycleRepairAction.update({ where: { id: action.id }, data: {
      status, revision: { increment: 1 }, decidedByUserId: args.actorUserId,
      decidedByUserIdSnapshot: args.actorUserId, decidedAt: new Date(), decisionReason: args.reason.trim(),
    } });
    await createSystemEvent({
      type: args.decision === 'APPROVE' ? 'lifecycle_repair.action_approved' : 'lifecycle_repair.action_refused',
      entityType: 'lifecycleRepairAction', entityId: action.id, tradingAccountId: action.repairCase.tradingAccountId,
      actorUserId: args.actorUserId, severity: SystemEventSeverity.INFO,
      message: `${action.actionType} was ${args.decision === 'APPROVE' ? 'approved' : 'refused'}.`,
      payloadJson: json({ caseId: action.caseId, actionId: action.id, actionType: action.actionType, actionFingerprint: action.actionFingerprint, reason: args.reason.trim() }),
    }, tx);
    return updated;
  });
}

export async function applyHistoricalLifecycleAction(args: {
  actionId: number; actorUserId: number; expectedRevision: number; reason: string; confirmation: string; attemptKey: string;
}) {
  const existing = await prisma.lifecycleRepairExecution.findUnique({ where: { attemptKey: args.attemptKey } });
  if (existing) {
    if (existing.actionId !== args.actionId) throw new HttpError(409, 'Attempt key belongs to another action.');
    return { execution: existing, idempotent: true };
  }
  const action = await prisma.lifecycleRepairAction.findUnique({ where: { id: args.actionId }, include: { repairCase: { include: { tradingAccount: true } } } });
  if (!action) throw new HttpError(404, 'Lifecycle repair action not found.');
  const expectedConfirmation = action.actionType === LifecycleRepairActionType.TERMINALIZE_ORDER_LIFECYCLE ? TERMINALIZE_CONFIRMATION : LINK_CONFIRMATION;
  if (args.confirmation !== expectedConfirmation) throw new HttpError(400, 'Invalid action-specific confirmation.');
  if (action.repairCase.tradingAccount.environment !== 'PAPER') throw new HttpError(409, 'Historical lifecycle repair Apply is PAPER-only. LIVE preview remains read-only.');
  if (action.status !== LifecycleRepairActionStatus.APPROVED || action.revision !== args.expectedRevision) throw new HttpError(409, 'Action is not approved at the expected revision.');
  if (action.repairCase.expiresAt <= new Date()) throw new HttpError(409, 'Repair preview expired. Refresh it.');
  const lock = await withTradingAccountWorkflowLock({
    tradingAccountId: action.repairCase.tradingAccountId, workflowKey: 'historical-entry-lifecycle-repair', processInstanceId: args.attemptKey,
    execute: async () => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "LifecycleRepairCase" WHERE id = ${action.caseId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "LifecycleRepairAction" WHERE id = ${action.id} FOR UPDATE`;
      const currentAction = await tx.lifecycleRepairAction.findUniqueOrThrow({ where: { id: action.id } });
      if (currentAction.status !== 'APPROVED' || currentAction.revision !== args.expectedRevision) throw new HttpError(409, 'Action changed before Apply.');
      const built = await buildPreviewEvidenceForTransaction(tx, action.repairCase.tradingAccountId, Number(action.repairCase.targetId));
      const proposal = action.proposedMutationsJson as any;
      let after: unknown;
      if (action.actionType === LifecycleRepairActionType.TERMINALIZE_ORDER_LIFECYCLE) {
        if (!built.assessment.deterministic) throw new HttpError(409, 'Full-fill evidence changed or became contradictory.');
        await tx.brokerOrder.updateMany({ where: { id: built.order.id, tradingAccountId: built.order.tradingAccountId, status: proposal.brokerOrder.status.before }, data: { status: 'filled' } });
        await tx.orderIntent.updateMany({ where: { id: built.order.orderIntentId, tradingAccountId: built.order.tradingAccountId, status: proposal.orderIntent.status.before }, data: { status: 'filled' } });
      } else {
        const positionId = Number(proposal.trackedPositionId);
        await tx.$queryRaw`SELECT id FROM "TrackedPosition" WHERE id = ${positionId} FOR UPDATE`;
        const position = await tx.trackedPosition.findFirst({ where: { id: positionId, tradingAccountId: built.order.tradingAccountId, status: 'closed' } });
        if (!position || built.existingLinkIds.length) throw new HttpError(409, 'Position candidate or lifecycle links changed.');
        await tx.orderIntent.updateMany({ where: { id: built.order.orderIntentId, trackedPositionId: null }, data: { trackedPositionId: positionId } });
        await tx.brokerOrder.updateMany({ where: { id: built.order.id, trackedPositionId: null }, data: { trackedPositionId: positionId } });
        await tx.brokerActivity.updateMany({ where: { id: { in: proposal.brokerActivityIds }, brokerOrderRecordId: built.order.id, orderIntentId: built.order.orderIntentId, trackedPositionId: null }, data: { trackedPositionId: positionId, trackedPositionLinkSource: 'historical_order_lifecycle_repair', trackedPositionLinkedAt: new Date() } });
      }
      const refreshed = await tx.brokerOrder.findUniqueOrThrow({ where: { id: built.order.id }, include: { orderIntent: true, brokerActivities: true } });
      after = lifecycleState(refreshed);
      const execution = await tx.lifecycleRepairExecution.create({ data: {
        caseId: action.caseId, actionId: action.id, attemptKey: args.attemptKey, result: LifecycleRepairExecutionResult.SUCCEEDED,
        executedByUserId: args.actorUserId, reason: args.reason, confirmation: args.confirmation,
        diagnosticFingerprint: action.repairCase.diagnosticFingerprint, beforeJson: json(action.beforeJson), afterJson: json(after),
        validationJson: json({ valid: true, brokerCalls: 0, exposureChanged: false, financialValuesChanged: false }),
      } });
      await tx.lifecycleRepairAction.update({ where: { id: action.id }, data: { status: 'VERIFIED', revision: { increment: 1 }, afterJson: json(after), verificationJson: json({ valid: true, verifiedAt: new Date().toISOString() }) } });
      await tx.lifecycleRepairAction.updateMany({ where: { caseId: action.caseId, id: { not: action.id }, status: { in: ['PROPOSED', 'APPROVED'] } }, data: { status: 'SUPERSEDED', decidedAt: new Date(), decisionReason: 'Sibling action applied; refresh authoritative evidence.', revision: { increment: 1 } } });
      await createSystemEvent({ type: 'lifecycle_repair.action_applied', entityType: 'lifecycleRepairAction', entityId: action.id, tradingAccountId: built.order.tradingAccountId, actorUserId: args.actorUserId, severity: SystemEventSeverity.INFO, message: `${action.actionType} was applied and structurally verified.`, payloadJson: json({ caseId: action.caseId, actionId: action.id, executionId: execution.id, brokerImpact: 'NONE' }) }, tx);
      return execution;
    }),
  });
  if (lock.outcome !== 'ACQUIRED_AND_COMPLETED') throw (lock.outcome === 'WORKFLOW_ERROR' || lock.outcome === 'LOCK_ERROR' ? lock.error : new HttpError(409, 'Lifecycle repair lock is busy.'));
  return { execution: lock.value, idempotent: false };
}

async function buildPreviewEvidenceForTransaction(tx: Prisma.TransactionClient, tradingAccountId: number, brokerOrderId: number) {
  await tx.$queryRaw`SELECT id FROM "BrokerOrder" WHERE id = ${brokerOrderId} FOR UPDATE`;
  const order = await tx.brokerOrder.findFirst({ where: { id: brokerOrderId, tradingAccountId }, include: { orderIntent: true, brokerActivities: true } });
  if (!order) throw new HttpError(409, 'Lifecycle target changed.');
  await tx.$queryRaw`SELECT id FROM "OrderIntent" WHERE id = ${order.orderIntentId} FOR UPDATE`;
  const activityIds = order.brokerActivities.map((item) => item.id);
  if (activityIds.length) await tx.$queryRawUnsafe(`SELECT id FROM "BrokerActivity" WHERE id IN (${activityIds.map((_, index) => `$${index + 1}`).join(',')}) FOR UPDATE`, ...activityIds);
  const assessment = assessHistoricalFullFillEvidence({ orderQty: order.orderIntent.qty, tradingAccountId, brokerOrderRecordId: order.id, brokerOrderId: order.brokerOrderId, activities: order.brokerActivities });
  return { order, assessment, existingLinkIds: [...new Set([order.trackedPositionId, order.orderIntent.trackedPositionId, ...order.brokerActivities.map((item) => item.trackedPositionId)].filter((id): id is number => id !== null))] };
}
