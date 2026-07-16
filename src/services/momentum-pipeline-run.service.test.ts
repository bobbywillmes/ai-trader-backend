import {
  MomentumPipelineRunSource,
  MomentumPipelineRunStatus,
  MomentumPipelineStage,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    momentumPipelineRun: {
      create: mocks.create,
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      update: mocks.update,
      count: mocks.count,
      findMany: mocks.findMany,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  completeMomentumPipelineRun,
  failMomentumPipelineRun,
  getLatestMomentumPipelineRuns,
  recordMomentumPipelineStage,
  serializeMomentumPipelineRun,
  startMomentumPipelineRun,
} from './momentum-pipeline-run.service.js';

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    source: MomentumPipelineRunSource.N8N_SCHEDULED,
    status: MomentumPipelineRunStatus.RUNNING,
    startedAt: new Date('2026-07-16T14:00:00.000Z'),
    completedAt: null,
    currentStage: null,
    errorStage: null,
    errorCode: null,
    errorMessage: null,
    newsResult: null,
    expirationResult: null,
    candidateResult: null,
    priceResult: null,
    handoffResult: null,
    deliveryResult: null,
    metadata: null,
    createdAt: new Date('2026-07-16T14:00:00.000Z'),
    updatedAt: new Date('2026-07-16T14:00:00.000Z'),
    ...overrides,
  };
}

describe('momentum pipeline run service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation(({ data }) => Promise.resolve(run(data)));
    mocks.findUnique.mockResolvedValue(run());
    mocks.update.mockImplementation(({ data }) => Promise.resolve(run(data)));
  });

  it('starts a run with bounded metadata and no secrets added by the service', async () => {
    const result = await startMomentumPipelineRun({
      source: MomentumPipelineRunSource.N8N_MANUAL,
      metadata: { workflowName: 'Momentum Scanner', executionId: 12n },
      now: new Date('2026-07-16T14:00:00.000Z'),
    });
    expect(result.status).toBe(MomentumPipelineRunStatus.RUNNING);
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      metadata: { workflowName: 'Momentum Scanner', executionId: '12' },
    }) });
  });

  it('records a bounded stage summary while the run is active', async () => {
    await recordMomentumPipelineStage({
      runId: 'run-1',
      stage: MomentumPipelineStage.EXPIRATION,
      status: 'SUCCEEDED',
      result: { expired: 2, ids: [1n] },
      now: new Date('2026-07-16T14:01:00.000Z'),
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        currentStage: MomentumPipelineStage.EXPIRATION,
        expirationResult: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    });
  });

  it('requires every decision-pipeline stage before successful completion', async () => {
    await expect(completeMomentumPipelineRun({ runId: 'run-1' })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('completes idempotently when already in the requested terminal state', async () => {
    mocks.findUnique.mockResolvedValue(run({ status: MomentumPipelineRunStatus.SUCCEEDED }));
    await expect(completeMomentumPipelineRun({ runId: 'run-1' })).resolves.toMatchObject({
      status: MomentumPipelineRunStatus.SUCCEEDED,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('stores safe failure details and rejects late stage updates', async () => {
    await failMomentumPipelineRun({
      runId: 'run-1',
      stage: MomentumPipelineStage.PRICE_CONFIRMATION,
      errorCode: 'PROVIDER_ERROR',
      errorMessage: 'Provider failed\nwithout stack',
    });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: MomentumPipelineRunStatus.FAILED,
        errorMessage: 'Provider failed without stack',
      }),
    }));

    mocks.findUnique.mockResolvedValue(run({ status: MomentumPipelineRunStatus.FAILED }));
    await expect(recordMomentumPipelineStage({
      runId: 'run-1',
      stage: MomentumPipelineStage.HANDOFF_PREPARATION,
      status: 'SUCCEEDED',
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('interprets an old running row as abandoned and excludes it from current run', async () => {
    const stale = run({ startedAt: new Date('2026-07-16T12:00:00.000Z') });
    expect(serializeMomentumPipelineRun(stale, new Date('2026-07-16T14:00:00.000Z'))).toMatchObject({
      status: MomentumPipelineRunStatus.ABANDONED,
      durationMs: null,
    });
    mocks.findFirst
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stale);
    await expect(getLatestMomentumPipelineRuns(new Date('2026-07-16T14:00:00.000Z'))).resolves.toMatchObject({
      latestAttempt: { status: MomentumPipelineRunStatus.ABANDONED },
      latestSuccessful: null,
      currentRun: null,
    });
  });
});
