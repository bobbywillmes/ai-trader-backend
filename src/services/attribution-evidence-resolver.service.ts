import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { getAlpacaOrderById } from '../integrations/alpaca/orders.adapter.js';
import { parseTradingAccountSubscriptionIdFromClientOrderId } from './client-order-id.service.js';

export type AttributionBrokerLookupPolicy = 'LOCAL_ONLY' | 'ALLOW_EXACT_ORDER_ID_READ';
export type AttributionConfidence = 'DETERMINISTIC' | 'STRONG' | 'AMBIGUOUS' | 'INSUFFICIENT';

export type ExactBrokerAttributionResult = {
  confidence: AttributionConfidence;
  resolutionSource: 'BROKER_CLIENT_ORDER_ID' | null;
  reason: string;
  assignment: {
    id: number;
    tradingAccountId: number;
    subscriptionId: number;
    subscriptionKey: string;
    symbol: string;
    exitProfileId: number;
    exitProfileKey: string;
    exitsEnabled: boolean;
  } | null;
  brokerOrderId: string | null;
  clientOrderId: string | null;
  activities: Array<{
    id: number;
    activityId: string;
    orderId: string | null;
    qty: number | null;
    price: number | null;
    transactionTime: string | null;
  }>;
  fillQty: number | null;
  weightedAveragePrice: number | null;
  candidates: Array<{ assignmentId: number; subscriptionId: number; subscriptionKey: string; exitProfileKey: string }>;
  rejectedAlternatives: Array<{ assignmentId: number; reason: string }>;
  warnings: Array<{ code: string; message: string }>;
};

const LOOKBACK_MS = 12 * 60 * 60_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const NUMERIC_TOLERANCE = 1e-6;

function closeEnough(actual: number, expected: number) {
  return Math.abs(actual - expected) <= Math.max(NUMERIC_TOLERANCE, Math.abs(expected) * 1e-9);
}

function baseResult(args: {
  confidence: AttributionConfidence;
  reason: string;
  activities: ExactBrokerAttributionResult['activities'];
  brokerOrderId?: string | null;
  clientOrderId?: string | null;
  candidates: ExactBrokerAttributionResult['candidates'];
}): ExactBrokerAttributionResult {
  return {
    confidence: args.confidence,
    resolutionSource: null,
    reason: args.reason,
    assignment: null,
    brokerOrderId: args.brokerOrderId ?? null,
    clientOrderId: args.clientOrderId ?? null,
    activities: args.activities,
    fillQty: null,
    weightedAveragePrice: null,
    candidates: args.candidates,
    rejectedAlternatives: [],
    warnings: [],
  };
}

