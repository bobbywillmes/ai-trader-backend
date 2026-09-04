import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TradingAccountWorkerHealthState } from '@prisma/client';
import {
  recordTradingAccountWorkerAttempt,
  recordTradingAccountWorkflowLockContention,
  deriveTradingAccountWorkerStatus,
} from './trading-account-worker-health.service.js';
import { getWorkerDefinition } from '../workers/worker-health.definitions.js';

const healthLogger = {
  trace: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const emitSystemEvent = vi.fn().mockResolvedValue(undefined);
const account = { displayName: 'Bobby Paper', environment: 'PAPER' };
let state: TradingAccountWorkerHealthState | null;
let id = 1;

function makeState(
  data: Partial<TradingAccountWorkerHealthState> = {}
): TradingAccountWorkerHealthState {
  const now = new Date();
  return {
    id: id++,
    tradingAccountId: 7,
    workerKey: 'exit_evaluation',
    processInstanceId: 'process-a',
    enabled: true,
    applicable: true,
    eligible: true,
    eligibilityReason: null,
    expectedIntervalMs: getWorkerDefinition('exit_evaluation').expectedIntervalMs,
    currentRunStartedAt: null,
    lastTickStartedAt: now,
    lastTickCompletedAt: now,
    lastSucceededAt: now,
    lastWorkSucceededAt: null,
    lastFailedAt: null,
    lastDurationMs: 1,
    lastOutcome: 'success',
    lastSkipReason: null,
    consecutiveFailures: 0,
    totalRuns: 1,
    totalFailures: 0,
    totalSkips: 0,
    totalLockSkips: 0,
    lastLockSkippedAt: null,
    lastError: null,
    lastErrorCode: null,
    lastErrorAt: null,
    backoffUntil: null,
    lastSummaryJson: null,
    createdAt: now,
    updatedAt: now,
    ...data,
  };
}

const db = {
  tradingAccountWorkerHealthState: {
    findUnique: vi.fn(async () => state),
    upsert: vi.fn(async ({ create, update }: {
      create: Partial<TradingAccountWorkerHealthState>;
      update: Record<string, unknown>;
    }) => {
      if (!state) {
        state = makeState(create);
      } else {
        const next = { ...state } as Record<string, unknown>;
        for (const [key, value] of Object.entries(update)) {
          if (value && typeof value === 'object' && 'increment' in value) {
            next[key] = Number(next[key] ?? 0) + Number(value.increment);
          } else {
            next[key] = value;
          }
        }
        state = next as TradingAccountWorkerHealthState;
      }
      return state;
    }),
  },
  tradingAccount: {
    findUnique: vi.fn(async () => account),
  },
};

const dependencies = {
  db: db as never,
  emitSystemEvent,
  logger: healthLogger,
};

describe('account workflow health logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state = makeState();
  });

  it('keeps repeated healthy and no-work ticks below normal log levels', async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      await recordTradingAccountWorkerAttempt({
        tradingAccountId: 7,
        workerKey: 'exit_evaluation',
        processInstanceId: 'process-a',
        outcome: 'success',
        workSucceeded: false,
      }, dependencies);
    }

    expect(healthLogger.info).not.toHaveBeenCalled();
    expect(healthLogger.warn).not.toHaveBeenCalled();
    expect(healthLogger.error).not.toHaveBeenCalled();
    expect(healthLogger.trace).toHaveBeenCalledTimes(10);
    expect(state?.totalRuns).toBe(11);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists skipped not-due as healthy liveness without moving work success', async () => {
    const previousWorkSucceededAt = new Date('2026-07-27T13:35:00.000Z');
    state = makeState({
      workerKey: 'account_snapshot_scheduler',
      lastSucceededAt: new Date('2026-07-27T13:36:00.000Z'),
      lastWorkSucceededAt: previousWorkSucceededAt,
    });

    const result = await recordTradingAccountWorkerAttempt({
      tradingAccountId: 7,
      workerKey: 'account_snapshot_scheduler',
      processInstanceId: 'process-a',
      outcome: 'skipped',
      skipReason: 'not_due',
      workSucceeded: false,
    }, dependencies);

    expect(result).toMatchObject({
      status: 'HEALTHY',
      lastOutcome: 'skipped',
      lastSkipReason: 'not_due',
      lastWorkSucceededAt: previousWorkSucceededAt,
      consecutiveFailures: 0,
      backoffUntil: null,
    });
    expect(result.lastSucceededAt!.getTime())
      .toBeGreaterThan(new Date('2026-07-27T13:36:00.000Z').getTime());
  });

  it('stays healthy beyond the stale threshold while minute not-due ticks continue', async () => {
    vi.useFakeTimers();
    const definition = getWorkerDefinition('account_snapshot_scheduler');
    const start = new Date('2026-07-27T14:00:00.000Z');
    const previousWorkSucceededAt = new Date('2026-07-27T13:35:00.000Z');
    state = makeState({
      workerKey: 'account_snapshot_scheduler',
      expectedIntervalMs: definition.expectedIntervalMs,
      lastSucceededAt: start,
      lastWorkSucceededAt: previousWorkSucceededAt,
      createdAt: start,
    });

    for (let minute = 1; minute <= 15; minute += 1) {
      vi.setSystemTime(new Date(start.getTime() + minute * 60_000));
      await recordTradingAccountWorkerAttempt({
        tradingAccountId: 7,
        workerKey: 'account_snapshot_scheduler',
        processInstanceId: 'process-a',
        outcome: 'skipped',
        skipReason: 'not_due',
        workSucceeded: false,
      }, dependencies);
      expect(deriveTradingAccountWorkerStatus(state!, definition, new Date()))
        .toBe('HEALTHY');
    }

    expect(state?.lastWorkSucceededAt).toEqual(previousWorkSucceededAt);
    vi.setSystemTime(new Date(
      state!.lastSucceededAt!.getTime() + definition.staleAfterMs + 1
    ));
    expect(deriveTradingAccountWorkerStatus(state!, definition, new Date()))
      .toBe('STALE');
  });

  it('keeps a credentialless dormant Live account below normal log levels', async () => {
    state = makeState({
      applicable: false,
      eligible: false,
      lastOutcome: 'dormant',
      lastSkipReason: 'dormant',
    });

    await recordTradingAccountWorkerAttempt({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      processInstanceId: 'process-a',
      outcome: 'dormant',
      applicable: false,
      eligible: false,
      eligibilityReason: 'credentials_unavailable_dormant',
    }, dependencies);

    expect(healthLogger.info).not.toHaveBeenCalled();
    expect(healthLogger.warn).not.toHaveBeenCalled();
    expect(healthLogger.error).not.toHaveBeenCalled();
    expect(healthLogger.trace).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      applicable: false,
      eligibilityReason: 'credentials_unavailable_dormant',
      totalSkips: 1,
    });
  });

  it('logs a stable failure once, a changed code again, recovery once, and recurrence', async () => {
    const fail = (errorCode: string) => recordTradingAccountWorkerAttempt({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      processInstanceId: 'process-a',
      outcome: 'failure',
      error: new Error('sanitized failure'),
      errorCode,
      summary: { trackedPositionId: 44 },
    }, dependencies);
    const recover = () => recordTradingAccountWorkerAttempt({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      processInstanceId: 'process-a',
      outcome: 'success',
    }, dependencies);

    await fail('BROKER_TIMEOUT');
    for (let tick = 0; tick < 10; tick += 1) await fail('BROKER_TIMEOUT');
    expect(healthLogger.error).toHaveBeenCalledTimes(1);

    await fail('BROKER_REJECTED');
    expect(healthLogger.error).toHaveBeenCalledTimes(2);
    expect(healthLogger.error.mock.calls[1]?.[0]).toMatchObject({
      failureFingerprint:
        '7|exit_evaluation|BROKER_REJECTED|trackedPositionId:44',
    });

    await recover();
    await recover();
    expect(healthLogger.info).toHaveBeenCalledTimes(1);

    await fail('BROKER_REJECTED');
    expect(healthLogger.error).toHaveBeenCalledTimes(3);
  });

  it('uses the persisted failure fields after restart to suppress an identical incident', async () => {
    state = makeState({
      consecutiveFailures: 3,
      lastError: 'sanitized failure',
      lastErrorCode: 'BROKER_TIMEOUT',
      lastSummaryJson: { trackedPositionId: 44 },
      lastFailedAt: new Date(),
    });

    await recordTradingAccountWorkerAttempt({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      processInstanceId: 'new-process',
      outcome: 'failure',
      error: new Error('sanitized failure'),
      errorCode: 'BROKER_TIMEOUT',
      summary: { trackedPositionId: 44 },
    }, dependencies);

    expect(healthLogger.error).not.toHaveBeenCalled();
  });

  it('does not emit recovery when a failed exit evaluation enters renewed backoff', async () => {
    const failedAt = new Date();
    state = makeState({
      consecutiveFailures: 1,
      lastFailedAt: failedAt,
      lastSucceededAt: new Date(failedAt.getTime() - 60_000),
      lastOutcome: 'failure',
      lastError: 'Broker unavailable',
      lastErrorCode: 'BROKER_TIMEOUT',
      backoffUntil: null,
    });

    await recordTradingAccountWorkerAttempt({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      processInstanceId: 'process-a',
      outcome: 'failure',
      error: new Error('Broker still unavailable'),
      errorCode: 'BROKER_TIMEOUT',
      backoffUntil: new Date(failedAt.getTime() + 16_000),
    }, dependencies);

    expect(state).toMatchObject({
      consecutiveFailures: 2,
      lastOutcome: 'failure',
    });
    expect(emitSystemEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'account_worker_health.recovered' })
    );
  });

  it('emits exactly one recovery after backoff ends with a healthy attempt', async () => {
    state = makeState({
      consecutiveFailures: 2,
      lastFailedAt: new Date(Date.now() - 20_000),
      lastOutcome: 'failure',
      backoffUntil: new Date(Date.now() + 16_000),
    });

    await recordTradingAccountWorkerAttempt({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      processInstanceId: 'process-a',
      outcome: 'success',
    }, dependencies);
    await recordTradingAccountWorkerAttempt({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      processInstanceId: 'process-a',
      outcome: 'success',
    }, dependencies);

    expect(emitSystemEvent).toHaveBeenCalledTimes(1);
    expect(emitSystemEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'account_worker_health.recovered',
      payloadJson: expect.objectContaining({
        previousStatus: 'BACKING_OFF',
        nextStatus: 'HEALTHY',
      }),
    }));
  });

  it('suppresses recovery when a failing workflow becomes dormant', async () => {
    state = makeState({
      consecutiveFailures: 1,
      lastFailedAt: new Date(),
      lastOutcome: 'failure',
    });

    await recordTradingAccountWorkerAttempt({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      processInstanceId: 'process-a',
      outcome: 'dormant',
      applicable: false,
      eligible: false,
      eligibilityReason: 'credentials_unavailable_dormant',
    }, dependencies);

    expect(emitSystemEvent).not.toHaveBeenCalled();
    expect(healthLogger.info).not.toHaveBeenCalled();
  });

  it('keeps ordinary contention quiet and logs only a delayed transition', async () => {
    const definition = getWorkerDefinition('exit_evaluation');
    state = makeState({
      lastSucceededAt: null,
      createdAt: new Date(),
      totalLockSkips: 0,
    });
    await recordTradingAccountWorkflowLockContention({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      contenderProcessInstanceId: 'contender',
      lockFamily: 'exit-evaluation',
      attemptedAt: new Date(),
    }, dependencies);
    expect(healthLogger.warn).not.toHaveBeenCalled();
    expect(emitSystemEvent).not.toHaveBeenCalled();

    const oldCreatedAt = new Date(Date.now() - definition.delayedAfterMs - 1);
    state = {
      ...state!,
      createdAt: oldCreatedAt,
      lastLockSkippedAt: new Date(oldCreatedAt.getTime() + 1),
    };
    await recordTradingAccountWorkflowLockContention({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      contenderProcessInstanceId: 'contender',
      lockFamily: 'exit-evaluation',
      attemptedAt: new Date(),
    }, dependencies);
    expect(healthLogger.warn).toHaveBeenCalledTimes(1);
    expect(emitSystemEvent).toHaveBeenCalledTimes(1);
    expect(emitSystemEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'account_worker_health.lock_contention' }));
    await recordTradingAccountWorkflowLockContention({
      tradingAccountId: 7,
      workerKey: 'exit_evaluation',
      contenderProcessInstanceId: 'contender',
      lockFamily: 'exit-evaluation',
      attemptedAt: new Date(),
    }, dependencies);
    expect(emitSystemEvent).toHaveBeenCalledTimes(1);
    expect(state?.totalLockSkips).toBe(3);
  });
});
