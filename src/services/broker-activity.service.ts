import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  getAlpacaAccountActivities,
  type AlpacaAccountActivity,
} from '../integrations/alpaca/activities.adapter.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { createSystemEvent } from './system-event.service.js';
import { resolveDefaultTradingAccountId } from './trading-account.service.js';

type SyncBrokerActivitiesInput = {
  activityType?: string;
  after?: Date;
  pageSize?: number;
  maxPages?: number;
  operation?: AlpacaApiOperation;
};

export type BrokerActivityTrackedPositionLinkSource =
  | 'broker_order'
  | 'exit_state_trailing_order'
  | 'close_order_submission'
  | 'reconciliation_discovered_close'
  | 'manual_review';

function parseNullableFloat(value: string | undefined): number | null {
  if (value === undefined) return null;

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableDate(value: string | undefined): Date | null {
  if (!value) return null;

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function subtractMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() - minutes * 60_000);
}

function defaultInitialAfterDate() {
  const date = new Date();
  date.setDate(date.getDate() - 3);
  return date;
}

async function getDefaultAfterDate(args: {
  activityType: string;
  tradingAccountId: number;
}) {
  const latest = await prisma.brokerActivity.findFirst({
    where: {
      activityType: args.activityType,
      tradingAccountId: args.tradingAccountId,
      transactionTime: {
        not: null,
      },
    },
    orderBy: {
      transactionTime: 'desc',
    },
  });

  if (!latest?.transactionTime) {
    return defaultInitialAfterDate();
  }

  // Overlap slightly. Upserts prevent duplicate rows, and the overlap reduces
  // the chance of missing a late-arriving activity.
  return subtractMinutes(latest.transactionTime, 5);
}

