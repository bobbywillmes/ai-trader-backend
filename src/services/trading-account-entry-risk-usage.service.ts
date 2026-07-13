import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import {
  getNewYorkDailyEntryWindow,
  representsDailyEntryActivity,
  representsPendingEntryExposure,
} from './trading-account-entry-risk-limits.service.js';

const ACTIVE_POSITION_STATUSES = ['open', 'closing'];
const PENDING_ENTRY_QUERY_STATUSES = [
  'pending',
  'submitting',
  'submitted',
  'new',
  'accepted',
  'accepted_for_bidding',
  'pending_new',
  'partially_filled',
  'filled',
];

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function getSizingEstimatedNotional(value: Prisma.JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sizing = (value as Record<string, unknown>).accountSubscriptionSizing;

  if (!sizing || typeof sizing !== 'object' || Array.isArray(sizing)) return null;
  const estimatedNotional = (sizing as Record<string, unknown>).estimatedNotional;

  return isPositiveFiniteNumber(estimatedNotional) ? estimatedNotional : null;
}

export function getEntryIntentEstimatedNotional(order: {
  notional: number | null;
  qty: number | null;
  limitPrice: number | null;
  rawRequestJson: Prisma.JsonValue;
}) {
  if (isPositiveFiniteNumber(order.notional)) return order.notional;
  if (isPositiveFiniteNumber(order.qty) && isPositiveFiniteNumber(order.limitPrice)) {
    return order.qty * order.limitPrice;
  }

  return getSizingEstimatedNotional(order.rawRequestJson);
}

export function getTrackedPositionExposure(position: {
  marketValue: number;
  costBasis: number;
}) {
  return Math.abs(position.marketValue || position.costBasis || 0);
}

export async function getTradingAccountEntryRiskUsage(args: {
  tradingAccountId: number;
  symbol: string;
  now?: Date;
  excludeOrderIntentId?: number;
}) {
  const dailyWindow = getNewYorkDailyEntryWindow(args.now);
  const excludeIntentWhere = args.excludeOrderIntentId
    ? { id: { not: args.excludeOrderIntentId } }
    : {};
  const [activePositions, dailyCandidates, pendingCandidates] =
    await Promise.all([
      prisma.trackedPosition.findMany({
        where: {
          tradingAccountId: args.tradingAccountId,
          status: { in: ACTIVE_POSITION_STATUSES },
        },
        select: {
          id: true,
          symbol: true,
          subscriptionId: true,
          tradingAccountSubscriptionId: true,
          marketValue: true,
          costBasis: true,
          status: true,
        },
      }),
      prisma.orderIntent.findMany({
        where: {
          tradingAccountId: args.tradingAccountId,
          side: 'buy',
          createdAt: { gte: dailyWindow.start, lt: dailyWindow.nextStart },
          ...excludeIntentWhere,
        },
        select: {
          id: true,
          symbol: true,
          subscriptionId: true,
          side: true,
          status: true,
          blockReason: true,
          trackedPositionId: true,
          notional: true,
          qty: true,
          limitPrice: true,
          rawRequestJson: true,
          brokerOrders: { select: { id: true } },
        },
      }),
      prisma.orderIntent.findMany({
        where: {
          tradingAccountId: args.tradingAccountId,
          side: 'buy',
          trackedPositionId: null,
          blockReason: null,
          status: { in: PENDING_ENTRY_QUERY_STATUSES },
          ...excludeIntentWhere,
        },
        select: {
          id: true,
          symbol: true,
          subscriptionId: true,
          side: true,
          status: true,
          blockReason: true,
          trackedPositionId: true,
          notional: true,
          qty: true,
          limitPrice: true,
          rawRequestJson: true,
        },
      }),
    ]);

  const dailyEntryOrders = dailyCandidates.filter((intent) =>
    representsDailyEntryActivity({
      ...intent,
      brokerOrderCount: intent.brokerOrders?.length ?? 0,
    })
  );
  const pendingEntryOrders = pendingCandidates.filter(
    representsPendingEntryExposure
  );
  const openPositionNotional = activePositions.reduce(
    (total, position) => total + getTrackedPositionExposure(position),
    0
  );
  const pendingEntryNotional = pendingEntryOrders.reduce(
    (total, intent) => total + (getEntryIntentEstimatedNotional(intent) ?? 0),
    0
  );
  const symbolOpenNotional = activePositions
    .filter((position) => position.symbol === args.symbol)
    .reduce(
      (total, position) => total + getTrackedPositionExposure(position),
      0
    );
  const symbolPendingEntryNotional = pendingEntryOrders
    .filter((intent) => intent.symbol === args.symbol)
    .reduce(
      (total, intent) => total + (getEntryIntentEstimatedNotional(intent) ?? 0),
      0
    );

  const pendingEntryNotionalBySubscriptionId = new Map<number, number>();
  for (const intent of pendingEntryOrders) {
    if (intent.subscriptionId === null) continue;
    pendingEntryNotionalBySubscriptionId.set(
      intent.subscriptionId,
      (pendingEntryNotionalBySubscriptionId.get(intent.subscriptionId) ?? 0) +
        (getEntryIntentEstimatedNotional(intent) ?? 0)
    );
  }

  return {
    dailyWindow,
    activePositions,
    dailyEntryOrders,
    pendingEntryOrders,
    dailyEntryOrderCount: dailyEntryOrders.length,
    dailyEntryNotional: dailyEntryOrders.reduce(
      (total, intent) => total + (getEntryIntentEstimatedNotional(intent) ?? 0),
      0
    ),
    activePositionCount: activePositions.length,
    pendingEntryPositionCount: pendingEntryOrders.length,
    currentAccountPositionSlots:
      activePositions.length + pendingEntryOrders.length,
    openPositionNotional,
    pendingEntryNotional,
    currentAccountExposure: openPositionNotional + pendingEntryNotional,
    symbolOpenNotional,
    symbolPendingEntryNotional,
    currentSymbolExposure: symbolOpenNotional + symbolPendingEntryNotional,
    activeSymbols: Array.from(
      new Set(activePositions.map((position) => position.symbol))
    ),
    pendingSymbols: Array.from(
      new Set(pendingEntryOrders.map((intent) => intent.symbol))
    ),
    pendingEntryNotionalBySubscriptionId,
  };
}
