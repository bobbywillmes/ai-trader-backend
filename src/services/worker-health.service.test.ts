import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workerHealthUpsert: vi.fn(),
  createSystemEvent: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    workerHealthState: {
      upsert: mocks.workerHealthUpsert,
    },
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
  type WorkerDefinition,
  workerDefinitions,
} from '../workers/worker-health.definitions.js';
import { WorkerHealthRegistry } from './worker-health.service.js';

const baseDefinition: WorkerDefinition = {
  key: 'pending_order_processing',
  displayName: 'Pending order processing',
  description: 'Test worker',
  criticality: 'critical',
  expectedIntervalMs: 2_000,
  startupGraceMs: 15_000,
  delayedAfterMs: 15_000,
  staleAfterMs: 60_000,
  maxRunDurationMs: 20_000,
  enabledByDefault: true,
};

function createRegistry(start = '2026-06-19T12:00:00.000Z') {
  let nowMs = new Date(start).getTime();
  const registry = new WorkerHealthRegistry({
    processInstanceId: 'process-test',
    now: () => new Date(nowMs),
  });

  registry.registerWorker(baseDefinition);

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

function firstItem(registry: WorkerHealthRegistry) {
  return registry.getSnapshot().items[0];
}

describe('WorkerHealthRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerHealthUpsert.mockResolvedValue({});
    mocks.createSystemEvent.mockResolvedValue({});
  });

  it('registers every centralized worker with unique stable keys', () => {
    const keys = workerDefinitions.map((worker) => worker.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      'pending_order_processing',
      'submitted_order_sync',
      'tracked_position_sync',
      'exit_evaluation',
      'account_snapshot_scheduler',
      'broker_activity_sync',
      'scheduled_reconciliation',
    ]);
  });

  it('reports a newly registered worker as starting during startup grace', () => {
    const { registry } = createRegistry();

    expect(firstItem(registry)).toMatchObject({
      status: 'starting',
      statusReason: 'within_startup_grace',
      processInstanceId: 'process-test',
    });
  });

  it('reports never-successful workers as stale after startup grace plus stale threshold', () => {
    const { registry, advance } = createRegistry();

    advance(baseDefinition.startupGraceMs + baseDefinition.staleAfterMs + 1);

    expect(firstItem(registry)).toMatchObject({
      status: 'stale',
      statusReason: 'never_succeeded',
    });
  });

  it('records successful execution and clears active failure state', async () => {
    const { registry, advance } = createRegistry();

    await registry.runMonitoredWorker('pending_order_processing', async () => {
      advance(25);
      return { outcome: 'success', workSucceeded: true };
    });

    expect(firstItem(registry)).toMatchObject({
      status: 'healthy',
      lastOutcome: 'success',
      consecutiveFailures: 0,
      totalRuns: 1,
      lastDurationMs: 25,
    });
    expect(firstItem(registry)?.lastWorkSucceededAt).toBe(
      '2026-06-19T12:00:00.025Z'
    );
  });

  it('treats idle and not-due skipped ticks as healthy scheduler liveness', async () => {
    const { registry, advance } = createRegistry();

    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'idle',
    }));
    advance(1_000);
    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'skipped',
      skipReason: 'not_due',
    }));

    expect(firstItem(registry)).toMatchObject({
      status: 'healthy',
      lastOutcome: 'skipped',
      lastSkipReason: 'not_due',
      totalSkips: 1,
    });
  });

  it('does not refresh scheduler liveness for already-running skips', async () => {
    const { registry, advance } = createRegistry();

    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'success',
    }));

    advance(baseDefinition.delayedAfterMs + 1);
    registry.skipWorkerTick('pending_order_processing', 'already_running');

    expect(firstItem(registry)).toMatchObject({
      status: 'delayed',
      statusReason: 'heartbeat_delayed',
      lastSkipReason: 'already_running',
    });
  });

  it('moves from degraded to failing after three consecutive top-level failures', async () => {
    const { registry } = createRegistry();
    const error = new Error('Database unavailable');

    await registry
      .runMonitoredWorker('pending_order_processing', async () => {
        throw error;
      })
      .catch(() => undefined);

    expect(firstItem(registry)).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 1,
      lastError: 'Database unavailable',
    });

    for (let i = 0; i < 2; i += 1) {
      await registry
        .runMonitoredWorker('pending_order_processing', async () => {
          throw error;
        })
        .catch(() => undefined);
    }

    expect(firstItem(registry)).toMatchObject({
      status: 'failing',
      statusReason: 'consecutive_failures',
      consecutiveFailures: 3,
      totalFailures: 3,
    });
  });

  it('recovers to healthy while preserving historical failure timestamp', async () => {
    const { registry, advance } = createRegistry();

    await registry
      .runMonitoredWorker('pending_order_processing', async () => {
        throw new Error('Broker sync failed');
      })
      .catch(() => undefined);

    const failedAt = firstItem(registry)?.lastFailedAt;
    advance(500);

    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'success',
    }));

    expect(firstItem(registry)).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
      lastError: null,
      lastFailedAt: failedAt,
    });
  });

  it('uses exact delayed and stale boundaries', async () => {
    const { registry, advance } = createRegistry();

    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'success',
    }));

    advance(baseDefinition.delayedAfterMs);
    expect(firstItem(registry)?.status).toBe('healthy');

    advance(1);
    expect(firstItem(registry)).toMatchObject({
      status: 'delayed',
      statusReason: 'heartbeat_delayed',
    });

    advance(baseDefinition.staleAfterMs - baseDefinition.delayedAfterMs - 1);
    expect(firstItem(registry)?.status).toBe('delayed');

    advance(1);
    expect(firstItem(registry)).toMatchObject({
      status: 'stale',
      statusReason: 'heartbeat_overdue',
    });
  });

  it('reports a run timeout as stale while the worker is still running', () => {
    const { registry, advance } = createRegistry();

    registry.beginWorkerTick('pending_order_processing');
    advance(baseDefinition.maxRunDurationMs + 1);

    expect(firstItem(registry)).toMatchObject({
      status: 'stale',
      statusReason: 'run_timeout',
      running: true,
    });
  });

  it('sanitizes error details without exposing stack traces or obvious secrets', async () => {
    const { registry } = createRegistry();

    await registry
      .runMonitoredWorker('pending_order_processing', async () => {
        throw new Error(
          'Request failed with token=abc123 password=hunter2 at line 1'
        );
      })
      .catch(() => undefined);

    const item = firstItem(registry);

    expect(item?.lastError).toContain('token=[redacted]');
    expect(item?.lastError).toContain('password=[redacted]');
    expect(item?.lastError).not.toContain('at Worker');
  });

  it('batch persists dirty worker state without writing every tick immediately', async () => {
    const { registry } = createRegistry();

    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'success',
    }));

    expect(mocks.workerHealthUpsert).not.toHaveBeenCalled();

    await registry.flushDirtyStates();

    expect(mocks.workerHealthUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.workerHealthUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'pending_order_processing' },
        update: expect.objectContaining({
          processInstanceId: 'process-test',
          lastOutcome: 'success',
        }),
      })
    );
  });

  it('does not fail business worker state when persistence fails', async () => {
    const { registry } = createRegistry();

    mocks.workerHealthUpsert.mockRejectedValue(new Error('database down'));

    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'success',
    }));
    await registry.flushDirtyStates();

    expect(firstItem(registry)).toMatchObject({
      status: 'healthy',
      lastOutcome: 'success',
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
      }),
      'Worker health persistence failed.'
    );
  });

  it('creates one failing transition event and one recovery event', async () => {
    const { registry } = createRegistry();

    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'success',
    }));

    for (let i = 0; i < 3; i += 1) {
      await registry
        .runMonitoredWorker('pending_order_processing', async () => {
          throw new Error('Broker unavailable');
        })
        .catch(() => undefined);
    }

    await registry
      .runMonitoredWorker('pending_order_processing', async () => {
        throw new Error('Broker still unavailable');
      })
      .catch(() => undefined);

    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'success',
    }));

    expect(mocks.createSystemEvent).toHaveBeenCalledTimes(2);
    expect(mocks.createSystemEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'worker_health.failing',
        entityType: 'worker',
        entityId: 'pending_order_processing',
      })
    );
    expect(mocks.createSystemEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'worker_health.recovered',
        entityType: 'worker',
        entityId: 'pending_order_processing',
      })
    );
  });

  it('creates a stale transition event from timer-based evaluation during flush', async () => {
    const { registry, advance } = createRegistry();

    await registry.runMonitoredWorker('pending_order_processing', async () => ({
      outcome: 'success',
    }));
    await registry.flushDirtyStates();
    mocks.createSystemEvent.mockClear();

    advance(baseDefinition.staleAfterMs + 1);
    await registry.flushDirtyStates();

    expect(mocks.createSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'worker_health.stale',
        entityType: 'worker',
        entityId: 'pending_order_processing',
      })
    );
  });
});
