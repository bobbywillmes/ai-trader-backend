import { PlatformRole, type Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { TRADING_ACCOUNT_SUMMARY_SELECT } from './trading-account.service.js';

const MAX_PAGE_SIZE = 100;
const MAX_OPPORTUNITY_PAGE_SIZE = 20;
const MAX_EVENT_PAGE_SIZE = 100;
const MAX_RAW_JSON_BYTES = 32 * 1024;

export type EvidenceUser = { id: number; platformRole: PlatformRole };

export type OrderIntentHistoryFilters = {
  accountId: number | null;
  page: number;
  pageSize: number;
  symbol?: string;
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
};

export type OperationalEvidenceOptions = {
  opportunityPage: number;
  opportunityPageSize: number;
  eventPage: number;
  eventPageSize: number;
  includeRawEvidence: boolean;
};

function accountScope(user: EvidenceUser): Prisma.OrderIntentWhereInput {
  return user.platformRole === PlatformRole.SYSTEM_OWNER
    ? {}
    : { tradingAccount: { memberships: { some: { userId: user.id } } } };
}

function presentRawJson(value: Prisma.JsonValue) {
  const serialized = JSON.stringify(value);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  return byteLength <= MAX_RAW_JSON_BYTES
    ? { truncated: false, byteLength, value }
    : { truncated: true, byteLength, value: null };
}

function presentGate(gate: any, user: EvidenceUser, includeRawEvidence: boolean) {
  return {
    id: gate.id,
    ordinal: gate.ordinal,
    dimension: gate.dimension,
    algorithmVersion: gate.algorithmVersion,
    requirement: gate.requirement,
    outcome: gate.outcome,
    observedState: gate.observedState,
    sourceHealth: gate.sourceHealth,
    sourceAssessmentId: gate.sourceAssessmentId,
    reasonCode: gate.reasonCode,
    createdAt: gate.createdAt,
    ...(user.platformRole !== PlatformRole.ACCOUNT_USER
      ? { allowedStates: gate.allowedStatesJson }
      : {}),
    ...(includeRawEvidence
      ? { rawEvidence: presentRawJson(gate.evidenceJson) }
      : {}),
  };
}

function presentAttempt(attempt: any, user: EvidenceUser, includeRawEvidence: boolean) {
  return {
    id: attempt.id,
    attempt: attempt.attempt,
    evidenceAsOf: attempt.evidenceAsOf,
    evaluationVersion: attempt.evaluationVersion,
    enrollmentDisposition: attempt.enrollmentDisposition,
    outcome: attempt.outcome,
    reasonCode: attempt.reasonCode,
    authority: attempt.authority,
    tradingEffect: attempt.tradingEffect,
    createdAt: attempt.createdAt,
    gates: attempt.gates.map((gate: any) => presentGate(gate, user, includeRawEvidence)),
    ...(includeRawEvidence
      ? { rawEvidence: presentRawJson(attempt.evidenceJson) }
      : {}),
  };
}

function comparisonState(delivery: any, attempts: any[]) {
  if (!delivery) return 'NOT_SCHEDULED';
  if (delivery.status === 'TERMINAL_FAILURE') return 'TERMINAL_RETRY_EXHAUSTED';
  if (delivery.status === 'COMPLETED') {
    const latest = attempts.at(-1);
    if (latest?.outcome === 'INSUFFICIENT_EVIDENCE') return 'INSUFFICIENT_EVIDENCE';
    if (latest?.outcome === 'TECHNICAL_FAILURE') return 'TECHNICAL_FAILURE';
    return 'COMPLETED';
  }
  return 'PENDING';
}

function coverageState(intent: any, rollout: any) {
  const coverage = intent.marketPolicyCoverage;
  if (!coverage) {
    if (!rollout?.effectiveEpoch || intent.createdAt < rollout.effectiveEpoch) {
      return 'PRE_ROLLOUT';
    }
    return 'POST_EPOCH_MISSING_CAPTURE';
  }
  if (coverage.provenance === 'UNENROLLED') return 'UNENROLLED';
  if (coverage.provenance === 'CAPTURE_UNKNOWN' || coverage.compositionCapture === 'LEGACY_UNKNOWN') {
    return 'LEGACY_UNKNOWN';
  }
  if (coverage.compositionCapture === 'NONE_VISIBLE') return 'NONE_VISIBLE';
  return 'EXACT';
}

const deliverySelect = {
  status: true,
  attemptCount: true,
  nextAttemptAt: true,
  lastErrorCode: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrderIntentMarketPolicyComparisonDeliverySelect;

const gateSelect = {
  id: true,
  ordinal: true,
  dimension: true,
  algorithmVersion: true,
  requirement: true,
  outcome: true,
  observedState: true,
  sourceHealth: true,
  sourceAssessmentId: true,
  allowedStatesJson: true,
  reasonCode: true,
  evidenceJson: true,
  createdAt: true,
} satisfies Prisma.OrderIntentMarketPolicyComparisonGateSelect;

const brokerGateSelect = { ...gateSelect } satisfies Prisma.OrderIntentBrokerComparisonGateSelect;

export async function getAccessibleOrderIntentOperationalEvidence(
  user: EvidenceUser,
  orderIntentId: number,
  options: OperationalEvidenceOptions,
) {
  if (options.includeRawEvidence && user.platformRole !== PlatformRole.SYSTEM_OWNER) {
    throw new HttpError(403, 'Raw operational evidence requires SYSTEM_OWNER access.');
  }

  const intent = await prisma.orderIntent.findFirst({
    where: { id: orderIntentId, ...accountScope(user) },
    select: {
      id: true,
      source: true,
      symbol: true,
      side: true,
      orderType: true,
      timeInForce: true,
      qty: true,
      notional: true,
      limitPrice: true,
      extendedHours: true,
      clientOrderId: true,
      status: true,
      blockReason: true,
      createdAt: true,
      updatedAt: true,
      tradingAccountId: true,
      tradingAccount: { select: TRADING_ACCOUNT_SUMMARY_SELECT },
      subscriptionId: true,
      subscriptionKey: true,
      tradingAccountSubscriptionId: true,
      tradingAccountSubscription: {
        select: {
          id: true,
          subscription: {
            select: {
              id: true,
              key: true,
              name: true,
              strategy: { select: { id: true, key: true, name: true } },
            },
          },
        },
      },
      trackedPositionId: true,
      trackedPosition: { select: { id: true, symbol: true, side: true, status: true, openedAt: true, closedAt: true } },
      brokerOrders: {
        select: { id: true, broker: true, brokerOrderId: true, clientOrderId: true, symbol: true, side: true, status: true, trackedPositionId: true, createdAt: true, updatedAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
      entryDecision: { select: { id: true } },
      marketPolicyCoverage: {
        select: {
          id: true,
          orderIntentId: true,
          tradingAccountId: true,
          accountSubscriptionId: true,
          enrollmentGenerationId: true,
          boundPolicyRevisionId: true,
          activePolicyRevisionId: true,
          marketRegimeAssessmentId: true,
          provenance: true,
          compositionCapture: true,
          captureSchemaVersion: true,
          comparisonMode: true,
          tradingEffect: true,
          capturedAt: true,
          enrollmentGeneration: { select: { id: true, generation: true, status: true, strategyId: true, policyRevisionId: true, preparedAt: true, activatedAt: true, disabledAt: true } },
          boundPolicyRevision: { select: { id: true, revision: true, status: true } },
          activePolicyRevision: { select: { id: true, revision: true, status: true } },
          marketRegimeAssessment: { select: { id: true, compositionVersion: true, targetAt: true, observedAt: true, dataThroughAt: true, validUntil: true, publicationStatus: true, evidenceHealth: true, publicationReasonCode: true, evidenceReasonCode: true, sourceSetFingerprint: true, completedAt: true } },
          comparisonDelivery: { select: deliverySelect },
          comparisonAttempts: {
            select: {
              id: true, attempt: true, evidenceAsOf: true, evaluationVersion: true,
              enrollmentDisposition: true, outcome: true, reasonCode: true,
              authority: true, tradingEffect: true, evidenceJson: true, createdAt: true,
              gates: { select: gateSelect, orderBy: [{ ordinal: 'asc' }, { id: 'asc' }] },
            },
            orderBy: [{ attempt: 'asc' }, { id: 'asc' }],
            take: 20,
          },
          _count: { select: { comparisonAttempts: true } },
        },
      },
    },
  });

  if (!intent) throw new HttpError(404, 'Order intent was not found.');

  const opportunityWhere = { orderIntentId: intent.id, tradingAccountId: intent.tradingAccountId! };
  const unboundWhere = { orderIntentId: intent.id, opportunityId: null };
  const [rollout, opportunityTotal, opportunities, unboundEventTotal, unboundEvents] = await Promise.all([
    prisma.orderIntentMarketPolicyCaptureRollout.findUnique({ where: { id: 1 }, select: { enabled: true, deployedAt: true, effectiveEpoch: true, disabledAt: true } }),
    prisma.orderIntentBrokerPostOpportunity.count({ where: opportunityWhere }),
    prisma.orderIntentBrokerPostOpportunity.findMany({
      where: opportunityWhere,
      orderBy: [{ opportunitySequence: 'asc' }, { id: 'asc' }],
      skip: (options.opportunityPage - 1) * options.opportunityPageSize,
      take: options.opportunityPageSize,
      select: {
        id: true, orderIntentId: true, intentCoverageId: true, tradingAccountId: true,
        accountSubscriptionId: true, enrollmentGenerationId: true, policyRevisionId: true,
        clientOrderId: true, opportunitySequence: true, marketRegimeAssessmentId: true,
        sourceSetFingerprint: true, compositionCapture: true, applicability: true,
        comparisonMode: true, tradingEffect: true, opportunityAt: true, createdAt: true,
        comparisonDelivery: { select: deliverySelect },
        comparisonAttempts: {
          select: {
            id: true, attempt: true, evidenceAsOf: true, evaluationVersion: true,
            enrollmentDisposition: true, outcome: true, reasonCode: true,
            authority: true, tradingEffect: true, evidenceJson: true, createdAt: true,
            gates: { select: brokerGateSelect, orderBy: [{ ordinal: 'asc' }, { id: 'asc' }] },
          },
          orderBy: [{ attempt: 'asc' }, { id: 'asc' }],
          take: 20,
        },
        events: {
          select: { id: true, orderIntentId: true, opportunityId: true, sequence: true, eventType: true, evidenceJson: true, occurredAt: true, createdAt: true },
          orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
          skip: (options.eventPage - 1) * options.eventPageSize,
          take: options.eventPageSize,
        },
        _count: { select: { events: true, comparisonAttempts: true } },
      },
    }),
    prisma.orderIntentBrokerOpportunityEvent.count({ where: unboundWhere }),
    prisma.orderIntentBrokerOpportunityEvent.findMany({
      where: unboundWhere,
      orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      skip: (options.eventPage - 1) * options.eventPageSize,
      take: options.eventPageSize,
      select: { id: true, orderIntentId: true, opportunityId: true, sequence: true, eventType: true, evidenceJson: true, occurredAt: true, createdAt: true },
    }),
  ]);

  const coverage = intent.marketPolicyCoverage;
  const intentAttempts = coverage?.comparisonAttempts ?? [];
  const fingerprintAllowed = user.platformRole !== PlatformRole.ACCOUNT_USER;
  const presentEvent = (event: any) => ({
    id: event.id, sequence: event.sequence, eventType: event.eventType,
    occurredAt: event.occurredAt, createdAt: event.createdAt,
    ...(includeRawEvent(user, options.includeRawEvidence, event.evidenceJson)),
  });

  const brokerOpportunityRows = opportunities.map((opportunity) => ({
    id: opportunity.id,
    orderIntentId: opportunity.orderIntentId,
    intentCoverageId: opportunity.intentCoverageId,
    tradingAccountId: opportunity.tradingAccountId,
    accountSubscriptionId: opportunity.accountSubscriptionId,
    enrollmentGenerationId: opportunity.enrollmentGenerationId,
    policyRevisionId: opportunity.policyRevisionId,
    clientOrderId: opportunity.clientOrderId,
    opportunitySequence: opportunity.opportunitySequence,
    marketRegimeAssessmentId: opportunity.marketRegimeAssessmentId,
    ...(fingerprintAllowed ? { sourceSetFingerprint: opportunity.sourceSetFingerprint } : {}),
    compositionCapture: opportunity.compositionCapture,
    applicability: opportunity.applicability,
    comparisonMode: opportunity.comparisonMode,
    tradingEffect: opportunity.tradingEffect,
    opportunityAt: opportunity.opportunityAt,
    createdAt: opportunity.createdAt,
    comparison: {
      state: comparisonState(opportunity.comparisonDelivery, opportunity.comparisonAttempts),
      delivery: opportunity.comparisonDelivery,
      attempts: opportunity.comparisonAttempts.map((attempt) => presentAttempt(attempt, user, options.includeRawEvidence)),
      attemptBounds: { returned: opportunity.comparisonAttempts.length, limit: 20, total: opportunity._count.comparisonAttempts, hasMore: opportunity._count.comparisonAttempts > opportunity.comparisonAttempts.length },
    },
    events: opportunity.events.map(presentEvent),
    eventPagination: pagination(options.eventPage, options.eventPageSize, opportunity._count.events),
  }));

  const brokerLookupFoundWithoutPost = opportunityTotal === 0 && intent.brokerOrders.length > 0;

  return {
    authority: { comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE', enforcementAuthority: false },
    orderIntent: {
      id: intent.id, source: intent.source, symbol: intent.symbol, side: intent.side,
      orderType: intent.orderType, timeInForce: intent.timeInForce, qty: intent.qty,
      notional: intent.notional, limitPrice: intent.limitPrice, extendedHours: intent.extendedHours,
      clientOrderId: intent.clientOrderId, status: intent.status, blockReason: intent.blockReason,
      createdAt: intent.createdAt, updatedAt: intent.updatedAt,
      tradingAccountId: intent.tradingAccountId, tradingAccount: intent.tradingAccount,
      subscriptionId: intent.subscriptionId, subscriptionKey: intent.subscriptionKey,
      tradingAccountSubscriptionId: intent.tradingAccountSubscriptionId,
      assignment: intent.tradingAccountSubscription,
      brokerOrders: intent.brokerOrders,
      trackedPositionId: intent.trackedPositionId,
      trackedPosition: intent.trackedPosition,
    },
    intentStage: {
      state: coverageState(intent, rollout),
      rollout: rollout ? { effectiveEpoch: rollout.effectiveEpoch, deployedAt: rollout.deployedAt, disabledAt: rollout.disabledAt } : null,
      coverage: coverage ? {
        id: coverage.id, orderIntentId: coverage.orderIntentId,
        tradingAccountId: coverage.tradingAccountId, accountSubscriptionId: coverage.accountSubscriptionId,
        enrollmentGenerationId: coverage.enrollmentGenerationId,
        boundPolicyRevisionId: coverage.boundPolicyRevisionId,
        activePolicyRevisionId: coverage.activePolicyRevisionId,
        marketRegimeAssessmentId: coverage.marketRegimeAssessmentId,
        provenance: coverage.provenance, compositionCapture: coverage.compositionCapture,
        captureSchemaVersion: coverage.captureSchemaVersion,
        comparisonMode: coverage.comparisonMode, tradingEffect: coverage.tradingEffect,
        capturedAt: coverage.capturedAt,
        enrollmentGeneration: coverage.enrollmentGeneration,
        boundPolicyRevision: coverage.boundPolicyRevision,
        activePolicyRevision: coverage.activePolicyRevision,
        marketComposition: coverage.marketRegimeAssessment ? {
          id: coverage.marketRegimeAssessment.id,
          compositionVersion: coverage.marketRegimeAssessment.compositionVersion,
          targetAt: coverage.marketRegimeAssessment.targetAt,
          observedAt: coverage.marketRegimeAssessment.observedAt,
          dataThroughAt: coverage.marketRegimeAssessment.dataThroughAt,
          validUntil: coverage.marketRegimeAssessment.validUntil,
          publicationStatus: coverage.marketRegimeAssessment.publicationStatus,
          evidenceHealth: coverage.marketRegimeAssessment.evidenceHealth,
          publicationReasonCode: coverage.marketRegimeAssessment.publicationReasonCode,
          evidenceReasonCode: coverage.marketRegimeAssessment.evidenceReasonCode,
          completedAt: coverage.marketRegimeAssessment.completedAt,
          ...(fingerprintAllowed ? { sourceSetFingerprint: coverage.marketRegimeAssessment.sourceSetFingerprint } : {}),
        } : null,
      } : null,
      comparison: {
        state: comparisonState(coverage?.comparisonDelivery, intentAttempts),
        delivery: coverage?.comparisonDelivery ?? null,
        attempts: intentAttempts.map((attempt) => presentAttempt(attempt, user, options.includeRawEvidence)),
        attemptBounds: { returned: intentAttempts.length, limit: 20, total: coverage?._count.comparisonAttempts ?? 0, hasMore: (coverage?._count.comparisonAttempts ?? 0) > intentAttempts.length },
      },
    },
    brokerStage: {
      state: brokerLookupFoundWithoutPost ? 'BROKER_LOOKUP_FOUND_WITHOUT_NEW_POST' : opportunityTotal > 1 ? 'MULTIPLE_POST_OPPORTUNITIES' : opportunityTotal === 1 ? 'POST_OPPORTUNITY_RECORDED' : unboundEventTotal > 0 ? 'MISSING_OBSERVATION' : 'NO_POST_OPPORTUNITY',
      stateSource: brokerLookupFoundWithoutPost ? 'DERIVED_FROM_LIFECYCLE' : 'RECORDED_EVIDENCE',
      opportunities: brokerOpportunityRows,
      pagination: pagination(options.opportunityPage, options.opportunityPageSize, opportunityTotal),
      unboundMissingObservations: unboundEvents.map(presentEvent),
      unboundEventPagination: pagination(options.eventPage, options.eventPageSize, unboundEventTotal),
    },
    relatedRecords: {
      entryDecisionId: intent.entryDecision?.id ?? null,
      brokerOrderRecordIds: intent.brokerOrders.map((order) => order.id),
      trackedPositionId: intent.trackedPositionId,
      tradingAccountId: intent.tradingAccountId,
      accountSubscriptionId: intent.tradingAccountSubscriptionId,
      subscriptionId: intent.subscriptionId,
      strategyId: intent.tradingAccountSubscription?.subscription.strategy.id ?? null,
      marketRegimeAssessmentIds: [...new Set([
        ...(coverage?.marketRegimeAssessmentId ? [coverage.marketRegimeAssessmentId] : []),
        ...opportunities.flatMap((item) => item.marketRegimeAssessmentId ? [item.marketRegimeAssessmentId] : []),
      ])],
    },
  };
}

function includeRawEvent(user: EvidenceUser, include: boolean, value: Prisma.JsonValue) {
  return include && user.platformRole === PlatformRole.SYSTEM_OWNER
    ? { rawEvidence: presentRawJson(value) }
    : {};
}

function pagination(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), hasMore: page * pageSize < total };
}

export async function listAccessibleOrderIntentHistory(user: EvidenceUser, filters: OrderIntentHistoryFilters) {
  const where: Prisma.OrderIntentWhereInput = {
    ...accountScope(user),
    ...(filters.accountId !== null ? { tradingAccountId: filters.accountId } : {}),
    ...(filters.symbol ? { symbol: filters.symbol.trim().toUpperCase() } : {}),
    ...(filters.status ? { status: filters.status.trim() } : {}),
    ...(filters.dateFrom || filters.dateTo ? { createdAt: { ...(filters.dateFrom ? { gte: filters.dateFrom } : {}), ...(filters.dateTo ? { lte: filters.dateTo } : {}) } } : {}),
  };
  const pageSize = Math.min(filters.pageSize, MAX_PAGE_SIZE);
  const [rollout, total, intents] = await Promise.all([
    prisma.orderIntentMarketPolicyCaptureRollout.findUnique({ where: { id: 1 }, select: { effectiveEpoch: true } }),
    prisma.orderIntent.count({ where }),
    prisma.orderIntent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (filters.page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, symbol: true, side: true, status: true, blockReason: true,
        clientOrderId: true, createdAt: true, updatedAt: true,
        tradingAccountId: true, tradingAccount: { select: TRADING_ACCOUNT_SUMMARY_SELECT },
        tradingAccountSubscriptionId: true,
        tradingAccountSubscription: { select: { id: true, subscription: { select: { id: true, key: true, name: true, strategy: { select: { id: true, key: true, name: true } } } } } },
        trackedPositionId: true,
        _count: { select: { brokerOrders: true, brokerPostOpportunities: true, brokerOpportunityEvents: { where: { opportunityId: null } } } },
        marketPolicyCoverage: {
          select: {
            provenance: true, compositionCapture: true,
            comparisonDelivery: { select: { status: true } },
            comparisonAttempts: { select: { outcome: true, reasonCode: true }, orderBy: [{ attempt: 'desc' }, { id: 'desc' }], take: 1 },
          },
        },
        brokerPostOpportunities: {
          select: {
            opportunitySequence: true,
            comparisonDelivery: { select: { status: true } },
            comparisonAttempts: { select: { outcome: true, reasonCode: true }, orderBy: [{ attempt: 'desc' }, { id: 'desc' }], take: 1 },
          },
          orderBy: [{ opportunitySequence: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      },
    }),
  ]);

  return {
    intents: intents.map((intent) => {
      const latestIntentAttempt = intent.marketPolicyCoverage?.comparisonAttempts[0] ?? null;
      const latestOpportunity = intent.brokerPostOpportunities[0] ?? null;
      const latestBrokerAttempt = latestOpportunity?.comparisonAttempts[0] ?? null;
      return {
        id: intent.id, symbol: intent.symbol, side: intent.side, status: intent.status,
        blockReason: intent.blockReason, clientOrderId: intent.clientOrderId,
        createdAt: intent.createdAt, updatedAt: intent.updatedAt,
        tradingAccountId: intent.tradingAccountId, tradingAccount: intent.tradingAccount,
        tradingAccountSubscriptionId: intent.tradingAccountSubscriptionId,
        assignment: intent.tradingAccountSubscription,
        trackedPositionId: intent.trackedPositionId,
        brokerOrderCount: intent._count.brokerOrders,
        opportunityCount: intent._count.brokerPostOpportunities,
        missingObservationCount: intent._count.brokerOpportunityEvents,
        evidence: {
          intentState: coverageState(intent, rollout),
          intentComparisonState: comparisonState(intent.marketPolicyCoverage?.comparisonDelivery, latestIntentAttempt ? [latestIntentAttempt] : []),
          intentOutcome: latestIntentAttempt?.outcome ?? null,
          intentReasonCode: latestIntentAttempt?.reasonCode ?? null,
          latestBrokerComparisonState: latestOpportunity ? comparisonState(latestOpportunity.comparisonDelivery, latestBrokerAttempt ? [latestBrokerAttempt] : []) : null,
          latestBrokerOutcome: latestBrokerAttempt?.outcome ?? null,
          latestBrokerReasonCode: latestBrokerAttempt?.reasonCode ?? null,
          brokerLookupFoundWithoutNewPost: intent._count.brokerPostOpportunities === 0 && intent._count.brokerOrders > 0,
          brokerLookupStateSource: intent._count.brokerPostOpportunities === 0 && intent._count.brokerOrders > 0 ? 'DERIVED_FROM_LIFECYCLE' : null,
          comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE',
        },
      };
    }),
    filters: { account: filters.accountId ?? 'all', symbol: filters.symbol ?? null, status: filters.status ?? null, dateFrom: filters.dateFrom ?? null, dateTo: filters.dateTo ?? null },
    pagination: pagination(filters.page, pageSize, total),
  };
}

export const ORDER_EVIDENCE_QUERY_LIMITS = {
  maxHistoryPageSize: MAX_PAGE_SIZE,
  maxOpportunityPageSize: MAX_OPPORTUNITY_PAGE_SIZE,
  maxEventPageSize: MAX_EVENT_PAGE_SIZE,
  maxRawJsonBytes: MAX_RAW_JSON_BYTES,
} as const;
