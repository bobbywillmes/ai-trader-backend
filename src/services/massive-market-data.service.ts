import { env } from '../config/env.js';
import { HttpError } from '../errors/http-error.js';

const INDEX_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM'] as const;
const INDEX_CHART_RANGE_CONFIG = {
  '1d': {
    label: '1D',
    multiplier: 5,
    timespan: 'minute',
    subtract: { days: 0 },
  },
  '7d': {
    label: '7D',
    multiplier: 30,
    timespan: 'minute',
    subtract: { days: 6 },
  },
  '14d': {
    label: '14D',
    multiplier: 1,
    timespan: 'hour',
    subtract: { days: 13 },
  },
  '30d': {
    label: '30D',
    multiplier: 4,
    timespan: 'hour',
    subtract: { days: 29 },
  },
  '6m': {
    label: '6M',
    multiplier: 1,
    timespan: 'day',
    subtract: { months: 6 },
  },
  '1y': {
    label: '1Y',
    multiplier: 1,
    timespan: 'day',
    subtract: { years: 1 },
  },
} as const;

export type IndexSymbol = (typeof INDEX_SYMBOLS)[number];
export type IndexChartRange = keyof typeof INDEX_CHART_RANGE_CONFIG;

export type IndexPerformanceSymbol = {
  symbol: IndexSymbol;
  lastPrice: number | null;
  todayChange: number | null;
  todayChangePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  previousClose: number | null;
  marketStatus: string | null;
  updatedTime: string | null;
};

export type IndexPerformanceResponse = {
  marketStatus: string | null;
  serverTime: string | null;
  updatedAt: string;
  symbols: IndexPerformanceSymbol[];
};

export type IndexIntradayPoint = {
  time: string;
  close: number;
};

export type IndexChartSummary = {
  open: number | null;
  close: number | null;
  change: number | null;
  changePercent: number | null;
  high: number | null;
  low: number | null;
};

export type IndexIntradaySymbol = {
  symbol: IndexSymbol;
  from: string | null;
  to: string | null;
  summary: IndexChartSummary;
  points: IndexIntradayPoint[];
};

export type IndexIntradayResponse = {
  updatedAt: string;
  range: IndexChartRange;
  rangeLabel: string;
  interval: {
    multiplier: number;
    timespan: string;
  };
  symbols: IndexIntradaySymbol[];
};

type MassiveMarketStatus = {
  market?: unknown;
  serverTime?: unknown;
};

type MassiveSnapshotBar = {
  c?: unknown;
  h?: unknown;
  l?: unknown;
  t?: unknown;
};

type MassiveSnapshotTicker = {
  ticker?: unknown;
  day?: MassiveSnapshotBar;
  lastTrade?: {
    p?: unknown;
    t?: unknown;
  };
  min?: MassiveSnapshotBar;
  prevDay?: MassiveSnapshotBar;
  todaysChange?: unknown;
  todaysChangePerc?: unknown;
  updated?: unknown;
};

type MassiveSnapshotResponse = {
  ticker?: MassiveSnapshotTicker;
};

type MassiveAggregateBar = {
  c?: unknown;
  h?: unknown;
  l?: unknown;
  o?: unknown;
  t?: unknown;
};

type MassiveAggregatesResponse = {
  results?: MassiveAggregateBar[];
};

type AggregateRequestConfig = {
  multiplier: number;
  timespan: string;
};

