import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import {
  getAlpacaOrderByClientOrderId,
  getAlpacaOrderById,
  getOpenAlpacaOrders,
} from '../integrations/alpaca/orders.adapter.js';
import type { AlpacaOrder } from '../integrations/alpaca/alpaca.types.js';
import {
  isTerminalBrokerOrderStatus,
  NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
  normalizeBrokerOrderStatus,
} from './broker-order-lifecycle-status.service.js';

export const HISTORICAL_ORDER_MINIMUM_AGE_MS = 15 * 60_000;
export const HISTORICAL_POSITION_TIME_TOLERANCE_MS = 5_000;
export const HISTORICAL_QUANTITY_TOLERANCE = 0.000001;
export const HISTORICAL_PRICE_TOLERANCE = 0.0001;
export const HISTORICAL_LOOKUP_CONCURRENCY = 4;
export const HISTORICAL_LOOKUP_BUDGET = 50;

export type HistoricalOrderClassification =
  | 'FULL_FILL_LOCAL_EVIDENCE'
  | 'PARTIAL_FILL_LOCAL_EVIDENCE'
  | 'TERMINAL_BROKER_CONFIRMED'
  | 'NONTERMINAL_BROKER_CONFIRMED'
  | 'POSITION_LINK_EXACT'
  | 'POSITION_LINK_EXISTING_VALID'
  | 'POSITION_LINK_AMBIGUOUS'
  | 'POSITION_LINK_MISSING'
  | 'NO_TERMINAL_EVIDENCE'
  | 'BROKER_LOOKUP_FAILED';

export type HistoricalPositionMatchInput = {
  tradingAccountId: number | null;
  broker: string;
  symbol: string;
  side: string;
  qty: number | null;
  fillPrice: number | null;
  fillTime: Date | null;
  subscriptionId: number | null;
  tradingAccountSubscriptionId: number | null;
};

export type HistoricalPositionCandidate = {
  id: number;
  tradingAccountId: number | null;
  broker: string;
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  openedAt: Date;
  subscriptionId: number | null;
  tradingAccountSubscriptionId: number | null;
};

export type HistoricalPositionRejectionReason =
  | 'account_mismatch'
  | 'broker_mismatch'
  | 'symbol_mismatch'
  | 'subscription_mismatch'
  | 'assignment_mismatch'
  | 'quantity_mismatch'
  | 'price_outside_tolerance'
  | 'time_outside_window';

export function evaluateHistoricalPositionCandidates(
  input: HistoricalPositionMatchInput,
  candidates: HistoricalPositionCandidate[]
) {
  return candidates.map((candidate) => {
    const rejectionReasons: HistoricalPositionRejectionReason[] = [];
    if (candidate.tradingAccountId !== input.tradingAccountId)
      rejectionReasons.push('account_mismatch');
    if (candidate.broker.toLowerCase() !== input.broker.toLowerCase())
      rejectionReasons.push('broker_mismatch');
    if (candidate.symbol.toUpperCase() !== input.symbol.toUpperCase())
      rejectionReasons.push('symbol_mismatch');
    if (candidate.subscriptionId !== input.subscriptionId)
      rejectionReasons.push('subscription_mismatch');
    if (
      candidate.tradingAccountSubscriptionId !==
      input.tradingAccountSubscriptionId
    )
      rejectionReasons.push('assignment_mismatch');
    if (
      input.qty === null ||
      !closeEnough(
        Math.abs(candidate.qty),
        Math.abs(input.qty),
        HISTORICAL_QUANTITY_TOLERANCE
      )
    )
      rejectionReasons.push('quantity_mismatch');
    if (
      input.fillPrice === null ||
      !closeEnough(
        candidate.avgEntryPrice,
        input.fillPrice,
        HISTORICAL_PRICE_TOLERANCE
      )
    )
      rejectionReasons.push('price_outside_tolerance');
    if (
      input.fillTime === null ||
      Math.abs(candidate.openedAt.getTime() - input.fillTime.getTime()) >
        HISTORICAL_POSITION_TIME_TOLERANCE_MS
    )
      rejectionReasons.push('time_outside_window');
    return { candidate, rejectionReasons };
  });
}

