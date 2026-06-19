import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSystemStatus } from './system-status.service.js';

const mocks = vi.hoisted(() => ({
  getHealthStatus: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
  getRiskStatus: vi.fn(),
  getLatestAccountSnapshot: vi.fn(),
  getLatestBrokerActivity: vi.fn(),
  orderIntentCount: vi.fn(),
  trackedPositionCount: vi.fn(),
  systemEventCount: vi.fn(),
  workerHealthSnapshot: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    orderIntent: { count: mocks.orderIntentCount },
    trackedPosition: { count: mocks.trackedPositionCount },
    systemEvent: { count: mocks.systemEventCount },
  },
}));

vi.mock('./config.service.js', () => ({
  getRuntimeTradingConfig: mocks.getRuntimeTradingConfig,
}));

vi.mock('./risk-gate.service.js', () => ({
  getRiskStatus: mocks.getRiskStatus,
}));

vi.mock('./account-snapshot.service.js', () => ({
  getLatestAccountSnapshot: mocks.getLatestAccountSnapshot,
}));

vi.mock('./broker-activity.service.js', () => ({
  getLatestBrokerActivity: mocks.getLatestBrokerActivity,
}));

vi.mock('./health.service.js', () => ({
  getHealthStatus: mocks.getHealthStatus,
}));

vi.mock('./worker-health.service.js', () => ({
  workerHealthRegistry: {
    getSnapshot: mocks.workerHealthSnapshot,
  },
}));

vi.mock('../config/cors.js', () => ({
  allowedCorsOrigins: [],
}));

describe('system status health semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHealthStatus.mockResolvedValue({
      ok: true,
      service: 'ai-trader-backend',
      environment: 'test',
      uptimeSeconds: 1,
      database: { ok: true, message: 'ok' },
      timestamp: '2026-06-18T21:00:00.000Z',
    });
    mocks.getRuntimeTradingConfig.mockResolvedValue({});
    mocks.getRiskStatus.mockResolvedValue({
      canEnter: false,
      reasons: ['Regular market is closed.'],
    });
    mocks.workerHealthSnapshot.mockReturnValue({
      summary: {
        status: 'healthy',
        total: 7,
        enabled: 6,
        disabled: 1,
        healthy: 6,
        degraded: 0,
        delayed: 0,
        stale: 0,
        failing: 0,
        starting: 0,
        criticalHealthy: true,
        needsAttention: false,
        processInstanceId: 'process-test',
        processStartedAt: '2026-06-18T20:59:00.000Z',
        evaluatedAt: '2026-06-18T21:00:00.000Z',
      },
      items: [],
    });
    mocks.getLatestAccountSnapshot.mockResolvedValue(null);
    mocks.getLatestBrokerActivity.mockResolvedValue(null);
    mocks.orderIntentCount.mockResolvedValue(0);
    mocks.trackedPositionCount.mockResolvedValue(0);
    mocks.systemEventCount.mockResolvedValue(0);
  });

  it('does not mark the backend unhealthy when entry policy blocks canEnter', async () => {
    const status = await getSystemStatus();

    expect(status.ok).toBe(true);
    expect(status.trading.risk.canEnter).toBe(false);
    expect(status.readiness).toMatchObject({
      serviceHealthy: true,
      workersHealthy: true,
      canEnter: false,
      tradingReady: false,
      needsAttention: false,
    });
  });

  it('marks readiness attention when a critical worker is stale without changing canEnter', async () => {
    mocks.getRiskStatus.mockResolvedValue({
      canEnter: true,
      reasons: [],
    });
    mocks.workerHealthSnapshot.mockReturnValue({
      summary: {
        status: 'stale',
        total: 7,
        enabled: 6,
        disabled: 1,
        healthy: 5,
        degraded: 0,
        delayed: 0,
        stale: 1,
        failing: 0,
        starting: 0,
        criticalHealthy: false,
        needsAttention: true,
        processInstanceId: 'process-test',
        processStartedAt: '2026-06-18T20:59:00.000Z',
        evaluatedAt: '2026-06-18T21:00:00.000Z',
      },
      items: [
        {
          key: 'broker_activity_sync',
          status: 'stale',
          enabled: true,
          criticality: 'critical',
        },
      ],
    });

    const status = await getSystemStatus();

    expect(status.ok).toBe(true);
    expect(status.trading.risk.canEnter).toBe(true);
    expect(status.readiness).toMatchObject({
      serviceHealthy: true,
      workersHealthy: false,
      canEnter: true,
      tradingReady: false,
      needsAttention: true,
    });
    expect(status.workers.health.summary.status).toBe('stale');
  });
});