export async function resolveExactBrokerOrderAttribution(args: {
  tradingAccountId: number;
  broker: string;
  symbol: string;
  side: string;
  qty: number;
  avgEntryPrice: number;
  openedAt: Date;
  mode: string;
  policy: AttributionBrokerLookupPolicy;
}): Promise<ExactBrokerAttributionResult | null> {
  const symbol = args.symbol.trim().toUpperCase();
  const entrySide = args.side.toLowerCase() === 'short' ? 'sell' : 'buy';
  const rows = await prisma.brokerActivity.findMany({
    where: {
      tradingAccountId: args.tradingAccountId,
      broker: args.broker,
      mode: args.mode,
      activityType: 'FILL',
      symbol,
      side: entrySide,
      transactionTime: {
        gte: new Date(args.openedAt.getTime() - LOOKBACK_MS),
        lte: new Date(args.openedAt.getTime() + FUTURE_TOLERANCE_MS),
      },
    },
    select: {
      id: true, activityId: true, orderId: true, qty: true, price: true,
      transactionTime: true, brokerOrderRecordId: true, trackedPositionId: true,
    },
    orderBy: [{ transactionTime: 'asc' }, { id: 'asc' }],
  });
  const relevant = rows.filter((row) => row.orderId !== null && row.brokerOrderRecordId === null);
  if (relevant.length === 0) return null;

  const activities = relevant.map((row) => ({
    id: row.id, activityId: row.activityId, orderId: row.orderId, qty: row.qty,
    price: row.price, transactionTime: row.transactionTime?.toISOString() ?? null,
  }));
  const candidates = await prisma.tradingAccountSubscription.findMany({
    where: { tradingAccountId: args.tradingAccountId, subscription: { symbol } },
    select: {
      id: true, subscriptionId: true,
      subscription: { select: { key: true, exitProfile: { select: { key: true } } } },
    },
    orderBy: { id: 'asc' },
  });
  const candidateSummaries = candidates.map((row) => ({
    assignmentId: row.id, subscriptionId: row.subscriptionId,
    subscriptionKey: row.subscription.key, exitProfileKey: row.subscription.exitProfile.key,
  }));
  const orderIds = [...new Set(relevant.map((row) => row.orderId!))];
  if (orderIds.length !== 1) {
    return baseResult({ confidence: 'AMBIGUOUS', reason: 'multiple_broker_order_ids', activities, candidates: candidateSummaries });
  }
  const brokerOrderId = orderIds[0]!;
  if (args.policy === 'LOCAL_ONLY') {
    return baseResult({ confidence: 'INSUFFICIENT', reason: 'exact_broker_order_read_required', activities, brokerOrderId, candidates: candidateSummaries });
  }

  let order;
  try {
    order = await getAlpacaOrderById(args.tradingAccountId, brokerOrderId, 'manual_admin_action');
  } catch {
    return baseResult({ confidence: 'INSUFFICIENT', reason: 'broker_order_read_failed', activities, brokerOrderId, candidates: candidateSummaries });
  }
  if (!order) {
    return baseResult({ confidence: 'INSUFFICIENT', reason: 'broker_order_not_found', activities, brokerOrderId, candidates: candidateSummaries });
  }
  if (order.id !== brokerOrderId) {
    return baseResult({ confidence: 'INSUFFICIENT', reason: 'broker_order_uuid_mismatch', activities, brokerOrderId, clientOrderId: order.client_order_id ?? null, candidates: candidateSummaries });
  }
  const clientOrderId = order.client_order_id ?? null;
  const assignmentId = parseTradingAccountSubscriptionIdFromClientOrderId(clientOrderId);
  if (!assignmentId) {
    return baseResult({ confidence: 'INSUFFICIENT', reason: 'malformed_or_unsupported_client_order_id', activities, brokerOrderId, clientOrderId, candidates: candidateSummaries });
  }
  if (order.symbol?.trim().toUpperCase() !== symbol || order.side?.toLowerCase() !== entrySide) {
    return baseResult({ confidence: 'INSUFFICIENT', reason: 'broker_order_symbol_or_side_mismatch', activities, brokerOrderId, clientOrderId, candidates: candidateSummaries });
  }

  const assignment = await prisma.tradingAccountSubscription.findUnique({
    where: { id: assignmentId },
    include: {
      subscription: { include: { security: true, strategy: true, exitProfile: true } },
    },
  });
  if (!assignment || assignment.tradingAccountId !== args.tradingAccountId) {
    return baseResult({ confidence: 'INSUFFICIENT', reason: assignment ? 'assignment_wrong_trading_account' : 'assignment_not_found', activities, brokerOrderId, clientOrderId, candidates: candidateSummaries });
  }
  const subscription = assignment.subscription;
  if (subscription.symbol.trim().toUpperCase() !== symbol || subscription.security.symbol.trim().toUpperCase() !== symbol) {
    return baseResult({ confidence: 'INSUFFICIENT', reason: 'assignment_symbol_or_security_mismatch', activities, brokerOrderId, clientOrderId, candidates: candidateSummaries });
  }
  if (!assignment.enabled || !subscription.enabled || !subscription.strategy.enabled || !subscription.exitProfile.enabled) {
    return baseResult({ confidence: 'INSUFFICIENT', reason: 'assignment_lifecycle_configuration_disabled', activities, brokerOrderId, clientOrderId, candidates: candidateSummaries });
  }

  const fillQty = relevant.reduce((sum, row) => sum + Math.abs(row.qty ?? 0), 0);
  const notional = relevant.reduce((sum, row) => sum + Math.abs(row.qty ?? 0) * (row.price ?? 0), 0);
  const weightedAveragePrice = fillQty > 0 ? notional / fillQty : 0;
  if (!closeEnough(fillQty, Math.abs(args.qty))) {
    return { ...baseResult({ confidence: 'INSUFFICIENT', reason: 'fill_quantity_mismatch', activities, brokerOrderId, clientOrderId, candidates: candidateSummaries }), fillQty, weightedAveragePrice };
  }
  if (!closeEnough(weightedAveragePrice, args.avgEntryPrice)) {
    return { ...baseResult({ confidence: 'INSUFFICIENT', reason: 'fill_weighted_price_mismatch', activities, brokerOrderId, clientOrderId, candidates: candidateSummaries }), fillQty, weightedAveragePrice };
  }

  return {
    confidence: 'DETERMINISTIC', resolutionSource: 'BROKER_CLIENT_ORDER_ID', reason: 'exact_broker_client_order_assignment',
    assignment: {
      id: assignment.id, tradingAccountId: assignment.tradingAccountId,
      subscriptionId: assignment.subscriptionId, subscriptionKey: subscription.key,
      symbol: subscription.symbol, exitProfileId: subscription.exitProfileId,
      exitProfileKey: subscription.exitProfile.key, exitsEnabled: assignment.exitsEnabled,
    },
    brokerOrderId, clientOrderId, activities, fillQty, weightedAveragePrice,
    candidates: candidateSummaries,
    rejectedAlternatives: candidateSummaries.filter((row) => row.assignmentId !== assignment.id).map((row) => ({ assignmentId: row.assignmentId, reason: `Broker client-order identity names assignment ${assignment.id}.` })),
    warnings: assignment.exitsEnabled ? [] : [{ code: 'ASSIGNMENT_EXITS_DISABLED', message: 'Attribution identity is deterministic, but automated exits are disabled for the assignment.' }],
  };
}

export function attributionEvidenceJson(value: ExactBrokerAttributionResult): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}
