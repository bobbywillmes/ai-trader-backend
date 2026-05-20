import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import {
  getAlpacaAccountActivities,
  type AlpacaAccountActivity,
} from '../integrations/alpaca/activities.adapter.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { createSystemEvent } from './system-event.service.js';

type SyncBrokerActivitiesInput = {
  activityType?: string;
  after?: Date;
  pageSize?: number;
  maxPages?: number;
};

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

async function getDefaultAfterDate(activityType: string) {
  const latest = await prisma.brokerActivity.findFirst({
    where: {
      activityType,
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

async function findLinkedBrokerOrder(activity: AlpacaAccountActivity) {
  if (!activity.order_id) {
    return null;
  }

  return prisma.brokerOrder.findFirst({
    where: {
      broker: 'alpaca',
      brokerOrderId: activity.order_id,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

async function upsertBrokerActivity(args: {
  activity: AlpacaAccountActivity;
  mode: string;
}) {
  const { activity, mode } = args;

  const existing = await prisma.brokerActivity.findUnique({
    where: {
      activityId: activity.id,
    },
  });

  const linkedBrokerOrder = await findLinkedBrokerOrder(activity);

  const data = {
    broker: 'alpaca',
    mode,

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
  const after = input.after ?? (await getDefaultAfterDate(activityType));

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
    } = {
      activityType,
      after,
      direction: 'asc',
      pageSize,
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