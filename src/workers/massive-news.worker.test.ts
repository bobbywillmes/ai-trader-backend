import { CatalystSource } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureMassiveNewsPullCursors: vi.fn(),
  listDueNewsPullCursors: vi.fn(),
  fetchMassiveNews: vi.fn(),
  ingestMassiveNewsPayload: vi.fn(),
  recordNewsPullCursorSuccess: vi.fn(),
  recordNewsPullCursorError: vi.fn(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  env: {
    MASSIVE_NEWS_WORKER_ENABLED: false,
    MASSIVE_NEWS_LOOKBACK_MINUTES: 240,
    MASSIVE_NEWS_LIMIT_PER_SYMBOL: 50,
    MASSIVE_NEWS_MAX_SYMBOLS_PER_RUN: 2,
  },
}));

vi.mock('../services/news-pull-cursor.service.js', () => ({
  ensureMassiveNewsPullCursors: mocks.ensureMassiveNewsPullCursors,
  getNewestPublishedAtFromMassiveNewsPayload: (payload: { results?: unknown }) => {
    if (!Array.isArray(payload.results)) {
      return null;
    }

    const newest = payload.results
      .flatMap((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          return [];
        }

        const raw = 'published_utc' in item ? item.published_utc : null;
        const date = typeof raw === 'string' ? new Date(raw) : null;

        return date && !Number.isNaN(date.getTime()) ? [date] : [];
      })
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return newest ?? null;
  },
  listDueNewsPullCursors: mocks.listDueNewsPullCursors,
  recordNewsPullCursorError: mocks.recordNewsPullCursorError,
  recordNewsPullCursorSuccess: mocks.recordNewsPullCursorSuccess,
}));

vi.mock('../services/massive-news.service.js', () => ({
  fetchMassiveNews: mocks.fetchMassiveNews,
}));

