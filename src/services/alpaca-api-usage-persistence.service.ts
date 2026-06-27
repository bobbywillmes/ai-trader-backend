import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import {
  alpacaApiUsageRegistry,
  type AlpacaApiUsageAggregateDelta,
} from './alpaca-api-usage.service.js';
import { resolveDefaultTradingAccountId } from './trading-account.service.js';

export type AlpacaApiUsagePersistenceSnapshot = {
  lastFlushAttemptAt: string | null;
  lastFlushSucceededAt: string | null;
  lastFlushFailedAt: string | null;
  pendingAggregateCount: number;
  retentionDays: number;
  lastRetentionRunAt: string | null;
};

type PersistenceRuntimeState = {
  lastFlushAttemptAt: Date | null;
  lastFlushSucceededAt: Date | null;
  lastFlushFailedAt: Date | null;
  lastRetentionRunAt: Date | null;
};

const RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const PERSISTENCE_FAILURE_LOG_INTERVAL_MS = 5 * 60_000;

let lastPersistenceFailureLoggedAt = 0;

const state: PersistenceRuntimeState = {
  lastFlushAttemptAt: null,
  lastFlushSucceededAt: null,
  lastFlushFailedAt: null,
  lastRetentionRunAt: null,
};

function toIso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function toDbTimestamp(value: Date | null) {
  return value;
}

async function persistDelta(
  delta: AlpacaApiUsageAggregateDelta,
  tradingAccountId: number
) {
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO "AlpacaApiUsageBucket" (
        "bucketStart",
        "bucketSizeMinutes",
        "operation",
        "endpoint",
        "method",
        "requestClass",
        "requestCount",
        "successCount",
        "failureCount",
        "rateLimitCount",
        "networkErrorCount",
        "totalDurationMs",
        "maxDurationMs",
        "lastStatusCode",
        "lastRequestAt",
        "lastFailureAt",
        "lastRateLimitedAt",
        "tradingAccountId",
        "createdAt",
        "updatedAt"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now(), now())
      ON CONFLICT ("bucketStart", "operation", "endpoint", "method", "requestClass")
      DO UPDATE SET
        "tradingAccountId" = COALESCE("AlpacaApiUsageBucket"."tradingAccountId", EXCLUDED."tradingAccountId"),
        "requestCount" = "AlpacaApiUsageBucket"."requestCount" + EXCLUDED."requestCount",
        "successCount" = "AlpacaApiUsageBucket"."successCount" + EXCLUDED."successCount",
        "failureCount" = "AlpacaApiUsageBucket"."failureCount" + EXCLUDED."failureCount",
        "rateLimitCount" = "AlpacaApiUsageBucket"."rateLimitCount" + EXCLUDED."rateLimitCount",
        "networkErrorCount" = "AlpacaApiUsageBucket"."networkErrorCount" + EXCLUDED."networkErrorCount",
        "totalDurationMs" = "AlpacaApiUsageBucket"."totalDurationMs" + EXCLUDED."totalDurationMs",
        "maxDurationMs" = GREATEST("AlpacaApiUsageBucket"."maxDurationMs", EXCLUDED."maxDurationMs"),
        "lastStatusCode" = EXCLUDED."lastStatusCode",
        "lastRequestAt" = GREATEST(
          COALESCE("AlpacaApiUsageBucket"."lastRequestAt", EXCLUDED."lastRequestAt"),
          COALESCE(EXCLUDED."lastRequestAt", "AlpacaApiUsageBucket"."lastRequestAt")
        ),
        "lastFailureAt" = GREATEST(
          COALESCE("AlpacaApiUsageBucket"."lastFailureAt", EXCLUDED."lastFailureAt"),
          COALESCE(EXCLUDED."lastFailureAt", "AlpacaApiUsageBucket"."lastFailureAt")
        ),
        "lastRateLimitedAt" = GREATEST(
          COALESCE("AlpacaApiUsageBucket"."lastRateLimitedAt", EXCLUDED."lastRateLimitedAt"),
          COALESCE(EXCLUDED."lastRateLimitedAt", "AlpacaApiUsageBucket"."lastRateLimitedAt")
        ),
        "updatedAt" = now()
    `,
    delta.bucketStart,
    delta.bucketSizeMinutes,
    delta.operation,
    delta.endpoint,
    delta.method,
    delta.requestClass,
    delta.requestCount,
    delta.successCount,
    delta.failureCount,
    delta.rateLimitCount,
    delta.networkErrorCount,
    delta.totalDurationMs,
    delta.maxDurationMs,
    delta.lastStatusCode,
    toDbTimestamp(delta.lastRequestAt),
    toDbTimestamp(delta.lastFailureAt),
    toDbTimestamp(delta.lastRateLimitedAt),
    tradingAccountId
  );
}

function shouldRunRetention(now: Date) {
  return (
    !state.lastRetentionRunAt ||
    now.getTime() - state.lastRetentionRunAt.getTime() >=
      RETENTION_CHECK_INTERVAL_MS
  );
}

async function runRetention(now: Date) {
  const cutoff = new Date(
    now.getTime() - env.ALPACA_API_USAGE_RETENTION_DAYS * 24 * 60 * 60_000
  );

  const deletedCount = await prisma.$executeRawUnsafe(
    'DELETE FROM "AlpacaApiUsageBucket" WHERE "bucketStart" < $1',
    cutoff
  );

  state.lastRetentionRunAt = now;
  return deletedCount;
}

function logPersistenceFailure(error: unknown, now: Date) {
  if (
    now.getTime() - lastPersistenceFailureLoggedAt <
    PERSISTENCE_FAILURE_LOG_INTERVAL_MS
  ) {
    return;
  }

  lastPersistenceFailureLoggedAt = now.getTime();
  logger.warn({ error }, 'Alpaca API usage persistence failed.');
}

export async function runAlpacaApiUsagePersistence(now = new Date()) {
  state.lastFlushAttemptAt = now;
  const deltas = alpacaApiUsageRegistry.drainPendingAggregateDeltas();
  let retentionDeletedCount = 0;
  const retentionDue = shouldRunRetention(now);
  const tradingAccountId = await resolveDefaultTradingAccountId();

  try {
    for (const delta of deltas) {
      await persistDelta(delta, tradingAccountId);
    }

    if (retentionDue) {
      retentionDeletedCount = await runRetention(now);
    }

    state.lastFlushSucceededAt = now;

    return {
      flushedAggregateCount: deltas.length,
      retentionDue,
      retentionDeletedCount,
    };
  } catch (error) {
    state.lastFlushFailedAt = now;
    alpacaApiUsageRegistry.restorePendingAggregateDeltas(deltas);
    logPersistenceFailure(error, now);
    throw error;
  }
}

export function getAlpacaApiUsagePersistenceSnapshot(): AlpacaApiUsagePersistenceSnapshot {
  return {
    lastFlushAttemptAt: toIso(state.lastFlushAttemptAt),
    lastFlushSucceededAt: toIso(state.lastFlushSucceededAt),
    lastFlushFailedAt: toIso(state.lastFlushFailedAt),
    pendingAggregateCount: alpacaApiUsageRegistry.getPendingAggregateCount(),
    retentionDays: env.ALPACA_API_USAGE_RETENTION_DAYS,
    lastRetentionRunAt: toIso(state.lastRetentionRunAt),
  };
}

export function resetAlpacaApiUsagePersistenceStateForTest() {
  state.lastFlushAttemptAt = null;
  state.lastFlushSucceededAt = null;
  state.lastFlushFailedAt = null;
  state.lastRetentionRunAt = null;
  lastPersistenceFailureLoggedAt = 0;
}
