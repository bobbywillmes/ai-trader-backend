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
  classifyHistoricalLifecycleLinks,
  diagnoseHistoricalOrderLifecycle,
  HISTORICAL_PRICE_TOLERANCE,
  HISTORICAL_POSITION_TIME_TOLERANCE_MS,
  validateExistingHistoricalPositionLink,
} from './historical-order-lifecycle-diagnostic.service.js';
import { isTerminalBrokerOrderStatus } from './broker-order-lifecycle-status.service.js';
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES, withTradingAccountWorkflowLock } from './trading-account-workflow-lock.service.js';
import { createSystemEvent } from './system-event.service.js';

export const HISTORICAL_ENTRY_REPAIR_TYPE = 'REPAIR_HISTORICAL_ENTRY_LIFECYCLE' as const;
export const TERMINALIZE_CONFIRMATION = 'TERMINALIZE HISTORICAL ORDER LIFECYCLE';
export const LINK_CONFIRMATION = 'LINK HISTORICAL ENTRY LIFECYCLE';
const CASE_TTL_MS = 10 * 60_000;
const SAME_ATTEMPT_REPLAY_WAIT_MS = 1_000;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

type HistoricalActionProposal = {
  actionType: LifecycleRepairActionType;
  classification: 'DETERMINISTIC' | 'OPERATOR_CONFIRMATION_REQUIRED';
  mutations: any;
  preconditions: unknown;
  evidence: unknown;
};

function json(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function persistedJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown;
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
      trackedPositionLinkSource: activity.trackedPositionLinkSource,
      trackedPositionLinkedAt: activity.trackedPositionLinkedAt?.toISOString() ?? null,
      qty: activity.qty, cumQty: activity.cumQty, leavesQty: activity.leavesQty,
      price: activity.price, transactionTime: activity.transactionTime?.toISOString() ?? null,
    })),
  };
}

function protectedLifecycleValues(order: any) {
  return {
    brokerOrder: { id: order.id, orderIntentId: order.orderIntentId, tradingAccountId: order.tradingAccountId, broker: order.broker, brokerOrderId: order.brokerOrderId, clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, qty: order.qty, filledQty: order.filledQty, avgFillPrice: order.avgFillPrice, rawBrokerJson: order.rawBrokerJson, trackedPositionId: order.trackedPositionId },
    orderIntent: { id: order.orderIntent.id, tradingAccountId: order.orderIntent.tradingAccountId, symbol: order.orderIntent.symbol, side: order.orderIntent.side, qty: order.orderIntent.qty, limitPrice: order.orderIntent.limitPrice, stopPrice: order.orderIntent.stopPrice, createdAt: order.orderIntent.createdAt, trackedPositionId: order.orderIntent.trackedPositionId },
    activities: order.brokerActivities.map((item: any) => ({ id: item.id, activityId: item.activityId, orderId: item.orderId, brokerOrderRecordId: item.brokerOrderRecordId, orderIntentId: item.orderIntentId, qty: item.qty, cumQty: item.cumQty, leavesQty: item.leavesQty, price: item.price, transactionTime: item.transactionTime, rawBrokerJson: item.rawBrokerJson, trackedPositionId: item.trackedPositionId })),
  };
}

