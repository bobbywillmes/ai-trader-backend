import { AssetType } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import { HttpError } from '../errors/http-error.js';
import {
  getTickerAggregateBars,
  getTickerDailyCandles,
  type TickerAggregateBar,
} from './massive-market-data.service.js';
import type { MomentumMarketChartQuery } from '../validators/momentum-market-chart.schema.js';

const MARKET_TIME_ZONE = 'America/New_York';
const DAY_MS = 86_400_000;

const intervalConfig = {
  '1m': { multiplier: 1, timespan: 'minute', maxRangeMs: DAY_MS, cacheTtlMs: 30_000 },
  '5m': { multiplier: 5, timespan: 'minute', maxRangeMs: 7 * DAY_MS, cacheTtlMs: 300_000 },
  '15m': { multiplier: 15, timespan: 'minute', maxRangeMs: 14 * DAY_MS, cacheTtlMs: 300_000 },
  '1d': { multiplier: 1, timespan: 'day', maxRangeMs: 183 * DAY_MS, cacheTtlMs: 1_800_000 },
} as const;

type ChartInterval = keyof typeof intervalConfig;

type MarketDataCacheValue = {
  bars: TickerAggregateBar[];
  dailyCandles: Awaited<ReturnType<typeof getTickerDailyCandles>>;
  fetchedAt: Date;
  expiresAtMs: number;
};

const marketDataCache = new Map<string, MarketDataCacheValue>();
const marketDataInFlight = new Map<string, Promise<MarketDataCacheValue>>();
const MAX_CACHE_ENTRIES = 250;

export function resetMomentumMarketChartCacheForTests() {
  marketDataCache.clear();
  marketDataInFlight.clear();
}

function newYorkParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));

  return {
    date: `${values.get('year')}-${values.get('month')}-${values.get('day')}`,
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
  };
}

function getTimeZoneOffsetMs(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));

  return Date.UTC(
    Number(values.get('year')),
    Number(values.get('month')) - 1,
    Number(values.get('day')),
    Number(values.get('hour')),
    Number(values.get('minute')),
    Number(values.get('second'))
  ) - date.getTime();
}

function newYorkDateTime(datePart: string, hour: number, minute: number) {
  const [year, month, day] = datePart.split('-').map(Number);
  const utcGuess = new Date(Date.UTC(year!, month! - 1, day!, hour, minute));
  const firstPass = new Date(utcGuess.getTime() - getTimeZoneOffsetMs(utcGuess));

  return new Date(utcGuess.getTime() - getTimeZoneOffsetMs(firstPass));
}

function defaultRange(interval: ChartInterval, now: Date) {
  if (interval === '1m') {
    const currentDate = newYorkParts(now).date;
    let from = newYorkDateTime(currentDate, 4, 0);

    if (from > now) {
      from = new Date(from.getTime() - DAY_MS);
    }

    return { from, to: now };
  }

  const days = interval === '5m' ? 7 : interval === '15m' ? 14 : 183;
  return { from: new Date(now.getTime() - days * DAY_MS), to: now };
}

function normalizeRange(query: MomentumMarketChartQuery, now: Date) {
  const defaults = defaultRange(query.interval, now);
  const from = query.from ?? defaults.from;
  const to = query.to ?? defaults.to;
  const config = intervalConfig[query.interval];

  if (from > to) {
    throw new HttpError(400, 'Chart range start must not be after its end.', {
      code: 'INVALID_CHART_RANGE',
    });
  }

  if (to.getTime() - from.getTime() > config.maxRangeMs) {
    throw new HttpError(400, `Chart range exceeds the ${query.interval} interval limit.`, {
      code: 'CHART_RANGE_TOO_LARGE',
      maximumRangeDays: config.maxRangeMs / DAY_MS,
    });
  }

  return { from, to, config };
}

function volumeString(value: number | null) {
  return value === null || !Number.isFinite(value) || value < 0
    ? null
    : String(Math.trunc(value));
}

function sessionMinute(bar: TickerAggregateBar) {
  const parts = newYorkParts(new Date(bar.time));
  return { ...parts, minuteOfDay: parts.hour * 60 + parts.minute };
}

function weightedVwap(bars: TickerAggregateBar[]) {
  const usable = bars.filter(
    (bar) => bar.vwap !== null && bar.volume !== null && bar.volume > 0
  );
  const volume = usable.reduce((total, bar) => total + (bar.volume ?? 0), 0);

  return volume === 0
    ? null
    : usable.reduce(
        (total, bar) => total + (bar.vwap ?? 0) * (bar.volume ?? 0),
        0
      ) / volume;
}

