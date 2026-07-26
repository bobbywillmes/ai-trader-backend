import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
  createSystemEvent: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccountWorkerHealthState: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      upsert: mocks.upsert,
    },
  },
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

import { startTradingAccountWorkerRun } from './trading-account-worker-health.service.js';

describe('startTradingAccountWorkerRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({});
    mocks.upsert.mockResolvedValue({ consecutiveFailures: 1 });
    mocks.createSystemEvent.mockResolvedValue({});
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
});
