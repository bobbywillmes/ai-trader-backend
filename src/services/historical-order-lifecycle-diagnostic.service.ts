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
    return { status: 'missing' as const, matches: [] };
  }

  const matches = candidates.filter(
    (candidate) =>
      candidate.tradingAccountId === input.tradingAccountId &&
      candidate.broker.toLowerCase() === input.broker.toLowerCase() &&
      candidate.symbol.toUpperCase() === input.symbol.toUpperCase() &&
      candidate.subscriptionId === input.subscriptionId &&
      candidate.tradingAccountSubscriptionId ===
        input.tradingAccountSubscriptionId &&
      closeEnough(Math.abs(candidate.qty), Math.abs(input.qty!), HISTORICAL_QUANTITY_TOLERANCE) &&
      closeEnough(candidate.avgEntryPrice, input.fillPrice!, HISTORICAL_PRICE_TOLERANCE) &&
      Math.abs(candidate.openedAt.getTime() - input.fillTime!.getTime()) <=
        HISTORICAL_POSITION_TIME_TOLERANCE_MS
  );

  if (matches.length === 1) {
    return { status: 'exact' as const, match: matches[0]!, matches };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous' as const, matches };
  }
  return { status: 'missing' as const, matches };
}

type FillEvidenceActivity = {
  activityType: string;
  cumQty: number | null;
  leavesQty: number | null;
  price: number | null;
  transactionTime: Date | null;
  tradingAccountId: number | null;
  brokerOrderRecordId: number | null;
};

export function classifyLocalFillEvidence(args: {
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
  if (ownedFills.length === 0 || args.orderQty === null) return 'none' as const;

  const latest = [...ownedFills].sort(
    (left, right) =>
      (right.transactionTime?.getTime() ?? 0) -
      (left.transactionTime?.getTime() ?? 0)
  )[0]!;
  if (
    latest.cumQty !== null &&
    latest.leavesQty !== null &&
    closeEnough(Math.abs(latest.cumQty), Math.abs(args.orderQty), HISTORICAL_QUANTITY_TOLERANCE) &&
    closeEnough(Math.abs(latest.leavesQty), 0, HISTORICAL_QUANTITY_TOLERANCE)
  ) {
    return 'full' as const;
  }
  return 'partial' as const;
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
}) {
  const now = args.now ?? new Date();
  const cutoff = new Date(now.getTime() - HISTORICAL_ORDER_MINIMUM_AGE_MS);
  const openOrders = await getOpenAlpacaOrders(
    args.tradingAccountId,
    'open_orders_sync'
  );
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
      const fillEvidence = classifyLocalFillEvidence({
        orderQty: order.orderIntent.qty,
        tradingAccountId: args.tradingAccountId,
        brokerOrderRecordId: order.id,
        activities: order.brokerActivities,
      });
      const fill = [...order.brokerActivities]
        .filter((activity) => activity.activityType.toUpperCase() === 'FILL')
        .sort(
          (left, right) =>
            (right.transactionTime?.getTime() ?? 0) -
            (left.transactionTime?.getTime() ?? 0)
        )[0];
      const positionCandidates =
        fillEvidence === 'full' && order.side.toLowerCase() === 'buy'
          ? await prisma.trackedPosition.findMany({
              where: {
                tradingAccountId: args.tradingAccountId,
                broker: order.broker,
                symbol: order.symbol,
              },
              orderBy: { openedAt: 'asc' },
            })
          : [];
      const positionMatch = matchHistoricalEntryPosition(
        {
          tradingAccountId: order.tradingAccountId,
          broker: order.broker,
          symbol: order.symbol,
          side: order.side,
          qty: order.orderIntent.qty,
          fillPrice: fill?.price ?? null,
          fillTime: fill?.transactionTime ?? null,
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
      if (fillEvidence === 'full' && positionMatch.status === 'ambiguous')
        classifications.push('POSITION_LINK_AMBIGUOUS');
      if (fillEvidence === 'full' && positionMatch.status === 'missing')
        classifications.push('POSITION_LINK_MISSING');
      return { order, fillEvidence, fill, positionMatch, classifications };
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
      subscriptionId: candidate.order.orderIntent.subscriptionId,
      tradingAccountSubscriptionId:
        candidate.order.orderIntent.tradingAccountSubscriptionId,
      createdAt: candidate.order.createdAt,
      classifications: candidate.classifications,
      matchedTrackedPositionId:
        candidate.positionMatch.status === 'exact'
          ? candidate.positionMatch.match.id
          : null,
      candidateTrackedPositionIds: candidate.positionMatch.matches.map(
        (position) => position.id
      ),
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
