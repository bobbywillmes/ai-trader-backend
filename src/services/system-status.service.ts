import { prisma } from '../db/prisma.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { getRiskStatus } from './risk-gate.service.js';
import { getLatestAccountSnapshot } from './account-snapshot.service.js';
import { getLatestBrokerActivity } from './broker-activity.service.js';
import { getHealthStatus } from './health.service.js';
import { allowedCorsOrigins } from '../config/cors.js';
import { workerHealthRegistry } from './worker-health.service.js';
import { alpacaApiUsageRegistry } from './alpaca-api-usage.service.js';
import { getAlpacaApiUsagePersistenceSnapshot } from './alpaca-api-usage-persistence.service.js';
import { adaptivePollingCoordinator } from './adaptive-polling.service.js';
import {
  ACCOUNT_SNAPSHOT_WORKER_INTERVAL_MS,
  BROKER_ACTIVITY_WORKER_INTERVAL_MS,
  TRADING_WORKER_INTERVAL_MS,
} from '../workers/worker-health.definitions.js';

function hasEnv(name: string) {
  return Boolean(process.env[name]);
}

export async function getSystemStatus() {
  const [
    health,
    runtimeConfig,
    risk,
    latestAccountSnapshot,
    latestBrokerActivity,
    pendingOrderCount,
    submittingOrderCount,
    submittedOrderCount,
    openTrackedPositionCount,
    closingTrackedPositionCount,
    unprocessedSystemEventCount,
  ] = await Promise.all([
    getHealthStatus(),
    getRuntimeTradingConfig(),
    getRiskStatus(),
    getLatestAccountSnapshot(),
    getLatestBrokerActivity(),

    prisma.orderIntent.count({
      where: { status: 'pending' },
    }),

    prisma.orderIntent.count({
      where: { status: 'submitting' },
    }),

    prisma.orderIntent.count({
      where: { status: 'submitted' },
    }),

    prisma.trackedPosition.count({
      where: { status: 'open' },
    }),

    prisma.trackedPosition.count({
      where: { status: 'closing' },
    }),

    prisma.systemEvent.count({
      where: { processed: false },
    }),
  ]);
  const workerHealth = workerHealthRegistry.getSnapshot();
  const alpacaApiUsage = alpacaApiUsageRegistry.getSnapshot();
  const alpacaApiUsagePersistence = getAlpacaApiUsagePersistenceSnapshot();
  const adaptivePolling = await adaptivePollingCoordinator.getSnapshot();
  const alpacaUsagePersistenceWorker = workerHealth.items.find(
    (worker) => worker.key === 'alpaca_api_usage_persistence'
  );
  const alpacaApiUsageStatus =
    alpacaUsagePersistenceWorker &&
    ['degraded', 'delayed', 'stale', 'failing'].includes(
      alpacaUsagePersistenceWorker.status
    )
      ? 'degraded'
      : alpacaApiUsage.status;
  const workersHealthy = workerHealth.summary.criticalHealthy;
  const serviceHealthy = health.ok;
  const canEnter = risk.canEnter;
  const tradingReady = serviceHealthy && workersHealthy && canEnter;
  const needsAttention = !serviceHealthy || workerHealth.summary.needsAttention;

  return {
    ok: health.ok,
    health,
    readiness: {
      serviceHealthy,
      workersHealthy,
      tradingReady,
      canEnter,
      needsAttention,
    },
    environment: {
      nodeEnv: process.env.NODE_ENV ?? 'unknown',
      port: process.env.PORT ?? null,
      hasDatabaseUrl: hasEnv('DATABASE_URL'),
      hasAlpacaApiKey: hasEnv('ALPACA_API_KEY'),
      hasAlpacaSecretKey: hasEnv('ALPACA_API_SECRET'),
      hasAlpacaBaseUrl: hasEnv('ALPACA_BASE_URL'),
      hasAdminSessionToken: true,
      hasSignalApiKey: hasEnv('AI_TRADER_SIGNAL_API_KEY'),
      corsAllowedOrigins: allowedCorsOrigins,
      hasCorsAllowedOrigins: allowedCorsOrigins.length > 0,
    },
    trading: {
      config: runtimeConfig,
      risk,
    },
    workers: {
      health: workerHealth,
      tradingLoopSeconds: TRADING_WORKER_INTERVAL_MS / 1_000,
      accountSnapshotCheckSeconds: ACCOUNT_SNAPSHOT_WORKER_INTERVAL_MS / 1_000,
      brokerActivitySyncSeconds: BROKER_ACTIVITY_WORKER_INTERVAL_MS / 1_000,
      pendingOrderCount,
      submittingOrderCount,
      submittedOrderCount,
      openTrackedPositionCount,
      closingTrackedPositionCount,
      unprocessedSystemEventCount,
    },
    alpacaApiUsage: {
      ...alpacaApiUsage,
      status: alpacaApiUsageStatus,
      persistence: alpacaApiUsagePersistence,
    },
    adaptivePolling,
    audit: {
      latestAccountSnapshot,
      latestBrokerActivity,
    },
    timestamp: new Date().toISOString(),
  };
}
