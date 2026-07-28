import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  getAlpacaAccountActivities,
  type AlpacaAccountActivity,
} from '../integrations/alpaca/activities.adapter.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';
import { createSystemEvent } from './system-event.service.js';
import {
  resolveDefaultTradingAccountId,
  TRADING_ACCOUNT_SUMMARY_SELECT,
} from './trading-account.service.js';

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

const FULL_FILL_TOLERANCE = 0.000001;

export function isAuthoritativeFullFill(args: {
  activityType: string | undefined;
  cumulativeQty: string | number | undefined;
  leavesQty: string | number | undefined;
  orderQty: number | null | undefined;
}) {
  const cumulativeQty = Number(args.cumulativeQty);
  const leavesQty = Number(args.leavesQty);
  return (
    args.activityType?.toUpperCase() === 'FILL' &&
    args.orderQty !== null &&
    args.orderQty !== undefined &&
    Number.isFinite(cumulativeQty) &&
    Number.isFinite(leavesQty) &&
    Math.abs(Math.abs(cumulativeQty) - Math.abs(args.orderQty)) <=
      FULL_FILL_TOLERANCE &&
    Math.abs(leavesQty) <= FULL_FILL_TOLERANCE
  );
}

async function terminalizeImportedFullFill(args: {
  activity: AlpacaAccountActivity;
  tradingAccountId: number;
  linkedBrokerOrder: Awaited<ReturnType<typeof findLinkedBrokerOrder>>;
  trackedPositionId: number | null;
}) {
  if (
    !args.linkedBrokerOrder ||
    !isAuthoritativeFullFill({
      activityType:
        args.activity.activity_type ?? args.activity.type,
      cumulativeQty: args.activity.cum_qty,
      leavesQty: args.activity.leaves_qty,
      orderQty: args.linkedBrokerOrder.orderIntent.qty,
    })
  ) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.brokerOrder.updateMany({
      where: {
        id: args.linkedBrokerOrder!.id,
        tradingAccountId: args.tradingAccountId,
        status: {
          notIn: ['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'replaced'],
        },
      },
      data: {
        status: 'filled',
        ...(args.trackedPositionId !== null && {
          trackedPositionId: args.trackedPositionId,
        }),
      },
    });
    await tx.orderIntent.updateMany({
      where: {
        id: args.linkedBrokerOrder!.orderIntentId,
        tradingAccountId: args.tradingAccountId,
        status: {
          notIn: ['filled', 'canceled', 'cancelled', 'expired', 'rejected'],
        },
      },
      data: {
        status: 'filled',
        ...(args.trackedPositionId !== null && {
          trackedPositionId: args.trackedPositionId,
        }),
      },
    });
    if (args.trackedPositionId !== null) {
      await tx.brokerActivity.updateMany({
        where: {
          tradingAccountId: args.tradingAccountId,
          brokerOrderRecordId: args.linkedBrokerOrder!.id,
          activityType: 'FILL',
        },
        data: {
          trackedPositionId: args.trackedPositionId,
          trackedPositionLinkSource: 'broker_order',
          trackedPositionLinkedAt: new Date(),
        },
      });
    }
  });
}

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
  tradingAccountId: number;
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
      trackedPosition: {
        tradingAccountId: args.tradingAccountId,
      },
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

  const existing = await prisma.brokerActivity.findFirst({
    where: {
      tradingAccountId,
      broker: 'alpaca',
      mode,
      activityId: activity.id,
    },
  });

  const linkedBrokerOrder = await findLinkedBrokerOrder({
    activity,
    tradingAccountId,
  });
  const trackedPositionLink = await findTrackedPositionLink({
    activity,
    tradingAccountId,
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
        id: existing.id,
      },
      data,
    });

    await terminalizeImportedFullFill({
      activity,
      tradingAccountId,
      linkedBrokerOrder,
      trackedPositionId:
        trackedPositionLink.trackedPositionId ?? existing.trackedPositionId ?? null,
    });
    return 'updated' as const;
  }

  await prisma.brokerActivity.create({
    data,
  });
  await terminalizeImportedFullFill({
    activity,
    tradingAccountId,
    linkedBrokerOrder,
    trackedPositionId: trackedPositionLink.trackedPositionId,
  });

  return 'created' as const;
}

export async function syncBrokerActivitiesForAccount(
  tradingAccountId: number,
  input: SyncBrokerActivitiesInput = {}
) {
  const activityType = input.activityType ?? 'FILL';
  const pageSize = input.pageSize ?? 100;
  const maxPages = input.maxPages ?? 5;
  const after =
    input.after ??
    (await getDefaultAfterDate({
      activityType,
      tradingAccountId,
    }));

  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: tradingAccountId },
    select: { environment: true },
  });
  const mode = account.environment.toLowerCase();

  let pageToken: string | undefined;
  let page = 0;

  let created = 0;
  let updated = 0;
  let seen = 0;
  let pagesProcessed = 0;
  let cursorEnd: string | null = null;

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
      tradingAccountId: number;
    } = {
      activityType,
      after,
      direction: 'asc',
      pageSize,
      operation: input.operation ?? 'broker_activity_sync',
      tradingAccountId,
    };

    if (pageToken) {
      activityRequest.pageToken = pageToken;
    }

    const activities = await getAlpacaAccountActivities(activityRequest);
    pagesProcessed += 1;

    if (activities.length === 0) {
      break;
    }

    for (const activity of activities) {
      seen += 1;
      cursorEnd = activity.id;

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
    cursorStart: after.toISOString(),
    cursorEnd,
    pagesProcessed,
    seen,
    created,
    updated,
  };
}

export async function syncBrokerActivities(input: SyncBrokerActivitiesInput = {}) {
  const tradingAccountId = await resolveDefaultTradingAccountId();
  return syncBrokerActivitiesForAccount(tradingAccountId, input);
}

export async function getRecentBrokerActivities(args: {
  limit?: number;
  symbol?: string;
  activityType?: string;
}) {
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const where: Prisma.BrokerActivityWhereInput = { tradingAccountId };

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
      tradingAccount: {
        select: TRADING_ACCOUNT_SUMMARY_SELECT,
      },
      orderIntent: true,
      brokerOrderRecord: true,
    },
  });
}

export async function getLatestBrokerActivity() {
  const tradingAccountId = await resolveDefaultTradingAccountId();

  return prisma.brokerActivity.findFirst({
    where: {
      tradingAccountId,
    },
    orderBy: {
      transactionTime: 'desc',
    },
    include: {
      tradingAccount: {
        select: TRADING_ACCOUNT_SUMMARY_SELECT,
      },
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
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const where: Prisma.BrokerActivityWhereInput = {
    broker: 'alpaca',
    tradingAccountId,
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
  tradingAccountId: number;
  broker: string;
  symbol: string;
  closeSide: 'buy' | 'sell';
  openedAt: Date;
}) {
  return prisma.brokerActivity.findMany({
    where: {
      trackedPositionId: args.trackedPositionId,
      tradingAccountId: args.tradingAccountId,
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
  tradingAccountId: number;
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
      tradingAccountId: args.tradingAccountId,
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
      tradingAccountId: args.tradingAccountId,
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
      tradingAccountId: args.tradingAccountId,
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
