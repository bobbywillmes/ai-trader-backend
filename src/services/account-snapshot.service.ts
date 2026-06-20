import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { getNormalizedAccount } from './account.service.js';

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
};

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
  if (input.runKey) {
    const existingRun = await prisma.accountSnapshot.findUnique({
      where: { runKey: input.runKey },
    });

    if (existingRun) {
      return {
        created: false,
        skipped: true,
        reason: 'run_already_recorded',
        snapshot: existingRun,
      };
    }
  }

  const account = await getNormalizedAccount('account_snapshot');
  const snapshotHash = buildSnapshotHash(account);

  const latestSnapshot = await prisma.accountSnapshot.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  const changed = latestSnapshot?.snapshotHash !== snapshotHash;

  if (!input.force && latestSnapshot && !changed) {
    return {
      created: false,
      skipped: true,
      reason: 'unchanged',
      snapshot: latestSnapshot,
    };
  }

  const snapshot = await prisma.accountSnapshot.create({
    data: {
      broker: account.broker,
      mode: account.mode,
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
    snapshot,
  };
}

export async function getRecentAccountSnapshots(limit = 50) {
  return prisma.accountSnapshot.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function getLatestAccountSnapshot() {
  return prisma.accountSnapshot.findFirst({
    orderBy: { createdAt: 'desc' },
  });
}
