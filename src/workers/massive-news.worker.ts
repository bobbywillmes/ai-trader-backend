import { CatalystSource } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ingestMassiveNewsPayload } from '../services/catalyst-news-ingestion.service.js';
import { fetchMassiveNews } from '../services/massive-news.service.js';
import {
  ensureMassiveNewsPullCursors,
  getNewestPublishedAtFromMassiveNewsPayload,
  listDueNewsPullCursors,
  recordNewsPullCursorError,
  recordNewsPullCursorSuccess,
} from '../services/news-pull-cursor.service.js';

let running = false;

export type RunMassiveNewsWorkerOnceOptions = {
  enabled?: boolean;
  now?: Date;
};

export type MassiveNewsWorkerRunResult = {
  skipped: false;
  seededCursors: number;
  dueCursorCount: number;
  pulledSymbols: number;
  successfulSymbols: number;
  failedSymbols: number;
  articlesReturned: number;
  processedArticles: number;
  skippedArticles: number;
  upsertedEvents: number;
  upsertedTickerImpacts: number;
};

function subtractMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() - Math.max(1, minutes) * 60_000);
}

function getSincePublishedAt(cursor: { lastPublishedAt: Date | null }, now: Date) {
  return cursor.lastPublishedAt ?? subtractMinutes(now, env.MASSIVE_NEWS_LOOKBACK_MINUTES);
}

function getArticleCount(payload: { results?: unknown }) {
  return Array.isArray(payload.results) ? payload.results.length : 0;
}

export async function runMassiveNewsWorkerOnce(
  options: RunMassiveNewsWorkerOnceOptions = {}
) {
  if (running) {
    logger.debug('Massive news worker tick skipped because previous tick is still running.');

    return {
      skipped: true as const,
      reason: 'already_running' as const,
    };
  }

  const enabled = options.enabled ?? env.MASSIVE_NEWS_WORKER_ENABLED;

  if (!enabled) {
    logger.debug('Massive news worker tick skipped because worker is disabled.');

    return {
      skipped: true as const,
      reason: 'disabled' as const,
    };
  }

  running = true;

  try {
    const now = options.now ?? new Date();
    const seeded = await ensureMassiveNewsPullCursors();
    const dueCursors = await listDueNewsPullCursors({
      source: CatalystSource.MASSIVE_NEWS,
      now,
      take: env.MASSIVE_NEWS_MAX_SYMBOLS_PER_RUN,
    });
    const summary: MassiveNewsWorkerRunResult = {
      skipped: false,
      seededCursors: seeded.ensured,
      dueCursorCount: dueCursors.length,
      pulledSymbols: 0,
      successfulSymbols: 0,
      failedSymbols: 0,
      articlesReturned: 0,
      processedArticles: 0,
      skippedArticles: 0,
      upsertedEvents: 0,
      upsertedTickerImpacts: 0,
    };

    logger.info(
      {
        seededCursors: seeded.ensured,
        dueCursorCount: dueCursors.length,
        maxSymbolsPerRun: env.MASSIVE_NEWS_MAX_SYMBOLS_PER_RUN,
      },
      'Massive news worker run started.'
    );

    for (const cursor of dueCursors) {
      const sincePublishedAt = getSincePublishedAt(cursor, now);

      summary.pulledSymbols += 1;

      try {
        const payload = await fetchMassiveNews({
          ticker: cursor.symbol,
          sincePublishedAt,
          limit: env.MASSIVE_NEWS_LIMIT_PER_SYMBOL,
        });
        const articlesReturned = getArticleCount(payload);
        const ingestResult = await ingestMassiveNewsPayload(payload);
        const newestPublishedAt =
          getNewestPublishedAtFromMassiveNewsPayload(payload);

        await recordNewsPullCursorSuccess({
          source: CatalystSource.MASSIVE_NEWS,
          symbol: cursor.symbol,
          pulledAt: now,
          newestPublishedAt,
        });

        summary.successfulSymbols += 1;
        summary.articlesReturned += articlesReturned;
        summary.processedArticles += ingestResult.processedArticles;
        summary.skippedArticles += ingestResult.skippedArticles;
        summary.upsertedEvents += ingestResult.upsertedEvents;
        summary.upsertedTickerImpacts += ingestResult.upsertedTickerImpacts;

        logger.info(
          {
            symbol: cursor.symbol,
            sincePublishedAt: sincePublishedAt.toISOString(),
            articlesReturned,
            processedArticles: ingestResult.processedArticles,
            skippedArticles: ingestResult.skippedArticles,
            upsertedEvents: ingestResult.upsertedEvents,
            upsertedTickerImpacts: ingestResult.upsertedTickerImpacts,
            newestPublishedAt: newestPublishedAt?.toISOString() ?? null,
          },
          'Massive news symbol pull completed.'
        );
      } catch (error) {
        summary.failedSymbols += 1;

        await recordNewsPullCursorError({
          source: CatalystSource.MASSIVE_NEWS,
          symbol: cursor.symbol,
          error,
        });

        logger.warn(
          {
            error,
            symbol: cursor.symbol,
            sincePublishedAt: sincePublishedAt.toISOString(),
          },
          'Massive news symbol pull failed.'
        );
      }
    }

    logger.info(summary, 'Massive news worker run completed.');

    return summary;
  } catch (error) {
    logger.error({ error }, 'Massive news worker error.');
    throw error;
  } finally {
    running = false;
  }
}
