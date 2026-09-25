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
      if (!response.ok) throw new Error(`Tiingo HTTP ${response.status}`);
      return await response.json().catch(() => { throw new Error('Tiingo returned invalid JSON'); });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Tiingo ')) throw error;
      throw new Error('Tiingo request failed or timed out');
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
