import { getTickerLatestPrice, type TickerLatestPrice } from './massive-market-data.service.js';
import { massiveEvidenceGet } from '../integrations/massive/evidence.client.js';
import { env } from '../config/env.js';
import { configuredTiingoRestClient, type TiingoBar, type TiingoRealtimeSnapshot } from '../integrations/tiingo/rest.client.js';
import { TiingoRequestError } from '../integrations/tiingo/rest.client.js';
import type { CapabilityProvider, CapabilityUnavailableReason, ReferencePriceEvidence, RegularMinute, RegularSessionMinuteEvidence } from './live-market-data.contracts.js';

const MAX_PRICE_AGE_MS = 5 * 60_000;
const nyDate = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const nyClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateInNy = (date: Date) => {
  const parts = nyDate.formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const minuteInNy = (date: Date) => {
  const parts = nyClock.formatToParts(date);
  return Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value);
};
const validPrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const iso = (date: Date) => date.toISOString();

export function normalizeReferencePrice(symbol: string, provider: CapabilityProvider,
  source: TickerLatestPrice | TiingoRealtimeSnapshot, fetchedAt: Date): ReferencePriceEvidence {
  const massive = provider === 'MASSIVE';
  const candidate = massive ? source as TickerLatestPrice : source as TiingoRealtimeSnapshot;
  const price = massive ? (candidate as TickerLatestPrice).latestPrice : (candidate as TiingoRealtimeSnapshot).referencePrice;
  const basis = massive ? ((candidate as TickerLatestPrice).latestPriceSource ? ({ lastTrade: 'LAST_TRADE', minuteClose: 'MINUTE_CLOSE', dayClose: 'DAY_CLOSE', previousClose: 'PREVIOUS_CLOSE' } as const)[(candidate as TickerLatestPrice).latestPriceSource!] : null)
    : (candidate as TiingoRealtimeSnapshot).referencePriceSource === 'TNGO_LAST' ? 'TIINGO_TNGO_LAST'
      : (candidate as TiingoRealtimeSnapshot).referencePriceSource === 'LQ_REF_PRICE' ? 'TIINGO_LQ_REF_PRICE' : null;
  const observedAt = massive ? (candidate as TickerLatestPrice).latestPriceAt : (candidate as TiingoRealtimeSnapshot).observedAt;
  const observedMs = observedAt instanceof Date ? observedAt.getTime() : observedAt ? Date.parse(observedAt) : NaN;
  const freshness = !Number.isFinite(observedMs) ? 'UNKNOWN' : observedMs > fetchedAt.getTime() ? 'FUTURE'
    : fetchedAt.getTime() - observedMs > MAX_PRICE_AGE_MS ? 'STALE' : 'FRESH';
  const unavailableReason: CapabilityUnavailableReason | null = !validPrice(price) ? 'NO_PRICE'
    : basis === null ? 'MALFORMED_RESPONSE'
    : basis === 'PREVIOUS_CLOSE' ? 'PREVIOUS_CLOSE_ONLY'
      : freshness === 'UNKNOWN' ? 'MISSING_TIMESTAMP' : freshness === 'FUTURE' ? 'FUTURE_TIMESTAMP'
        : freshness === 'STALE' ? 'STALE_OBSERVATION' : null;
  return { symbol, provider, price: validPrice(price) ? price : null, basis: basis ?? null,
    observedAt: Number.isFinite(observedMs) ? iso(new Date(observedMs)) : null, fetchedAt: iso(fetchedAt),
    freshness, available: unavailableReason === null, unavailableReason, providerError: null };
}

