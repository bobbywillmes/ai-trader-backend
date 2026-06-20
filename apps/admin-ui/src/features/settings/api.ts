import { apiRequest } from "../../lib/api";
import type { RuntimeTradingConfig } from "../dashboard/types";

export function getConfig(token: string) {
  return apiRequest<RuntimeTradingConfig>("/api/config", { token });
}

export function updateConfig(
  token: string,
  payload: Partial<RuntimeTradingConfig>
) {
  return apiRequest<RuntimeTradingConfig>("/api/config/settings", {
    method: "PATCH",
    token,
    body: payload,
  });
}

export type SystemStatusResponse = {
  ok: boolean;
  health: {
    ok: boolean;
    service: string;
    environment: string;
    uptimeSeconds: number;
    database: {
      ok: boolean;
      message: string;
    };
    timestamp: string;
  };
  environment: {
    nodeEnv: string;
    port: string | null;
    hasDatabaseUrl: boolean;
    hasAlpacaApiKey: boolean;
    hasAlpacaSecretKey: boolean;
    hasAlpacaBaseUrl: boolean;
    hasAdminSessionToken: boolean;
    hasSignalApiKey: boolean;
    corsAllowedOrigins: string[];
    hasCorsAllowedOrigins: boolean;
  };
  readiness: {
    serviceHealthy: boolean;
    workersHealthy: boolean;
    tradingReady: boolean;
    canEnter: boolean;
    needsAttention: boolean;
  };
  trading: {
    config: {
      tradingEnabled: boolean;
      paperMode: boolean;
      killSwitchEnabled: boolean;
      maxDailyEntryOrders: number | null;
      maxDailyEntryNotional: number | null;
      maxOpenPositions: number | null;
      maxTotalOpenNotional: number | null;
      maxSymbolOpenNotional: number | null;
      maxSubscriptionOpenNotional: number | null;
      entrySessionGuardEnabled: boolean;
      entryStartMinutesAfterOpen: number;
      entryCutoffMinutesBeforeClose: number | null;
      failClosedOnMarketClockError: boolean;
    };
    risk: {
      canEnter: boolean;
      reasons: string[];
      broker: {
        name: string;
        mode: "paper" | "live";
        expectedMode: "paper" | "live";
        tradingBlocked: boolean;
      };
      entrySession: {
        enabled: boolean;
        status:
          | "disabled"
          | "allowed"
          | "market_closed"
          | "open_buffer"
          | "close_buffer"
          | "unavailable"
          | "degraded"
          | "invalid_window";
        canEnterNow: boolean;
        marketOpen: boolean | null;
        evaluatedAt: string;
        sessionOpenAt: string | null;
        entryAllowedAt: string | null;
        entryCutoffAt: string | null;
        sessionCloseAt: string | null;
        nextOpenAt: string | null;
        nextCloseAt: string | null;
        openingBufferMinutes: number;
        closingBufferMinutes: number | null;
        failClosed: boolean;
        degraded: boolean;
        rule: string | null;
        error: { name: string; message: string } | null;
      };
    };
  };
  workers: {
    health: {
      summary: {
        status:
          | "disabled"
          | "starting"
          | "healthy"
          | "degraded"
          | "delayed"
          | "stale"
          | "failing";
        total: number;
        enabled: number;
        disabled: number;
        healthy: number;
        degraded: number;
        delayed: number;
        stale: number;
        failing: number;
        starting: number;
        criticalHealthy: boolean;
        needsAttention: boolean;
        processInstanceId: string;
        processStartedAt: string;
        evaluatedAt: string;
      };
      items: Array<{
        key: string;
        displayName: string;
        description: string;
        criticality: "critical" | "important" | "informational";
        enabled: boolean;
        status:
          | "disabled"
          | "starting"
          | "healthy"
          | "degraded"
          | "delayed"
          | "stale"
          | "failing";
        statusReason: string;
        expectedIntervalMs: number;
        delayedAfterMs: number;
        staleAfterMs: number;
        maxRunDurationMs: number;
        running: boolean;
        currentRunStartedAt: string | null;
        lastTickStartedAt: string | null;
        lastTickCompletedAt: string | null;
        lastSucceededAt: string | null;
        lastWorkSucceededAt: string | null;
        lastFailedAt: string | null;
        lastDurationMs: number | null;
        lastOutcome: "success" | "idle" | "skipped" | "failed" | null;
        lastSkipReason: string | null;
        consecutiveFailures: number;
        totalRuns: number;
        totalFailures: number;
        totalSkips: number;
        lastError: string | null;
        lastErrorAt: string | null;
        ageSinceLastSuccessMs: number | null;
      }>;
    };
    tradingLoopSeconds: number;
    accountSnapshotCheckSeconds: number;
    brokerActivitySyncSeconds: number;
    pendingOrderCount: number;
    submittingOrderCount: number;
    submittedOrderCount: number;
    openTrackedPositionCount: number;
    closingTrackedPositionCount: number;
    unprocessedSystemEventCount: number;
  };
  alpacaApiUsage: {
    evaluatedAt: string;
    processInstanceId: string;
    processStartedAt: string;
    status: "normal" | "elevated" | "rate_limited" | "degraded";
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
    rateLimit: {
      active: boolean;
      firstRateLimitedAt: string | null;
      lastRateLimitedAt: string | null;
      backoffUntil: string | null;
      retryAfterSeconds: number | null;
      incidentCount: number;
      currentIncident429Count: number;
      lastOperation: string | null;
      lastEndpoint: string | null;
      latestKnownLimit: number | null;
      latestKnownRemaining: number | null;
      latestKnownResetAt: string | null;
      recoveredAt: string | null;
    };
    rolling: Record<
      | "currentMinute"
      | "oneMinute"
      | "fiveMinutes"
      | "fifteenMinutes"
      | "sixtyMinutes"
      | "sinceStartup",
      {
        requestCount: number;
        successCount: number;
        failureCount: number;
        rateLimitCount: number;
        networkErrorCount: number;
        totalDurationMs: number;
        averageDurationMs: number;
        maxDurationMs: number;
      }
    >;
    topOperations: Array<{
      key: string;
      requestCount: number;
      successCount: number;
      failureCount: number;
      rateLimitCount: number;
      networkErrorCount: number;
      totalDurationMs: number;
      averageDurationMs: number;
      maxDurationMs: number;
      latestRequestAt: string | null;
      latestFailureAt: string | null;
      latestRateLimitedAt: string | null;
    }>;
    topEndpoints: Array<{
      key: string;
      requestCount: number;
      successCount: number;
      failureCount: number;
      rateLimitCount: number;
      networkErrorCount: number;
      totalDurationMs: number;
      averageDurationMs: number;
      maxDurationMs: number;
      latestRequestAt: string | null;
      latestFailureAt: string | null;
      latestRateLimitedAt: string | null;
    }>;
    persistence: {
      lastFlushAttemptAt: string | null;
      lastFlushSucceededAt: string | null;
      lastFlushFailedAt: string | null;
      pendingAggregateCount: number;
      retentionDays: number;
      lastRetentionRunAt: string | null;
    };
  };
  audit: {
    latestAccountSnapshot: {
      createdAt: string;
      reason: string;
    } | null;
    latestBrokerActivity: {
      transactionTime: string | null;
      symbol: string | null;
      side: string | null;
      activityType: string;
    } | null;
  };
  timestamp: string;
};

export function getSystemStatus(token: string) {
  return apiRequest<SystemStatusResponse>("/api/system-status", { token });
}
