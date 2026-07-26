import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  healthFind: vi.fn(),
  startRun: vi.fn(),
  recordAttempt: vi.fn(),
  withLock: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccountWorkerHealthState: {
      findUnique: mocks.healthFind,
    },
  },
}));

vi.mock('./trading-account-worker-health.service.js', () => ({
  startTradingAccountWorkerRun: mocks.startRun,
  recordTradingAccountWorkerAttempt: mocks.recordAttempt,
}));

vi.mock('./trading-account-workflow-lock.service.js', () => ({
  withTradingAccountWorkflowLock: mocks.withLock,
}));

import { runTradingAccountWorkflow } from './trading-account-workflow-runner.service.js';

describe('runTradingAccountWorkflow durable ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.healthFind.mockResolvedValue({ backoffUntil: null });
    mocks.startRun.mockResolvedValue({ consecutiveFailures: 0 });
    mocks.recordAttempt.mockResolvedValue({});
    mocks.withLock.mockImplementation(async (args: { execute: () => Promise<unknown> }) => ({
      outcome: 'ACQUIRED_AND_COMPLETED',
      value: await args.execute(),
    }));
  });

  it('uses locking and durable health persistence in the test environment', async () => {
    const execute = vi.fn().mockResolvedValue({ processed: 1 });

    const result = await runTradingAccountWorkflow({
      tradingAccountId: 41,
      workerKey: 'pending_order_processing',
      lockFamily: 'order-lifecycle',
      execute,
    });

    expect(result).toMatchObject({ outcome: 'PROCESSED', value: { processed: 1 } });
    expect(mocks.withLock).toHaveBeenCalledOnce();
    expect(mocks.startRun).toHaveBeenCalledOnce();
    expect(mocks.startRun.mock.invocationCallOrder[0])
      .toBeLessThan(execute.mock.invocationCallOrder[0]!);
  });

  it('persists a classified item failure before the advisory lock is released', async () => {
    let finalHealthWasPersistedBeforeRelease = false;
    mocks.withLock.mockImplementation(async (args: { execute: () => Promise<unknown> }) => {
      const value = await args.execute();
      finalHealthWasPersistedBeforeRelease = mocks.recordAttempt.mock.calls.some(
        ([attempt]) => attempt.outcome === 'failure'
      );
      return { outcome: 'ACQUIRED_AND_COMPLETED', value };
    });

    const result = await runTradingAccountWorkflow({
      tradingAccountId: 42,
      workerKey: 'tracked_position_sync',
      lockFamily: 'position-sync',
      execute: async () => ({ symbolErrors: [{ symbol: 'DIA', error: 'mock failure' }] }),
      classify: (value) => ({
        outcome: 'failure',
        error: new Error(value.symbolErrors[0]!.error),
        errorCode: 'TRACKED_POSITION_ITEM_FAILURE',
        summary: value,
      }),
    });

    expect(result).toMatchObject({
      outcome: 'FAILED',
      value: { symbolErrors: [{ symbol: 'DIA', error: 'mock failure' }] },
    });
    expect(finalHealthWasPersistedBeforeRelease).toBe(true);
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
      errorCode: 'TRACKED_POSITION_ITEM_FAILURE',
      backoffUntil: expect.any(Date),
    }));
  });

  it('does not execute or create an active marker during persisted backoff', async () => {
    const backoffUntil = new Date(Date.now() + 30_000);
    mocks.healthFind.mockResolvedValue({ backoffUntil });
    const execute = vi.fn();

    const result = await runTradingAccountWorkflow({
      tradingAccountId: 43,
      workerKey: 'exit_evaluation',
      lockFamily: 'exit-evaluation',
      execute,
    });

    expect(result).toEqual({ outcome: 'BACKING_OFF', backoffUntil });
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'backoff_skipped',
      backoffUntil,
    }));
  });
});
