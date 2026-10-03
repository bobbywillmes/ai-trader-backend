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

export type TickerLatestPriceSource =
  | 'lastTrade'
  | 'minuteClose'
  | 'dayClose'
  | 'previousClose';

export type TickerLatestPrice = {
  symbol: string;
  latestPrice: number | null;
  latestPriceAt: string | null;
  latestPriceSource: TickerLatestPriceSource | null;
};

export type DailyMarketCandle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type TickerPriceConfirmationSnapshot = {
  symbol: string;
  lastPrice: number | null;
  previousClose: number | null;
  intradayHigh: number | null;
  intradayLow: number | null;
  dayVolume: number | null;
  sessionVwap: number | null;
  updatedTime: string | null;
  observationSource: 'LAST_TRADE' | 'SNAPSHOT' | 'UNKNOWN';
};

export type TickerPriceConfirmationBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  vwap: number | null;
};

export type TickerAggregateBar = TickerPriceConfirmationBar & {
  transactions: number | null;
};

export type GetTickerAggregateBarsArgs = {
  multiplier: number;
  timespan: 'minute' | 'day';
  from: string;
  to: string;
};

export type TickerPriceConfirmationMarketData = {
  symbol: string;
  from: string | null;
  to: string | null;
  snapshot: TickerPriceConfirmationSnapshot;
  minuteBars: TickerPriceConfirmationBar[];
  extendedHoursRequested: boolean;
  rawPayload: {
    snapshot: unknown;
    aggregates: unknown;
  };
};

export type GetTickerPriceConfirmationMarketDataArgs = {
  now?: Date;
  lookbackMinutes?: number;
};

type MassiveMarketStatus = {
  market?: unknown;
  serverTime?: unknown;
};

type MassiveSnapshotBar = {
  c?: unknown;
  h?: unknown;
  l?: unknown;
  v?: unknown;
  vw?: unknown;
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
  v?: unknown;
  vw?: unknown;
  n?: unknown;
};

type MassiveAggregatesResponse = {
  results?: MassiveAggregateBar[];
};

type AggregateRequestConfig = {
  multiplier: number;
  timespan: string;
};

const MIN_VALID_MARKET_YEAR = 2000;
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

function subtractUtcMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() - minutes * 60 * 1000);
}

function isSafeEtDateString(value: string | null): value is string {
  if (!value) {
    return false;
  }

  const year = Number(value.slice(0, 4));

  return Number.isInteger(year) && year >= MIN_VALID_MARKET_YEAR;
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
  ].map((value) => ({ raw: value, milliseconds: toMillisFromMassiveTimestamp(value) }))
    .filter((candidate): candidate is { raw: unknown; milliseconds: number } => candidate.milliseconds !== null)
    .sort((a, b) => b.milliseconds - a.milliseconds);
  const priceUpdatedTimestamp = validPriceTimestampCandidates[0]?.raw ?? snapshot?.prevDay?.t ?? snapshot?.updated;
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

export function normalizeTickerLatestPrice(
  symbol: string,
  snapshot: MassiveSnapshotTicker | undefined
): TickerLatestPrice {
  const candidates: Array<{
    price: number | null;
    source: TickerLatestPriceSource;
    timestamp: unknown;
  }> = [
    {
      price: toPositiveFiniteNumber(snapshot?.lastTrade?.p),
      source: 'lastTrade',
      timestamp: snapshot?.lastTrade?.t,
    },
    {
      price: toPositiveFiniteNumber(snapshot?.min?.c),
      source: 'minuteClose',
      timestamp: snapshot?.min?.t,
    },
    {
      price: toPositiveFiniteNumber(snapshot?.day?.c),
      source: 'dayClose',
      timestamp: snapshot?.day?.t,
    },
    {
      price: toPositiveFiniteNumber(snapshot?.prevDay?.c),
      source: 'previousClose',
      timestamp: snapshot?.prevDay?.t,
    },
  ];
  const latest = candidates.find((candidate) => candidate.price !== null);

  return {
    symbol,
    latestPrice: latest?.price ?? null,
    latestPriceAt: latest
      ? toIsoFromMassiveTimestamp(latest.timestamp) ??
        toIsoFromMassiveTimestamp(snapshot?.updated)
      : null,
    latestPriceSource: latest?.source ?? null,
  };
}

export function normalizeTickerPriceConfirmationSnapshot(
  symbol: string,
  snapshot: MassiveSnapshotTicker | undefined
): TickerPriceConfirmationSnapshot {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const lastTradePrice = toPositiveFiniteNumber(snapshot?.lastTrade?.p);
  const minuteClose = toPositiveFiniteNumber(snapshot?.min?.c);
  const dayClose = toPositiveFiniteNumber(snapshot?.day?.c);
  const previousClose = toPositiveFiniteNumber(snapshot?.prevDay?.c);
  const dayHigh = toPositiveFiniteNumber(snapshot?.day?.h);
  const dayLow = toPositiveFiniteNumber(snapshot?.day?.l);
  const dayVolume = toFiniteNumber(snapshot?.day?.v);
  const sessionVwap = toPositiveFiniteNumber(snapshot?.day?.vw);
  const priceUpdatedTimestamp =
    (lastTradePrice !== null ? snapshot?.lastTrade?.t : null) ??
    (minuteClose !== null ? snapshot?.min?.t : null) ??
    (dayClose !== null ? snapshot?.day?.t : null) ??
    snapshot?.prevDay?.t ??
    snapshot?.updated;

  return {
    symbol: normalizedSymbol,
    lastPrice: lastTradePrice ?? minuteClose ?? dayClose,
    previousClose,
    intradayHigh: dayHigh,
    intradayLow: dayLow,
    dayVolume: dayVolume !== null && dayVolume >= 0 ? dayVolume : null,
    sessionVwap,
    updatedTime: toIsoFromMassiveTimestamp(priceUpdatedTimestamp),
    observationSource: lastTradePrice !== null
      ? 'LAST_TRADE'
      : minuteClose !== null || dayClose !== null
        ? 'SNAPSHOT'
        : 'UNKNOWN',
  };
}