function referenceLevels(
  bars: TickerAggregateBar[],
  previousClose: number | null,
  referenceDate: string
) {
  const sessionBars = bars.map((bar) => ({ bar, session: sessionMinute(bar) }))
    .filter(({ session }) => session.date === referenceDate);
  const premarket = sessionBars.filter(
    ({ session }) => session.minuteOfDay >= 240 && session.minuteOfDay < 570
  );
  const regular = sessionBars.filter(
    ({ session }) => session.minuteOfDay >= 570 && session.minuteOfDay < 960
  );

  return {
    previousClose,
    sessionVwap: weightedVwap(sessionBars.map(({ bar }) => bar)),
    premarketHigh: premarket.length
      ? Math.max(...premarket.map(({ bar }) => bar.high))
      : null,
    regularSessionHigh: regular.length
      ? Math.max(...regular.map(({ bar }) => bar.high))
      : null,
  };
}

function cacheKey(
  symbol: string,
  interval: ChartInterval,
  from: Date,
  to: Date
) {
  return [symbol, interval, from.toISOString(), to.toISOString(), 'adjusted=true'].join('|');
}

async function loadMarketData(
  symbol: string,
  interval: ChartInterval,
  range: ReturnType<typeof normalizeRange>,
  referenceDate: string,
  now: Date
) {
  const key = cacheKey(symbol, interval, range.from, range.to);
  const cached = marketDataCache.get(key);

  if (cached && cached.expiresAtMs > now.getTime()) {
    logger.debug({ symbol, interval }, 'Momentum market chart cache hit.');
    return { ...cached, cached: true };
  }

  if (cached) {
    marketDataCache.delete(key);
  }

  const existing = marketDataInFlight.get(key);
  if (existing) {
    logger.debug({ symbol, interval }, 'Momentum market chart request joined in-flight fetch.');
    return { ...(await existing), cached: true };
  }

  logger.debug({ symbol, interval }, 'Momentum market chart cache miss.');
  const previousLookupFrom = new Date(range.from.getTime() - 10 * DAY_MS);
  const request = (async (): Promise<MarketDataCacheValue> => {
    logger.info({ symbol, interval }, 'Momentum market chart Massive request started.');
    const [bars, dailyCandles] = await Promise.all([
      getTickerAggregateBars(symbol, {
        multiplier: range.config.multiplier,
        timespan: range.config.timespan,
        from: String(range.from.getTime()),
        to: String(range.to.getTime()),
      }),
      getTickerDailyCandles(
        symbol,
        newYorkParts(previousLookupFrom).date,
        referenceDate
      ),
    ]);
    const value = {
      bars,
      dailyCandles,
      fetchedAt: now,
      expiresAtMs: now.getTime() + range.config.cacheTtlMs,
    };

    if (marketDataCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = marketDataCache.keys().next().value;
      if (oldestKey) marketDataCache.delete(oldestKey);
    }
    marketDataCache.set(key, value);
    return value;
  })();

  marketDataInFlight.set(key, request);

  try {
    return { ...(await request), cached: false };
  } finally {
    marketDataInFlight.delete(key);
  }
}

function decimalNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

type CandidateForMarkers = Awaited<ReturnType<typeof loadMarkerCandidates>>[number];

async function loadMarkerCandidates(
  symbol: string,
  candidateId: string | undefined,
  to: Date
) {
  const include = {
    catalystEvent: true,
    priceChecks: { orderBy: { observedAt: 'asc' as const } },
    scannerHandoffs: { orderBy: { preparedAt: 'asc' as const } },
  };

  if (candidateId) {
    const candidate = await prisma.momentumCandidate.findUnique({
      where: { id: candidateId },
      include,
    });

    if (!candidate) {
      throw new HttpError(404, `Momentum candidate ${candidateId} was not found.`, {
        code: 'MOMENTUM_CANDIDATE_NOT_FOUND',
      });
    }

    if (candidate.symbol !== symbol) {
      throw new HttpError(400, 'Momentum candidate does not belong to the requested symbol.', {
        code: 'CANDIDATE_SYMBOL_MISMATCH',
      });
    }

    return [candidate];
  }

  return prisma.momentumCandidate.findMany({
    where: { symbol, discoveredAt: { lte: to } },
    include,
    orderBy: { discoveredAt: 'desc' },
    take: 25,
  });
}

