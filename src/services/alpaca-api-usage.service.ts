import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createSystemEvent } from './system-event.service.js';
import type {
  AlpacaApiEndpoint,
  AlpacaApiOperation,
  AlpacaRequestMetadata,
} from '../integrations/alpaca/request-metadata.js';

export type AlpacaApiOutcome =
  | 'client_error'
  | 'network_error'
  | 'rate_limited'
  | 'server_error'
  | 'success'
  | 'timeout';

export type AlpacaUsageSummary = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  networkErrorCount: number;
  totalDurationMs: number;
  averageDurationMs: number | null;
  maxDurationMs: number;
};

export type AlpacaUsageGroup = AlpacaUsageSummary & {
  key: string;
  latestRequestAt: string | null;
  latestFailureAt: string | null;
  latestRateLimitedAt: string | null;
};

export type AlpacaRateLimitSnapshot = {
  active: boolean;
  firstRateLimitedAt: string | null;
  lastRateLimitedAt: string | null;
  backoffUntil: string | null;
  retryAfterSeconds: number | null;
  incidentCount: number;
  currentIncident429Count: number;
  lastOperation: AlpacaApiOperation | null;
  lastEndpoint: AlpacaApiEndpoint | null;
  latestKnownLimit: number | null;
  latestKnownRemaining: number | null;
  latestKnownResetAt: string | null;
  recoveredAt: string | null;
};

export type AlpacaApiUsageSnapshot = {
  evaluatedAt: string;
  processInstanceId: string;
  processStartedAt: string;
  activeRequestCount: number;
  peakConcurrentRequests: number;
  totalRequestsSinceStartup: number;
  totalFailuresSinceStartup: number;
  totalRateLimitedSinceStartup: number;
  warning: {
    active: boolean;
    thresholdPerMinute: number;
    startedAt: string | null;
    recoveredAt: string | null;
  };
  rateLimit: AlpacaRateLimitSnapshot;
  rolling: {
    currentMinute: AlpacaUsageSummary;
    oneMinute: AlpacaUsageSummary;
    fiveMinutes: AlpacaUsageSummary;
    fifteenMinutes: AlpacaUsageSummary;
    sixtyMinutes: AlpacaUsageSummary;
    sinceStartup: AlpacaUsageSummary;
  };
  topOperations: AlpacaUsageGroup[];
  topEndpoints: AlpacaUsageGroup[];
};

type RequestStart = {
  metadata: AlpacaRequestMetadata;
  startedAt: Date;
};

type RequestCompletion = {
  statusCode: number | null;
  outcome: AlpacaApiOutcome;
  responseFailedBeforeHeaders: boolean;
  headers?: Headers | null;
};

export type AlpacaApiUsageAggregateDelta = {
  bucketStart: Date;
  bucketSizeMinutes: number;
  operation: AlpacaApiOperation;
  endpoint: AlpacaApiEndpoint;
  method: string;
  requestClass: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  networkErrorCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastStatusCode: number | null;
  lastRequestAt: Date | null;
  lastFailureAt: Date | null;
  lastRateLimitedAt: Date | null;
};

type CounterValues = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  networkErrorCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  latestRequestAt: Date | null;
  latestSuccessAt: Date | null;
  latestFailureAt: Date | null;
  latestRateLimitedAt: Date | null;
};

type MinuteBucket = CounterValues & {
  minuteStartMs: number;
  operations: Map<AlpacaApiOperation, CounterValues>;
  endpoints: Map<AlpacaApiEndpoint, CounterValues>;
};

type RateLimitState = {
  active: boolean;
  firstRateLimitedAt: Date | null;
  lastRateLimitedAt: Date | null;
  backoffUntil: Date | null;
  retryAfterSeconds: number | null;
  incidentCount: number;
  currentIncident429Count: number;
  lastOperation: AlpacaApiOperation | null;
  lastEndpoint: AlpacaApiEndpoint | null;
  latestKnownLimit: number | null;
  latestKnownRemaining: number | null;
  latestKnownResetAt: Date | null;
  recoveredAt: Date | null;
};