async function findLinkedBrokerOrder(args: {
  activity: AlpacaAccountActivity;
  tradingAccountId: number;
}) {
  const { activity, tradingAccountId } = args;

  if (!activity.order_id) {
    return null;
  }

  return prisma.brokerOrder.findFirst({
    where: {
      broker: 'alpaca',
      brokerOrderId: activity.order_id,
      tradingAccountId,
    },
    include: {
      orderIntent: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

async function findTrackedPositionLink(args: {
  activity: AlpacaAccountActivity;
  linkedBrokerOrder: Awaited<ReturnType<typeof findLinkedBrokerOrder>>;
}) {
  const trackedPositionId =
    args.linkedBrokerOrder?.trackedPositionId ??
    args.linkedBrokerOrder?.orderIntent.trackedPositionId ??
    null;

  if (trackedPositionId !== null) {
    return {
      trackedPositionId,
      trackedPositionLinkSource:
        args.linkedBrokerOrder?.orderIntent.source === 'close-position'
          ? ('close_order_submission' as const)
          : ('broker_order' as const),
    };
  }

  if (!args.activity.order_id) {
    return {
      trackedPositionId: null,
      trackedPositionLinkSource: null,
    };
  }

  const exitState = await prisma.positionExitState.findFirst({
    where: {
      trailBrokerOrderId: args.activity.order_id,
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });

  if (exitState) {
    return {
      trackedPositionId: exitState.trackedPositionId,
      trackedPositionLinkSource: 'exit_state_trailing_order' as const,
    };
  }

  return {
    trackedPositionId: null,
    trackedPositionLinkSource: null,
  };
}

async function upsertBrokerActivity(args: {
  activity: AlpacaAccountActivity;
  mode: string;
  tradingAccountId: number;
}) {
  const { activity, mode, tradingAccountId } = args;

  const existing = await prisma.brokerActivity.findUnique({
    where: {
      activityId: activity.id,
    },
  });

  const linkedBrokerOrder = await findLinkedBrokerOrder({
    activity,
    tradingAccountId,
  });
  const trackedPositionLink = await findTrackedPositionLink({
    activity,
    linkedBrokerOrder,
  });
  const trackedPositionLinkedAt =
    trackedPositionLink.trackedPositionId !== null
      ? existing?.trackedPositionLinkedAt ?? new Date()
      : existing?.trackedPositionLinkedAt ?? null;

  const data = {
    broker: 'alpaca',
    mode,
    tradingAccountId,

    activityId: activity.id,
    activityType: activity.activity_type ?? activity.type ?? 'UNKNOWN',
    activityCategory: activity.type ?? null,

    symbol: activity.symbol ?? null,
    side: activity.side ?? null,

    qty: parseNullableFloat(activity.qty),
    cumQty: parseNullableFloat(activity.cum_qty),
    leavesQty: parseNullableFloat(activity.leaves_qty),
    price: parseNullableFloat(activity.price),
    netAmount: parseNullableFloat(activity.net_amount),

    orderId: activity.order_id ?? null,
    brokerOrderRecordId: linkedBrokerOrder?.id ?? null,
    orderIntentId: linkedBrokerOrder?.orderIntentId ?? null,
    trackedPositionId:
      trackedPositionLink.trackedPositionId ?? existing?.trackedPositionId ?? null,
    trackedPositionLinkSource:
      trackedPositionLink.trackedPositionLinkSource ??
      existing?.trackedPositionLinkSource ??
      null,
    trackedPositionLinkedAt,

    transactionTime: parseNullableDate(activity.transaction_time),

    rawBrokerJson: activity as unknown as Prisma.InputJsonValue,
  };

  if (existing) {
    await prisma.brokerActivity.update({
      where: {
        activityId: activity.id,
      },
      data,
    });

    return 'updated' as const;
  }

  await prisma.brokerActivity.create({
    data,
  });

  return 'created' as const;
}

export async function syncBrokerActivities(
  input: SyncBrokerActivitiesInput = {}
) {
  const activityType = input.activityType ?? 'FILL';
  const pageSize = input.pageSize ?? 100;
  const maxPages = input.maxPages ?? 5;
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const after =
    input.after ??
    (await getDefaultAfterDate({
      activityType,
      tradingAccountId,
    }));

  const config = await getRuntimeTradingConfig();
  const mode = config.paperMode ? 'paper' : 'live';

  let pageToken: string | undefined;
  let page = 0;

  let created = 0;
  let updated = 0;
  let seen = 0;

  while (page < maxPages) {
    const activityRequest: {
      activityType?: string;
      after?: Date | string;
      until?: Date | string;
      date?: Date | string;
      direction?: 'asc' | 'desc';
      pageSize?: number;
      pageToken?: string;
      operation?: AlpacaApiOperation;
    } = {
      activityType,
      after,
      direction: 'asc',
      pageSize,
      operation: input.operation ?? 'broker_activity_sync',
    };

    if (pageToken) {
      activityRequest.pageToken = pageToken;
    }

    const activities = await getAlpacaAccountActivities(activityRequest);

    if (activities.length === 0) {
      break;
    }

    for (const activity of activities) {
      seen += 1;

      const result = await upsertBrokerActivity({
        activity,
        mode,
        tradingAccountId,
      });

      if (result === 'created') created += 1;
      if (result === 'updated') updated += 1;
    }

    if (activities.length < pageSize) {
      break;
    }

    pageToken = activities[activities.length - 1]?.id;

    if (!pageToken) {
      break;
    }

    page += 1;
  }

  if (created > 0) {
    await createSystemEvent({
      type: 'broker_activity.synced',
      entityType: 'brokerActivity',
      entityId: 'alpaca',
      tradingAccountId,
      payloadJson: {
        broker: 'alpaca',
        mode,
        activityType,
        after: after.toISOString(),
        seen,
        created,
        updated,
      } as Prisma.InputJsonValue,
    });
  }

  return {
    broker: 'alpaca',
    mode,
    tradingAccountId,
    activityType,
    after: after.toISOString(),
    seen,
    created,
    updated,
  };
}

export async function getRecentBrokerActivities(args: {
  limit?: number;
  symbol?: string;
  activityType?: string;
}) {
  const where: Prisma.BrokerActivityWhereInput = {};

  if (args.symbol) {
    where.symbol = args.symbol;
  }

  if (args.activityType) {
    where.activityType = args.activityType;
  }

  return prisma.brokerActivity.findMany({
    where,
    orderBy: {
      transactionTime: 'desc',
    },
    take: args.limit ?? 50,
    include: {
      orderIntent: true,
      brokerOrderRecord: true,
    },
  });
}

export async function getLatestBrokerActivity() {
  return prisma.brokerActivity.findFirst({
    orderBy: {
      transactionTime: 'desc',
    },
    include: {
      orderIntent: true,
      brokerOrderRecord: true,
    },
  });
}

export async function getLatestBrokerFillForSymbol(args: {
  symbol: string;
  side?: 'buy' | 'sell';
  after?: Date;
}) {
  const where: Prisma.BrokerActivityWhereInput = {
    broker: 'alpaca',
    activityType: 'FILL',
    symbol: args.symbol,
  };

  if (args.side) {
    where.side = args.side;
  }

  if (args.after) {
    where.transactionTime = {
      gte: args.after,
    };
  }

  return prisma.brokerActivity.findFirst({
    where,
    orderBy: {
      transactionTime: 'desc',
    },
  });
}

export type CloseFillAttributionResult = {
  status: 'linked' | 'ambiguous' | 'none';
  source: BrokerActivityTrackedPositionLinkSource | null;
  activities: Awaited<ReturnType<typeof getCloseFillsForTrackedPosition>>;
  reason?: string;
};

const ACTIVE_TRACKED_POSITION_STATUSES = ['open', 'closing'] as const;

function hasPositiveCloseQtySum(args: {
  activities: Array<{ qty: number | null }>;
  targetQty: number;
}) {
  const totalQty = args.activities.reduce(
    (total, activity) => total + Math.abs(activity.qty ?? 0),
    0
  );

  return totalQty > 0 && totalQty <= Math.abs(args.targetQty) + 0.000001;
}

export async function getCloseFillsForTrackedPosition(args: {
  trackedPositionId: number;
  broker: string;
  symbol: string;
  closeSide: 'buy' | 'sell';
  openedAt: Date;
}) {
  return prisma.brokerActivity.findMany({
    where: {
      trackedPositionId: args.trackedPositionId,
      broker: args.broker,
      activityType: 'FILL',
      symbol: args.symbol,
      side: args.closeSide,
      transactionTime: {
        gte: args.openedAt,
      },
    },
    orderBy: {
      transactionTime: 'asc',
    },
  });
}

export async function attributeCloseFillsForTrackedPosition(args: {
  trackedPositionId: number;
  broker: string;
  symbol: string;
  closeSide: 'buy' | 'sell';
  openedAt: Date;
  qty: number;
}): Promise<CloseFillAttributionResult> {
  const existingLinked = await getCloseFillsForTrackedPosition(args);

  if (existingLinked.length > 0) {
    return {
      status: 'linked',
      source:
        (existingLinked[0]?.trackedPositionLinkSource as
          | BrokerActivityTrackedPositionLinkSource
          | null) ?? 'broker_order',
      activities: existingLinked,
    };
  }

  const activeSameSymbolCycle = await prisma.trackedPosition.findFirst({
    where: {
      id: {
        not: args.trackedPositionId,
      },
      broker: args.broker,
      symbol: args.symbol,
      status: {
        in: [...ACTIVE_TRACKED_POSITION_STATUSES],
      },
    },
    orderBy: {
      openedAt: 'desc',
    },
  });

  if (activeSameSymbolCycle) {
    return {
      status: 'ambiguous',
      source: null,
      activities: [],
      reason: 'active_same_symbol_cycle_exists',
    };
  }

  const candidates = await prisma.brokerActivity.findMany({
    where: {
      broker: args.broker,
      activityType: 'FILL',
      symbol: args.symbol,
      side: args.closeSide,
      trackedPositionId: null,
      transactionTime: {
        gte: args.openedAt,
      },
    },
    orderBy: {
      transactionTime: 'asc',
    },
  });

  if (candidates.length === 0) {
    return {
      status: 'none',
      source: null,
      activities: [],
      reason: 'no_unlinked_candidate_close_fills',
    };
  }

  if (!hasPositiveCloseQtySum({ activities: candidates, targetQty: args.qty })) {
    return {
      status: 'ambiguous',
      source: null,
      activities: candidates,
      reason: 'candidate_fill_quantity_inconsistent',
    };
  }

  await prisma.brokerActivity.updateMany({
    where: {
      id: {
        in: candidates.map((activity) => activity.id),
      },
      trackedPositionId: null,
    },
    data: {
      trackedPositionId: args.trackedPositionId,
      trackedPositionLinkSource: 'reconciliation_discovered_close',
      trackedPositionLinkedAt: new Date(),
    },
  });

  const linked = await getCloseFillsForTrackedPosition(args);

  return {
    status: 'linked',
    source: 'reconciliation_discovered_close',
    activities: linked,
  };
}
