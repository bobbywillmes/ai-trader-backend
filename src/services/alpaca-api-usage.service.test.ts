import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSystemEvent: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: {
    ALPACA_API_USAGE_WARNING_REQUESTS_PER_MINUTE: 3,
  },
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
}));

import {
  AlpacaApiUsageRegistry,
  parseRetryAfter,
} from './alpaca-api-usage.service.js';
import type { AlpacaRequestMetadata } from '../integrations/alpaca/request-metadata.js';

const metadata: AlpacaRequestMetadata = {
  operation: 'submitted_order_sync',
  endpoint: 'GET /v2/orders',
  method: 'GET',
  requestClass: 'synchronization_read',
  deferDuringRateLimit: true,
};

function createRegistry(start = '2026-06-20T12:00:00.000Z') {
  let nowMs = new Date(start).getTime();
  const registry = new AlpacaApiUsageRegistry({
    processInstanceId: 'process-test',
    warningThresholdPerMinute: 3,
    now: () => new Date(nowMs),
  });

  return {
    registry,
    advance(ms: number) {
      nowMs += ms;
    },
    setNow(value: string) {
      nowMs = new Date(value).getTime();
    },
  };
}

function recordSuccess(registry: AlpacaApiUsageRegistry) {
  const request = registry.beginRequest(metadata);
  registry.completeRequest(request, {
    statusCode: 200,
    outcome: 'success',
    responseFailedBeforeHeaders: false,
    headers: new Headers(),
  });
}

describe('AlpacaApiUsageRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSystemEvent.mockResolvedValue({});
  });

  it('parses Retry-After seconds and HTTP dates safely', () => {
    const now = new Date('2026-06-20T12:00:00.000Z');

    expect(parseRetryAfter('30', now)).toEqual({
      retryAfterSeconds: 30,
      backoffUntil: new Date('2026-06-20T12:00:30.000Z'),
    });
    expect(parseRetryAfter('Sat, 20 Jun 2026 12:01:10 GMT', now)).toEqual({
      retryAfterSeconds: 70,
      backoffUntil: new Date('2026-06-20T12:01:10.000Z'),
    });
    expect(parseRetryAfter('not-a-date', now)).toEqual({
      retryAfterSeconds: null,
      backoffUntil: null,
    });
  });

  it('tracks active requests, peak concurrency, outcomes, and rolling windows', () => {
    const { registry, advance } = createRegistry();
    const first = registry.beginRequest(metadata);
    const second = registry.beginRequest({
      ...metadata,
      operation: 'tracked_position_sync',
      endpoint: 'GET /v2/positions',
    });

    expect(registry.getSnapshot().activeRequestCount).toBe(2);
    expect(registry.getSnapshot().peakConcurrentRequests).toBe(2);

    advance(25);
    registry.completeRequest(first, {
      statusCode: 200,
      outcome: 'success',
      responseFailedBeforeHeaders: false,
      headers: new Headers(),
    });
    advance(10);
    registry.completeRequest(second, {
      statusCode: null,
      outcome: 'network_error',
      responseFailedBeforeHeaders: true,
    });

    const snapshot = registry.getSnapshot();

    expect(snapshot.activeRequestCount).toBe(0);
    expect(snapshot.rolling.oneMinute).toMatchObject({
      requestCount: 2,
      successCount: 1,
      failureCount: 1,
      networkErrorCount: 1,
      maxDurationMs: 35,
    });
    expect(snapshot.rolling.sinceStartup.requestCount).toBe(2);
    expect(snapshot.topOperations.map((group) => group.key)).toEqual([
      'submitted_order_sync',
      'tracked_position_sync',
    ]);
  });

  it('uses exact minute boundaries and expires old buckets from rolling windows', () => {
    const { registry, setNow } = createRegistry();

    recordSuccess(registry);
    setNow('2026-06-20T12:01:00.000Z');
    recordSuccess(registry);
    setNow('2026-06-20T12:05:00.000Z');
    recordSuccess(registry);

    expect(registry.getSnapshot().rolling.oneMinute.requestCount).toBe(1);
    expect(registry.getSnapshot().rolling.fiveMinutes.requestCount).toBe(2);
    expect(registry.getSnapshot().rolling.sixtyMinutes.requestCount).toBe(3);

    setNow('2026-06-20T13:06:00.000Z');
    expect(registry.getSnapshot().rolling.sixtyMinutes.requestCount).toBe(0);
    expect(registry.getSnapshot().rolling.sinceStartup.requestCount).toBe(3);
  });

  it('creates one warning transition and recovers with hysteresis', () => {
    const { registry, setNow } = createRegistry();

    recordSuccess(registry);
    recordSuccess(registry);
    recordSuccess(registry);
    recordSuccess(registry);

    expect(mocks.createSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'alpaca_api.volume_warning_started',
      })
    );
    expect(registry.getSnapshot().warning.active).toBe(true);

    setNow('2026-06-20T12:01:00.000Z');
    recordSuccess(registry);

    expect(mocks.createSystemEvent).toHaveBeenCalledTimes(2);
    expect(mocks.createSystemEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'alpaca_api.volume_warning_recovered',
      })
    );
    expect(registry.getSnapshot().warning.active).toBe(false);
  });

  it('tracks rate-limit incidents, defers safe reads, and requires later success for recovery', () => {
    const { registry, advance } = createRegistry();
    const request = registry.beginRequest(metadata);

    registry.completeRequest(request, {
      statusCode: 429,
      outcome: 'rate_limited',
      responseFailedBeforeHeaders: false,
      headers: new Headers({
        'retry-after': '30',
        'x-ratelimit-limit': '200',
        'x-ratelimit-remaining': '0',
      }),
    });

    expect(registry.getSnapshot().rateLimit).toMatchObject({
      active: true,
      incidentCount: 1,
      currentIncident429Count: 1,
      retryAfterSeconds: 30,
      latestKnownLimit: 200,
      latestKnownRemaining: 0,
      lastOperation: 'submitted_order_sync',
    });
    expect(registry.shouldDefer(metadata)).toBe(true);
    expect(
      registry.shouldDefer({
        ...metadata,
        requestClass: 'critical_write',
        deferDuringRateLimit: false,
      })
    ).toBe(false);

    advance(31_000);
    expect(registry.shouldDefer(metadata)).toBe(false);
    expect(registry.getSnapshot().rateLimit.active).toBe(true);

    recordSuccess(registry);

    expect(registry.getSnapshot().rateLimit.active).toBe(false);
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'alpaca_api.rate_limit_started',
      })
    );
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'alpaca_api.rate_limit_recovered',
      })
    );
  });

  it('drains and restores pending aggregate deltas without double counting', () => {
    const { registry } = createRegistry();

    recordSuccess(registry);
    recordSuccess(registry);

    expect(registry.getPendingAggregateCount()).toBe(1);

    const firstDrain = registry.drainPendingAggregateDeltas();

    expect(firstDrain).toHaveLength(1);
    expect(firstDrain[0]).toMatchObject({
      bucketSizeMinutes: 5,
      operation: 'submitted_order_sync',
      endpoint: 'GET /v2/orders',
      requestCount: 2,
      successCount: 2,
    });
    expect(registry.getPendingAggregateCount()).toBe(0);

    registry.restorePendingAggregateDeltas(firstDrain);

    expect(registry.getPendingAggregateCount()).toBe(1);
    expect(registry.drainPendingAggregateDeltas()[0]?.requestCount).toBe(2);
  });
});
