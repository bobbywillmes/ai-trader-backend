import {
  MomentumPipelineRunSource,
  MomentumPipelineRunStatus,
  MomentumPipelineStage,
} from '@prisma/client';

import { runMassiveNewsWorkerOnce } from '../workers/massive-news.worker.js';
import { expireStaleMomentumCandidates } from './momentum-candidate-expiration.service.js';
import { generateMomentumCandidatesFromCatalysts } from './momentum-candidates.service.js';
import {
  completeMomentumPipelineRun,
  failMomentumPipelineRun,
  recordMomentumPipelineStage,
  startMomentumPipelineRun,
} from './momentum-pipeline-run.service.js';
import { confirmActiveCandidates } from './momentum-price-confirmation.service.js';
import { prepareReadyMomentumScannerHandoffs } from './momentum-scanner-handoff.service.js';

export type FullMomentumPipelineOptions = {
  source: MomentumPipelineRunSource;
  metadata?: Record<string, unknown> | undefined;
  now?: Date | undefined;
  expirationLimit?: number | undefined;
  minCatalystScore?: number | undefined;
  candidateTake?: number | undefined;
  expiresInHours?: number | undefined;
  maxCandidates?: number | undefined;
  minHandoffScore?: number | undefined;
};

type StageSummary = Record<string, unknown>;

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown pipeline stage failure.';
  return {
    errorCode: error instanceof Error && error.name !== 'Error'
      ? error.name.replace(/[^A-Za-z0-9_]+/g, '_').toUpperCase().slice(0, 100)
      : 'PIPELINE_STAGE_ERROR',
    errorMessage: message.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1_000),
  };
}

function newsSummary(result: Awaited<ReturnType<typeof runMassiveNewsWorkerOnce>>) {
  return result.skipped
    ? { skipped: true, reason: result.reason }
    : {
        skipped: false,
        pulledSymbols: result.pulledSymbols,
        successfulSymbols: result.successfulSymbols,
        failedSymbols: result.failedSymbols,
        articlesReturned: result.articlesReturned,
        processedArticles: result.processedArticles,
        upsertedEvents: result.upsertedEvents,
        upsertedTickerImpacts: result.upsertedTickerImpacts,
      };
}

export async function runFullMomentumPipeline(options: FullMomentumPipelineOptions) {
  const now = options.now ?? new Date();
  const run = await startMomentumPipelineRun({
    source: options.source,
    now,
    metadata: {
      ...(options.metadata ?? {}),
      orchestration: 'BACKEND_FULL_RUN_V1',
      deliveryIncluded: false,
    },
  });
  const stages: Partial<Record<MomentumPipelineStage, StageSummary>> = {};
  let currentStage: MomentumPipelineStage = MomentumPipelineStage.NEWS;
  let partial = false;

  async function record(stage: MomentumPipelineStage, summary: StageSummary) {
    stages[stage] = summary;
    await recordMomentumPipelineStage({
      runId: run.id,
      stage,
      status: 'SUCCEEDED',
      result: summary,
    });
  }

  try {
    const news = await runMassiveNewsWorkerOnce({ enabled: true, now });
    const summarizedNews = newsSummary(news);
    partial ||= news.skipped || (!news.skipped && news.failedSymbols > 0);
    await record(currentStage, summarizedNews);

    currentStage = MomentumPipelineStage.EXPIRATION;
    const expiration = await expireStaleMomentumCandidates({
      now,
      ...(options.expirationLimit === undefined ? {} : { limit: options.expirationLimit }),
    });
    partial ||= expiration.staleRemaining > 0;
    await record(currentStage, {
      inspected: expiration.inspected,
      expired: expiration.expired,
      unchanged: expiration.unchanged,
      skipped: expiration.skipped,
      staleRemaining: expiration.staleRemaining,
      reasonCounts: expiration.reasonCounts,
    });

    currentStage = MomentumPipelineStage.CANDIDATE_GENERATION;
    const candidates = await generateMomentumCandidatesFromCatalysts({
      now,
      ...(options.minCatalystScore === undefined ? {} : { minCatalystScore: options.minCatalystScore }),
      ...(options.candidateTake === undefined ? {} : { take: options.candidateTake }),
      ...(options.expiresInHours === undefined ? {} : { expiresInHours: options.expiresInHours }),
    });
    await record(currentStage, {
      impactsEvaluated: candidates.evaluatedImpacts,
      created: candidates.generatedCandidates,
      skipped: candidates.skippedCandidates,
      skipCounts: candidates.skipCounts,
    });

    currentStage = MomentumPipelineStage.PRICE_CONFIRMATION;
    const price = await confirmActiveCandidates({
      now,
      ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }),
    });
    partial ||= price.errors.length > 0;
    await record(currentStage, {
      evaluated: price.evaluated,
      watching: price.watching,
      entryReady: price.entryReady,
      blocked: price.blocked,
      skipped: price.skipped,
      skipCounts: price.skipCounts,
      errors: price.errors.length,
    });

    currentStage = MomentumPipelineStage.HANDOFF_PREPARATION;
    const handoffs = await prepareReadyMomentumScannerHandoffs({
      now,
      ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }),
      ...(options.minHandoffScore === undefined ? {} : { minScore: options.minHandoffScore }),
    });
    await record(currentStage, {
      prepared: handoffs.prepared,
      skipped: handoffs.skipped,
      skipCounts: handoffs.skipCounts,
    });

    const status = partial
      ? MomentumPipelineRunStatus.PARTIAL
      : MomentumPipelineRunStatus.SUCCEEDED;
    const completedRun = await completeMomentumPipelineRun({
      runId: run.id,
      status: partial ? 'PARTIAL' : 'SUCCEEDED',
    });

    return {
      runId: run.id,
      status,
      startedAt: run.startedAt,
      completedAt: completedRun.completedAt ?? new Date(),
      stages,
    };
  } catch (error) {
    const safe = safeError(error);
    stages[currentStage] = { failed: true, ...safe };
    try {
      await recordMomentumPipelineStage({
        runId: run.id,
        stage: currentStage,
        status: 'FAILED',
        result: stages[currentStage],
      });
    } catch {
      // The terminal failure record below remains authoritative.
    }
    const failedRun = await failMomentumPipelineRun({
      runId: run.id,
      stage: currentStage,
      ...safe,
    });
    return {
      runId: run.id,
      status: MomentumPipelineRunStatus.FAILED,
      startedAt: run.startedAt,
      completedAt: failedRun.completedAt ?? new Date(),
      failedStage: currentStage,
      ...safe,
      stages,
    };
  }
}