export function normalizeTickerPriceConfirmationBars(
  bars: MassiveAggregateBar[] | undefined
): TickerPriceConfirmationBar[] {
  return (bars ?? []).flatMap((bar) => {
    const close = toPositiveFiniteNumber(bar.c);
    const high = toPositiveFiniteNumber(bar.h);
    const low = toPositiveFiniteNumber(bar.l);
    const open = toPositiveFiniteNumber(bar.o);
    const time = toIsoFromMassiveTimestamp(bar.t);

    if (
      close === null ||
      high === null ||
      low === null ||
      open === null ||
      time === null
    ) {
      return [];
    }

    const volume = toFiniteNumber(bar.v);

    return [
      {
        time,
        open,
        high,
        low,
        close,
        volume: volume !== null && volume >= 0 ? volume : null,
        vwap: toPositiveFiniteNumber(bar.vw),
      },
    ];
  });
}

function normalizeTickerAggregateBars(
  bars: MassiveAggregateBar[] | undefined
): TickerAggregateBar[] {
  return (bars ?? []).flatMap((bar) => {
    const normalized = normalizeTickerPriceConfirmationBars([bar])[0];

    if (!normalized) {
      return [];
    }

    const transactions = toFiniteNumber(bar.n);

    return [{
      ...normalized,
      transactions:
        transactions !== null &&
        Number.isInteger(transactions) &&
        transactions >= 0
          ? transactions
          : null,
    }];
  });
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

export async function getTickerLatestPrice(
  symbol: string
): Promise<TickerLatestPrice> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const response = await massiveGet<MassiveSnapshotResponse>(
    `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(
      normalizedSymbol
    )}`
  );

  return normalizeTickerLatestPrice(normalizedSymbol, response.ticker);
}

export async function getTickerPriceConfirmationMarketData(
  symbol: string,
  args: GetTickerPriceConfirmationMarketDataArgs = {}
): Promise<TickerPriceConfirmationMarketData> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const now = args.now ?? new Date();
  const lookbackMinutes =
    args.lookbackMinutes ?? env.MOMENTUM_CONFIRMATION_LOOKBACK_MINUTES ?? 390;
  const from = getEtDateString(subtractUtcMinutes(now, lookbackMinutes));
  const to = getEtDateString(now);
  const snapshotResponse = await massiveGet<MassiveSnapshotResponse>(
    `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(
      normalizedSymbol
    )}`
  );
  const snapshot = normalizeTickerPriceConfirmationSnapshot(
    normalizedSymbol,
    snapshotResponse.ticker
  );

  if (!isSafeEtDateString(from) || !isSafeEtDateString(to)) {
    return {
      symbol: normalizedSymbol,
      from,
      to,
      snapshot,
      minuteBars: [],
      extendedHoursRequested: true,
      rawPayload: {
        snapshot: snapshotResponse,
        aggregates: null,
      },
    };
  }

  const aggregateResponse = await getAggregateBars(
    normalizedSymbol,
    { multiplier: 1, timespan: 'minute' },
    from,
    to
  );

  return {
    symbol: normalizedSymbol,
    from,
    to,
    snapshot,
    minuteBars: normalizeTickerPriceConfirmationBars(
      aggregateResponse.results
    ),
    extendedHoursRequested: true,
    rawPayload: {
      snapshot: snapshotResponse,
      aggregates: aggregateResponse,
    },
  };
}

async function getAggregateBars(
  symbol: string,
  config: AggregateRequestConfig,
  from: string,
  to: string
) {
  return massiveGet<MassiveAggregatesResponse>(
    `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${config.multiplier}/${config.timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000`
  );
}

export async function getTickerAggregateBars(
  symbol: string,
  args: GetTickerAggregateBarsArgs
): Promise<TickerAggregateBar[]> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const response = await getAggregateBars(
    normalizedSymbol,
    { multiplier: args.multiplier, timespan: args.timespan },
    args.from,
    args.to
  );

  return normalizeTickerAggregateBars(response.results)
    .sort((a, b) => a.time.localeCompare(b.time));
}

function normalizeDailyCandles(
  bars: MassiveAggregateBar[] | undefined
): DailyMarketCandle[] {
  return (bars ?? []).flatMap((bar) => {
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

    const date = getEtDateString(new Date(time));

    if (!date) {
      return [];
    }

    return [
      {
        date,
        open,
        high,
        low,
        close,
        volume: toFiniteNumber(bar.v),
      },
    ];
  });
}

export async function getTickerDailyCandles(
  symbol: string,
  from: string,
  to: string
): Promise<DailyMarketCandle[]> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const response = await getAggregateBars(
    normalizedSymbol,
    { multiplier: 1, timespan: 'day' },
    from,
    to
  );

  return normalizeDailyCandles(response.results);
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
