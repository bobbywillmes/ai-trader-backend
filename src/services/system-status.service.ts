import { prisma } from '../db/prisma.js';
import { getRuntimeTradingConfig } from './config.service.js';
import { getRiskStatus } from './risk-gate.service.js';
import { getLatestAccountSnapshot } from './account-snapshot.service.js';
import { getLatestBrokerActivity } from './broker-activity.service.js';
import { getHealthStatus } from './health.service.js';

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

  return {
    ok: health.ok && risk.canEnter,
    health,
    environment: {
      nodeEnv: process.env.NODE_ENV ?? 'unknown',
      port: process.env.PORT ?? null,
      hasDatabaseUrl: hasEnv('DATABASE_URL'),
      hasAlpacaApiKey: hasEnv('ALPACA_API_KEY'),
      hasAlpacaSecretKey: hasEnv('ALPACA_API_SECRET'),
      hasAlpacaBaseUrl: hasEnv('ALPACA_BASE_URL'),
      hasSignalApiKey: hasEnv('AI_TRADER_SIGNAL_API_KEY'),
    },
    trading: {
      config: runtimeConfig,
      risk,
    },
    workers: {
      tradingLoopSeconds: 2,
      accountSnapshotCheckSeconds: 60,
      brokerActivitySyncSeconds: 60,
      pendingOrderCount,
      submittingOrderCount,
      submittedOrderCount,
      openTrackedPositionCount,
      closingTrackedPositionCount,
      unprocessedSystemEventCount,
    },
    audit: {
      latestAccountSnapshot,
      latestBrokerActivity,
    },
    timestamp: new Date().toISOString(),
  };
}