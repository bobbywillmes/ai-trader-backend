import {
  CatalystSentiment,
  CatalystSource,
  Prisma,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';

type MassivePublisher = {
  name?: unknown;
};

type MassiveInsight = {
  ticker?: unknown;
  sentiment?: unknown;
  sentiment_reasoning?: unknown;
};

type MassiveNewsArticle = {
  id?: unknown;
  publisher?: MassivePublisher;
  title?: unknown;
  author?: unknown;
  published_utc?: unknown;
  article_url?: unknown;
  tickers?: unknown;
  description?: unknown;
  keywords?: unknown;
  insights?: unknown;
};

type MassiveNewsPayload = {
  results?: unknown;
};

type NormalizedTickerImpact = {
  symbol: string;
  sentiment: CatalystSentiment;
  sentimentReasoning: string | null;
  rawInsight: Prisma.InputJsonValue | null;
  hasInsight: boolean;
};

export type IngestMassiveNewsPayloadResult = {
  source: CatalystSource;
  processedArticles: number;
  skippedArticles: number;
  upsertedEvents: number;
  upsertedTickerImpacts: number;
};

function toNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toNonEmptyString(item))
    .filter((item): item is string => item !== null);
}

function normalizeSymbol(value: unknown) {
  const symbol = toNonEmptyString(value);

  return symbol ? symbol.toUpperCase() : null;
}

function parseDate(value: unknown) {
  const raw = toNonEmptyString(value);

  if (!raw) {
    return null;
  }

  const date = new Date(raw);

  return Number.isNaN(date.getTime()) ? null : date;
}

export function mapMassiveSentiment(value: unknown): CatalystSentiment {
  const normalized = toNonEmptyString(value)?.toLowerCase();

  switch (normalized) {
    case 'positive':
    case 'bullish':
      return CatalystSentiment.POSITIVE;

    case 'negative':
    case 'bearish':
      return CatalystSentiment.NEGATIVE;

    case 'neutral':
      return CatalystSentiment.NEUTRAL;

    case 'mixed':
      return CatalystSentiment.MIXED;

    default:
      return CatalystSentiment.UNKNOWN;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMassiveArticles(payload: MassiveNewsPayload) {
  return Array.isArray(payload.results)
    ? payload.results.filter(isRecord)
    : [];
}

function getArticleInsights(article: MassiveNewsArticle) {
  return Array.isArray(article.insights)
    ? article.insights.filter(isRecord)
    : [];
}

function uniqueSymbols(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeSymbol(value))
        .filter((value): value is string => value !== null)
    )
  );
}

function scoreSourceQuality(publisherName: string | null) {
  const normalizedPublisher = publisherName?.toLowerCase() ?? '';

  if (
    normalizedPublisher.includes('globenewswire') ||
    normalizedPublisher.includes('business wire') ||
    normalizedPublisher.includes('pr newswire') ||
    normalizedPublisher.includes('sec')
  ) {
    return 25;
  }

  if (
    normalizedPublisher.includes('benzinga') ||
    normalizedPublisher.includes('dow jones') ||
    normalizedPublisher.includes('reuters')
  ) {
    return 20;
  }

  return 10;
}

function scoreFreshness(publishedAt: Date | null) {
  if (!publishedAt) {
    return 0;
  }

  const ageMs = Date.now() - publishedAt.getTime();
  const ageHours = ageMs / 1000 / 60 / 60;

  if (ageHours <= 24) return 20;
  if (ageHours <= 72) return 15;
  if (ageHours <= 24 * 7) return 10;

  return 5;
}

function scoreRelevance(
  symbol: string,
  article: MassiveNewsArticle,
  hasInsight: boolean
) {
  const title = toNonEmptyString(article.title)?.toUpperCase() ?? '';
  const description =
    toNonEmptyString(article.description)?.toUpperCase() ?? '';
  const appearsInText = title.includes(symbol) || description.includes(symbol);

  if (hasInsight && appearsInText) return 35;
  if (hasInsight) return 30;
  if (appearsInText) return 20;

  return 10;
}

function scoreActionability(sentiment: CatalystSentiment, hasInsight: boolean) {
  if (!hasInsight) {
    return 0;
  }

  return sentiment === CatalystSentiment.POSITIVE ||
    sentiment === CatalystSentiment.NEGATIVE
    ? 10
    : 5;
}

function buildImpactScores(
  symbol: string,
  article: MassiveNewsArticle,
  publisherName: string | null,
  publishedAt: Date | null,
  impact: NormalizedTickerImpact
) {
  const relevanceScore = scoreRelevance(symbol, article, impact.hasInsight);
  const actionabilityScore = scoreActionability(
    impact.sentiment,
    impact.hasInsight
  );
  const freshnessScore = scoreFreshness(publishedAt);
  const sourceQualityScore = scoreSourceQuality(publisherName);

  return {
    relevanceScore,
    actionabilityScore,
    freshnessScore,
    sourceQualityScore,
    totalCatalystScore:
      relevanceScore + actionabilityScore + freshnessScore + sourceQualityScore,
  };
}

