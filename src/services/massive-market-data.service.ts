import { env } from '../config/env.js';
import { HttpError } from '../errors/http-error.js';

const INDEX_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM'] as const;

export type IndexSymbol = (typeof INDEX_SYMBOLS)[number];

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

export type IndexIntradaySymbol = {
  symbol: IndexSymbol;
  date: string | null;
  points: IndexIntradayPoint[];
};

export type IndexIntradayResponse = {
  updatedAt: string;
  intervalMinutes: number;
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

async function getTickerIntraday(
  symbol: IndexSymbol,
  snapshot: IndexPerformanceSymbol
): Promise<IndexIntradaySymbol> {
  const sourceDate = snapshot.updatedTime
    ? new Date(snapshot.updatedTime)
    : new Date();
  const date = Number.isNaN(sourceDate.getTime())
    ? getEtDateString(new Date())
    : getEtDateString(sourceDate);

  if (!date) {
    return {
      symbol,
      date: null,
      points: [],
    };
  }

  const response = await massiveGet<MassiveAggregatesResponse>(
    `/v2/aggs/ticker/${symbol}/range/5/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000`
  );

  return {
    symbol,
    date,
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

export async function getIndexIntraday(): Promise<IndexIntradayResponse> {
  const performance = await getIndexPerformance();
  const symbols = await Promise.all(
    performance.symbols.map((symbol) =>
      getTickerIntraday(symbol.symbol, symbol)
    )
  );

  return {
    updatedAt: new Date().toISOString(),
    intervalMinutes: 5,
    symbols,
  };
}