function markersForCandidates(
  candidates: CandidateForMarkers[],
  from: Date,
  to: Date
) {
  const markers: Array<{
    id: string;
    type: string;
    timestamp: string;
    price: number | null;
    label: string;
    candidateId: string | null;
    metadata?: Record<string, unknown>;
  }> = [];
  const add = (marker: (typeof markers)[number]) => {
    const timestamp = new Date(marker.timestamp);
    if (timestamp >= from && timestamp <= to) markers.push(marker);
  };

  for (const candidate of candidates) {
    const catalyst = candidate.catalystEvent;
    if (catalyst?.publishedAt) add({
      id: `${candidate.id}:${catalyst.id}:published`, type: 'CATALYST_PUBLISHED',
      timestamp: catalyst.publishedAt.toISOString(), price: null,
      label: 'Catalyst published', candidateId: candidate.id,
    });
    if (catalyst) add({
      id: `${candidate.id}:${catalyst.id}:received`, type: 'CATALYST_RECEIVED',
      timestamp: catalyst.receivedAt.toISOString(), price: null,
      label: 'Catalyst received', candidateId: candidate.id,
    });
    add({
      id: `${candidate.id}:discovered`, type: 'CANDIDATE_DISCOVERED',
      timestamp: candidate.discoveredAt.toISOString(), price: null,
      label: 'Candidate discovered', candidateId: candidate.id,
    });

    for (const check of candidate.priceChecks) {
      const price = decimalNumber(check.lastPrice);
      add({
        id: check.id, type: 'PRICE_CHECK', timestamp: check.observedAt.toISOString(),
        price, label: 'Price check', candidateId: candidate.id,
        metadata: {
          decision: check.decision,
          confirmed: check.confirmed,
          blockedReason: check.blockedReason,
          aboveVwap: check.aboveVwap,
          sessionVwap: check.sessionVwap?.toString() ?? null,
          priceActionScore: check.priceActionScore,
          volumeScore: check.volumeScore,
          totalConfirmationScore: check.totalConfirmationScore,
          dayVolume: check.dayVolume?.toString() ?? null,
          recentVolume: check.recentVolume?.toString() ?? null,
          relativeVolume: check.relativeVolume?.toString() ?? null,
        },
      });
      if (check.decision === 'ENTRY_READY') add({
        id: `${check.id}:entry-ready`, type: 'ENTRY_READY',
        timestamp: check.observedAt.toISOString(), price,
        label: 'Entry ready observed', candidateId: candidate.id,
      });
      if (check.blockedReason) add({
        id: `${check.id}:entry-blocked`, type: 'ENTRY_BLOCKED',
        timestamp: check.observedAt.toISOString(), price,
        label: 'Entry blocked', candidateId: candidate.id,
        metadata: { reason: check.blockedReason },
      });
    }

    for (const handoff of candidate.scannerHandoffs) {
      add({
        id: `${handoff.id}:prepared`, type: 'HANDOFF_PREPARED',
        timestamp: handoff.preparedAt.toISOString(), price: null,
        label: 'Handoff prepared', candidateId: candidate.id,
      });
      if (handoff.sentAt) add({
        id: `${handoff.id}:sent`, type: 'HANDOFF_SENT',
        timestamp: handoff.sentAt.toISOString(), price: null,
        label: 'Handoff sent', candidateId: candidate.id,
      });
      if (handoff.status === 'CANCELLED') add({
        id: `${handoff.id}:cancelled`, type: 'HANDOFF_CANCELLED',
        timestamp: handoff.updatedAt.toISOString(), price: null,
        label: 'Handoff cancelled', candidateId: candidate.id,
        metadata: { timestampSource: 'updatedAt' },
      });
    }
  }

  return markers.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function getMomentumMarketChart(
  symbol: string,
  query: MomentumMarketChartQuery,
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const range = normalizeRange(query, now);
  const security = await prisma.security.findUnique({ where: { symbol } });

  if (!security) {
    throw new HttpError(404, `Security ${symbol} was not found.`, {
      code: 'SECURITY_NOT_FOUND',
    });
  }

  if (
    security.assetType !== AssetType.STOCK &&
    security.assetType !== AssetType.ETF
  ) {
    throw new HttpError(400, `Security ${symbol} does not support stock market charts.`, {
      code: 'UNSUPPORTED_SECURITY',
    });
  }

  const referenceDate = newYorkParts(range.to).date;

  try {
    const candidates = await loadMarkerCandidates(
      symbol,
      query.candidateId,
      range.to
    );
    const marketData = await loadMarketData(
      symbol,
      query.interval,
      range,
      referenceDate,
      now
    );
    const previousClose = marketData.dailyCandles
      .filter((candle) => candle.date < referenceDate)
      .sort((a, b) => b.date.localeCompare(a.date))[0]?.close ?? null;

    return {
      security: {
        id: String(security.id),
        symbol: security.symbol,
        name: security.name,
      },
      query: {
        interval: query.interval,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        timezone: MARKET_TIME_ZONE,
        adjusted: true,
      },
      bars: marketData.bars.map((bar) => ({
        timestamp: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: volumeString(bar.volume),
        vwap: bar.vwap,
        transactions: bar.transactions,
      })),
      referenceLevels: referenceLevels(marketData.bars, previousClose, referenceDate),
      markers: markersForCandidates(candidates, range.from, range.to),
      source: {
        provider: 'MASSIVE' as const,
        fetchedAt: marketData.fetchedAt.toISOString(),
        cached: marketData.cached,
      },
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 502) {
      const upstreamStatus =
        error.details && typeof error.details === 'object' &&
        'upstreamStatus' in error.details
          ? error.details.upstreamStatus
          : null;

      if (upstreamStatus === 429) {
        logger.warn({ symbol, interval: query.interval }, 'Momentum market chart Massive rate limit response.');
      } else {
        logger.error({ symbol, interval: query.interval }, 'Momentum market chart Massive upstream error.');
      }

      throw new HttpError(503, 'Market data provider is temporarily unavailable.', {
        code: 'MARKET_DATA_PROVIDER_UNAVAILABLE',
      });
    }

    throw error;
  }
}
