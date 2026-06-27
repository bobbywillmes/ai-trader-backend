import type { BrokerActivity, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { resolveDefaultTradingAccountId } from './trading-account.service.js';

export type TradeCycleFilters = {
  symbol?: string;
  status?: 'open' | 'closed' | 'closing';
  dateFrom?: Date;
  dateTo?: Date;
  closedDateFrom?: Date;
  closedDateTo?: Date;
  strategyId?: number;
  subscriptionId?: number;
  exitProfileId?: number;
  exitReason?: string;
  mode?: string;
  limit?: number | null;
};

function getCloseSide(positionSide: string): 'buy' | 'sell' {
  return positionSide.toLowerCase() === 'short' ? 'buy' : 'sell';
}

function getEntrySide(positionSide: string): 'buy' | 'sell' {
  return positionSide.toLowerCase() === 'short' ? 'sell' : 'buy';
}

function averageFillPrice(fills: BrokerActivity[]) {
  const totalQty = fills.reduce(
    (total, fill) => total + Math.abs(fill.qty ?? 0),
    0
  );

  if (totalQty === 0) {
    return null;
  }

  const notional = fills.reduce(
    (total, fill) => total + Math.abs(fill.qty ?? 0) * (fill.price ?? 0),
    0
  );

  return notional / totalQty;
}

function sumFillQty(fills: BrokerActivity[]) {
  const total = fills.reduce((sum, fill) => sum + Math.abs(fill.qty ?? 0), 0);
  return total > 0 ? total : null;
}

function getHoldingDurationMs(args: {
  openedAt: Date;
  closedAt: Date | null;
}) {
  if (!args.closedAt) {
    return null;
  }

  return Math.max(0, args.closedAt.getTime() - args.openedAt.getTime());
}

function getRealizedPnl(args: {
  side: string;
  qty: number;
  avgEntryPrice: number;
  avgExitPrice: number | null;
}) {
  if (args.avgExitPrice === null) {
    return null;
  }

  const qty = Math.abs(args.qty);

  if (args.side.toLowerCase() === 'short') {
    return (args.avgEntryPrice - args.avgExitPrice) * qty;
  }

  return (args.avgExitPrice - args.avgEntryPrice) * qty;
}

function getReturnPct(args: {
  side: string;
  avgEntryPrice: number;
  avgExitPrice: number | null;
}) {
  if (args.avgExitPrice === null || args.avgEntryPrice === 0) {
    return null;
  }

  if (args.side.toLowerCase() === 'short') {
    return (args.avgEntryPrice - args.avgExitPrice) / args.avgEntryPrice;
  }

  return (args.avgExitPrice - args.avgEntryPrice) / args.avgEntryPrice;
}

function parseExitReason(position: {
  exitState: { status: string; attentionCode: string | null } | null;
}) {
  const status = position.exitState?.status ?? null;

  if (status === 'closed') {
    return null;
  }

  return position.exitState?.attentionCode ?? status;
}

type TrackedPositionSystemEvent = {
  id: number;
  type: string;
  message: string | null;
  createdAt: Date;
  payloadJson: Prisma.JsonValue;
};

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPayloadNumber(
  payload: Prisma.JsonValue,
  key: string
): number | null {
  if (!isJsonObject(payload)) {
    return null;
  }

  const value = payload[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readSnapshotObject(
  snapshot: Prisma.JsonValue | null | undefined,
  key: string
) {
  if (!snapshot || !isJsonObject(snapshot)) {
    return null;
  }

  const value = snapshot[key];

  return value !== undefined && isJsonObject(value) ? value : null;
}

function readSnapshotString(
  value: Prisma.JsonObject | null,
  key: string
): string | null {
  const field = value?.[key];
  return typeof field === 'string' ? field : null;
}

function readSnapshotNumber(
  value: Prisma.JsonObject | null,
  key: string
): number | null {
  const field = value?.[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

function getLatestPositionClosedEvent(events: TrackedPositionSystemEvent[]) {
  return events
    .filter((event) => event.type === 'position.closed')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

function buildCycleSummary(
  position: Prisma.TrackedPositionGetPayload<{
    include: {
      exitState: true;
      subscription: {
        include: {
          strategy: true;
          exitProfile: true;
        };
      };
      brokerActivities: true;
      entryDecision: true;
    };
  }>,
  systemEvents: TrackedPositionSystemEvent[] = []
) {
  const entrySide = getEntrySide(position.side);
  const closeSide = getCloseSide(position.side);
  const entryFills = position.brokerActivities.filter(
    (activity) => activity.activityType === 'FILL' && activity.side === entrySide
  );
  const closeFills = position.brokerActivities.filter(
    (activity) => activity.activityType === 'FILL' && activity.side === closeSide
  );
  const avgEntryPrice =
    averageFillPrice(entryFills) ?? position.avgEntryPrice ?? null;
  const closedEvent = getLatestPositionClosedEvent(systemEvents);
  const snapshot = position.configSnapshotJson as Prisma.JsonValue | null;
  const snapshotStrategy = readSnapshotObject(snapshot, 'strategy');
  const snapshotSubscription = readSnapshotObject(snapshot, 'subscription');
  const snapshotExitProfile = readSnapshotObject(snapshot, 'exitProfile');
  const eventClosePrice = closedEvent
    ? readPayloadNumber(closedEvent.payloadJson, 'closePrice')
    : null;
  const eventCloseQty = closedEvent
    ? readPayloadNumber(closedEvent.payloadJson, 'closeQty')
    : null;
  const avgExitPrice = averageFillPrice(closeFills) ?? eventClosePrice;
  const realizedPnl = getRealizedPnl({
    side: position.side,
    qty: position.qty,
    avgEntryPrice,
    avgExitPrice,
  });

  return {
    id: position.id,
    broker: position.broker,
    symbol: position.symbol,
    side: position.side,
    status: position.status,
    openedAt: position.openedAt,
    closedAt: position.closedAt,
    quantity: position.qty,
    avgEntryPrice,
    avgExitPrice,
    realizedPnl,
    returnPct: getReturnPct({
      side: position.side,
      avgEntryPrice,
      avgExitPrice,
    }),
    holdingDurationMs: getHoldingDurationMs({
      openedAt: position.openedAt,
      closedAt: position.closedAt,
    }),
    entryFillQty: sumFillQty(entryFills),
    closeFillQty: sumFillQty(closeFills) ?? eventCloseQty,
    strategy: snapshotStrategy
      ? {
          id: readSnapshotNumber(snapshotStrategy, 'id'),
          key: readSnapshotString(snapshotStrategy, 'key'),
          name: readSnapshotString(snapshotStrategy, 'name'),
        }
      : position.subscription?.strategy
      ? {
          id: position.subscription.strategy.id,
          key: position.subscription.strategy.key,
          name: position.subscription.strategy.name,
        }
      : null,
    subscription: snapshotSubscription
      ? {
          id: readSnapshotNumber(snapshotSubscription, 'id'),
          key: readSnapshotString(snapshotSubscription, 'key'),
          name: readSnapshotString(snapshotSubscription, 'name'),
          brokerMode: readSnapshotString(snapshotSubscription, 'brokerMode'),
        }
      : position.subscription
      ? {
          id: position.subscription.id,
          key: position.subscription.key,
          name: position.subscription.name,
          brokerMode: position.subscription.brokerMode,
        }
      : null,
    exitProfile: snapshotExitProfile
      ? {
          id: readSnapshotNumber(snapshotExitProfile, 'id'),
          key: readSnapshotString(snapshotExitProfile, 'key'),
          name: readSnapshotString(snapshotExitProfile, 'name'),
        }
      : position.subscription?.exitProfile
      ? {
          id: position.subscription.exitProfile.id,
          key: position.subscription.exitProfile.key,
          name: position.subscription.exitProfile.name,
        }
      : null,
    exitReason: parseExitReason(position),
    exitStateStatus: position.exitState?.status ?? null,
    entryDecision: position.entryDecision
      ? {
          id: position.entryDecision.id,
          decisionKey: position.entryDecision.decisionKey,
          evaluatedAt: position.entryDecision.evaluatedAt,
          source: position.entryDecision.source,
          decisionState: position.entryDecision.decisionState,
          decisionReason: position.entryDecision.decisionReason,
          signalCreated: position.entryDecision.signalCreated,
          signalBlocked: position.entryDecision.signalBlocked,
          blockingReason: position.entryDecision.blockingReason,
          persistenceReason: position.entryDecision.persistenceReason,
        }
      : null,
  };
}

function buildWhere(
  filters: TradeCycleFilters,
  tradingAccountId: number
): Prisma.TrackedPositionWhereInput {
  const where: Prisma.TrackedPositionWhereInput = { tradingAccountId };

  if (filters.symbol) {
    where.symbol = filters.symbol.trim().toUpperCase();
  }

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.dateFrom || filters.dateTo) {
    where.openedAt = {
      ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { lte: filters.dateTo } : {}),
    };
  }

  if (filters.closedDateFrom || filters.closedDateTo) {
    where.closedAt = {
      ...(filters.closedDateFrom ? { gte: filters.closedDateFrom } : {}),
      ...(filters.closedDateTo ? { lte: filters.closedDateTo } : {}),
    };
  }

  if (filters.subscriptionId !== undefined) {
    where.subscriptionId = filters.subscriptionId;
  }

  if (
    filters.strategyId !== undefined ||
    filters.exitProfileId !== undefined ||
    filters.mode !== undefined
  ) {
    where.subscription = {
      ...(filters.strategyId !== undefined
        ? { strategyId: filters.strategyId }
        : {}),
      ...(filters.exitProfileId !== undefined
        ? { exitProfileId: filters.exitProfileId }
        : {}),
      ...(filters.mode !== undefined ? { brokerMode: filters.mode } : {}),
    };
  }

  if (filters.exitReason) {
    where.exitState = {
      OR: [
        { status: filters.exitReason },
        { attentionCode: filters.exitReason },
      ],
    };
  }

  return where;
}

const tradeCycleInclude = {
  exitState: true,
  subscription: {
    include: {
      strategy: true,
      exitProfile: true,
    },
  },
  brokerActivities: {
    orderBy: {
      transactionTime: 'asc',
    },
  },
  entryDecision: true,
} satisfies Prisma.TrackedPositionInclude;

export async function listTradeCycles(filters: TradeCycleFilters = {}) {
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const take = filters.limit === null ? undefined : filters.limit ?? 50;
  const cycles = await prisma.trackedPosition.findMany({
    where: buildWhere(filters, tradingAccountId),
    include: tradeCycleInclude,
    orderBy: {
      openedAt: 'desc',
    },
    ...(take !== undefined ? { take } : {}),
  });

  const systemEvents = await prisma.systemEvent.findMany({
    where: {
      entityType: 'trackedPosition',
      entityId: {
        in: cycles.map((cycle) => String(cycle.id)),
      },
      tradingAccountId,
      type: 'position.closed',
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  const systemEventsByTrackedPositionId = new Map<
    string,
    TrackedPositionSystemEvent[]
  >();

  for (const event of systemEvents) {
    const existing = systemEventsByTrackedPositionId.get(event.entityId) ?? [];
    existing.push(event);
    systemEventsByTrackedPositionId.set(event.entityId, existing);
  }

  return {
    cycles: cycles.map((cycle) =>
      buildCycleSummary(
        cycle,
        systemEventsByTrackedPositionId.get(String(cycle.id)) ?? []
      )
    ),
  };
}

export async function getTradeCycleById(id: number) {
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const position = await prisma.trackedPosition.findFirst({
    where: { id, tradingAccountId },
    include: {
      ...tradeCycleInclude,
      orderIntents: {
        include: {
          brokerOrders: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      },
      brokerOrders: {
        orderBy: {
          createdAt: 'asc',
        },
      },
    },
  });

  if (!position) {
    throw new HttpError(404, `Trade cycle ${id} was not found.`);
  }

  const systemEvents = await prisma.systemEvent.findMany({
    where: {
      entityType: 'trackedPosition',
      entityId: String(id),
      tradingAccountId,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  return {
    cycle: {
      ...buildCycleSummary(position, systemEvents),
      rawPositionJson: position.rawPositionJson,
      configSnapshotJson: position.configSnapshotJson,
      configSnapshotCapturedAt: position.configSnapshotCapturedAt,
      currentPrice: position.currentPrice,
      marketValue: position.marketValue,
      costBasis: position.costBasis,
      unrealizedPnL: position.unrealizedPnL,
      unrealizedPnLPct: position.unrealizedPnLPct,
      exitState: position.exitState,
      orderIntents: position.orderIntents,
      brokerOrders: position.brokerOrders,
      brokerActivities: position.brokerActivities,
      entryDecision: position.entryDecision,
      systemEvents,
      timeline: buildTimeline({
        openedAt: position.openedAt,
        closedAt: position.closedAt,
        entryDecision: position.entryDecision,
        orderIntents: position.orderIntents,
        brokerOrders: position.brokerOrders,
        brokerActivities: position.brokerActivities,
        systemEvents,
      }),
    },
  };
}

function buildTimeline(args: {
  openedAt: Date;
  closedAt: Date | null;
  entryDecision: {
    id: number;
    decisionState: string;
    decisionReason: string | null;
    evaluatedAt: Date;
  } | null;
  orderIntents: Array<{
    id: number;
    source: string;
    side: string;
    status: string;
    createdAt: Date;
  }>;
  brokerOrders: Array<{
    id: number;
    brokerOrderId: string;
    side: string;
    status: string;
    createdAt: Date;
  }>;
  brokerActivities: BrokerActivity[];
  systemEvents: Array<{
    id: number;
    type: string;
    message: string | null;
    createdAt: Date;
    payloadJson: Prisma.JsonValue;
  }>;
}) {
  const items = [
    {
      type: 'position.opened',
      occurredAt: args.openedAt,
      source: 'tracked_position',
      summary: 'Position tracking started',
      entityId: null,
    },
    ...(args.entryDecision
      ? [
          {
            type: `entry_decision.${args.entryDecision.decisionState}`,
            occurredAt: args.entryDecision.evaluatedAt,
            source: 'entry_decision',
            summary:
              args.entryDecision.decisionReason ??
              args.entryDecision.decisionState,
            entityId: args.entryDecision.id,
          },
        ]
      : []),
    ...args.orderIntents.map((intent) => ({
      type: `order_intent.${intent.status}`,
      occurredAt: intent.createdAt,
      source: 'order_intent',
      summary: `${intent.side.toUpperCase()} intent from ${intent.source}`,
      entityId: intent.id,
    })),
    ...args.brokerOrders.map((order) => ({
      type: `broker_order.${order.status}`,
      occurredAt: order.createdAt,
      source: 'broker_order',
      summary: `${order.side.toUpperCase()} broker order ${order.status}`,
      entityId: order.id,
    })),
    ...args.brokerActivities.map((activity) => ({
      type: `broker_activity.${activity.activityType.toLowerCase()}`,
      occurredAt: activity.transactionTime ?? activity.createdAt,
      source: 'broker_activity',
      summary: `${activity.activityType} ${activity.side ?? ''} ${
        activity.qty ?? ''
      } @ ${activity.price ?? ''}`.trim(),
      entityId: activity.id,
    })),
    ...args.systemEvents.map((event) => ({
      type: event.type,
      occurredAt: event.createdAt,
      source: 'system_event',
      summary: event.message ?? event.type,
      entityId: event.id,
    })),
    ...(args.closedAt
      ? [
          {
            type: 'position.closed',
            occurredAt: args.closedAt,
            source: 'tracked_position',
            summary: 'Position tracking closed',
            entityId: null,
          },
        ]
      : []),
  ];

  return items.sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()
  );
}
