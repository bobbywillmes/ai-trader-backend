import {
  CatalystSentiment,
  CatalystSource,
  Prisma,
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  catalystEventUpsert: vi.fn(),
  catalystTickerImpactUpsert: vi.fn(),
  securityFindMany: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    catalystEvent: {
      upsert: mocks.catalystEventUpsert,
    },
    catalystTickerImpact: {
      upsert: mocks.catalystTickerImpactUpsert,
    },
    security: {
      findMany: mocks.securityFindMany,
    },
  },
}));

import {
  ingestMassiveNewsPayload,
  mapMassiveSentiment,
} from './catalyst-news-ingestion.service.js';

function massiveArticle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'massive-news-1',
    publisher: {
      name: 'Benzinga',
    },
    title: 'AAPL announces AI partnership',
    author: 'News Desk',
    published_utc: '2026-07-04T14:30:00Z',
    article_url: 'https://example.test/aapl-ai',
    tickers: ['AAPL', 'MSFT'],
    description: 'AAPL and MSFT expand an AI partnership.',
    keywords: ['AI', 'partnership'],
    insights: [
      {
        ticker: 'AAPL',
        sentiment: 'positive',
        sentiment_reasoning: 'Partnership expands a core growth theme.',
      },
      {
        ticker: 'MSFT',
        sentiment: 'neutral',
        sentiment_reasoning: 'Microsoft is already expected to benefit.',
      },
    ],
    ...overrides,
  };
}

