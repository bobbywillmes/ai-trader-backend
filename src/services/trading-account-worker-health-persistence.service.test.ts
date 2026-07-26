import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  accountFindUnique: vi.fn(),
  createSystemEvent: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccountWorkerHealthState: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      upsert: mocks.upsert,
    },
    tradingAccount: {
      findUnique: mocks.accountFindUnique,
    },
  },
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

import {
  recordTradingAccountWorkflowLockContention,
  startTradingAccountWorkerRun,
} from './trading-account-worker-health.service.js';

describe('startTradingAccountWorkerRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({});
    mocks.upsert.mockResolvedValue({ consecutiveFailures: 1 });
    mocks.createSystemEvent.mockResolvedValue({});
    mocks.accountFindUnique.mockResolvedValue(null);
  });

  it('accounts for an interrupted previous process before replacing its run marker', async () => {
    const previousRunStartedAt = new Date('2026-07-26T20:00:00.000Z');
    const startedAt = new Date('2026-07-26T20:01:00.000Z');
    mocks.findUnique.mockResolvedValue({
      id: 91,
      processInstanceId: 'previous-process',
      currentRunStartedAt: previousRunStartedAt,
    });

    await startTradingAccountWorkerRun({
      tradingAccountId: 7,
      workerKey: 'broker_activity_sync',
      processInstanceId: 'next-process',
      startedAt,
    });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 91 },
      data: expect.objectContaining({
        currentRunStartedAt: null,
        lastErrorCode: 'INTERRUPTED_PREVIOUS_PROCESS',
        consecutiveFailures: { increment: 1 },
        totalFailures: { increment: 1 },
      }),
    });
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'account_worker_health.interrupted',
      tradingAccountId: 7,
      payloadJson: expect.objectContaining({
        previousProcessInstanceId: 'previous-process',
        nextProcessInstanceId: 'next-process',
        previousRunStartedAt,
      }),
    }));
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        processInstanceId: 'next-process',
        currentRunStartedAt: startedAt,
      }),
    }));
    expect(mocks.update.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.upsert.mock.invocationCallOrder[0]!);
  });

  it('updates only contention evidence when an owner run is active', async () => {
    const ownerStartedAt = new Date('2026-07-26T20:00:00.000Z');
    const attemptedAt = new Date('2026-07-26T20:00:01.000Z');
    const previous = {
      id: 92,
      tradingAccountId: 7,
      workerKey: 'broker_activity_sync',
      processInstanceId: 'owner-process',
      applicable: true,
      eligible: true,
      currentRunStartedAt: ownerStartedAt,
      lastTickStartedAt: ownerStartedAt,
      lastTickCompletedAt: null,
      lastSucceededAt: null,
      lastFailedAt: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      lastLockSkippedAt: null,
      totalLockSkips: 0,
      createdAt: ownerStartedAt,
      lastError: null,
      lastSkipReason: null,
    };
    mocks.findUnique.mockResolvedValue(previous);
    mocks.upsert.mockResolvedValue({
      ...previous,
      totalRuns: 2,
      totalSkips: 1,
      totalLockSkips: 1,
      lastLockSkippedAt: attemptedAt,
      lastSkipReason: 'lock_skipped',
    });

    await recordTradingAccountWorkflowLockContention({
      tradingAccountId: 7,
      workerKey: 'broker_activity_sync',
      contenderProcessInstanceId: 'contender-process',
      lockFamily: 'broker-activity',
      attemptedAt,
    });

    const update = mocks.upsert.mock.calls[0]![0].update;
    expect(update).toEqual({
      lastSkipReason: 'lock_skipped',
      totalRuns: { increment: 1 },
      totalSkips: { increment: 1 },
      totalLockSkips: { increment: 1 },
      lastLockSkippedAt: attemptedAt,
      lastSummaryJson: {
        reason: 'lock_not_acquired',
        lockFamily: 'broker-activity',
        contenderProcessInstanceId: 'contender-process',
        attemptedAt: attemptedAt.toISOString(),
      },
    });
    expect(update).not.toHaveProperty('processInstanceId');
    expect(update).not.toHaveProperty('currentRunStartedAt');
    expect(update).not.toHaveProperty('lastTickStartedAt');
    expect(update).not.toHaveProperty('lastTickCompletedAt');
    expect(update).not.toHaveProperty('consecutiveFailures');
    expect(update).not.toHaveProperty('backoffUntil');
  });

  it('creates a minimal non-owner health row for first contention', async () => {
    const attemptedAt = new Date('2026-07-26T20:00:01.000Z');
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({
      tradingAccountId: 8,
      workerKey: 'exit_evaluation',
      processInstanceId: 'lock-contention:no-owner',
      applicable: true,
      eligible: true,
      currentRunStartedAt: null,
      lastSucceededAt: null,
      lastFailedAt: null,
      consecutiveFailures: 0,
      backoffUntil: null,
      lastLockSkippedAt: attemptedAt,
      totalLockSkips: 1,
      createdAt: attemptedAt,
      lastError: null,
      lastSkipReason: 'lock_skipped',
    });

    await recordTradingAccountWorkflowLockContention({
      tradingAccountId: 8,
      workerKey: 'exit_evaluation',
      contenderProcessInstanceId: 'contender-process',
      lockFamily: 'exit-evaluation',
      attemptedAt,
    });

    expect(mocks.upsert.mock.calls[0]![0].create).toMatchObject({
      processInstanceId: 'lock-contention:no-owner',
      currentRunStartedAt: null,
      lastOutcome: 'lock_skipped',
      totalLockSkips: 1,
      lastSummaryJson: {
        contenderProcessInstanceId: 'contender-process',
      },
    });
    expect(mocks.upsert.mock.calls[0]![0].create).not.toHaveProperty('totalFailures');
    expect(mocks.upsert.mock.calls[0]![0].create)
      .not.toHaveProperty('consecutiveFailures');
  });
});