export function validateExistingHistoricalPositionLink(args: {
  existingPositionIds: number[];
  tradingAccountId: number | null;
  broker: string;
  symbol: string;
  subscriptionId: number | null;
  tradingAccountSubscriptionId: number | null;
  positions: HistoricalPositionCandidate[];
}) {
  const uniqueIds = [...new Set(args.existingPositionIds)];
  if (uniqueIds.length !== 1) {
    return {
      status: uniqueIds.length > 1 ? ('conflicting' as const) : ('missing' as const),
      trackedPositionId: null,
      rejectionReasons:
        uniqueIds.length > 1 ? ['conflicting_existing_links'] : ['no_existing_link'],
    };
  }
  const trackedPositionId = uniqueIds[0]!;
  const position = args.positions.find((item) => item.id === trackedPositionId);
  const rejectionReasons: string[] = [];
  if (!position) rejectionReasons.push('referenced_position_missing');
  else {
    if (position.tradingAccountId !== args.tradingAccountId)
      rejectionReasons.push('account_mismatch');
    if (position.broker.toLowerCase() !== args.broker.toLowerCase())
      rejectionReasons.push('broker_mismatch');
    if (position.symbol.toUpperCase() !== args.symbol.toUpperCase())
      rejectionReasons.push('symbol_mismatch');
    if (
      args.subscriptionId !== null &&
      position.subscriptionId !== null &&
      position.subscriptionId !== args.subscriptionId
    )
      rejectionReasons.push('subscription_mismatch');
    if (
      args.tradingAccountSubscriptionId !== null &&
      position.tradingAccountSubscriptionId !== null &&
      position.tradingAccountSubscriptionId !==
        args.tradingAccountSubscriptionId
    )
      rejectionReasons.push('assignment_mismatch');
  }
  return {
    status: rejectionReasons.length === 0 ? ('valid' as const) : ('invalid' as const),
    trackedPositionId:
      rejectionReasons.length === 0 ? trackedPositionId : null,
    rejectionReasons,
  };
}

export function createHistoricalLifecycleStateFingerprint(order: {
  id: number;
  orderIntentId: number;
  tradingAccountId: number | null;
  broker: string;
  brokerOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: string;
  status: string;
  trackedPositionId: number | null;
  orderIntent: {
    id: number;
    tradingAccountId: number | null;
    status: string;
    side: string;
    qty: number | null;
    blockReason: string | null;
    subscriptionId: number | null;
    tradingAccountSubscriptionId: number | null;
    trackedPositionId: number | null;
  };
  brokerActivities: Array<{
    id: number;
    activityId: string;
    activityType: string;
    tradingAccountId: number | null;
    brokerOrderRecordId: number | null;
    orderIntentId: number | null;
    trackedPositionId: number | null;
    qty: number | null;
    cumQty: number | null;
    leavesQty: number | null;
    price: number | null;
    transactionTime: Date | null;
  }>;
}) {
  return JSON.stringify({
    brokerOrder: {
      id: order.id,
      orderIntentId: order.orderIntentId,
      tradingAccountId: order.tradingAccountId,
      broker: order.broker,
      brokerOrderId: order.brokerOrderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      status: order.status,
      trackedPositionId: order.trackedPositionId,
    },
    orderIntent: {
      id: order.orderIntent.id,
      tradingAccountId: order.orderIntent.tradingAccountId,
      status: order.orderIntent.status,
      side: order.orderIntent.side,
      qty: order.orderIntent.qty,
      blockReason: order.orderIntent.blockReason,
      subscriptionId: order.orderIntent.subscriptionId,
      tradingAccountSubscriptionId:
        order.orderIntent.tradingAccountSubscriptionId,
      trackedPositionId: order.orderIntent.trackedPositionId,
    },
    brokerActivities: [...order.brokerActivities]
      .sort((left, right) => left.id - right.id)
      .map((activity) => ({
        id: activity.id,
        activityId: activity.activityId,
        activityType: activity.activityType,
        tradingAccountId: activity.tradingAccountId,
        brokerOrderRecordId: activity.brokerOrderRecordId,
        orderIntentId: activity.orderIntentId,
        trackedPositionId: activity.trackedPositionId,
        qty: activity.qty,
        cumQty: activity.cumQty,
        leavesQty: activity.leavesQty,
        price: activity.price,
        transactionTime: activity.transactionTime?.toISOString() ?? null,
      })),
  });
}