vi.mock('../services/catalyst-news-ingestion.service.js', () => ({
  ingestMassiveNewsPayload: mocks.ingestMassiveNewsPayload,
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    debug: mocks.loggerDebug,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import { runMassiveNewsWorkerOnce } from './massive-news.worker.js';

function cursor(overrides: Record<string, unknown>) {
  return {
    id: 'cursor-1',
    source: CatalystSource.MASSIVE_NEWS,
    symbol: 'AAPL',
    enabled: true,
    priority: 0,
    pullIntervalMin: 15,
    lastPulledAt: null,
    lastPublishedAt: null,
    lastSourceCursor: null,
    consecutiveErrors: 0,
    lastError: null,
    metadata: null,
    createdAt: new Date('2026-07-04T00:00:00Z'),
    updatedAt: new Date('2026-07-04T00:00:00Z'),
    ...overrides,
  };
}

describe('runMassiveNewsWorkerOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureMassiveNewsPullCursors.mockResolvedValue({
      ensured: 15,
      symbols: ['AAPL'],
    });
    mocks.listDueNewsPullCursors.mockResolvedValue([]);
    mocks.fetchMassiveNews.mockResolvedValue({ results: [] });
    mocks.ingestMassiveNewsPayload.mockResolvedValue({
      processedArticles: 0,
      skippedArticles: 0,
      upsertedEvents: 0,
      upsertedTickerImpacts: 0,
    });
    mocks.recordNewsPullCursorSuccess.mockResolvedValue({});
    mocks.recordNewsPullCursorError.mockResolvedValue({});
  });

  it('skips without touching cursors when disabled', async () => {
    await expect(runMassiveNewsWorkerOnce()).resolves.toEqual({
      skipped: true,
      reason: 'disabled',
    });

    expect(mocks.ensureMassiveNewsPullCursors).not.toHaveBeenCalled();
    expect(mocks.fetchMassiveNews).not.toHaveBeenCalled();
  });

  it('pulls only the configured max due cursors per run', async () => {
    const now = new Date('2026-07-04T16:00:00Z');

    mocks.listDueNewsPullCursors.mockResolvedValue([
      cursor({ symbol: 'AAPL' }),
      cursor({ symbol: 'MSFT' }),
    ]);

    await expect(
      runMassiveNewsWorkerOnce({
        enabled: true,
        now,
      })
    ).resolves.toMatchObject({
      skipped: false,
      pulledSymbols: 2,
      successfulSymbols: 2,
    });

    expect(mocks.listDueNewsPullCursors).toHaveBeenCalledWith({
      source: CatalystSource.MASSIVE_NEWS,
      now,
      take: 2,
    });
    expect(mocks.fetchMassiveNews).toHaveBeenCalledTimes(2);
  });

  it('uses cursor lastPublishedAt when available', async () => {
    const now = new Date('2026-07-04T16:00:00Z');
    const lastPublishedAt = new Date('2026-07-04T15:30:00Z');

    mocks.listDueNewsPullCursors.mockResolvedValue([
      cursor({
        symbol: 'NVDA',
        lastPublishedAt,
      }),
    ]);

    await runMassiveNewsWorkerOnce({
      enabled: true,
      now,
    });

    expect(mocks.fetchMassiveNews).toHaveBeenCalledWith({
      ticker: 'NVDA',
      sincePublishedAt: lastPublishedAt,
      limit: 50,
    });
  });

  it('uses fallback lookback when cursor lastPublishedAt is null', async () => {
    const now = new Date('2026-07-04T16:00:00Z');

    mocks.listDueNewsPullCursors.mockResolvedValue([
      cursor({
        symbol: 'AMD',
        lastPublishedAt: null,
      }),
    ]);

    await runMassiveNewsWorkerOnce({
      enabled: true,
      now,
    });

    expect(mocks.fetchMassiveNews).toHaveBeenCalledWith({
      ticker: 'AMD',
      sincePublishedAt: new Date('2026-07-04T12:00:00Z'),
      limit: 50,
    });
  });

  it('ingests returned payloads and records cursor success with newest article timestamp', async () => {
    const now = new Date('2026-07-04T16:00:00Z');
    const payload = {
      results: [
        {
          id: 'article-1',
          published_utc: '2026-07-04T15:45:00Z',
        },
      ],
    };

    mocks.listDueNewsPullCursors.mockResolvedValue([
      cursor({
        symbol: 'AAPL',
      }),
    ]);
    mocks.fetchMassiveNews.mockResolvedValue(payload);
    mocks.ingestMassiveNewsPayload.mockResolvedValue({
      processedArticles: 1,
      skippedArticles: 0,
      upsertedEvents: 1,
      upsertedTickerImpacts: 1,
    });

    await expect(
      runMassiveNewsWorkerOnce({
        enabled: true,
        now,
      })
    ).resolves.toMatchObject({
      articlesReturned: 1,
      processedArticles: 1,
      upsertedEvents: 1,
      upsertedTickerImpacts: 1,
    });

    expect(mocks.ingestMassiveNewsPayload).toHaveBeenCalledWith(payload);
    expect(mocks.recordNewsPullCursorSuccess).toHaveBeenCalledWith({
      source: CatalystSource.MASSIVE_NEWS,
      symbol: 'AAPL',
      pulledAt: now,
      newestPublishedAt: new Date('2026-07-04T15:45:00Z'),
    });
  });

  it('records cursor errors and continues pulling later symbols', async () => {
    const now = new Date('2026-07-04T16:00:00Z');
    const error = new Error('Massive unavailable');

    mocks.listDueNewsPullCursors.mockResolvedValue([
      cursor({ symbol: 'AAPL' }),
      cursor({ symbol: 'MSFT' }),
    ]);
    mocks.fetchMassiveNews
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ results: [] });

    await expect(
      runMassiveNewsWorkerOnce({
        enabled: true,
        now,
      })
    ).resolves.toMatchObject({
      pulledSymbols: 2,
      successfulSymbols: 1,
      failedSymbols: 1,
    });

    expect(mocks.recordNewsPullCursorError).toHaveBeenCalledWith({
      source: CatalystSource.MASSIVE_NEWS,
      symbol: 'AAPL',
      error,
    });
    expect(mocks.recordNewsPullCursorSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'MSFT',
      })
    );
  });
});
