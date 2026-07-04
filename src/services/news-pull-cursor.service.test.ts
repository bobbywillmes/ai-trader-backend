import { CatalystSource } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  newsPullCursorFindMany: vi.fn(),
  newsPullCursorUpdate: vi.fn(),
  newsPullCursorUpsert: vi.fn(),
  subscriptionFindMany: vi.fn(),
  trackedPositionFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    newsPullCursor: {
      findMany: mocks.newsPullCursorFindMany,
      update: mocks.newsPullCursorUpdate,
      upsert: mocks.newsPullCursorUpsert,
    },
    subscription: {
      findMany: mocks.subscriptionFindMany,
    },
    trackedPosition: {
      findMany: mocks.trackedPositionFindMany,
    },
  },
}));

import {
  ensureMassiveNewsPullCursors,
  ensureNewsPullCursors,
  getMassiveNewsSeedSymbols,
  getNewestPublishedAtFromMassiveNewsPayload,
  listDueNewsPullCursors,
  recordNewsPullCursorError,
  recordNewsPullCursorSuccess,
} from './news-pull-cursor.service.js';

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

describe('news pull cursor service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.newsPullCursorUpsert.mockResolvedValue({});
    mocks.newsPullCursorUpdate.mockResolvedValue({});
  });

  it('ensures initial Massive news cursors from static symbols, open positions, and active stock subscriptions', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      { symbol: 'qqq' },
      { symbol: 'AAPL' },
    ]);
    mocks.subscriptionFindMany.mockResolvedValue([
      { symbol: 'crm' },
      { symbol: 'NVDA' },
    ]);

    await expect(ensureMassiveNewsPullCursors()).resolves.toMatchObject({
      source: CatalystSource.MASSIVE_NEWS,
      symbols: expect.arrayContaining(['AAPL', 'CRM', 'NVDA', 'QQQ']),
    });

    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith({
      where: {
        status: {
          in: ['open', 'closing'],
        },
      },
      select: {
        symbol: true,
      },
    });
    expect(mocks.subscriptionFindMany).toHaveBeenCalledWith({
      where: {
        enabled: true,
        security: {
          assetType: 'STOCK',
        },
      },
      select: {
        symbol: true,
      },
    });
    expect(mocks.newsPullCursorUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          source_symbol: {
            source: CatalystSource.MASSIVE_NEWS,
            symbol: 'CRM',
          },
        },
        create: expect.objectContaining({
          enabled: true,
          priority: 0,
          pullIntervalMin: 15,
        }),
        update: {
          metadata: {
            seedUniverse: 'phase_2_massive_news_worker',
          },
        },
      })
    );
  });

  it('normalizes and dedupes explicit cursor symbols without re-enabling existing rows', async () => {
    await expect(
      ensureNewsPullCursors({
        source: CatalystSource.MASSIVE_NEWS,
        symbols: [' aapl ', 'AAPL', '', 'msft'],
        priority: 7,
        pullIntervalMin: 30,
      })
    ).resolves.toEqual({
      source: CatalystSource.MASSIVE_NEWS,
      ensured: 2,
      symbols: ['AAPL', 'MSFT'],
    });

    expect(mocks.newsPullCursorUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.newsPullCursorUpsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          symbol: 'AAPL',
          enabled: true,
          priority: 7,
          pullIntervalMin: 30,
        }),
        update: {},
      })
    );
  });

  it('selects due enabled cursors by priority descending and last pull nulls first', async () => {
    const now = new Date('2026-07-04T15:00:00Z');

    mocks.newsPullCursorFindMany.mockResolvedValue([
      cursor({
        symbol: 'LOW_PRIORITY_DUE',
        priority: 0,
        lastPulledAt: new Date('2026-07-04T14:00:00Z'),
        pullIntervalMin: 15,
      }),
      cursor({
        symbol: 'NOT_DUE',
        priority: 100,
        lastPulledAt: new Date('2026-07-04T14:55:00Z'),
        pullIntervalMin: 15,
      }),
      cursor({
        symbol: 'HIGH_PRIORITY_OLD',
        priority: 10,
        lastPulledAt: new Date('2026-07-04T13:00:00Z'),
        pullIntervalMin: 15,
      }),
      cursor({
        symbol: 'HIGH_PRIORITY_NEW',
        priority: 10,
        lastPulledAt: null,
        pullIntervalMin: 15,
      }),
    ]);

    await expect(
      listDueNewsPullCursors({
        source: CatalystSource.MASSIVE_NEWS,
        now,
      })
    ).resolves.toMatchObject([
      { symbol: 'HIGH_PRIORITY_NEW' },
      { symbol: 'HIGH_PRIORITY_OLD' },
      { symbol: 'LOW_PRIORITY_DUE' },
    ]);

    expect(mocks.newsPullCursorFindMany).toHaveBeenCalledWith({
      where: {
        source: CatalystSource.MASSIVE_NEWS,
        enabled: true,
      },
    });
  });

  it('limits due cursor results when take is provided', async () => {
    mocks.newsPullCursorFindMany.mockResolvedValue([
      cursor({ symbol: 'AAPL', priority: 2 }),
      cursor({ symbol: 'MSFT', priority: 1 }),
    ]);

    await expect(
      listDueNewsPullCursors({
        source: CatalystSource.MASSIVE_NEWS,
        take: 1,
      })
    ).resolves.toMatchObject([{ symbol: 'AAPL' }]);
  });

  it('updates cursor state after a successful pull', async () => {
    const pulledAt = new Date('2026-07-04T15:05:00Z');
    const newestPublishedAt = new Date('2026-07-04T15:04:00Z');

    await recordNewsPullCursorSuccess({
      source: CatalystSource.MASSIVE_NEWS,
      symbol: ' aapl ',
      pulledAt,
      newestPublishedAt,
    });

    expect(mocks.newsPullCursorUpdate).toHaveBeenCalledWith({
      where: {
        source_symbol: {
          source: CatalystSource.MASSIVE_NEWS,
          symbol: 'AAPL',
        },
      },
      data: {
        lastPulledAt: pulledAt,
        lastPublishedAt: newestPublishedAt,
        consecutiveErrors: 0,
        lastError: null,
      },
    });
  });

  it('does not clear lastPublishedAt when a successful pull returns no articles', async () => {
    const pulledAt = new Date('2026-07-04T15:05:00Z');

    await recordNewsPullCursorSuccess({
      source: CatalystSource.MASSIVE_NEWS,
      symbol: 'MSFT',
      pulledAt,
      newestPublishedAt: null,
    });

    expect(mocks.newsPullCursorUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          lastPulledAt: pulledAt,
          consecutiveErrors: 0,
          lastError: null,
        },
      })
    );
  });

  it('increments cursor errors and leaves lastPulledAt unchanged by default', async () => {
    await recordNewsPullCursorError({
      source: CatalystSource.MASSIVE_NEWS,
      symbol: 'nvda',
      error: new Error('Massive failed\nwith rate limit'),
    });

    expect(mocks.newsPullCursorUpdate).toHaveBeenCalledWith({
      where: {
        source_symbol: {
          source: CatalystSource.MASSIVE_NEWS,
          symbol: 'NVDA',
        },
      },
      data: {
        consecutiveErrors: {
          increment: 1,
        },
        lastError: 'Massive failed with rate limit',
      },
    });
  });

  it('extracts the newest Massive published timestamp from a raw payload', () => {
    expect(
      getNewestPublishedAtFromMassiveNewsPayload({
        results: [
          { published_utc: '2026-07-04T12:00:00Z' },
          { published_utc: 'bad-date' },
          { published_utc: '2026-07-04T13:30:00Z' },
        ],
      })
    ).toEqual(new Date('2026-07-04T13:30:00Z'));
  });
});