function closeEnough(actual: number, expected: number, tolerance: number) {
  return Math.abs(actual - expected) <= tolerance;
}

export function matchHistoricalEntryPosition(
  input: HistoricalPositionMatchInput,
  candidates: HistoricalPositionCandidate[]
) {
  if (
    input.tradingAccountId === null ||
    input.side.toLowerCase() !== 'buy' ||
    input.qty === null ||
    input.fillPrice === null ||
    input.fillTime === null ||
    input.subscriptionId === null ||
    input.tradingAccountSubscriptionId === null
  ) {
    return {
      status: 'missing' as const,
      matches: [],
      evaluations: evaluateHistoricalPositionCandidates(input, candidates),
    };
  }

  const evaluations = evaluateHistoricalPositionCandidates(input, candidates);
  const matches = evaluations
    .filter((evaluation) => evaluation.rejectionReasons.length === 0)
    .map((evaluation) => evaluation.candidate);

  if (matches.length === 1) {
    return {
      status: 'exact' as const,
      match: matches[0]!,
      matches,
      evaluations,
    };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous' as const, matches, evaluations };
  }
  return { status: 'missing' as const, matches, evaluations };
}

type FillEvidenceActivity = {
  activityType: string;
  qty: number | null;
  cumQty: number | null;
  leavesQty: number | null;
  price: number | null;
  transactionTime: Date | null;
  tradingAccountId: number | null;
  brokerOrderRecordId: number | null;
};

export function summarizeLocalFillEvidence(args: {
  orderQty: number | null;
  tradingAccountId: number;
  brokerOrderRecordId: number;
  activities: FillEvidenceActivity[];
}) {
  const ownedFills = args.activities.filter(
    (activity) =>
      activity.activityType.toUpperCase() === 'FILL' &&
      activity.tradingAccountId === args.tradingAccountId &&
      activity.brokerOrderRecordId === args.brokerOrderRecordId
  );
  if (ownedFills.length === 0 || args.orderQty === null) {
    return {
      classification: 'none' as const,
      cumulativeQty: null,
      leavesQty: null,
      weightedAveragePrice: null,
      completionTime: null,
      activityCount: ownedFills.length,
    };
  }

  const ordered = [...ownedFills].sort(
    (left, right) =>
      (left.transactionTime?.getTime() ?? 0) -
      (right.transactionTime?.getTime() ?? 0)
  );
  const completion = [...ordered]
    .reverse()
    .find(
      (activity) =>
        activity.cumQty !== null &&
        activity.leavesQty !== null &&
        closeEnough(
          Math.abs(activity.cumQty),
          Math.abs(args.orderQty!),
          HISTORICAL_QUANTITY_TOLERANCE
        ) &&
        closeEnough(
          Math.abs(activity.leavesQty),
          0,
          HISTORICAL_QUANTITY_TOLERANCE
        )
    );
  const pricedFills = ownedFills.filter(
    (activity) =>
      activity.qty !== null &&
      activity.price !== null &&
      Number.isFinite(activity.qty) &&
      Number.isFinite(activity.price) &&
      Math.abs(activity.qty) > 0
  );
  const pricedQty = pricedFills.reduce(
    (total, activity) => total + Math.abs(activity.qty!),
    0
  );
  const weightedAveragePrice =
    pricedQty > 0
      ? pricedFills.reduce(
          (total, activity) =>
            total + Math.abs(activity.qty!) * activity.price!,
          0
        ) / pricedQty
      : null;

  return {
    classification: completion ? ('full' as const) : ('partial' as const),
    cumulativeQty: completion?.cumQty ?? ordered.at(-1)?.cumQty ?? null,
    leavesQty: completion?.leavesQty ?? ordered.at(-1)?.leavesQty ?? null,
    weightedAveragePrice,
    completionTime: completion?.transactionTime ?? null,
    activityCount: ownedFills.length,
  };
}