const BUCKET_COUNT = 60;
const MINUTE_MS = 60_000;
const PERSISTENCE_BUCKET_MINUTES = 5;
const PERSISTENCE_BUCKET_MS = PERSISTENCE_BUCKET_MINUTES * MINUTE_MS;
const WARNING_RECOVERY_RATIO = 0.7;

function createCounters(): CounterValues {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    rateLimitCount: 0,
    networkErrorCount: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    latestRequestAt: null,
    latestSuccessAt: null,
    latestFailureAt: null,
    latestRateLimitedAt: null,
  };
}

function toMinuteStartMs(date: Date) {
  return Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS;
}

function addCounters(target: CounterValues, source: CounterValues) {
  target.requestCount += source.requestCount;
  target.successCount += source.successCount;
  target.failureCount += source.failureCount;
  target.rateLimitCount += source.rateLimitCount;
  target.networkErrorCount += source.networkErrorCount;
  target.totalDurationMs += source.totalDurationMs;
  target.maxDurationMs = Math.max(target.maxDurationMs, source.maxDurationMs);
  target.latestRequestAt = latestDate(target.latestRequestAt, source.latestRequestAt);
  target.latestSuccessAt = latestDate(target.latestSuccessAt, source.latestSuccessAt);
  target.latestFailureAt = latestDate(target.latestFailureAt, source.latestFailureAt);
  target.latestRateLimitedAt = latestDate(
    target.latestRateLimitedAt,
    source.latestRateLimitedAt
  );
}

