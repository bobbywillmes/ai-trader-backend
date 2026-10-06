import { z } from 'zod';
import { env } from '../../config/env.js';

const date = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });
const positive = z.number().finite().positive();
const volume = z.number().finite().nonnegative();
const ohlcv = z.object({ open: positive, high: positive, low: positive, close: positive, volume }).strict()
  .refine(bar => bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close, bar.low), 'Inconsistent OHLC');
const dailyRow = z.object({ date: timestamp, open: positive, high: positive, low: positive, close: positive, volume,
  splitFactor: positive }).passthrough();
const intradayRow = z.object({ date: timestamp, open: positive, high: positive, low: positive, close: positive, volume }).passthrough();

/** Security.symbol stays canonical; Tiingo uses a hyphen for a single share-class suffix. */
export function tiingoSymbol(symbol: string): string {
  if (!/^[A-Z][A-Z0-9]{0,9}(?:\.[A-Z])?$/.test(symbol)) throw new Error('Unsupported Tiingo symbol form');
  return symbol.replace('.', '-');
}

export class TiingoRequestError extends Error {
  constructor(readonly status: number | null, readonly retryAfterMs: number | null = null) {
    super(status === null ? 'Tiingo transport failure' : `Tiingo HTTP ${status}`);
  }
}

export type TiingoBar = { barStartAt: Date; open: number; high: number; low: number; close: number; volume: number; splitFactor?: number };