function withoutLifecycleLinks(value: ReturnType<typeof protectedLifecycleValues>) {
  return {
    brokerOrder: { ...value.brokerOrder, trackedPositionId: null },
    orderIntent: { ...value.orderIntent, trackedPositionId: null },
    activities: value.activities.map((item: any) => ({ ...item, trackedPositionId: null })),
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
    expectedBroker: order.broker,
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
  const window = completionTime ? { gte: new Date(completionTime.getTime() - HISTORICAL_POSITION_TIME_TOLERANCE_MS), lte: new Date(completionTime.getTime() + HISTORICAL_POSITION_TIME_TOLERANCE_MS) } : null;
  const competingOrders = window ? await prisma.brokerOrder.count({
    where: {
      id: { not: order.id }, tradingAccountId: attention.tradingAccountId,
      symbol: order.symbol, side: { equals: 'buy', mode: 'insensitive' },
      createdAt: window,
    },
  }) : 1;
  const competingIntents = window ? await prisma.orderIntent.count({ where: {
    id: { not: order.orderIntentId }, tradingAccountId: attention.tradingAccountId, symbol: order.symbol,
    side: { equals: 'buy', mode: 'insensitive' }, createdAt: window,
  } }) : 1;
  const competingFills = window ? await prisma.brokerActivity.count({ where: {
    id: { notIn: assessment.ownedActivityIds }, tradingAccountId: attention.tradingAccountId,
    broker: order.broker, symbol: order.symbol, side: { equals: 'buy', mode: 'insensitive' }, activityType: 'FILL', transactionTime: window,
  } }) : 1;
  const competingPositions = completionTime && compelling ? await prisma.trackedPosition.count({ where: {
    id: { not: compelling.id }, tradingAccountId: attention.tradingAccountId, broker: order.broker, symbol: order.symbol,
    openedAt: { lte: new Date(completionTime.getTime() + HISTORICAL_POSITION_TIME_TOLERANCE_MS) },
    OR: [{ closedAt: null }, { closedAt: { gte: new Date(completionTime.getTime() - HISTORICAL_POSITION_TIME_TOLERANCE_MS) } }],
  } }) : 1;
  const preceding = compelling ? await prisma.trackedPosition.findFirst({
    where: {
      id: { not: compelling.id }, tradingAccountId: attention.tradingAccountId,
      broker: order.broker, symbol: order.symbol, status: 'closed',
      closedAt: { lte: completionTime ?? compelling.openedAt },
    }, orderBy: { closedAt: 'desc' },
  }) : null;
  const exitEvidence = compelling?.brokerActivities.some((activity) => activity.side?.toLowerCase() === 'sell' && activity.activityType.toUpperCase() === 'FILL') ?? false;
  const linkConflicts = new Set([
    order.trackedPositionId, order.orderIntent.trackedPositionId,
    ...order.brokerActivities.map((activity) => activity.trackedPositionId),
  ].filter((id): id is number => id !== null));
  const candidateApplicable = Boolean(
    compelling && compelling.status === 'closed' && compelling.closedAt && preceding && exitEvidence &&
    competingOrders === 0 && competingIntents === 0 && competingFills === 0 && competingPositions === 0 &&
    linkConflicts.size === 0 && row.lifecycleLinkState.state === 'ALL_MISSING'
  );
  const unresolvedComponents = [
    ...(!isTerminalBrokerOrderStatus(order.status) || !isTerminalBrokerOrderStatus(order.orderIntent.status) ? ['STALE_ORDER_STATUS'] : []),
    ...(row.lifecycleLinkState.state === 'ALL_MISSING' ? ['MISSING_POSITION_LINK'] : []),
    ...(row.lifecycleLinkState.state === 'PARTIAL' ? ['PARTIAL_POSITION_LINK'] : []),
    ...(row.lifecycleLinkState.state === 'CONFLICTING' || (row.lifecycleLinkState.state === 'CONSISTENT' && row.existingPositionLinkValidation.status !== 'valid') ? ['CONFLICTING_POSITION_LINK'] : []),
  ];
  const evidence = {
    unresolvedComponents,
    lifecycle: lifecycleState(order), fillAssessment: assessment,
    positionCandidates: evaluations.map((evaluation) => ({
      ...evaluation,
      comparison: {
        fillDerivedExpectedPrice: row.fillEvidence.weightedAveragePrice,
        candidateAverageEntryPrice: positionById.get(evaluation.trackedPositionId)?.avgEntryPrice ?? null,
        absolutePriceDifference: row.fillEvidence.weightedAveragePrice === null || !positionById.has(evaluation.trackedPositionId)
          ? null
          : Math.abs(positionById.get(evaluation.trackedPositionId)!.avgEntryPrice - row.fillEvidence.weightedAveragePrice),
        priceTolerance: HISTORICAL_PRICE_TOLERANCE,
        fillCompletionAt: row.fillEvidence.completionTime,
        positionOpenedAt: positionById.get(evaluation.trackedPositionId)?.openedAt.toISOString() ?? null,
        absoluteTimeDifferenceMs: completionTime && positionById.has(evaluation.trackedPositionId)
          ? Math.abs(positionById.get(evaluation.trackedPositionId)!.openedAt.getTime() - completionTime.getTime())
          : null,
        timeToleranceMs: HISTORICAL_POSITION_TIME_TOLERANCE_MS,
      },
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
      competingOpeningIntentCount: competingIntents, competingFillCount: competingFills, competingPositionIntervalCount: competingPositions,
      fillPrice: row.fillEvidence.weightedAveragePrice, brokerAverageEntryPrice: compelling.avgEntryPrice,
      priceDifference: row.fillEvidence.weightedAveragePrice === null ? null : compelling.avgEntryPrice - row.fillEvidence.weightedAveragePrice,
      arithmeticCorroboration: { authoritative: false, explanation: 'Broker average arithmetic is displayed only as corroboration and never changes either stored price.' },
    } : null,
    candidateApplicable,
    lifecycleLinkState: row.lifecycleLinkState,
  };
  return { attention, observation: { attentionId: attention.id, revision: attention.revision, activeKey: attention.activeKey, status: attention.status }, order, row, assessment, evidence, compelling, unresolvedComponents };
}

function buildActionProposals(built: Awaited<ReturnType<typeof buildPreviewEvidence>>) {
  const proposals: HistoricalActionProposal[] = [];
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
      mutations: { trackedPositionId: built.compelling.id, orderIntentId: built.order.orderIntentId, brokerOrderRecordId: built.order.id, brokerActivityIds: built.assessment.ownedActivityIds },
      preconditions: { candidateMustRemainClosed: true, linksMustRemainNull: true, strictPriceMismatchIsNotOverridden: true, noBrokerWrite: true },
      evidence: built.evidence.compellingCandidate,
    });
  }
  return proposals;
}

