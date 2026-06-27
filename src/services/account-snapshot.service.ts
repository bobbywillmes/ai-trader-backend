import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getNormalizedAccount } from './account.service.js';
import { resolveDefaultTradingAccountId } from './trading-account.service.js';
import type { BrokerMode } from '../types/broker.js';

export type AccountSnapshotReason =
  | 'manual'
  | 'scheduled_morning'
  | 'scheduled_midday'
  | 'scheduled_after_close'
  | 'position_opened'
  | 'position_closed';

type RecordAccountSnapshotInput = {
  reason: AccountSnapshotReason;
  force?: boolean;
  runKey?: string;
  sourceEntityType?: string;
  sourceEntityId?: string | number;
  tradingAccountId?: number | null;
};

export type AccountSnapshotQuery = {
  dateFrom?: Date;
  dateTo?: Date;
  mode?: BrokerMode;
  limit?: number;
};

export type AccountSnapshotExposureMetrics = {
  longExposure: number | null;
  shortExposure: number | null;
  grossExposure: number | null;
  netExposure: number | null;
  grossExposurePct: number | null;
};

type AccountSnapshotRecord = {
  id: number;
  broker: string;
  mode: string;
  accountStatus: string | null;
  currency: string | null;
  accountNumber: string | null;
  reason: string;
  runKey: string | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  tradingAccountId: number | null;
  cash: number;
  buyingPower: number;
  equity: number;
  portfolioValue: number;
  lastEquity: number | null;
  longMarketValue: number | null;
  shortMarketValue: number | null;
  dayPnL: number | null;
  dayPnLPct: number | null;
  tradingBlocked: boolean;
  snapshotHash: string;
  changed: boolean;
  rawJson: Prisma.JsonValue;
  createdAt: Date;
};

const DEFAULT_RECENT_SNAPSHOT_LIMIT = 50;
const MAX_RECENT_SNAPSHOT_LIMIT = 200;
const DEFAULT_TREND_SNAPSHOT_LIMIT = 500;
const MAX_TREND_SNAPSHOT_LIMIT = 2000;

function clampLimit(limit: number | undefined, fallback: number, max: number) {
  if (limit === undefined) return fallback;
  return Math.min(Math.max(limit, 1), max);
}

function buildSnapshotWhere(query: AccountSnapshotQuery) {
  const where: {
    createdAt?: { gte?: Date; lte?: Date };
    mode?: BrokerMode;
  } = {};

  if (query.dateFrom !== undefined || query.dateTo !== undefined) {
    where.createdAt = {};

    if (query.dateFrom !== undefined) {
      where.createdAt.gte = query.dateFrom;
    }

    if (query.dateTo !== undefined) {
      where.createdAt.lte = query.dateTo;
    }
  }

  if (query.mode !== undefined) {
    where.mode = query.mode;
  }

  return where;
}

function toFiniteNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined) return null;

  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

export function calculateAccountSnapshotExposureMetrics(input: {
  equity: number | string | null | undefined;
  longMarketValue: number | string | null | undefined;
  shortMarketValue: number | string | null | undefined;
}): AccountSnapshotExposureMetrics {
  const equity = toFiniteNumber(input.equity);
  const longMarketValue = toFiniteNumber(input.longMarketValue);
  const shortMarketValue = toFiniteNumber(input.shortMarketValue);

  if (longMarketValue === null || shortMarketValue === null) {
    return {
      longExposure: longMarketValue,
      shortExposure:
        shortMarketValue === null ? null : Math.abs(shortMarketValue),
      grossExposure: null,
      netExposure: null,
      grossExposurePct: null,
    };
  }

  const shortExposure = Math.abs(shortMarketValue);
  const grossExposure = longMarketValue + shortExposure;
  const netExposure = longMarketValue + shortMarketValue;

  return {
    longExposure: longMarketValue,
    shortExposure,
    grossExposure,
    netExposure,
    grossExposurePct:
      equity !== null && equity !== 0 ? (grossExposure / equity) * 100 : null,
  };
}

export function mapAccountSnapshot(snapshot: AccountSnapshotRecord) {
  return {
    ...snapshot,
    exposure: calculateAccountSnapshotExposureMetrics(snapshot),
  };
}