describe('catalyst news ingestion service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.catalystEventUpsert.mockResolvedValue({
      id: 'catalyst-event-1',
    });
    mocks.catalystTickerImpactUpsert.mockResolvedValue({});
    mocks.securityFindMany.mockResolvedValue([
      { id: 1, symbol: 'AAPL' },
      { id: 2, symbol: 'MSFT' },
    ]);
  });

  it('maps Massive sentiment strings to CatalystSentiment values', () => {
    expect(mapMassiveSentiment('positive')).toBe(CatalystSentiment.POSITIVE);
    expect(mapMassiveSentiment('bullish')).toBe(CatalystSentiment.POSITIVE);
    expect(mapMassiveSentiment('negative')).toBe(CatalystSentiment.NEGATIVE);
    expect(mapMassiveSentiment('bearish')).toBe(CatalystSentiment.NEGATIVE);
    expect(mapMassiveSentiment('neutral')).toBe(CatalystSentiment.NEUTRAL);
    expect(mapMassiveSentiment('mixed')).toBe(CatalystSentiment.MIXED);
    expect(mapMassiveSentiment('unclear')).toBe(CatalystSentiment.UNKNOWN);
  });

  it('upserts a Massive article as a CatalystEvent and preserves rawPayload', async () => {
    const article = massiveArticle();

    await expect(
      ingestMassiveNewsPayload({
        results: [article],
      })
    ).resolves.toMatchObject({
      source: CatalystSource.MASSIVE_NEWS,
      processedArticles: 1,
      skippedArticles: 0,
      upsertedEvents: 1,
      upsertedTickerImpacts: 2,
    });

    expect(mocks.catalystEventUpsert).toHaveBeenCalledWith({
      where: {
        source_sourceExternalId: {
          source: CatalystSource.MASSIVE_NEWS,
          sourceExternalId: 'massive-news-1',
        },
      },
      create: expect.objectContaining({
        source: CatalystSource.MASSIVE_NEWS,
        sourceExternalId: 'massive-news-1',
        sourcePublisher: 'Benzinga',
        sourceAuthor: 'News Desk',
        sourceUrl: 'https://example.test/aapl-ai',
        title: 'AAPL announces AI partnership',
        summary: 'AAPL and MSFT expand an AI partnership.',
        publishedAt: new Date('2026-07-04T14:30:00Z'),
        rawPayload: article,
        metadata: {
          keywords: ['AI', 'partnership'],
          tickers: ['AAPL', 'MSFT'],
        },
      }),
      update: expect.objectContaining({
        rawPayload: article,
      }),
      select: {
        id: true,
      },
    });
  });

  it('uses source and article id as the dedupe key for repeated ingests', async () => {
    const article = massiveArticle();

    await ingestMassiveNewsPayload({
      results: [article, article],
    });

    expect(mocks.catalystEventUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.catalystEventUpsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          source_sourceExternalId: {
            source: CatalystSource.MASSIVE_NEWS,
            sourceExternalId: 'massive-news-1',
          },
        },
      })
    );
    expect(mocks.catalystEventUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          source_sourceExternalId: {
            source: CatalystSource.MASSIVE_NEWS,
            sourceExternalId: 'massive-news-1',
          },
        },
      })
    );
  });

  it('dedupes the same Massive article across ticker query payloads', async () => {
    await ingestMassiveNewsPayload({
      results: [
        massiveArticle({
          tickers: ['AAPL'],
        }),
        massiveArticle({
          tickers: ['MSFT'],
        }),
      ],
    });

    const eventWhereInputs = mocks.catalystEventUpsert.mock.calls.map(
      ([input]) => input.where
    );

    expect(eventWhereInputs).toEqual([
      {
        source_sourceExternalId: {
          source: CatalystSource.MASSIVE_NEWS,
          sourceExternalId: 'massive-news-1',
        },
      },
      {
        source_sourceExternalId: {
          source: CatalystSource.MASSIVE_NEWS,
          sourceExternalId: 'massive-news-1',
        },
      },
    ]);
  });

  it('creates ticker impacts from Massive insights', async () => {
    await ingestMassiveNewsPayload({
      results: [massiveArticle()],
    });

    expect(mocks.catalystTickerImpactUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.catalystTickerImpactUpsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          catalystEventId_symbol: {
            catalystEventId: 'catalyst-event-1',
            symbol: 'AAPL',
          },
        },
        create: expect.objectContaining({
          securityId: 1,
          symbol: 'AAPL',
          sentiment: CatalystSentiment.POSITIVE,
          sentimentReasoning: 'Partnership expands a core growth theme.',
          rawInsight: {
            ticker: 'AAPL',
            sentiment: 'positive',
            sentiment_reasoning: 'Partnership expands a core growth theme.',
          },
          isPrimaryTicker: true,
          isCompanySpecific: true,
          relevanceScore: expect.any(Number),
          sourceQualityScore: expect.any(Number),
          totalCatalystScore: expect.any(Number),
        }),
      })
    );
  });

  it('preserves unknown ticker impacts without inventing a Security relation', async () => {
    mocks.securityFindMany.mockResolvedValue([{ id: 1, symbol: 'AAPL' }]);

    await ingestMassiveNewsPayload({ results: [massiveArticle()] });

    const msftInput = mocks.catalystTickerImpactUpsert.mock.calls[1]?.[0];
    expect(msftInput.create.symbol).toBe('MSFT');
    expect(msftInput.create).not.toHaveProperty('securityId');
    expect(msftInput.update).not.toHaveProperty('securityId');
  });

  it('does not choose arbitrarily between normalized Security matches', async () => {
    mocks.securityFindMany.mockResolvedValue([
      { id: 1, symbol: 'AAPL' },
      { id: 2, symbol: 'aapl' },
      { id: 3, symbol: 'MSFT' },
    ]);

    await ingestMassiveNewsPayload({ results: [massiveArticle()] });

    const aaplInput = mocks.catalystTickerImpactUpsert.mock.calls[0]?.[0];
    expect(aaplInput.create).not.toHaveProperty('securityId');
    expect(aaplInput.update).not.toHaveProperty('securityId');
  });

  it('creates fallback ticker impacts when insights are missing', async () => {
    await ingestMassiveNewsPayload({
      results: [
        massiveArticle({
          insights: [],
          tickers: ['aapl', 'AAPL', 'msft'],
        }),
      ],
    });

    expect(mocks.catalystTickerImpactUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.catalystTickerImpactUpsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          catalystEventId_symbol: {
            catalystEventId: 'catalyst-event-1',
            symbol: 'AAPL',
          },
        },
        create: expect.objectContaining({
          symbol: 'AAPL',
          sentiment: CatalystSentiment.UNKNOWN,
          sentimentReasoning: null,
          rawInsight: Prisma.JsonNull,
          metadata: {
            source: CatalystSource.MASSIVE_NEWS,
            hasInsight: false,
          },
        }),
      })
    );
    expect(mocks.catalystTickerImpactUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          catalystEventId_symbol: {
            catalystEventId: 'catalyst-event-1',
            symbol: 'MSFT',
          },
        },
      })
    );
  });

  it('skips articles without a usable id or title', async () => {
    await expect(
      ingestMassiveNewsPayload({
        results: [
          massiveArticle({ id: '' }),
          massiveArticle({ title: '' }),
        ],
      })
    ).resolves.toMatchObject({
      processedArticles: 0,
      skippedArticles: 2,
      upsertedEvents: 0,
      upsertedTickerImpacts: 0,
    });

    expect(mocks.catalystEventUpsert).not.toHaveBeenCalled();
    expect(mocks.catalystTickerImpactUpsert).not.toHaveBeenCalled();
  });
});