function bars(input: unknown, kind: 'daily' | 'intraday'): TiingoBar[] {
  const rows = z.array(kind === 'daily' ? dailyRow : intradayRow).parse(input);
  const seen = new Set<number>();
  return rows.map(row => {
    ohlcv.parse({ open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
    const barStartAt = new Date(row.date);
    if (seen.has(barStartAt.getTime())) throw new Error('Tiingo returned duplicate bar timestamps');
    seen.add(barStartAt.getTime());
    if (kind === 'daily' && (row.date.slice(11, 19) !== '00:00:00' || !row.date.endsWith('Z'))) {
      throw new Error('Tiingo daily date must be UTC midnight');
    }
    return { barStartAt, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
      ...(kind === 'daily' ? { splitFactor: (row as z.infer<typeof dailyRow>).splitFactor } : {}) };
  });
}

export const normalizeTiingoDaily = (input: unknown) => bars(input, 'daily');
export const normalizeTiingoIntraday = (input: unknown) => bars(input, 'intraday');
const nullablePrice = positive.nullable().optional();
const snapshotRow = z.object({
  ticker: z.string().min(1).nullable().optional(), timestamp: timestamp.nullable().optional(),
  tngoLast: nullablePrice, lqRefPrice: nullablePrice, prevClose: nullablePrice,
  open: nullablePrice, high: nullablePrice, low: nullablePrice,
  volume: volume.nullable().optional(),
}).passthrough();

export type TiingoRealtimeSnapshot = {
  provider: 'TIINGO_CONSOLIDATED' | 'TIINGO_IEX'; symbol: string;
  observedAt: Date | null; fetchedAt: Date;
  referencePrice: number | null; referencePriceSource: 'TNGO_LAST' | 'LQ_REF_PRICE' | null;
  previousClose: number | null; open: number | null; high: number | null;
  low: number | null; volume: number | null; extendedHours: true;
};

function snapshotRecord(input: unknown) {
  return snapshotRow.parse(z.array(z.unknown()).parse(input)[0]);
}

export function normalizeTiingoConsolidatedSnapshot(input: unknown, symbol: string, fetchedAt = new Date()): TiingoRealtimeSnapshot {
  const row = snapshotRecord(input);
  if (row.ticker && row.ticker.toUpperCase().replace('-', '.') !== symbol.toUpperCase()) throw new Error('Tiingo snapshot ticker mismatch');
  return { provider: 'TIINGO_CONSOLIDATED', symbol: symbol.toUpperCase(),
    observedAt: row.timestamp ? new Date(row.timestamp) : null, fetchedAt,
    referencePrice: row.tngoLast ?? row.lqRefPrice ?? null,
    referencePriceSource: row.tngoLast != null ? 'TNGO_LAST' : row.lqRefPrice != null ? 'LQ_REF_PRICE' : null,
    previousClose: row.prevClose ?? null, open: row.open ?? null, high: row.high ?? null,
    low: row.low ?? null, volume: row.volume ?? null, extendedHours: true };
}

export function normalizeTiingoIexSnapshot(input: unknown, symbol: string, fetchedAt = new Date()): TiingoRealtimeSnapshot {
  const row = snapshotRecord(input);
  if (row.ticker && row.ticker.toUpperCase().replace('-', '.') !== symbol.toUpperCase()) throw new Error('Tiingo IEX snapshot ticker mismatch');
  return { provider: 'TIINGO_IEX', symbol: symbol.toUpperCase(),
    observedAt: row.timestamp ? new Date(row.timestamp) : null, fetchedAt,
    referencePrice: row.tngoLast ?? null, referencePriceSource: row.tngoLast != null ? 'TNGO_LAST' : null,
    previousClose: row.prevClose ?? null, open: row.open ?? null, high: row.high ?? null,
    low: row.low ?? null, volume: row.volume ?? null, extendedHours: true };
}
export function normalizeTiingoLatest(input: unknown, symbol: string) {
  const rows = normalizeTiingoIntraday(input).sort((a, b) => a.barStartAt.getTime() - b.barStartAt.getTime());
  const row = rows.at(-1);
  if (!row) throw new Error('Tiingo latest observation unavailable');
  return { symbol: symbol.toUpperCase(), price: row.close, observedAt: row.barStartAt };
}

// Per-process bound. Later distributed ingestion must still coordinate its own rate budget.
export class TiingoRestClient {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly config: { token: string; baseUrl?: string; timeoutMs?: number; maxConcurrency?: number; fetcher?: typeof fetch }) {
    if (!config.token || !Number.isInteger(config.maxConcurrency ?? 8) || (config.maxConcurrency ?? 8) < 1) throw new Error('Invalid Tiingo client configuration');
  }
  private async get(path: string, params: Record<string, string>) {
    if (this.active >= (this.config.maxConcurrency ?? 8)) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active++;
    try {
      const url = new URL(path, this.config.baseUrl ?? 'https://api.tiingo.com');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await (this.config.fetcher ?? fetch)(url, {
        headers: { Accept: 'application/json', Authorization: `Token ${this.config.token}` },
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10000),
      });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
        const parsed = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
        throw new TiingoRequestError(response.status, Number.isFinite(parsed) ? Math.max(0, parsed) : null);
      }
      return await response.json().catch(() => { throw new Error('Tiingo returned invalid JSON'); });
    } catch (error) {
      if (error instanceof TiingoRequestError || (error instanceof Error && error.message.startsWith('Tiingo '))) throw error;
      throw new TiingoRequestError(null);
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
  async daily(symbol: string, startDate: string, endDate: string) {
    date.parse(startDate); date.parse(endDate);
    return normalizeTiingoDaily(await this.get(`/tiingo/daily/${encodeURIComponent(symbol)}/prices`, { startDate, endDate }));
  }
  async intraday(symbol: string, startDate: string, endDate: string) {
    date.parse(startDate); date.parse(endDate);
    return normalizeTiingoIntraday(await this.get(`/tiingo/equity/intraday/${encodeURIComponent(symbol)}/prices`,
      { startDate, endDate, resampleFreq: '15min', afterHours: 'false', forceFill: 'false' }));
  }
  async intradayMinutes(symbol: string, sessionDate: string) {
    date.parse(sessionDate);
    return normalizeTiingoIntraday(await this.get(`/tiingo/equity/intraday/${encodeURIComponent(symbol)}/prices`,
      { startDate: sessionDate, endDate: sessionDate, resampleFreq: '1min', afterHours: 'false', forceFill: 'false' }));
  }
  async intradayHistory(symbol: string, startDate: string, endDate: string,
    options: { resampleFreq: '1min' | '5min' | '15min'; afterHours: boolean }) {
    date.parse(startDate); date.parse(endDate);
    return normalizeTiingoIntraday(await this.get(`/tiingo/equity/intraday/${encodeURIComponent(tiingoSymbol(symbol))}/prices`,
      { startDate, endDate, resampleFreq: options.resampleFreq, afterHours: String(options.afterHours),
        forceFill: 'false', columns: 'open,high,low,close,volume' }));
  }
  async consolidatedSnapshot(symbol: string) {
    return normalizeTiingoConsolidatedSnapshot(await this.get(`/tiingo/equity/intraday/${encodeURIComponent(tiingoSymbol(symbol))}`, {}), symbol);
  }
  async iexSnapshot(symbol: string) {
    return normalizeTiingoIexSnapshot(await this.get(`/iex/${encodeURIComponent(tiingoSymbol(symbol))}`, {}), symbol);
  }
  async latest(symbol: string, startDate: string, endDate: string) {
    date.parse(startDate); date.parse(endDate);
    return normalizeTiingoLatest(await this.get(`/tiingo/equity/intraday/${encodeURIComponent(symbol)}/prices`,
      { startDate, endDate, resampleFreq: '1min', afterHours: 'false', forceFill: 'false' }), symbol);
  }
}

export function configuredTiingoRestClient() {
  if (!env.TIINGO_API_TOKEN) throw new Error('TIINGO_API_TOKEN is required for Tiingo requests');
  return new TiingoRestClient({ token: env.TIINGO_API_TOKEN, baseUrl: env.TIINGO_BASE_URL,
    timeoutMs: env.TIINGO_TIMEOUT_MS, maxConcurrency: env.TIINGO_MAX_CONCURRENCY });
}