function latestDate(left: Date | null, right: Date | null) {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

function toSummary(counters: CounterValues): AlpacaUsageSummary {
  return {
    requestCount: counters.requestCount,
    successCount: counters.successCount,
    failureCount: counters.failureCount,
    rateLimitCount: counters.rateLimitCount,
    networkErrorCount: counters.networkErrorCount,
    totalDurationMs: counters.totalDurationMs,
    averageDurationMs:
      counters.requestCount > 0
        ? counters.totalDurationMs / counters.requestCount
        : null,
    maxDurationMs: counters.maxDurationMs,
  };
}

function toIso(date: Date | null) {
  return date?.toISOString() ?? null;
}

function parseHeaderNumber(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHeaderDateOrEpoch(value: string | null) {
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const ms = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseRetryAfter(value: string | null, now: Date) {
  if (!value) {
    return {
      retryAfterSeconds: null,
      backoffUntil: null,
    };
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return {
      retryAfterSeconds: seconds,
      backoffUntil: new Date(now.getTime() + seconds * 1_000),
    };
  }

  const retryDate = new Date(value);
  if (Number.isNaN(retryDate.getTime())) {
    return {
      retryAfterSeconds: null,
      backoffUntil: null,
    };
  }

  const retryAfterSeconds = Math.max(
    0,
    Math.ceil((retryDate.getTime() - now.getTime()) / 1_000)
  );

  return {
    retryAfterSeconds,
    backoffUntil: retryDate,
  };
}

export class AlpacaApiUsageRegistry {
  readonly processInstanceId: string;
  readonly processStartedAt: Date;

  private readonly buckets = new Array<MinuteBucket | null>(BUCKET_COUNT).fill(null);
  private readonly now: () => Date;
  private readonly warningThresholdPerMinute: number;
  private readonly sinceStartup = createCounters();
  private readonly pendingDeltas = new Map<string, AlpacaApiUsageAggregateDelta>();
  private activeRequestCount = 0;
  private peakConcurrentRequests = 0;
  private warningActive = false;
  private warningStartedAt: Date | null = null;
  private warningRecoveredAt: Date | null = null;
  private readonly rateLimit: RateLimitState = {
    active: false,
    firstRateLimitedAt: null,
    lastRateLimitedAt: null,
    backoffUntil: null,
    retryAfterSeconds: null,
    incidentCount: 0,
    currentIncident429Count: 0,
    lastOperation: null,
    lastEndpoint: null,
    latestKnownLimit: null,
    latestKnownRemaining: null,
    latestKnownResetAt: null,
    recoveredAt: null,
  };

  constructor(args: {
    now?: () => Date;
    processInstanceId?: string;
    warningThresholdPerMinute?: number;
  } = {}) {
    this.now = args.now ?? (() => new Date());
    this.processStartedAt = this.now();
    this.processInstanceId = args.processInstanceId ?? crypto.randomUUID();
    this.warningThresholdPerMinute =
      args.warningThresholdPerMinute ??
      env.ALPACA_API_USAGE_WARNING_REQUESTS_PER_MINUTE;
  }

  shouldDefer(metadata: AlpacaRequestMetadata) {
    const now = this.now();

    return Boolean(
      metadata.deferDuringRateLimit &&
        this.rateLimit.active &&
        this.rateLimit.backoffUntil &&
        now.getTime() < this.rateLimit.backoffUntil.getTime()
    );
  }

  getBackoffUntil() {
    return this.rateLimit.backoffUntil;
  }

  beginRequest(metadata: AlpacaRequestMetadata): RequestStart {
    this.activeRequestCount += 1;
    this.peakConcurrentRequests = Math.max(
      this.peakConcurrentRequests,
      this.activeRequestCount
    );

    return {
      metadata,
      startedAt: this.now(),
    };
  }

  completeRequest(start: RequestStart, completion: RequestCompletion) {
    const completedAt = this.now();
    const durationMs = Math.max(
      0,
      completedAt.getTime() - start.startedAt.getTime()
    );

    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    this.recordCounters({
      metadata: start.metadata,
      completedAt,
      durationMs,
      completion,
    });
    this.recordPersistenceDelta({
      metadata: start.metadata,
      completedAt,
      durationMs,
      completion,
    });

    if (completion.outcome === 'rate_limited') {
      this.recordRateLimit(start.metadata, completion.headers ?? null, completedAt);
    } else if (completion.outcome === 'success') {
      this.recordRateLimitRecovery(start.metadata, completedAt);
    }

    this.evaluateWarning(completedAt);
  }

  getSnapshot(now = this.now()): AlpacaApiUsageSnapshot {
    const oneMinute = this.aggregateWindow(1, now);
    const fiveMinutes = this.aggregateWindow(5, now);
    const fifteenMinutes = this.aggregateWindow(15, now);
    const sixtyMinutes = this.aggregateWindow(60, now);

    return {
      evaluatedAt: now.toISOString(),
      processInstanceId: this.processInstanceId,
      processStartedAt: this.processStartedAt.toISOString(),
      activeRequestCount: this.activeRequestCount,
      peakConcurrentRequests: this.peakConcurrentRequests,
      totalRequestsSinceStartup: this.sinceStartup.requestCount,
      totalFailuresSinceStartup: this.sinceStartup.failureCount,
      totalRateLimitedSinceStartup: this.sinceStartup.rateLimitCount,
      warning: {
        active: this.warningActive,
        thresholdPerMinute: this.warningThresholdPerMinute,
        startedAt: toIso(this.warningStartedAt),
        recoveredAt: toIso(this.warningRecoveredAt),
      },
      rateLimit: {
        active: this.rateLimit.active,
        firstRateLimitedAt: toIso(this.rateLimit.firstRateLimitedAt),
        lastRateLimitedAt: toIso(this.rateLimit.lastRateLimitedAt),
        backoffUntil: toIso(this.rateLimit.backoffUntil),
        retryAfterSeconds: this.rateLimit.retryAfterSeconds,
        incidentCount: this.rateLimit.incidentCount,
        currentIncident429Count: this.rateLimit.currentIncident429Count,
        lastOperation: this.rateLimit.lastOperation,
        lastEndpoint: this.rateLimit.lastEndpoint,
        latestKnownLimit: this.rateLimit.latestKnownLimit,
        latestKnownRemaining: this.rateLimit.latestKnownRemaining,
        latestKnownResetAt: toIso(this.rateLimit.latestKnownResetAt),
        recoveredAt: toIso(this.rateLimit.recoveredAt),
      },
      rolling: {
        currentMinute: toSummary(this.currentBucket(now)),
        oneMinute: toSummary(oneMinute.overall),
        fiveMinutes: toSummary(fiveMinutes.overall),
        fifteenMinutes: toSummary(fifteenMinutes.overall),
        sixtyMinutes: toSummary(sixtyMinutes.overall),
        sinceStartup: toSummary(this.sinceStartup),
      },
      topOperations: this.toTopGroups(fiveMinutes.operations, 5),
      topEndpoints: this.toTopGroups(fiveMinutes.endpoints, 5),
    };
  }

  drainPendingAggregateDeltas() {
    const deltas = Array.from(this.pendingDeltas.values()).map((delta) => ({
      ...delta,
    }));
    this.pendingDeltas.clear();
    return deltas;
  }

  restorePendingAggregateDeltas(deltas: AlpacaApiUsageAggregateDelta[]) {
    for (const delta of deltas) {
      this.mergePendingDelta(delta);
    }
  }

  getPendingAggregateCount() {
    return this.pendingDeltas.size;
  }

  private recordCounters(args: {
    metadata: AlpacaRequestMetadata;
    completedAt: Date;
    durationMs: number;
    completion: RequestCompletion;
  }) {
    const bucket = this.getBucket(args.completedAt);
    const operationCounters = this.getGroupCounters(
      bucket.operations,
      args.metadata.operation
    );
    const endpointCounters = this.getGroupCounters(
      bucket.endpoints,
      args.metadata.endpoint
    );

    for (const counters of [
      bucket,
      operationCounters,
      endpointCounters,
      this.sinceStartup,
    ]) {
      counters.requestCount += 1;
      counters.totalDurationMs += args.durationMs;
      counters.maxDurationMs = Math.max(counters.maxDurationMs, args.durationMs);
      counters.latestRequestAt = args.completedAt;

      if (args.completion.outcome === 'success') {
        counters.successCount += 1;
        counters.latestSuccessAt = args.completedAt;
      } else {
        counters.failureCount += 1;
        counters.latestFailureAt = args.completedAt;
      }

      if (args.completion.outcome === 'rate_limited') {
        counters.rateLimitCount += 1;
        counters.latestRateLimitedAt = args.completedAt;
      }

      if (
        args.completion.outcome === 'network_error' ||
        args.completion.outcome === 'timeout'
      ) {
        counters.networkErrorCount += 1;
      }
    }
  }

  private recordPersistenceDelta(args: {
    metadata: AlpacaRequestMetadata;
    completedAt: Date;
    durationMs: number;
    completion: RequestCompletion;
  }) {
    const bucketStart = new Date(
      Math.floor(args.completedAt.getTime() / PERSISTENCE_BUCKET_MS) *
        PERSISTENCE_BUCKET_MS
    );
    const delta: AlpacaApiUsageAggregateDelta = {
      bucketStart,
      bucketSizeMinutes: PERSISTENCE_BUCKET_MINUTES,
      operation: args.metadata.operation,
      endpoint: args.metadata.endpoint,
      method: args.metadata.method,
      requestClass: args.metadata.requestClass,
      requestCount: 1,
      successCount: args.completion.outcome === 'success' ? 1 : 0,
      failureCount: args.completion.outcome === 'success' ? 0 : 1,
      rateLimitCount: args.completion.outcome === 'rate_limited' ? 1 : 0,
      networkErrorCount:
        args.completion.outcome === 'network_error' ||
        args.completion.outcome === 'timeout'
          ? 1
          : 0,
      totalDurationMs: Math.round(args.durationMs),
      maxDurationMs: Math.round(args.durationMs),
      lastStatusCode: args.completion.statusCode,
      lastRequestAt: args.completedAt,
      lastFailureAt:
        args.completion.outcome === 'success' ? null : args.completedAt,
      lastRateLimitedAt:
        args.completion.outcome === 'rate_limited' ? args.completedAt : null,
    };

    this.mergePendingDelta(delta);
  }

  private mergePendingDelta(delta: AlpacaApiUsageAggregateDelta) {
    const key = [
      delta.bucketStart.toISOString(),
      delta.operation,
      delta.endpoint,
      delta.method,
      delta.requestClass,
    ].join('|');
    const existing = this.pendingDeltas.get(key);

    if (!existing) {
      this.pendingDeltas.set(key, { ...delta });
      return;
    }

    existing.requestCount += delta.requestCount;
    existing.successCount += delta.successCount;
    existing.failureCount += delta.failureCount;
    existing.rateLimitCount += delta.rateLimitCount;
    existing.networkErrorCount += delta.networkErrorCount;
    existing.totalDurationMs += delta.totalDurationMs;
    existing.maxDurationMs = Math.max(existing.maxDurationMs, delta.maxDurationMs);
    existing.lastStatusCode = delta.lastStatusCode ?? existing.lastStatusCode;
    existing.lastRequestAt = latestDate(existing.lastRequestAt, delta.lastRequestAt);
    existing.lastFailureAt = latestDate(existing.lastFailureAt, delta.lastFailureAt);
    existing.lastRateLimitedAt = latestDate(
      existing.lastRateLimitedAt,
      delta.lastRateLimitedAt
    );
  }

  private recordRateLimit(
    metadata: AlpacaRequestMetadata,
    headers: Headers | null,
    now: Date
  ) {
    const wasActive = this.rateLimit.active;
    const retryAfter = parseRetryAfter(headers?.get('retry-after') ?? null, now);

    if (!wasActive) {
      this.rateLimit.incidentCount += 1;
      this.rateLimit.currentIncident429Count = 0;
      this.rateLimit.firstRateLimitedAt = now;
      this.rateLimit.recoveredAt = null;
      this.emitEvent('alpaca_api.rate_limit_started', {
        operation: metadata.operation,
        endpoint: metadata.endpoint,
        processInstanceId: this.processInstanceId,
        retryAfterSeconds: retryAfter.retryAfterSeconds,
      });
    }

    this.rateLimit.active = true;
    this.rateLimit.currentIncident429Count += 1;
    this.rateLimit.lastRateLimitedAt = now;
    this.rateLimit.lastOperation = metadata.operation;
    this.rateLimit.lastEndpoint = metadata.endpoint;
    this.rateLimit.retryAfterSeconds = retryAfter.retryAfterSeconds;

    if (
      retryAfter.backoffUntil &&
      (!this.rateLimit.backoffUntil ||
        retryAfter.backoffUntil.getTime() > this.rateLimit.backoffUntil.getTime())
    ) {
      this.rateLimit.backoffUntil = retryAfter.backoffUntil;
    }

    this.rateLimit.latestKnownLimit = parseHeaderNumber(
      headers?.get('x-ratelimit-limit') ?? headers?.get('x-rate-limit-limit') ?? null
    );
    this.rateLimit.latestKnownRemaining = parseHeaderNumber(
      headers?.get('x-ratelimit-remaining') ??
        headers?.get('x-rate-limit-remaining') ??
        null
    );
    this.rateLimit.latestKnownResetAt = parseHeaderDateOrEpoch(
      headers?.get('x-ratelimit-reset') ?? headers?.get('x-rate-limit-reset') ?? null
    );
  }

  private recordRateLimitRecovery(
    metadata: AlpacaRequestMetadata,
    now: Date
  ) {
    if (!this.rateLimit.active) {
      return;
    }

    if (
      this.rateLimit.backoffUntil &&
      now.getTime() < this.rateLimit.backoffUntil.getTime()
    ) {
      return;
    }

    this.rateLimit.active = false;
    this.rateLimit.recoveredAt = now;
    this.emitEvent('alpaca_api.rate_limit_recovered', {
      operation: metadata.operation,
      endpoint: metadata.endpoint,
      processInstanceId: this.processInstanceId,
      incidentCount: this.rateLimit.incidentCount,
      rateLimitCount: this.rateLimit.currentIncident429Count,
    });
  }

  private evaluateWarning(now: Date) {
    const oneMinute = this.aggregateWindow(1, now).overall.requestCount;

    if (!this.warningActive && oneMinute >= this.warningThresholdPerMinute) {
      this.warningActive = true;
      this.warningStartedAt = now;
      this.warningRecoveredAt = null;
      this.emitEvent('alpaca_api.volume_warning_started', {
        requestCountLastMinute: oneMinute,
        thresholdPerMinute: this.warningThresholdPerMinute,
        processInstanceId: this.processInstanceId,
      });
      return;
    }

    const recoveryThreshold = Math.floor(
      this.warningThresholdPerMinute * WARNING_RECOVERY_RATIO
    );

    if (this.warningActive && oneMinute <= recoveryThreshold) {
      this.warningActive = false;
      this.warningRecoveredAt = now;
      this.emitEvent('alpaca_api.volume_warning_recovered', {
        requestCountLastMinute: oneMinute,
        thresholdPerMinute: this.warningThresholdPerMinute,
        recoveryThreshold,
        processInstanceId: this.processInstanceId,
      });
    }
  }

  private getBucket(date: Date): MinuteBucket {
    const minuteStartMs = toMinuteStartMs(date);
    const index = Math.floor(minuteStartMs / MINUTE_MS) % BUCKET_COUNT;
    const existing = this.buckets[index];

    if (existing?.minuteStartMs === minuteStartMs) {
      return existing;
    }

    const bucket: MinuteBucket = {
      ...createCounters(),
      minuteStartMs,
      operations: new Map(),
      endpoints: new Map(),
    };
    this.buckets[index] = bucket;
    return bucket;
  }

  private currentBucket(date: Date) {
    return this.getBucket(date);
  }

  private getGroupCounters<Key extends string>(
    groups: Map<Key, CounterValues>,
    key: Key
  ) {
    const existing = groups.get(key);
    if (existing) return existing;

    const counters = createCounters();
    groups.set(key, counters);
    return counters;
  }

  private aggregateWindow(minutes: number, now: Date) {
    const minimumMinuteStart =
      toMinuteStartMs(now) - Math.max(0, minutes - 1) * MINUTE_MS;
    const overall = createCounters();
    const operations = new Map<AlpacaApiOperation, CounterValues>();
    const endpoints = new Map<AlpacaApiEndpoint, CounterValues>();

    for (const bucket of this.buckets) {
      if (!bucket || bucket.minuteStartMs < minimumMinuteStart) {
        continue;
      }

      addCounters(overall, bucket);

      for (const [operation, counters] of bucket.operations) {
        addCounters(this.getGroupCounters(operations, operation), counters);
      }

      for (const [endpoint, counters] of bucket.endpoints) {
        addCounters(this.getGroupCounters(endpoints, endpoint), counters);
      }
    }

    return { overall, operations, endpoints };
  }

  private toTopGroups(groups: Map<string, CounterValues>, limit: number) {
    return Array.from(groups.entries())
      .map(([key, counters]) => ({
        key,
        ...toSummary(counters),
        latestRequestAt: toIso(counters.latestRequestAt),
        latestFailureAt: toIso(counters.latestFailureAt),
        latestRateLimitedAt: toIso(counters.latestRateLimitedAt),
      }))
      .sort(
        (left, right) =>
          right.requestCount - left.requestCount || left.key.localeCompare(right.key)
      )
      .slice(0, limit);
  }

  private emitEvent(type: string, payloadJson: Record<string, unknown>) {
    void createSystemEvent({
      type,
      entityType: 'alpacaApiUsage',
      entityId: 'alpaca',
      payloadJson: payloadJson as Prisma.InputJsonValue,
    }).catch((error) => {
      logger.warn({ error, eventType: type }, 'Alpaca API usage event write failed.');
    });
  }
}

export const alpacaApiUsageRegistry = new AlpacaApiUsageRegistry();