export function classifyLocalFillEvidence(args: {
  orderQty: number | null;
  tradingAccountId: number;
  brokerOrderRecordId: number;
  activities: FillEvidenceActivity[];
}) {
  return summarizeLocalFillEvidence(args).classification;
}

const candidateInclude = {
  orderIntent: true,
  brokerActivities: true,
  trackedPosition: true,
} satisfies Prisma.BrokerOrderInclude;

async function lookupHistoricalOrder(candidate: {
  tradingAccountId: number;
  brokerOrderId: string;
  clientOrderId: string;
}) {
  const byId = await getAlpacaOrderById(
    candidate.tradingAccountId,
    candidate.brokerOrderId,
    'open_orders_sync'
  );
  if (byId) return byId;
  return getAlpacaOrderByClientOrderId(
    candidate.tradingAccountId,
    candidate.clientOrderId,
    'open_orders_sync'
  );
}

async function mapBounded<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker)
  );
  return results;
}

function brokerOrderIdentity(order: AlpacaOrder) {
  return {
    id: order.id,
    clientOrderId: order.client_order_id,
    status: normalizeBrokerOrderStatus(order.status),
  };
}

export async function diagnoseHistoricalOrderLifecycle(args: {
  tradingAccountId: number;
  now?: Date;
  lookupBudget?: number;
  openOrders?: AlpacaOrder[];
}) {
  const now = args.now ?? new Date();
  const cutoff = new Date(now.getTime() - HISTORICAL_ORDER_MINIMUM_AGE_MS);
  const openOrders =
    args.openOrders ??
    (await getOpenAlpacaOrders(args.tradingAccountId, 'open_orders_sync'));
  const openIds = new Set(openOrders.flatMap((order) => [order.id, order.client_order_id]));
  const localCandidates = await prisma.brokerOrder.findMany({
    where: {
      tradingAccountId: args.tradingAccountId,
      status: NONTERMINAL_BROKER_ORDER_PRISMA_FILTER,
      createdAt: { lt: cutoff },
    },
    include: candidateInclude,
    orderBy: { id: 'asc' },
  });
  const candidates = localCandidates.filter(
    (order) =>
      !openIds.has(order.brokerOrderId) && !openIds.has(order.clientOrderId)
  );

  const locallyClassified = await Promise.all(
    candidates.map(async (order) => {
      const fillSummary = summarizeLocalFillEvidence({
        orderQty: order.orderIntent.qty,
        tradingAccountId: args.tradingAccountId,
        brokerOrderRecordId: order.id,
        activities: order.brokerActivities,
      });
      const fillEvidence = fillSummary.classification;
      const existingPositionIds = Array.from(
        new Set(
          [
            order.orderIntent.trackedPositionId,
            order.trackedPositionId,
            ...order.brokerActivities.map(
              (activity) => activity.trackedPositionId
            ),
          ].filter((id): id is number => id !== null)
        )
      );
      const positionCandidates =
        fillEvidence === 'full' && order.side.toLowerCase() === 'buy'
          ? await prisma.trackedPosition.findMany({
              where: {
                OR: [
                  {
                    tradingAccountId: args.tradingAccountId,
                    broker: order.broker,
                    symbol: order.symbol,
                  },
                  ...(fillSummary.completionTime
                    ? [
                        {
                          openedAt: {
                            gte: new Date(
                              fillSummary.completionTime.getTime() -
                                HISTORICAL_POSITION_TIME_TOLERANCE_MS
                            ),
                            lte: new Date(
                              fillSummary.completionTime.getTime() +
                                HISTORICAL_POSITION_TIME_TOLERANCE_MS
                            ),
                          },
                        },
                      ]
                    : []),
                  ...(existingPositionIds.length > 0
                    ? [{ id: { in: existingPositionIds } }]
                    : []),
                ],
              },
              orderBy: { openedAt: 'asc' },
            })
          : [];
      const existingLinkValidation = validateExistingHistoricalPositionLink({
        existingPositionIds,
        tradingAccountId: order.tradingAccountId,
        broker: order.broker,
        symbol: order.symbol,
        subscriptionId: order.orderIntent.subscriptionId,
        tradingAccountSubscriptionId:
          order.orderIntent.tradingAccountSubscriptionId,
        positions: positionCandidates,
      });
      const positionMatch = matchHistoricalEntryPosition(
        {
          tradingAccountId: order.tradingAccountId,
          broker: order.broker,
          symbol: order.symbol,
          side: order.side,
          qty: order.orderIntent.qty,
          fillPrice: fillSummary.weightedAveragePrice,
          fillTime: fillSummary.completionTime,
          subscriptionId: order.orderIntent.subscriptionId,
          tradingAccountSubscriptionId:
            order.orderIntent.tradingAccountSubscriptionId,
        },
        positionCandidates
      );
      const classifications: HistoricalOrderClassification[] = [];
      if (fillEvidence === 'full') classifications.push('FULL_FILL_LOCAL_EVIDENCE');
      if (fillEvidence === 'partial') classifications.push('PARTIAL_FILL_LOCAL_EVIDENCE');
      if (fillEvidence === 'full' && positionMatch.status === 'exact')
        classifications.push('POSITION_LINK_EXACT');
      if (
        fillEvidence === 'full' &&
        existingLinkValidation.status === 'valid'
      )
        classifications.push('POSITION_LINK_EXISTING_VALID');
      if (fillEvidence === 'full' && positionMatch.status === 'ambiguous')
        classifications.push('POSITION_LINK_AMBIGUOUS');
      if (fillEvidence === 'full' && positionMatch.status === 'missing')
        classifications.push('POSITION_LINK_MISSING');
      return {
        order,
        fillEvidence,
        fillSummary,
        positionMatch,
        existingLinkValidation,
        classifications,
      };
    })
  );

  const needingLookup = locallyClassified
    .filter((candidate) => candidate.fillEvidence !== 'full')
    .slice(0, args.lookupBudget ?? HISTORICAL_LOOKUP_BUDGET);
  const lookupResults = await mapBounded(
    needingLookup,
    HISTORICAL_LOOKUP_CONCURRENCY,
    async (candidate) => {
      try {
        return {
          brokerOrder: await lookupHistoricalOrder({
            tradingAccountId: args.tradingAccountId,
            brokerOrderId: candidate.order.brokerOrderId,
            clientOrderId: candidate.order.clientOrderId,
          }),
          failed: false,
        };
      } catch {
        return { brokerOrder: null, failed: true };
      }
    }
  );
  const lookupById = new Map(
    needingLookup.map((candidate, index) => [
      candidate.order.id,
      lookupResults[index]!,
    ])
  );

  const rows = locallyClassified.map((candidate) => {
    const lookup = lookupById.get(candidate.order.id);
    if (lookup?.failed) candidate.classifications.push('BROKER_LOOKUP_FAILED');
    else if (lookup?.brokerOrder) {
      candidate.classifications.push(
        isTerminalBrokerOrderStatus(lookup.brokerOrder.status)
          ? 'TERMINAL_BROKER_CONFIRMED'
          : 'NONTERMINAL_BROKER_CONFIRMED'
      );
    } else if (candidate.fillEvidence !== 'full') {
      candidate.classifications.push('NO_TERMINAL_EVIDENCE');
    }
    return {
      tradingAccountId: args.tradingAccountId,
      orderIntentId: candidate.order.orderIntentId,
      brokerOrderRecordId: candidate.order.id,
      brokerOrderId: candidate.order.brokerOrderId,
      clientOrderId: candidate.order.clientOrderId,
      symbol: candidate.order.symbol,
      side: candidate.order.side,
      quantity: candidate.order.orderIntent.qty,
      brokerOrderStatus: candidate.order.status,
      orderIntentStatus: candidate.order.orderIntent.status,
      blockReason: candidate.order.orderIntent.blockReason,
      orderIntentTrackedPositionId:
        candidate.order.orderIntent.trackedPositionId,
      brokerOrderTrackedPositionId: candidate.order.trackedPositionId,
      activityTrackedPositionIds: Array.from(
        new Set(
          candidate.order.brokerActivities
            .map((activity) => activity.trackedPositionId)
            .filter((id): id is number => id !== null)
        )
      ),
      localStateFingerprint:
        createHistoricalLifecycleStateFingerprint(candidate.order),
      fillEvidence: {
        cumulativeQty: candidate.fillSummary.cumulativeQty,
        leavesQty: candidate.fillSummary.leavesQty,
        weightedAveragePrice: candidate.fillSummary.weightedAveragePrice,
        completionTime:
          candidate.fillSummary.completionTime?.toISOString() ?? null,
        activityCount: candidate.fillSummary.activityCount,
      },
      subscriptionId: candidate.order.orderIntent.subscriptionId,
      tradingAccountSubscriptionId:
        candidate.order.orderIntent.tradingAccountSubscriptionId,
      createdAt: candidate.order.createdAt,
      classifications: candidate.classifications,
      matchedTrackedPositionId:
        candidate.positionMatch.status === 'exact'
          ? candidate.positionMatch.match.id
          : null,
      validatedExistingTrackedPositionId:
        candidate.existingLinkValidation.trackedPositionId,
      existingPositionLinkValidation: {
        status: candidate.existingLinkValidation.status,
        rejectionReasons:
          candidate.existingLinkValidation.rejectionReasons,
      },
      candidateTrackedPositionIds: candidate.positionMatch.matches.map(
        (position) => position.id
      ),
      candidatePositionEvaluations: candidate.positionMatch.evaluations.map(
        (evaluation) => ({
          trackedPositionId: evaluation.candidate.id,
          rejectionReasons:
            evaluation.rejectionReasons.length > 0
              ? evaluation.rejectionReasons
              : candidate.positionMatch.status === 'ambiguous'
                ? ['ambiguity']
                : [],
        })
      ),
      positionMatchRejectionReason:
        candidate.positionMatch.status === 'ambiguous'
          ? 'ambiguity'
          : candidate.positionMatch.status === 'missing'
            ? 'no_matching_position'
            : null,
      brokerLookup: lookup?.brokerOrder
        ? brokerOrderIdentity(lookup.brokerOrder)
        : lookup?.failed
          ? { error: 'lookup_failed' }
          : null,
    };
  });

  return {
    mode: 'dry-run' as const,
    tradingAccountId: args.tradingAccountId,
    cutoff: cutoff.toISOString(),
    openBrokerOrderCount: openOrders.length,
    candidateCount: rows.length,
    lookupCount: needingLookup.length,
    lookupBudget: args.lookupBudget ?? HISTORICAL_LOOKUP_BUDGET,
    classificationCounts: rows
      .flatMap((row) => row.classifications)
      .reduce<Record<string, number>>((counts, classification) => {
        counts[classification] = (counts[classification] ?? 0) + 1;
        return counts;
      }, {}),
    candidates: rows,
  };
}