export function historicalPreviewReuseDecision(args: {
  sameMaterialEvidence: boolean;
  expiresAt: Date;
  now: Date;
  actionStatuses: LifecycleRepairActionStatus[];
}) {
  if (!args.sameMaterialEvidence) return 'CREATE_GENERATION' as const;
  if (args.actionStatuses.includes(LifecycleRepairActionStatus.REFUSED)) return 'RETURN_IMMUTABLE_REFUSAL' as const;
  if (args.expiresAt > args.now && !args.actionStatuses.some((status) => status === LifecycleRepairActionStatus.FAILED || status === LifecycleRepairActionStatus.SUPERSEDED)) return 'RETURN_CURRENT' as const;
  return 'CREATE_GENERATION' as const;
}

export async function previewHistoricalEntryLifecycleRepair(args: { attentionId: number; actorUserId: number }) {
  const built = await buildPreviewEvidence(args.attentionId);
  const before = lifecycleState(built.order);
  const diagnosticFingerprint = hash(built.evidence);
  const expiresAt = new Date(Date.now() + CASE_TTL_MS);
  const proposals = buildActionProposals(built);
  const repairCase = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "OperationalAttention" WHERE id = ${built.attention.id} FOR UPDATE`;
    const prior = await tx.lifecycleRepairCase.findMany({
      where: { repairType: HISTORICAL_ENTRY_REPAIR_TYPE, targetType: 'BrokerOrder', targetId: String(built.order.id) },
      include: { tradingAccount: true, actions: { include: { executions: true }, orderBy: { ordinal: 'asc' } }, executions: true },
      orderBy: [{ generation: 'desc' }, { createdAt: 'desc' }],
    });
    const sameEvidence = prior.find((item) => item.diagnosticFingerprint === diagnosticFingerprint);
    const now = new Date();
    if (sameEvidence) {
      const decision = historicalPreviewReuseDecision({ sameMaterialEvidence: true, expiresAt: sameEvidence.expiresAt, now, actionStatuses: sameEvidence.actions.map((item) => item.status) });
      if (decision !== 'CREATE_GENERATION') return sameEvidence;
    }
    const supersededCase = sameEvidence ?? prior[0] ?? null;
    await tx.lifecycleRepairAction.updateMany({
      where: { caseId: { in: prior.map((item) => item.id) }, status: { in: ['PROPOSED', 'APPROVED'] } },
      data: { status: 'SUPERSEDED', decidedAt: new Date(), decisionReason: 'Superseded by freshly validated evidence.', revision: { increment: 1 } },
    });
    return tx.lifecycleRepairCase.create({
      data: {
        generation: (prior[0]?.generation ?? 0) + 1,
        operationalAttentionId: built.attention.id,
        supersedesCaseId: supersededCase?.id ?? null,
        repairType: HISTORICAL_ENTRY_REPAIR_TYPE, repairVersion: 1, impact: 'LOCAL_ONLY', source: 'RECONCILIATION',
        tradingAccountId: built.order.tradingAccountId!, targetType: 'BrokerOrder', targetId: String(built.order.id),
        confidence: proposals.some((item) => item.classification === 'OPERATOR_CONFIRMATION_REQUIRED') ? LifecycleRepairConfidence.STRONG : LifecycleRepairConfidence.DETERMINISTIC,
        resolutionSource: 'local_full_fill_evidence', diagnosticFingerprint,
        localLifecycleFingerprint: hash(before), evidenceJson: json(built.evidence),
        candidateResolutionsJson: json(built.evidence.positionCandidates), rejectedAlternativesJson: json([]),
        beforeJson: json(before), proposedMutationsJson: json(proposals.map((item) => item.mutations)),
        preconditionsJson: json({ attentionId: built.attention.id, attentionFingerprint: built.attention.fingerprint, attentionStatus: built.attention.status, noBrokerImpact: true }),
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

export async function reconsiderHistoricalLifecycleAction(args: {
  actionId: number; actorUserId: number; expectedRevision: number; reason: string;
}) {
  if (!args.reason.trim()) throw new HttpError(400, 'Reconsideration reason is required.');
  const source = await prisma.lifecycleRepairAction.findUnique({ where: { id: args.actionId }, include: { repairCase: true } });
  if (!source) throw new HttpError(404, 'Lifecycle repair action not found.');
  if (source.status !== 'REFUSED' || source.revision !== args.expectedRevision) throw new HttpError(409, 'Only the expected immutable refused action can be reconsidered.');
  const preconditions = source.repairCase.preconditionsJson as Record<string, unknown>;
  const attentionId = source.repairCase.operationalAttentionId ?? Number(preconditions.attentionId);
  const built = await buildPreviewEvidence(attentionId);
  if (hash(built.evidence) !== source.repairCase.diagnosticFingerprint) throw new HttpError(409, 'Material evidence changed. Create a fresh preview instead.');
  const proposal = buildActionProposals(built).find((item) => item.actionType === source.actionType);
  if (!proposal) throw new HttpError(409, 'The refused action is no longer safely proposal-eligible.');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "LifecycleRepairAction" WHERE id = ${source.id} FOR UPDATE`;
    const current = await tx.lifecycleRepairAction.findUniqueOrThrow({ where: { id: source.id } });
    if (current.status !== 'REFUSED' || current.revision !== args.expectedRevision) throw new HttpError(409, 'Refused action changed before reconsideration.');
    const existing = await tx.lifecycleRepairAction.findFirst({ where: { supersedesActionId: source.id }, orderBy: { generation: 'desc' } });
    if (existing) return existing;
    const last = await tx.lifecycleRepairAction.findFirst({ where: { caseId: source.caseId, actionType: source.actionType }, orderBy: { generation: 'desc' } });
    return tx.lifecycleRepairAction.create({ data: {
      caseId: source.caseId, actionType: source.actionType, ordinal: Math.max(...(await tx.lifecycleRepairAction.findMany({ where: { caseId: source.caseId }, select: { ordinal: true } })).map((item) => item.ordinal), -1) + 1,
      generation: (last?.generation ?? 0) + 1, classification: proposal.classification,
      actionFingerprint: hash({ diagnosticFingerprint: source.repairCase.diagnosticFingerprint, actionType: proposal.actionType, proposal: proposal.mutations }),
      proposedMutationsJson: json(proposal.mutations), preconditionsJson: json(proposal.preconditions), evidenceJson: json(proposal.evidence),
      beforeJson: json(source.beforeJson), supersedesActionId: source.id, reconsiderationReason: args.reason.trim(), reconsideredByUserIdSnapshot: args.actorUserId, reconsideredAt: new Date(),
    } });
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
    tradingAccountId: action.repairCase.tradingAccountId, workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.LIFECYCLE_MUTATION, processInstanceId: args.attemptKey,
    execute: async () => {
      const replay = await prisma.lifecycleRepairExecution.findUnique({ where: { attemptKey: args.attemptKey } });
      if (replay) {
        if (replay.actionId !== action.id) throw new HttpError(409, 'Attempt key belongs to another action.');
        return replay;
      }
      const preconditions = action.repairCase.preconditionsJson as Record<string, unknown>;
      const attentionId = action.repairCase.operationalAttentionId ?? Number(preconditions.attentionId);
      if (!Number.isInteger(attentionId) || attentionId <= 0) throw new HttpError(409, 'Repair case has no valid Operational Attention relationship.');
      const fresh = await buildPreviewEvidence(attentionId);
      if (fresh.attention.status === 'RESOLVED' || fresh.attention.activeKey !== preconditions.attentionFingerprint) {
        throw new HttpError(409, 'Operational Attention is no longer the active lifecycle condition.');
      }
      if (hash(fresh.evidence) !== action.repairCase.diagnosticFingerprint) {
        throw new HttpError(409, 'Material lifecycle evidence changed. Refresh the preview.');
      }
      const freshProposal = buildActionProposals(fresh).find((item) => item.actionType === action.actionType);
      const expectedActionFingerprint = freshProposal
        ? hash({ diagnosticFingerprint: action.repairCase.diagnosticFingerprint, actionType: freshProposal.actionType, proposal: freshProposal.mutations })
        : null;
      if (!freshProposal || expectedActionFingerprint !== action.actionFingerprint || stable(freshProposal.mutations) !== stable(action.proposedMutationsJson)) {
        throw new HttpError(409, 'The backend-generated repair proposal is no longer applicable.');
      }
      try {
        return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "LifecycleRepairCase" WHERE id = ${action.caseId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "LifecycleRepairAction" WHERE id = ${action.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "OperationalAttention" WHERE id = ${attentionId} FOR UPDATE`;
      const replayInside = await tx.lifecycleRepairExecution.findUnique({ where: { attemptKey: args.attemptKey } });
      if (replayInside) {
        if (replayInside.actionId !== action.id) throw new HttpError(409, 'Attempt key belongs to another action.');
        return replayInside;
      }
      const currentAction = await tx.lifecycleRepairAction.findUniqueOrThrow({ where: { id: action.id } });
      if (currentAction.status !== 'APPROVED' || currentAction.revision !== args.expectedRevision) throw new HttpError(409, 'Action changed before Apply.');
      const built = await buildPreviewEvidenceForTransaction(tx, action.repairCase.tradingAccountId, Number(action.repairCase.targetId));
      const proposal = action.proposedMutationsJson as any;
      const protectedBefore = protectedLifecycleValues(built.order);
      let after: unknown;
      if (action.actionType === LifecycleRepairActionType.TERMINALIZE_ORDER_LIFECYCLE) {
        if (!built.assessment.deterministic || stable(persistedJson(built.assessment)) !== stable(action.evidenceJson)) throw new HttpError(409, 'Full-fill evidence changed or became contradictory.');
        const orderUpdate = await tx.brokerOrder.updateMany({ where: { id: built.order.id, tradingAccountId: built.order.tradingAccountId, status: proposal.brokerOrder.status.before }, data: { status: 'filled' } });
        const intentUpdate = await tx.orderIntent.updateMany({ where: { id: built.order.orderIntentId, tradingAccountId: built.order.tradingAccountId, status: proposal.orderIntent.status.before }, data: { status: 'filled' } });
        if (orderUpdate.count !== 1 || intentUpdate.count !== 1) throw new HttpError(409, 'A conditional lifecycle status mutation did not affect exactly one row.');
      } else {
        const positionId = Number(proposal.trackedPositionId);
        if (stable([...built.assessment.ownedActivityIds].sort((a, b) => a - b)) !== stable([...proposal.brokerActivityIds].sort((a: number, b: number) => a - b))) throw new HttpError(409, 'Eligible fill lifecycle membership changed.');
        await tx.$queryRaw`SELECT id FROM "TrackedPosition" WHERE id = ${positionId} FOR UPDATE`;
        const position = await tx.trackedPosition.findFirst({ where: { id: positionId, tradingAccountId: built.order.tradingAccountId, status: 'closed' } });
        if (!position || built.existingLinkIds.length) throw new HttpError(409, 'Position candidate or lifecycle links changed.');
        const positionBefore = stable(position);
        const intentUpdate = await tx.orderIntent.updateMany({ where: { id: built.order.orderIntentId, tradingAccountId: built.order.tradingAccountId, trackedPositionId: null }, data: { trackedPositionId: positionId } });
        const orderUpdate = await tx.brokerOrder.updateMany({ where: { id: built.order.id, tradingAccountId: built.order.tradingAccountId, trackedPositionId: null }, data: { trackedPositionId: positionId } });
        const activityUpdate = await tx.brokerActivity.updateMany({ where: { id: { in: proposal.brokerActivityIds }, brokerOrderRecordId: built.order.id, orderIntentId: built.order.orderIntentId, tradingAccountId: built.order.tradingAccountId, trackedPositionId: null }, data: { trackedPositionId: positionId, trackedPositionLinkSource: 'historical_order_lifecycle_repair', trackedPositionLinkedAt: new Date() } });
        if (intentUpdate.count !== 1 || orderUpdate.count !== 1 || activityUpdate.count !== proposal.brokerActivityIds.length) throw new HttpError(409, 'A conditional lifecycle relationship mutation affected an unexpected row count.');
        const positionAfter = await tx.trackedPosition.findUniqueOrThrow({ where: { id: positionId } });
        if (stable(positionAfter) !== positionBefore) throw new HttpError(500, 'Repair unexpectedly changed the TrackedPosition.');
      }
      const refreshed = await tx.brokerOrder.findUniqueOrThrow({ where: { id: built.order.id }, include: { orderIntent: true, brokerActivities: true } });
      after = lifecycleState(refreshed);
      const valid = action.actionType === LifecycleRepairActionType.TERMINALIZE_ORDER_LIFECYCLE
        ? refreshed.status === 'filled' && refreshed.orderIntent.status === 'filled' && stable(protectedLifecycleValues(refreshed)) === stable(protectedBefore)
        : refreshed.trackedPositionId === proposal.trackedPositionId && refreshed.orderIntent.trackedPositionId === proposal.trackedPositionId && refreshed.brokerActivities.filter((item) => proposal.brokerActivityIds.includes(item.id)).length === proposal.brokerActivityIds.length && refreshed.brokerActivities.filter((item) => proposal.brokerActivityIds.includes(item.id)).every((item) => item.trackedPositionId === proposal.trackedPositionId && item.trackedPositionLinkSource === 'historical_order_lifecycle_repair') && stable(withoutLifecycleLinks(protectedLifecycleValues(refreshed))) === stable(withoutLifecycleLinks(protectedBefore));
      if (!valid) throw new HttpError(500, 'Post-mutation structural validation failed.');
      const execution = await tx.lifecycleRepairExecution.create({ data: {
        caseId: action.caseId, actionId: action.id, attemptKey: args.attemptKey, result: LifecycleRepairExecutionResult.SUCCEEDED,
        executedByUserId: args.actorUserId, reason: args.reason, confirmation: args.confirmation,
        diagnosticFingerprint: action.repairCase.diagnosticFingerprint, beforeJson: json(action.beforeJson), afterJson: json(after),
        validationJson: json({ valid, brokerCalls: 0, brokerWrites: 0, exposureChanged: false, financialValuesChanged: false }),
      } });
      await tx.lifecycleRepairAction.update({ where: { id: action.id }, data: { status: 'APPLIED', revision: { increment: 1 }, afterJson: json(after), verificationJson: json({ structurallyValid: true, authoritativeVerificationPending: true, appliedAt: new Date().toISOString() }) } });
      await tx.lifecycleRepairAction.updateMany({ where: { caseId: action.caseId, id: { not: action.id }, status: { in: ['PROPOSED', 'APPROVED'] } }, data: { status: 'SUPERSEDED', decidedAt: new Date(), decisionReason: 'Sibling action applied; refresh authoritative evidence.', revision: { increment: 1 } } });
      await createSystemEvent({ type: 'lifecycle_repair.action_applied', entityType: 'lifecycleRepairAction', entityId: action.id, tradingAccountId: built.order.tradingAccountId, actorUserId: args.actorUserId, severity: SystemEventSeverity.INFO, message: `${action.actionType} was applied and structurally verified.`, payloadJson: json({ caseId: action.caseId, actionId: action.id, executionId: execution.id, brokerImpact: 'NONE' }) }, tx);
      return execution;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        await persistFailedExecution({ action, args, error });
        throw error;
      }
    },
  });
  if (lock.outcome === 'NOT_ACQUIRED') {
    const deadline = Date.now() + SAME_ATTEMPT_REPLAY_WAIT_MS;
    while (Date.now() < deadline) {
      const replay = await prisma.lifecycleRepairExecution.findUnique({ where: { attemptKey: args.attemptKey } });
      if (replay) {
        if (replay.actionId !== args.actionId) throw new HttpError(409, 'Attempt key belongs to another action.');
        return { execution: replay, idempotent: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new HttpError(409, 'Lifecycle repair lock is busy.');
  }
  if (lock.outcome !== 'ACQUIRED_AND_COMPLETED') throw (lock.outcome === 'WORKFLOW_ERROR' || lock.outcome === 'LOCK_ERROR' ? lock.error : new HttpError(409, 'Lifecycle repair lock is busy.'));
  return { execution: lock.value, idempotent: false };
}

async function persistFailedExecution(args: {
  action: Awaited<ReturnType<typeof prisma.lifecycleRepairAction.findUniqueOrThrow>> & { repairCase: { tradingAccountId: number; diagnosticFingerprint: string } };
  args: { actorUserId: number; reason: string; confirmation: string; attemptKey: string };
  error: unknown;
}) {
  const message = args.error instanceof Error ? args.error.message : 'Unknown repair failure';
  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.lifecycleRepairExecution.findUnique({ where: { attemptKey: args.args.attemptKey } });
      if (existing) return;
      const execution = await tx.lifecycleRepairExecution.create({ data: {
        caseId: args.action.caseId, actionId: args.action.id, attemptKey: args.args.attemptKey,
        result: LifecycleRepairExecutionResult.FAILED, executedByUserId: args.args.actorUserId,
        reason: args.args.reason, confirmation: args.args.confirmation,
        diagnosticFingerprint: args.action.repairCase.diagnosticFingerprint,
        beforeJson: json(args.action.beforeJson), failureJson: json({ message }),
      } });
      await tx.lifecycleRepairAction.updateMany({ where: { id: args.action.id, status: 'APPROVED' }, data: { status: 'FAILED', revision: { increment: 1 } } });
      await createSystemEvent({ type: 'lifecycle_repair.action_failed', entityType: 'lifecycleRepairAction', entityId: args.action.id, tradingAccountId: args.action.repairCase.tradingAccountId, actorUserId: args.args.actorUserId, severity: SystemEventSeverity.WARNING, message: `${args.action.actionType} failed without committing its proposed mutation.`, payloadJson: json({ caseId: args.action.caseId, actionId: args.action.id, executionId: execution.id, failure: { message }, brokerImpact: 'NONE' }) }, tx);
    });
  } catch (auditError) {
    const existing = await prisma.lifecycleRepairExecution.findUnique({ where: { attemptKey: args.args.attemptKey } });
    if (!existing) throw auditError;
  }
}

async function buildPreviewEvidenceForTransaction(tx: Prisma.TransactionClient, tradingAccountId: number, brokerOrderId: number) {
  await tx.$queryRaw`SELECT id FROM "BrokerOrder" WHERE id = ${brokerOrderId} FOR UPDATE`;
  const order = await tx.brokerOrder.findFirst({ where: { id: brokerOrderId, tradingAccountId }, include: { orderIntent: true, brokerActivities: true } });
  if (!order) throw new HttpError(409, 'Lifecycle target changed.');
  await tx.$queryRaw`SELECT id FROM "OrderIntent" WHERE id = ${order.orderIntentId} FOR UPDATE`;
  const activityIds = order.brokerActivities.map((item) => item.id);
  if (activityIds.length) await tx.$queryRawUnsafe(`SELECT id FROM "BrokerActivity" WHERE id IN (${activityIds.map((_, index) => `$${index + 1}`).join(',')}) FOR UPDATE`, ...activityIds);
  const assessment = assessHistoricalFullFillEvidence({ orderQty: order.orderIntent.qty, tradingAccountId, brokerOrderRecordId: order.id, brokerOrderId: order.brokerOrderId, expectedBroker: order.broker, activities: order.brokerActivities });
  return { order, assessment, existingLinkIds: [...new Set([order.trackedPositionId, order.orderIntent.trackedPositionId, ...order.brokerActivities.map((item) => item.trackedPositionId)].filter((id): id is number => id !== null))] };
}

export async function verifyAppliedHistoricalLifecycleActions(args: {
  attentionId: number;
  unresolvedComponents: string[];
  runIdentifier: string;
}) {
  const cases = await prisma.lifecycleRepairCase.findMany({
    where: { operationalAttentionId: args.attentionId, repairType: HISTORICAL_ENTRY_REPAIR_TYPE },
    include: { actions: { where: { status: 'APPLIED' } } },
  });
  const applied = cases.flatMap((repairCase) => repairCase.actions.map((action) => ({ repairCase, action })));
  if (!applied.length) return { verified: 0 };
  const attention = await prisma.operationalAttention.findUnique({ where: { id: args.attentionId } });
  if (!attention?.brokerOrderId) return { verified: 0 };
  const order = await prisma.brokerOrder.findFirst({ where: { id: attention.brokerOrderId, tradingAccountId: attention.tradingAccountId }, include: { orderIntent: true, brokerActivities: true } });
  if (!order) return { verified: 0 };
  const fill = assessHistoricalFullFillEvidence({ orderQty: order.orderIntent.qty, tradingAccountId: attention.tradingAccountId, brokerOrderRecordId: order.id, brokerOrderId: order.brokerOrderId, expectedBroker: order.broker, activities: order.brokerActivities });
  let verified = 0;
  for (const item of applied) {
    let evidence: Record<string, unknown> | null = null;
    if (item.action.actionType === 'TERMINALIZE_ORDER_LIFECYCLE') {
      if (fill.deterministic && isTerminalBrokerOrderStatus(order.status) && isTerminalBrokerOrderStatus(order.orderIntent.status) && !args.unresolvedComponents.includes('STALE_ORDER_STATUS')) {
        evidence = { runIdentifier: args.runIdentifier, fullFillEvidence: fill, brokerOrderStatus: order.status, orderIntentStatus: order.orderIntent.status, terminalStatusComponentAbsent: true };
      }
    } else {
      const proposal = item.action.proposedMutationsJson as Record<string, unknown>;
      const positionId = Number(proposal.trackedPositionId);
      const ownedFills = order.brokerActivities.filter((activity) => fill.ownedActivityIds.includes(activity.id));
      const linkState = classifyHistoricalLifecycleLinks({ orderIntentTrackedPositionId: order.orderIntent.trackedPositionId, brokerOrderTrackedPositionId: order.trackedPositionId, activityTrackedPositionIds: ownedFills.map((activity) => activity.trackedPositionId) });
      const position = Number.isInteger(positionId) ? await prisma.trackedPosition.findUnique({ where: { id: positionId } }) : null;
      const validation = validateExistingHistoricalPositionLink({
        existingPositionIds: [order.orderIntent.trackedPositionId, order.trackedPositionId, ...ownedFills.map((activity) => activity.trackedPositionId)].filter((id): id is number => id !== null),
        tradingAccountId: order.tradingAccountId, broker: order.broker, symbol: order.symbol,
        subscriptionId: order.orderIntent.subscriptionId, tradingAccountSubscriptionId: order.orderIntent.tradingAccountSubscriptionId,
        positions: position ? [position] : [],
      });
      const linkComponentAbsent = !args.unresolvedComponents.some((component) => ['MISSING_POSITION_LINK', 'PARTIAL_POSITION_LINK', 'CONFLICTING_POSITION_LINK'].includes(component));
      if (fill.deterministic && linkState.state === 'CONSISTENT' && linkState.trackedPositionId === positionId && validation.status === 'valid' && linkComponentAbsent) {
        evidence = { runIdentifier: args.runIdentifier, fullFillEvidence: fill, lifecycleLinkState: linkState, existingLinkValidation: validation, positionLinkComponentAbsent: true };
      }
    }
    if (!evidence) continue;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "LifecycleRepairAction" WHERE id = ${item.action.id} FOR UPDATE`;
      const changed = await tx.lifecycleRepairAction.updateMany({ where: { id: item.action.id, status: 'APPLIED' }, data: { status: 'VERIFIED', revision: { increment: 1 }, verificationJson: json({ authoritative: true, verifiedAt: new Date().toISOString(), evidence }) } });
      if (changed.count !== 1) return;
      await createSystemEvent({ type: 'lifecycle_repair.action_verified', entityType: 'lifecycleRepairAction', entityId: item.action.id, tradingAccountId: order.tradingAccountId, severity: SystemEventSeverity.INFO, message: `${item.action.actionType} was verified by authoritative reconciliation.`, payloadJson: json({ caseId: item.repairCase.id, actionId: item.action.id, attentionId: args.attentionId, evidence }) }, tx);
      verified += 1;
    });
  }
  return { verified };
}