function normalizeTickerImpacts(
  article: MassiveNewsArticle
): NormalizedTickerImpact[] {
  const insights = getArticleInsights(article)
    .map((insight): NormalizedTickerImpact | null => {
      const symbol = normalizeSymbol(insight.ticker);

      if (!symbol) {
        return null;
      }

      return {
        symbol,
        sentiment: mapMassiveSentiment(insight.sentiment),
        sentimentReasoning: toNonEmptyString(insight.sentiment_reasoning),
        rawInsight: insight as Prisma.InputJsonValue,
        hasInsight: true,
      };
    })
    .filter((impact): impact is NormalizedTickerImpact => impact !== null);

  if (insights.length > 0) {
    return insights;
  }

  return uniqueSymbols(toStringArray(article.tickers)).map((symbol) => ({
    symbol,
    sentiment: CatalystSentiment.UNKNOWN,
    sentimentReasoning: null,
    rawInsight: null,
    hasInsight: false,
  }));
}

function buildEventMetadata(article: MassiveNewsArticle) {
  return {
    keywords: toStringArray(article.keywords),
    tickers: uniqueSymbols(toStringArray(article.tickers)),
  } satisfies Prisma.InputJsonValue;
}

async function ingestMassiveArticle(article: MassiveNewsArticle) {
  const sourceExternalId = toNonEmptyString(article.id);
  const title = toNonEmptyString(article.title);

  if (!sourceExternalId || !title) {
    return { skipped: true, tickerImpacts: 0 };
  }

  const publisherName = toNonEmptyString(article.publisher?.name);
  const publishedAt = parseDate(article.published_utc);
  const impacts = normalizeTickerImpacts(article);

  const event = await prisma.catalystEvent.upsert({
    where: {
      source_sourceExternalId: {
        source: CatalystSource.MASSIVE_NEWS,
        sourceExternalId,
      },
    },
    create: {
      source: CatalystSource.MASSIVE_NEWS,
      sourceExternalId,
      sourcePublisher: publisherName,
      sourceAuthor: toNonEmptyString(article.author),
      sourceUrl: toNonEmptyString(article.article_url),
      title,
      summary: toNonEmptyString(article.description),
      publishedAt,
      rawPayload: article as Prisma.InputJsonValue,
      metadata: buildEventMetadata(article),
    },
    update: {
      sourcePublisher: publisherName,
      sourceAuthor: toNonEmptyString(article.author),
      sourceUrl: toNonEmptyString(article.article_url),
      title,
      summary: toNonEmptyString(article.description),
      publishedAt,
      rawPayload: article as Prisma.InputJsonValue,
      metadata: buildEventMetadata(article),
    },
    select: {
      id: true,
    },
  });

  let tickerImpacts = 0;

  for (const impact of impacts) {
    const scores = buildImpactScores(
      impact.symbol,
      article,
      publisherName,
      publishedAt,
      impact
    );

    await prisma.catalystTickerImpact.upsert({
      where: {
        catalystEventId_symbol: {
          catalystEventId: event.id,
          symbol: impact.symbol,
        },
      },
      create: {
        catalystEventId: event.id,
        symbol: impact.symbol,
        sentiment: impact.sentiment,
        sentimentReasoning: impact.sentimentReasoning,
        rawInsight: impact.rawInsight ?? Prisma.JsonNull,
        metadata: {
          source: CatalystSource.MASSIVE_NEWS,
          hasInsight: impact.hasInsight,
        },
        isPrimaryTicker: impact.symbol === impacts[0]?.symbol,
        isCompanySpecific: true,
        ...scores,
      },
      update: {
        sentiment: impact.sentiment,
        sentimentReasoning: impact.sentimentReasoning,
        rawInsight: impact.rawInsight ?? Prisma.JsonNull,
        metadata: {
          source: CatalystSource.MASSIVE_NEWS,
          hasInsight: impact.hasInsight,
        },
        isPrimaryTicker: impact.symbol === impacts[0]?.symbol,
        isCompanySpecific: true,
        ...scores,
      },
    });

    tickerImpacts += 1;
  }

  return { skipped: false, tickerImpacts };
}

export async function ingestMassiveNewsPayload(
  payload: MassiveNewsPayload
): Promise<IngestMassiveNewsPayloadResult> {
  const articles = getMassiveArticles(payload);
  let skippedArticles = 0;
  let upsertedTickerImpacts = 0;

  for (const article of articles) {
    const result = await ingestMassiveArticle(article);

    if (result.skipped) {
      skippedArticles += 1;
    } else {
      upsertedTickerImpacts += result.tickerImpacts;
    }
  }

  return {
    source: CatalystSource.MASSIVE_NEWS,
    processedArticles: articles.length - skippedArticles,
    skippedArticles,
    upsertedEvents: articles.length - skippedArticles,
    upsertedTickerImpacts,
  };
}
