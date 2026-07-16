import {
  MomentumPipelineRunSource,
  MomentumPipelineRunStatus,
  MomentumPipelineStage,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  news: vi.fn(),
  expire: vi.fn(),
  generate: vi.fn(),
  confirm: vi.fn(),
  prepare: vi.fn(),
  start: vi.fn(),
  record: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));

vi.mock('../workers/massive-news.worker.js', () => ({ runMassiveNewsWorkerOnce: mocks.news }));
vi.mock('./momentum-candidate-expiration.service.js', () => ({ expireStaleMomentumCandidates: mocks.expire }));
vi.mock('./momentum-candidates.service.js', () => ({ generateMomentumCandidatesFromCatalysts: mocks.generate }));
vi.mock('./momentum-price-confirmation.service.js', () => ({ confirmActiveCandidates: mocks.confirm }));
vi.mock('./momentum-scanner-handoff.service.js', () => ({ prepareReadyMomentumScannerHandoffs: mocks.prepare }));
vi.mock('./momentum-pipeline-run.service.js', () => ({
  startMomentumPipelineRun: mocks.start,
  recordMomentumPipelineStage: mocks.record,
  completeMomentumPipelineRun: mocks.complete,
  failMomentumPipelineRun: mocks.fail,
}));

import { runFullMomentumPipeline } from './momentum-pipeline-orchestrator.service.js';

const now = new Date('2026-07-16T14:00:00.000Z');

describe('momentum pipeline orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.start.mockResolvedValue({ id: 'run-1', status: 'RUNNING', startedAt: now });
    mocks.record.mockResolvedValue({ id: 'run-1' });
    mocks.complete.mockResolvedValue({ id: 'run-1', completedAt: now });
    mocks.fail.mockResolvedValue({ id: 'run-1', completedAt: now });
    mocks.news.mockResolvedValue({
      skipped: false, seededCursors: 1, dueCursorCount: 1, pulledSymbols: 1,
      successfulSymbols: 1, failedSymbols: 0, articlesReturned: 2,
      processedArticles: 2, skippedArticles: 0, upsertedEvents: 2,
      upsertedTickerImpacts: 2,
    });
    mocks.expire.mockResolvedValue({
      inspected: 2, expired: 1, unchanged: 1, skipped: 0, staleRemaining: 0,
      expiredCandidateIds: ['old'], expiredCandidateIdsTruncated: false,
      reasonCounts: { EXPIRES_AT_REACHED: 1 }, asOf: now,
    });
    mocks.generate.mockResolvedValue({
      evaluatedImpacts: 2, generatedCandidates: 1, skippedCandidates: 1,
      skipCounts: { DUPLICATE_ACTIVE_CANDIDATE: 1 }, skippedImpacts: [],
      minCatalystScore: 60, recentSince: now, expiresAt: now, candidates: [],
    });
    mocks.confirm.mockResolvedValue({
      evaluated: 1, entryReady: 1, watching: 0, blocked: 0, skipped: 0,
      skipCounts: {}, errors: [], results: [],
    });
    mocks.prepare.mockResolvedValue({
      prepared: 1, skipped: 0, handoffs: [], skipCounts: {}, skippedReasons: [],
    });
  });

  it('creates and completes a full run in the required stage order', async () => {
    const result = await runFullMomentumPipeline({
      source: MomentumPipelineRunSource.ADMIN_MANUAL,
      now,
      metadata: { requestedBy: 'owner' },
    });

    expect(result).toMatchObject({ runId: 'run-1', status: MomentumPipelineRunStatus.SUCCEEDED });
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      source: MomentumPipelineRunSource.ADMIN_MANUAL,
      metadata: expect.objectContaining({ orchestration: 'BACKEND_FULL_RUN_V1' }),
    }));
    expect(mocks.record.mock.calls.map(([call]) => call.stage)).toEqual([
      MomentumPipelineStage.NEWS,
      MomentumPipelineStage.EXPIRATION,
      MomentumPipelineStage.CANDIDATE_GENERATION,
      MomentumPipelineStage.PRICE_CONFIRMATION,
      MomentumPipelineStage.HANDOFF_PREPARATION,
    ]);
    expect(mocks.complete).toHaveBeenCalledWith({ runId: 'run-1', status: 'SUCCEEDED' });
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it('completes as partial when recoverable stage results contain failures', async () => {
    mocks.news.mockResolvedValue({
      skipped: false, seededCursors: 1, dueCursorCount: 2, pulledSymbols: 2,
      successfulSymbols: 1, failedSymbols: 1, articlesReturned: 1,
      processedArticles: 1, skippedArticles: 0, upsertedEvents: 1,
      upsertedTickerImpacts: 1,
    });
    mocks.confirm.mockResolvedValue({
      evaluated: 1, entryReady: 0, watching: 1, blocked: 0, skipped: 0,
      skipCounts: {}, errors: [{ candidateId: 'c1', symbol: 'AAPL', message: 'provider failed' }],
      results: [],
    });

    await expect(runFullMomentumPipeline({
      source: MomentumPipelineRunSource.N8N_MANUAL,
      now,
    })).resolves.toMatchObject({ status: MomentumPipelineRunStatus.PARTIAL });
    expect(mocks.complete).toHaveBeenCalledWith({ runId: 'run-1', status: 'PARTIAL' });
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });

  it('records the failed stage and preserves completed stage summaries', async () => {
    mocks.generate.mockRejectedValue(new Error('candidate database unavailable'));

    const result = await runFullMomentumPipeline({
      source: MomentumPipelineRunSource.N8N_SCHEDULED,
      now,
    });

    expect(result).toMatchObject({
      runId: 'run-1',
      status: MomentumPipelineRunStatus.FAILED,
      failedStage: MomentumPipelineStage.CANDIDATE_GENERATION,
      errorCode: 'PIPELINE_STAGE_ERROR',
      errorMessage: 'candidate database unavailable',
      stages: expect.objectContaining({
        NEWS: expect.any(Object),
        EXPIRATION: expect.any(Object),
        CANDIDATE_GENERATION: expect.objectContaining({ failed: true }),
      }),
    });
    expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: MomentumPipelineStage.CANDIDATE_GENERATION,
      status: 'FAILED',
    }));
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      stage: MomentumPipelineStage.CANDIDATE_GENERATION,
    }));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
