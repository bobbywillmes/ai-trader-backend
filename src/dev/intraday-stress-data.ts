import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { massiveEvidenceGet, fetchSplitEvidence } from '../integrations/massive/evidence.client.js';
import { env } from '../config/env.js';
import { datesBetween, etDate, marketSession, type CalendarException } from '../services/market-calendar.js';
import { instrumentMeasurements } from '../services/volatility-calculation.js';
import { normalizeSplits, type ResearchSplit } from '../services/trend-calculation.js';
import { measureSession, validDaily, type Bar, type Symbol, type Target } from './intraday-stress-calculation.js';

export const CACHE = path.join('node_modules', '.cache', 'intraday-stress');
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type Envelope<T> = { ok: true; value: T; fetchedAt: string } | { ok: false; error: string; fetchedAt: string };
export let requests = 0;
export async function cached<T>(key: string, fetcher: () => Promise<T>, fetch: boolean): Promise<Envelope<T>> {
  const filename = path.join(CACHE, `${key}.json`);
  try { return JSON.parse(await readFile(filename, 'utf8')) as Envelope<T>; } catch { /* Cache miss. */ }
  if (!fetch) return { ok: false, error: 'NOT_CACHED', fetchedAt: new Date().toISOString() };
  let result: Envelope<T>;
  try { result = { ok: true, value: await fetcher(), fetchedAt: new Date().toISOString() }; }
  catch (error) { result = { ok: false, error: error instanceof Error ? error.message : 'Fetch failed', fetchedAt: new Date().toISOString() }; }
  await mkdir(CACHE, { recursive: true });
  await writeFile(filename, JSON.stringify(result));
  return result;
}
async function get(endpoint: string) {
  if (++requests > 450) throw new Error('Research request budget exhausted (450).');
  return massiveEvidenceGet(endpoint);
}
/** Monthly minute requests stay below 50,000 base minute aggregates. Pagination still checked. */
export async function fetchBars(symbol: Symbol, timeframe: Bar['timeframe'], from: string, to: string, transport = get): Promise<Bar[]> {
  const endpoint = `/v2/aggs/ticker/${symbol}/range/${timeframe === 'DAY_1' ? '1/day' : '15/minute'}/${from}/${to}`;
  let next: string | null = endpoint + '?adjusted=false&sort=asc&limit=50000';
  const seen = new Set<string>(), bars = new Map<number, Bar>();
  while (next) {
    if (seen.has(next) || seen.size >= 10) throw new Error('Pagination loop/limit.');
    seen.add(next);
    const page = await transport(next);
    if (!['OK', 'DELAYED'].includes(String(page.status)) || page.adjusted !== false || page.ticker !== symbol) throw new Error('Provider status/ticker/adjustment mismatch.');
    const results = page.results ?? (page.resultsCount === 0 ? [] : null);
    if (!Array.isArray(results)) throw new Error('Missing aggregate results.');
    for (const row of results) {
      if (!row || typeof row !== 'object' || !['t', 'o', 'h', 'l', 'c', 'v'].every(k => typeof row[k] === 'number' && Number.isFinite(row[k]))) throw new Error('Invalid provider numeric shape.');
      const date = etDate(new Date(row.t));
      if (!Number.isSafeInteger(row.t) || date < from || date > to) throw new Error('Provider timestamp outside requested range.');
      const bar: Bar = { symbol, timeframe, t: row.t, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v };
      if (bars.has(bar.t)) throw new Error('Duplicate provider aggregate interval.');
      bars.set(bar.t, bar);
    }
    next = null;
    if (page.next_url != null) {
      if (typeof page.next_url !== 'string') throw new Error('Invalid pagination URL.');
      const url = new URL(page.next_url, env.MASSIVE_BASE_URL);
      if (url.origin !== new URL(env.MASSIVE_BASE_URL).origin || url.username || url.password || url.pathname !== endpoint) throw new Error('Unsafe pagination destination.');
      url.searchParams.delete('apiKey'); url.searchParams.set('adjusted', 'false');
      next = url.pathname + url.search;
    }
  }
  return [...bars.values()].sort((a, b) => a.t - b.t);
}
export async function splits(symbol: Symbol, from: string, to: string): Promise<ResearchSplit[]> {
  if (symbol === 'SPY' || symbol === 'RSP') return fetchSplitEvidence(symbol, from, to, get);
  // Same contract for diagnostic tickers without broadening the production symbol type.
  const page = await get(`/stocks/v1/splits?ticker=${symbol}&execution_date.gte=${from}&execution_date.lte=${to}&sort=execution_date.asc&limit=1000`);
  if (!['OK', 'DELAYED'].includes(String(page.status)) || page.next_url || !Array.isArray(page.results)) throw new Error('Diagnostic split evidence unavailable/truncated.');
  return page.results.map(row => {
    if (row.ticker !== symbol || typeof row.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.execution_date)
      || row.execution_date < from || row.execution_date > to || !(row.split_from > 0 && row.split_to > 0)) throw new Error('Invalid diagnostic split.');
    return { id: row.id, executionDate: row.execution_date, splitFrom: row.split_from, splitTo: row.split_to, priceFactor: row.split_from / row.split_to };
  });
}
export function months(from: string, to: string): [string, string][] {
  const result: [string, string][] = [];
  for (let cursor = from; cursor <= to;) {
    const next = new Date(`${cursor.slice(0, 7)}-01T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const end = new Date(next.getTime() - 86400000).toISOString().slice(0, 10);
    result.push([cursor, end < to ? end : to]);
    cursor = next.toISOString().slice(0, 10);
  }
  return result;
}
export function baseline(daily: Bar[], events: ResearchSplit[], dates: string[], symbol: Symbol, exceptions: CalendarException[]) {
  const valid = daily.filter(b => validDaily(b, symbol, exceptions));
  const normalized = normalizeSplits(valid.map((b, id) => ({ ...b, id, date: etDate(new Date(b.t)) })), events, dates.at(-1)!);
  const map = new Map(normalized.map(b => [b.date, b]));
  const seen = new Set<string>();
  for (const b of normalized) { if (seen.has(b.date)) map.delete(b.date); seen.add(b.date); }
  const measurements = instrumentMeasurements(dates.map(date => map.get(date) ?? null));
  // Future split factors uniformly rescale every prefix; ATR/close is invariant. No current OHLC is used.
  return new Map(dates.map((date, i) => [date, i ? (measurements[i - 1]?.ATR14Pct?.value ?? 0) / 100 || null : null]));
}
export function measureHistory(symbol: Symbol, daily: Bar[], intraday: Bar[], events: ResearchSplit[], from: string, to: string, exceptions: CalendarException[]) {
  const dates = datesBetween('2021-01-01', to).filter(d => marketSession(d, exceptions));
  const atr = baseline(daily, events, dates, symbol, exceptions);
  const byDate = new Map<string, Bar[]>();
  const rejected: { t: number; reason: string }[] = [];
  let outsideRegularSession = 0;
  for (const bar of intraday) {
    const date = etDate(new Date(bar.t)), session = marketSession(date, exceptions);
    if (!session || bar.t < session.openAt.getTime() || bar.t >= session.closeAt.getTime()) { outsideRegularSession++; continue; }
    if ((bar.t - session.openAt.getTime()) % 900000) { rejected.push({ t: bar.t, reason: 'MISALIGNED_INTERVAL' }); continue; }
    const rows = byDate.get(date) ?? []; rows.push(bar); byDate.set(date, rows);
  }
  const targets: Target[] = [];
  for (const date of dates.filter(d => d >= from)) targets.push(...measureSession(symbol, date, byDate.get(date) ?? [], atr.get(date) ?? null, exceptions));
  return { targets, rejected, outsideRegularSession, invalidDaily: daily.filter(b => !validDaily(b, symbol, exceptions)).map(b => b.t) };
}