function buildSnapshotHash(account: Awaited<ReturnType<typeof getNormalizedAccount>>) {
  const stableAccountState = {
    broker: account.broker,
    mode: account.mode,
    status: account.status,
    currency: account.currency,
    accountNumber: account.accountNumber,
    cash: account.cash,
    buyingPower: account.buyingPower,
    equity: account.equity,
    portfolioValue: account.portfolioValue,
    lastEquity: account.lastEquity,
    longMarketValue: account.longMarketValue,
    shortMarketValue: account.shortMarketValue,
    dayPnL: account.dayPnL,
    dayPnLPct: account.dayPnLPct,
    tradingBlocked: account.tradingBlocked,
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableAccountState))
    .digest('hex');
}

export async function recordAccountSnapshot(input: RecordAccountSnapshotInput) {
  const tradingAccountId =
    input.tradingAccountId ?? (await resolveDefaultTradingAccountId());

  if (input.runKey) {
    const existingRun = await prisma.accountSnapshot.findUnique({
      where: { runKey: input.runKey },
    });

    if (existingRun) {
      return {
        created: false,
        skipped: true,
        reason: 'run_already_recorded',
        snapshot: mapAccountSnapshot(existingRun),
      };
    }
  }

  const account = await getNormalizedAccount('account_snapshot');
  const snapshotHash = buildSnapshotHash(account);

  const latestSnapshot = await prisma.accountSnapshot.findFirst({
    where: {
      tradingAccountId,
    },
    orderBy: { createdAt: 'desc' },
  });

  const changed = latestSnapshot?.snapshotHash !== snapshotHash;

  if (!input.force && latestSnapshot && !changed) {
    return {
      created: false,
      skipped: true,
      reason: 'unchanged',
      snapshot: mapAccountSnapshot(latestSnapshot),
    };
  }

  const snapshot = await prisma.accountSnapshot.create({
    data: {
      broker: account.broker,
      mode: account.mode,
      tradingAccountId,
      accountStatus: account.status,
      currency: account.currency,
      accountNumber: account.accountNumber,

      reason: input.reason,
      runKey: input.runKey ?? null,
      sourceEntityType: input.sourceEntityType ?? null,
      sourceEntityId:
        input.sourceEntityId === undefined ? null : String(input.sourceEntityId),

      cash: account.cash,
      buyingPower: account.buyingPower,
      equity: account.equity,
      portfolioValue: account.portfolioValue,
      lastEquity: account.lastEquity,
      longMarketValue: account.longMarketValue,
      shortMarketValue: account.shortMarketValue,
      dayPnL: account.dayPnL,
      dayPnLPct: account.dayPnLPct,
      tradingBlocked: account.tradingBlocked,

      snapshotHash,
      changed,

      // For this first pass, store the normalized broker account object.
      // If we later want raw Alpaca JSON, we can add a raw account service.
      rawJson: account as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    created: true,
    skipped: false,
    reason: changed ? 'changed' : 'forced',
    snapshot: mapAccountSnapshot(snapshot),
  };
}

export async function getRecentAccountSnapshots(
  limit = DEFAULT_RECENT_SNAPSHOT_LIMIT,
  query: AccountSnapshotQuery = {}
) {
  const snapshots = await prisma.accountSnapshot.findMany({
    where: buildSnapshotWhere(query),
    orderBy: { createdAt: 'desc' },
    take: clampLimit(limit, DEFAULT_RECENT_SNAPSHOT_LIMIT, MAX_RECENT_SNAPSHOT_LIMIT),
  });

  return snapshots.map(mapAccountSnapshot);
}

export async function getLatestAccountSnapshot() {
  const snapshot = await prisma.accountSnapshot.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  return snapshot === null ? null : mapAccountSnapshot(snapshot);
}

export async function getAccountSnapshotTrends(
  query: AccountSnapshotQuery = {}
) {
  const limit = clampLimit(
    query.limit,
    DEFAULT_TREND_SNAPSHOT_LIMIT,
    MAX_TREND_SNAPSHOT_LIMIT
  );
  const newestSnapshots = await prisma.accountSnapshot.findMany({
    where: buildSnapshotWhere(query),
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const snapshots = newestSnapshots.reverse().map(mapAccountSnapshot);

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      dateFrom: query.dateFrom?.toISOString() ?? null,
      dateTo: query.dateTo?.toISOString() ?? null,
      mode: query.mode ?? null,
      limit,
    },
    snapshots,
  };
}