export async function verifyReferencePrice(symbol: string, provider: CapabilityProvider, now?: Date,
  fetchers: { massive?: typeof getTickerLatestPrice; tiingo?: (symbol: string) => Promise<TiingoRealtimeSnapshot> } = {}): Promise<ReferencePriceEvidence> {
  const normalized = symbol.trim().toUpperCase();
  try {
    const source = provider === 'MASSIVE' ? await (fetchers.massive ?? getTickerLatestPrice)(normalized)
      : await (fetchers.tiingo ?? (s => configuredTiingoRestClient().consolidatedSnapshot(s)))(normalized);
    if (source.symbol !== normalized || (provider === 'TIINGO_CONSOLIDATED' && (source as TiingoRealtimeSnapshot).provider !== provider)) throw new Error('Provider identity mismatch');
    return normalizeReferencePrice(normalized, provider, source, now ?? new Date());
  } catch (error) {
    const malformed = error instanceof Error && /invalid|malform|mismatch|Zod/i.test(error.message);
    const status = error instanceof TiingoRequestError ? error.status
      : error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : null;
    return { symbol: normalized, provider, price: null, basis: null, observedAt: null, fetchedAt: iso(now ?? new Date()),
      freshness: 'UNKNOWN', available: false, unavailableReason: malformed ? 'MALFORMED_RESPONSE' : 'PROVIDER_ERROR',
      providerError: malformed ? null : status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP_${status}` : 'REQUEST_FAILED' };
  }
}

type RawMinute = { barStartAt: Date; open: number; high: number; low: number; close: number; volume: number };
type MassivePage = { status?: unknown; adjusted?: unknown; ticker?: unknown; results?: unknown; resultsCount?: unknown; next_url?: unknown };
export async function fetchMassiveRawMinutes(symbol: string, sessionDate: string): Promise<RawMinute[]> {
  const endpoint = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/minute/${sessionDate}/${sessionDate}`;
  let path: string | null = `${endpoint}?adjusted=false&sort=asc&limit=50000`;
  const seen = new Set<string>();
  const rows: RawMinute[] = [];
  while (path) {
    if (seen.has(path) || seen.size >= 10) throw new Error('Malformed Massive pagination');
    seen.add(path);
    const page: MassivePage = await massiveEvidenceGet(path);
    if ((page.status !== 'OK' && page.status !== 'DELAYED') || page.adjusted !== false || page.ticker !== symbol ||
      (!Array.isArray(page.results) && !(page.results === undefined && page.resultsCount === 0))) throw new Error('Malformed Massive raw minute response');
    for (const value of (page.results ?? []) as unknown[]) {
      if (!value || typeof value !== 'object') throw new Error('Malformed Massive raw minute');
      const bar = value as Record<string, unknown>;
      if (typeof bar.t !== 'number' || !Number.isSafeInteger(bar.t)) throw new Error('Malformed Massive minute timestamp');
      rows.push({ barStartAt: new Date(bar.t), open: bar.o as number, high: bar.h as number,
        low: bar.l as number, close: bar.c as number, volume: bar.v as number });
    }
    if (page.next_url == null) path = null;
    else {
      if (typeof page.next_url !== 'string') throw new Error('Malformed Massive pagination');
      const url = new URL(page.next_url, env.MASSIVE_BASE_URL);
      if (url.origin !== new URL(env.MASSIVE_BASE_URL).origin || url.username || url.password || url.pathname !== endpoint ||
        url.searchParams.get('adjusted') !== 'false' || url.searchParams.has('apiKey')) throw new Error('Malformed Massive pagination');
      path = url.pathname + url.search;
    }
  }
  return rows;
}

export function normalizeRegularMinutes(symbol: string, provider: CapabilityProvider, sessionDate: string,
  source: readonly RawMinute[], fetchedAt: Date, cutoff: Date): RegularSessionMinuteEvidence {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate) || !Number.isFinite(Date.parse(`${sessionDate}T00:00:00Z`))) throw new Error('Invalid session date');
  const cutoffMinute = dateInNy(cutoff) < sessionDate ? 569 : dateInNy(cutoff) > sessionDate ? 959 : Math.min(959, minuteInNy(cutoff));
  const finalMinute = cutoffMinute;
  const expectedMinuteCount = Math.max(0, finalMinute - 569);
  const kept = new Map<number, RegularMinute>();
  let invalid = false;
  for (const bar of source) {
    const time = bar.barStartAt;
    if (!(time instanceof Date) || !Number.isFinite(time.getTime())) { invalid = true; continue; }
    if (dateInNy(time) !== sessionDate) continue;
    const minute = minuteInNy(time);
    if (minute < 570 || minute > 959 || minute > finalMinute) continue;
    if (time.getUTCSeconds() !== 0 || time.getUTCMilliseconds() !== 0 ||
      ![bar.open, bar.high, bar.low, bar.close].every(validPrice) ||
      !Number.isFinite(bar.volume) || bar.volume < 0 ||
      bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close, bar.low) || kept.has(minute)) { invalid = true; continue; }
    kept.set(minute, { time: iso(time), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
  }
  const minutes = [...kept.values()].sort((a, b) => a.time.localeCompare(b.time));
  const observedMinuteCount = minutes.length;
  const complete = !invalid && expectedMinuteCount > 0 && observedMinuteCount === expectedMinuteCount;
  return { symbol, provider, sessionDate, session: 'AMERICA_NEW_YORK_REGULAR_0930_1559', adjustmentMode: 'UNADJUSTED',
    minutes, expectedMinuteCount, observedMinuteCount, complete, observedThrough: minutes.at(-1)?.time ?? null,
    cutoff: iso(cutoff), fetchedAt: iso(fetchedAt),
    unavailableReason: invalid ? 'INVALID_MINUTE' : observedMinuteCount === 0 ? 'NO_MINUTES'
      : !complete ? 'INCOMPLETE_MINUTES' : null };
}

export async function verifyRegularSessionMinutes(symbol: string, provider: CapabilityProvider, sessionDate: string,
  cutoff: Date, now = new Date(), fetchers: { massive?: typeof fetchMassiveRawMinutes; tiingo?: (symbol: string, date: string) => Promise<TiingoBar[]> } = {}): Promise<RegularSessionMinuteEvidence> {
  const normalized = symbol.trim().toUpperCase();
  try {
    const rows = provider === 'MASSIVE' ? await (fetchers.massive ?? fetchMassiveRawMinutes)(normalized, sessionDate)
      : await (fetchers.tiingo ?? ((s, d) => configuredTiingoRestClient().intradayHistory(s, d, d, { resampleFreq: '1min', afterHours: false })))(normalized, sessionDate);
    return normalizeRegularMinutes(normalized, provider, sessionDate, rows, now, cutoff);
  } catch (error) {
    const reason = error instanceof Error && /invalid|malform|Zod/i.test(error.message) ? 'MALFORMED_RESPONSE' : 'PROVIDER_ERROR';
    return { symbol: normalized, provider, sessionDate, session: 'AMERICA_NEW_YORK_REGULAR_0930_1559', adjustmentMode: 'UNADJUSTED',
      minutes: [], expectedMinuteCount: dateInNy(cutoff) < sessionDate ? 0 : dateInNy(cutoff) > sessionDate ? 390 : Math.max(0, Math.min(959, minuteInNy(cutoff)) - 569), observedMinuteCount: 0, complete: false, observedThrough: null,
      cutoff: iso(cutoff), fetchedAt: iso(now), unavailableReason: reason };
  }
}