const MIN_VALID_MARKET_YEAR = 2000;
const ONE_DAY_LOOKBACK_DAYS = 10;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toPositiveFiniteNumber(value: unknown): number | null {
  const numeric = toFiniteNumber(value);

  return numeric !== null && numeric > 0 ? numeric : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toIsoFromMassiveTimestamp(value: unknown): string | null {
  const numeric = toFiniteNumber(value);

  if (numeric === null || numeric <= 0) {
    return null;
  }

  const milliseconds = numeric > 1_000_000_000_000_000
    ? numeric / 1_000_000
    : numeric;
  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMillisFromMassiveTimestamp(value: unknown): number | null {
  const numeric = toFiniteNumber(value);

  if (numeric === null || numeric <= 0) {
    return null;
  }

  const milliseconds = numeric > 1_000_000_000_000_000
    ? numeric / 1_000_000
    : numeric;
  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function getEtDateString(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

function getIndexChartRangeConfig(range: IndexChartRange) {
  return INDEX_CHART_RANGE_CONFIG[range];
}

export function parseIndexChartRange(value: unknown): IndexChartRange {
  return typeof value === 'string' && value in INDEX_CHART_RANGE_CONFIG
    ? (value as IndexChartRange)
    : '1d';
}

function subtractChartRange(date: Date, range: IndexChartRange) {
  const config = getIndexChartRangeConfig(range);
  const result = new Date(date);

  if ('days' in config.subtract) {
    result.setUTCDate(result.getUTCDate() - config.subtract.days);
  }

  if ('months' in config.subtract) {
    result.setUTCMonth(result.getUTCMonth() - config.subtract.months);
  }

  if ('years' in config.subtract) {
    result.setUTCFullYear(result.getUTCFullYear() - config.subtract.years);
  }

  return result;
}

function subtractUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - days);

  return result;
}

function isSafeEtDateString(value: string | null): value is string {
  if (!value) {
    return false;
  }

  const year = Number(value.slice(0, 4));

  return Number.isInteger(year) && year >= MIN_VALID_MARKET_YEAR;
}

function emptyIntradaySymbol(
  symbol: IndexSymbol,
  from: string | null,
  to: string | null
): IndexIntradaySymbol {
  return {
    symbol,
    from,
    to,
    summary: {
      open: null,
      close: null,
      change: null,
      changePercent: null,
      high: null,
      low: null,
    },
    points: [],
  };
}

function hasValidAggregateBar(bar: MassiveAggregateBar) {
  return (
    toPositiveFiniteNumber(bar.c) !== null &&
    toPositiveFiniteNumber(bar.h) !== null &&
    toPositiveFiniteNumber(bar.l) !== null &&
    toPositiveFiniteNumber(bar.o) !== null &&
    toMillisFromMassiveTimestamp(bar.t) !== null
  );
}

function getLatestAggregateSessionDate(
  bars: MassiveAggregateBar[] | undefined
) {
  const latest = (bars ?? [])
    .flatMap((bar) => {
      const milliseconds = hasValidAggregateBar(bar)
        ? toMillisFromMassiveTimestamp(bar.t)
        : null;

      return milliseconds === null ? [] : [milliseconds];
    })
    .sort((a, b) => b - a)[0];

  return latest === undefined ? null : getEtDateString(new Date(latest));
}

function buildMassiveUrl(path: string) {
  const url = new URL(path, env.MASSIVE_BASE_URL);
  url.searchParams.set('_', String(Date.now()));

  return url.toString();
}

async function massiveGet<T>(path: string): Promise<T> {
  const response = await fetch(buildMassiveUrl(path), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${env.MASSIVE_API_KEY}`,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const upstreamError =
      data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : null;
    const upstreamMessage =
      data && typeof data === 'object' && 'message' in data
        ? String(data.message)
        : null;
    const message =
      upstreamError ??
      upstreamMessage ??
      `Massive request failed with status ${response.status}`;

    throw new HttpError(502, message, {
      upstreamStatus: response.status,
      path,
      upstream: data && typeof data === 'object'
        ? {
            error: upstreamError,
            message: upstreamMessage,
            status: 'status' in data ? String(data.status) : null,
            requestId: 'request_id' in data ? String(data.request_id) : null,
          }
        : null,
    });
  }

  return data as T;
}

export function normalizeMassiveSnapshotTicker(
  symbol: IndexSymbol,
  snapshot: MassiveSnapshotTicker | undefined,
  marketStatus: string | null
): IndexPerformanceSymbol {
  const lastTradePrice = toPositiveFiniteNumber(snapshot?.lastTrade?.p);
  const minuteClose = toPositiveFiniteNumber(snapshot?.min?.c);
  const dayClose = toPositiveFiniteNumber(snapshot?.day?.c);
  const previousClose = toPositiveFiniteNumber(snapshot?.prevDay?.c);
  const dayHigh = toPositiveFiniteNumber(snapshot?.day?.h);
  const dayLow = toPositiveFiniteNumber(snapshot?.day?.l);
  const validPriceTimestampCandidates = [
    lastTradePrice !== null ? snapshot?.lastTrade?.t : null,
    minuteClose !== null ? snapshot?.min?.t : null,
    dayClose !== null ? snapshot?.day?.t : null,
  ]
    .map((value) => ({
      raw: value,
      milliseconds: toMillisFromMassiveTimestamp(value),
    }))
    .filter(
      (candidate): candidate is { raw: unknown; milliseconds: number } =>
        candidate.milliseconds !== null
    )
    .sort((a, b) => b.milliseconds - a.milliseconds);
  const priceUpdatedTimestamp =
    validPriceTimestampCandidates[0]?.raw ??
    snapshot?.prevDay?.t ??
    snapshot?.updated;
  const hasValidCurrentPrice =
    lastTradePrice !== null ||
    minuteClose !== null ||
    dayClose !== null;

  return {
    symbol,
    lastPrice: lastTradePrice ?? minuteClose ?? dayClose,
    todayChange: hasValidCurrentPrice
      ? toFiniteNumber(snapshot?.todaysChange)
      : null,
    todayChangePercent: hasValidCurrentPrice
      ? toFiniteNumber(snapshot?.todaysChangePerc)
      : null,
    dayHigh,
    dayLow,
    previousClose,
    marketStatus,
    updatedTime: toIsoFromMassiveTimestamp(priceUpdatedTimestamp),
  };
}

async function getMarketStatus() {
  const status = await massiveGet<MassiveMarketStatus>('/v1/marketstatus/now');

  return {
    marketStatus: toStringOrNull(status.market),
    serverTime: toStringOrNull(status.serverTime),
  };
}

async function getTickerSnapshot(
  symbol: IndexSymbol,
  marketStatus: string | null
) {
  const response = await massiveGet<MassiveSnapshotResponse>(
    `/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`
  );

  return normalizeMassiveSnapshotTicker(symbol, response.ticker, marketStatus);
}

function normalizeAggregatePoints(
  bars: MassiveAggregateBar[] | undefined
): IndexIntradayPoint[] {
  return (bars ?? []).flatMap((bar) => {
    const close = toPositiveFiniteNumber(bar.c);
    const time = toIsoFromMassiveTimestamp(bar.t);

    if (close === null || time === null) {
      return [];
    }

    return [{ close, time }];
  });
}

function summarizeAggregateBars(
  bars: MassiveAggregateBar[] | undefined
): IndexChartSummary {
  const validBars = (bars ?? []).flatMap((bar) => {
    const close = toPositiveFiniteNumber(bar.c);
    const high = toPositiveFiniteNumber(bar.h);
    const low = toPositiveFiniteNumber(bar.l);
    const open = toPositiveFiniteNumber(bar.o);
    const time = toMillisFromMassiveTimestamp(bar.t);

    if (
      close === null ||
      high === null ||
      low === null ||
      open === null ||
      time === null
    ) {
      return [];
    }

    return [{ close, high, low, open, time }];
  });

  validBars.sort((a, b) => a.time - b.time);

  const first = validBars[0];
  const last = validBars.at(-1);

  if (!first || !last) {
    return {
      open: null,
      close: null,
      change: null,
      changePercent: null,
      high: null,
      low: null,
    };
  }

  const change = last.close - first.open;

  return {
    open: first.open,
    close: last.close,
    change,
    changePercent: first.open === 0 ? null : (change / first.open) * 100,
    high: Math.max(...validBars.map((bar) => bar.high)),
    low: Math.min(...validBars.map((bar) => bar.low)),
  };
}

async function getAggregateBars(
  symbol: IndexSymbol,
  config: AggregateRequestConfig,
  from: string,
  to: string
) {
  return massiveGet<MassiveAggregatesResponse>(
    `/v2/aggs/ticker/${symbol}/range/${config.multiplier}/${config.timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000`
  );
}

async function resolveOneDayAggregateBars(
  symbol: IndexSymbol,
  config: AggregateRequestConfig,
  toDate: Date,
  target: string
) {
  const initialResponse = await getAggregateBars(symbol, config, target, target);

  if (normalizeAggregatePoints(initialResponse.results).length > 0) {
    return {
      from: target,
      to: target,
      response: initialResponse,
    };
  }

  const lookbackFrom = getEtDateString(
    subtractUtcDays(toDate, ONE_DAY_LOOKBACK_DAYS)
  );

  if (!isSafeEtDateString(lookbackFrom)) {
    return {
      from: target,
      to: target,
      response: initialResponse,
    };
  }

  const dailyResponse = await getAggregateBars(
    symbol,
    { multiplier: 1, timespan: 'day' },
    lookbackFrom,
    target
  );
  const latestSession = getLatestAggregateSessionDate(dailyResponse.results);

  if (!isSafeEtDateString(latestSession) || latestSession === target) {
    return {
      from: target,
      to: target,
      response: initialResponse,
    };
  }

  const fallbackResponse = await getAggregateBars(
    symbol,
    config,
    latestSession,
    latestSession
  );

  return {
    from: latestSession,
    to: latestSession,
    response: fallbackResponse,
  };
}

async function getTickerIntraday(
  symbol: IndexSymbol,
  snapshot: IndexPerformanceSymbol,
  range: IndexChartRange
): Promise<IndexIntradaySymbol> {
  const config = getIndexChartRangeConfig(range);
  const sourceDate = snapshot.updatedTime
    ? new Date(snapshot.updatedTime)
    : new Date();
  const toDate = Number.isNaN(sourceDate.getTime()) ? new Date() : sourceDate;
  const fromDate = subtractChartRange(toDate, range);
  const from = getEtDateString(fromDate);
  const to = getEtDateString(toDate);

  if (!isSafeEtDateString(from) || !isSafeEtDateString(to)) {
    return emptyIntradaySymbol(symbol, null, null);
  }

  const resolved = range === '1d'
    ? await resolveOneDayAggregateBars(symbol, config, toDate, to)
    : {
        from,
        to,
        response: await getAggregateBars(symbol, config, from, to),
      };

  return {
    symbol,
    from: resolved.from,
    to: resolved.to,
    summary: summarizeAggregateBars(resolved.response.results),
    points: normalizeAggregatePoints(resolved.response.results),
  };
}

export async function getIndexPerformance(): Promise<IndexPerformanceResponse> {
  const status = await getMarketStatus();
  const symbols = await Promise.all(
    INDEX_SYMBOLS.map((symbol) =>
      getTickerSnapshot(symbol, status.marketStatus)
    )
  );

  return {
    marketStatus: status.marketStatus,
    serverTime: status.serverTime,
    updatedAt: new Date().toISOString(),
    symbols,
  };
}

export async function getIndexIntraday(
  range: IndexChartRange = '1d'
): Promise<IndexIntradayResponse> {
  const config = getIndexChartRangeConfig(range);
  const performance = await getIndexPerformance();
  const symbols = await Promise.all(
    performance.symbols.map((symbol) =>
      getTickerIntraday(symbol.symbol, symbol, range)
    )
  );

  return {
    updatedAt: new Date().toISOString(),
    range,
    rangeLabel: config.label,
    interval: {
      multiplier: config.multiplier,
      timespan: config.timespan,
    },
    symbols,
  };
}
