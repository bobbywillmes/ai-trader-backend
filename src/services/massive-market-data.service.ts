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

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toIsoFromMassiveTimestamp(value: unknown): string | null {
  const numeric = toFiniteNumber(value);

  if (numeric === null) {
    return null;
  }

  const milliseconds = numeric > 1_000_000_000_000_000
    ? numeric / 1_000_000
    : numeric;
  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : `Massive request failed with status ${response.status}`;

    throw new HttpError(502, message, {
      upstreamStatus: response.status,
      path,
    });
  }

  return data as T;
}

export function normalizeMassiveSnapshotTicker(
  symbol: IndexSymbol,
  snapshot: MassiveSnapshotTicker | undefined,
  marketStatus: string | null
): IndexPerformanceSymbol {
  const lastTradePrice = toFiniteNumber(snapshot?.lastTrade?.p);
  const minuteClose = toFiniteNumber(snapshot?.min?.c);
  const dayClose = toFiniteNumber(snapshot?.day?.c);
  const priceUpdatedTimestamp =
    lastTradePrice !== null
      ? snapshot?.lastTrade?.t
      : minuteClose !== null
        ? snapshot?.min?.t
        : dayClose !== null
          ? snapshot?.day?.t
          : snapshot?.updated;

  return {
    symbol,
    lastPrice: lastTradePrice ?? minuteClose ?? dayClose,
    todayChange: toFiniteNumber(snapshot?.todaysChange),
    todayChangePercent: toFiniteNumber(snapshot?.todaysChangePerc),
    dayHigh: toFiniteNumber(snapshot?.day?.h),
    dayLow: toFiniteNumber(snapshot?.day?.l),
    previousClose: toFiniteNumber(snapshot?.prevDay?.c),
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
    const close = toFiniteNumber(bar.c);
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
    const close = toFiniteNumber(bar.c);
    const high = toFiniteNumber(bar.h);
    const low = toFiniteNumber(bar.l);
    const open = toFiniteNumber(bar.o);
    const time = toFiniteNumber(bar.t);

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

  if (!from || !to) {
    return {
      symbol,
      from: null,
      to: null,
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

  const response = await massiveGet<MassiveAggregatesResponse>(
    `/v2/aggs/ticker/${symbol}/range/${config.multiplier}/${config.timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000`
  );

  return {
    symbol,
    from,
    to,
    summary: summarizeAggregateBars(response.results),
    points: normalizeAggregatePoints(response.results),
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
