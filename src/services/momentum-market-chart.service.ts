import { AssetType } from '@prisma/client';

import { prisma } from '../db/prisma.js';
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
  '1m': { multiplier: 1, timespan: 'minute', maxRangeMs: DAY_MS },
  '5m': { multiplier: 5, timespan: 'minute', maxRangeMs: 7 * DAY_MS },
  '15m': { multiplier: 15, timespan: 'minute', maxRangeMs: 14 * DAY_MS },
  '1d': { multiplier: 1, timespan: 'day', maxRangeMs: 183 * DAY_MS },
} as const;

type ChartInterval = keyof typeof intervalConfig;

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
  const previousLookupFrom = new Date(range.from.getTime() - 10 * DAY_MS);

  try {
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
    const previousClose = dailyCandles
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
      bars: bars.map((bar) => ({
        timestamp: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: volumeString(bar.volume),
        vwap: bar.vwap,
        transactions: bar.transactions,
      })),
      referenceLevels: referenceLevels(bars, previousClose, referenceDate),
      markers: [],
      source: {
        provider: 'MASSIVE' as const,
        fetchedAt: now.toISOString(),
        cached: false,
      },
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 502) {
      throw new HttpError(503, 'Market data provider is temporarily unavailable.', {
        code: 'MARKET_DATA_PROVIDER_UNAVAILABLE',
      });
    }

    throw error;
  }
}
