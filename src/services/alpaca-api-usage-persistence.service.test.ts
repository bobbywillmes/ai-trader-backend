import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeRawUnsafe: vi.fn(),
  drainPendingAggregateDeltas: vi.fn(),
  restorePendingAggregateDeltas: vi.fn(),
  getPendingAggregateCount: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: {
    ALPACA_API_USAGE_RETENTION_DAYS: 30,
  },
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    $executeRawUnsafe: mocks.executeRawUnsafe,
  },
}));

vi.mock('./alpaca-api-usage.service.js', () => ({
  alpacaApiUsageRegistry: {
    drainPendingAggregateDeltas: mocks.drainPendingAggregateDeltas,
    restorePendingAggregateDeltas: mocks.restorePendingAggregateDeltas,
    getPendingAggregateCount: mocks.getPendingAggregateCount,
  },
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
}));

import {
  getAlpacaApiUsagePersistenceSnapshot,
  resetAlpacaApiUsagePersistenceStateForTest,
  runAlpacaApiUsagePersistence,
} from './alpaca-api-usage-persistence.service.js';
import type { AlpacaApiUsageAggregateDelta } from './alpaca-api-usage.service.js';

const delta: AlpacaApiUsageAggregateDelta = {
  bucketStart: new Date('2026-06-20T12:00:00.000Z'),
  bucketSizeMinutes: 5,
  operation: 'submitted_order_sync',
  endpoint: 'GET /v2/orders',
  method: 'GET',
  requestClass: 'synchronization_read',
  requestCount: 3,
  successCount: 2,
  failureCount: 1,
  rateLimitCount: 1,
  networkErrorCount: 0,
  totalDurationMs: 150,
  maxDurationMs: 75,
  lastStatusCode: 429,
  lastRequestAt: new Date('2026-06-20T12:01:00.000Z'),
  lastFailureAt: new Date('2026-06-20T12:01:00.000Z'),
  lastRateLimitedAt: new Date('2026-06-20T12:01:00.000Z'),
};

describe('Alpaca API usage persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAlpacaApiUsagePersistenceStateForTest();
    mocks.executeRawUnsafe.mockResolvedValue(1);
    mocks.drainPendingAggregateDeltas.mockReturnValue([]);
    mocks.getPendingAggregateCount.mockReturnValue(0);
  });

  it('flushes aggregate deltas with one upsert per aggregate key', async () => {
    mocks.drainPendingAggregateDeltas.mockReturnValue([delta]);

    const result = await runAlpacaApiUsagePersistence(
      new Date('2026-06-20T12:02:00.000Z')
    );

    expect(result).toMatchObject({
      flushedAggregateCount: 1,
      retentionDue: true,
      retentionDeletedCount: 1,
    });
    expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(mocks.executeRawUnsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('ON CONFLICT'),
      delta.bucketStart,
      5,
      'submitted_order_sync',
      'GET /v2/orders',
      'GET',
      'synchronization_read',
      3,
      2,
      1,
      1,
      0,
      150,
      75,
      429,
      delta.lastRequestAt,
      delta.lastFailureAt,
      delta.lastRateLimitedAt
    );
    expect(mocks.executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      'DELETE FROM "AlpacaApiUsageBucket" WHERE "bucketStart" < $1',
      new Date('2026-05-21T12:02:00.000Z')
    );
    expect(mocks.restorePendingAggregateDeltas).not.toHaveBeenCalled();
    expect(getAlpacaApiUsagePersistenceSnapshot()).toMatchObject({
      lastFlushSucceededAt: '2026-06-20T12:02:00.000Z',
      retentionDays: 30,
    });
  });

  it('restores drained deltas and throttles logs when persistence fails', async () => {
    mocks.drainPendingAggregateDeltas.mockReturnValue([delta]);
    mocks.executeRawUnsafe.mockRejectedValue(new Error('database unavailable'));

    await expect(
      runAlpacaApiUsagePersistence(new Date('2026-06-20T12:02:00.000Z'))
    ).rejects.toThrow('database unavailable');

    expect(mocks.restorePendingAggregateDeltas).toHaveBeenCalledWith([delta]);
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(getAlpacaApiUsagePersistenceSnapshot()).toMatchObject({
      lastFlushFailedAt: '2026-06-20T12:02:00.000Z',
    });

    await expect(
      runAlpacaApiUsagePersistence(new Date('2026-06-20T12:03:00.000Z'))
    ).rejects.toThrow('database unavailable');

    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
  });

  it('runs retention at most once per day', async () => {
    await runAlpacaApiUsagePersistence(new Date('2026-06-20T12:00:00.000Z'));
    await runAlpacaApiUsagePersistence(new Date('2026-06-20T12:01:00.000Z'));

    expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mocks.executeRawUnsafe).toHaveBeenCalledWith(
      'DELETE FROM "AlpacaApiUsageBucket" WHERE "bucketStart" < $1',
      new Date('2026-05-21T12:00:00.000Z')
    );

    await runAlpacaApiUsagePersistence(new Date('2026-06-21T12:00:01.000Z'));

    expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(2);
  });
});
