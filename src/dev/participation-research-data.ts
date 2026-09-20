/** Research-only five-symbol adapter. Production TrendSymbol and evidence parsers stay unchanged. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { etDate, etInstant, validDate } from '../services/market-calendar.js';
import type { ResearchSplit } from '../services/trend-calculation.js';
import { validateSplits, type ParticipationSymbol } from './participation-calculation.js';

export const PARTICIPATION_CACHE = path.join('node_modules', '.cache', 'participation-v1');
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type RawPage = { status?: unknown; adjusted?: unknown; ticker?: unknown; results?: unknown; resultsCount?: unknown; next_url?: unknown };
export type Transport = (endpoint: string) => Promise<RawPage>;
export type RawBar = { date: string; t: number; o: number; h: number; l: number; c: number; v: number };
export type Evidence = { pages: RawPage[] };
type Envelope = { version: 1; key: string; fetchedAt: string; result: { ok: true; evidence: Evidence; digest: string } | { ok: false; error: string } };
export type CacheResult = { ok: true; evidence: Evidence } | { ok: false; error: string };

function rows(page: RawPage): Record<string, unknown>[] {
  if (page.status !== 'OK' && page.status !== 'DELAYED') throw new Error('PROVIDER_NON_SUCCESS_STATUS');
  const results = page.results ?? (page.resultsCount === 0 ? [] : null);
  if (!Array.isArray(results) || results.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('MALFORMED_PROVIDER_RESULTS');
  return results as Record<string, unknown>[];
}
export function parseDaily(evidence: Evidence, symbol: ParticipationSymbol, from: string, to: string): RawBar[] {
  const bars = new Map<string, RawBar>();
  for (const page of evidence.pages) {
    if (page.adjusted !== false || page.ticker !== symbol) throw new Error('PROVIDER_TICKER_OR_ADJUSTMENT_MISMATCH');
    for (const row of rows(page)) {
      if (!['t', 'o', 'h', 'l', 'c', 'v'].every(k => typeof row[k] === 'number' && Number.isFinite(row[k]))) throw new Error('INVALID_DAILY_NUMERIC_SHAPE');
      const r = row as Record<string, number>, timestamp = new Date(r.t!);
      if (!Number.isSafeInteger(r.t) || !Number.isFinite(timestamp.getTime())) throw new Error('INVALID_TIMESTAMP');
      const date = etDate(timestamp);
      if (date < from || date > to || etInstant(date, 0).getTime() !== r.t) throw new Error('INVALID_DAILY_DATE');
      if (r.v! < 0 || Math.min(r.o!, r.h!, r.l!, r.c!) <= 0 || r.l! > Math.min(r.o!, r.c!) || r.h! < Math.max(r.o!, r.c!) || r.h! < r.l!) throw new Error('INVALID_DAILY_OHLCV');
      if (bars.has(date)) throw new Error('DUPLICATE_DAILY_DATE');
      bars.set(date, { date, t: r.t!, o: r.o!, h: r.h!, l: r.l!, c: r.c!, v: r.v! });
    }
  }
  return [...bars.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function parseSplits(evidence: Evidence, symbol: ParticipationSymbol, from: string, to: string): ResearchSplit[] {
  const splits = evidence.pages.flatMap(page => rows(page).map(row => {
    if (row.ticker !== symbol || typeof row.id !== 'string' || !row.id || typeof row.execution_date !== 'string'
      || !validDate(row.execution_date) || row.execution_date < from || row.execution_date > to
      || typeof row.split_from !== 'number' || typeof row.split_to !== 'number') throw new Error('INVALID_SPLIT_SHAPE');
    return { id: row.id, executionDate: row.execution_date, splitFrom: row.split_from, splitTo: row.split_to, priceFactor: row.split_from / row.split_to };
  }));
  validateSplits(splits);
  return splits.sort((a, b) => a.executionDate.localeCompare(b.executionDate));
}

/** Same-origin/path pagination; no credentials or arbitrary provider metadata persisted. */
export async function fetchEvidence(kind: 'daily' | 'splits', symbol: ParticipationSymbol, from: string, to: string,
  get: Transport, baseUrl: string): Promise<Evidence> {
  const endpoint = kind === 'daily' ? `/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}` : '/stocks/v1/splits';
  let next: string | null = kind === 'daily' ? `${endpoint}?adjusted=false&sort=asc&limit=50000`
    : `${endpoint}?ticker=${symbol}&execution_date.gte=${from}&execution_date.lte=${to}&sort=execution_date.asc&limit=1000`;
  const seen = new Set<string>(), pages: RawPage[] = [];
  while (next) {
    if (seen.has(next) || seen.size >= 5) throw new Error('PAGINATION_LOOP_OR_LIMIT');
    seen.add(next);
    const page = await get(next);
    rows(page);
    // Retain raw observations and contract metadata, excluding links which can carry API keys.
    pages.push({ status: page.status, ...(kind === 'daily' ? { adjusted: page.adjusted, ticker: page.ticker } : {}),
      results: page.results ?? [], ...(page.resultsCount !== undefined ? { resultsCount: page.resultsCount } : {}) });
    next = null;
    if (page.next_url != null) {
      if (typeof page.next_url !== 'string' || !page.next_url) throw new Error('INVALID_PAGINATION');
      const url = new URL(page.next_url, baseUrl), base = new URL(baseUrl);
      // Massive aggregate pagination may advance the range start. Validate the complete shape.
      const prefix = `/v2/aggs/ticker/${symbol}/range/1/day/`;
      const tail = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).split('/') : [];
      const validDailyPath = tail.length === 2 && tail.every(validDate) && tail[0]! >= from && tail[0]! <= to && tail[1] === to;
      if (url.origin !== base.origin || url.username || url.password || url.hash
        || (kind === 'daily' ? !validDailyPath : url.pathname !== endpoint)) throw new Error('UNSAFE_PAGINATION');
      url.searchParams.delete('apiKey');
      if (kind === 'daily') url.searchParams.set('adjusted', 'false');
      else { url.searchParams.set('ticker', symbol); url.searchParams.set('execution_date.gte', from); url.searchParams.set('execution_date.lte', to); }
      next = url.pathname + url.search;
    }
  }
  const evidence = { pages };
  if (kind === 'daily') parseDaily(evidence, symbol, from, to); else parseSplits(evidence, symbol, from, to);
  return evidence;
}

export class ParticipationCache {
  requests = 0;
  hits = 0;
  constructor(readonly directory: string, readonly fetchEnabled: boolean, readonly refresh: boolean,
    readonly maxRequests: number, readonly transport: Transport, readonly baseUrl: string) {
    if (refresh && !fetchEnabled) throw new Error('--refresh requires --fetch.');
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 300) throw new Error('Request budget must be 1..300.');
  }
  async load(kind: 'daily' | 'splits', symbol: ParticipationSymbol, from: string, to: string): Promise<CacheResult> {
    const key = `v1-${symbol}-${kind}-${from}-${to}`, file = path.join(this.directory, `${key}.json`);
    if (!this.refresh) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as Envelope;
        if (cached.version !== 1 || cached.key !== key || typeof cached.result?.ok !== 'boolean') throw new Error('INVALID_CACHE');
        if (cached.result.ok && cached.result.digest !== digest(cached.result.evidence)) throw new Error('CACHE_DIGEST_MISMATCH');
        this.hits++;
        return cached.result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: 'INVALID_CACHE_USE_REFRESH' };
      }
    }
    if (!this.fetchEnabled) return { ok: false, error: 'NOT_CACHED' };
    if (this.requests >= this.maxRequests) return { ok: false, error: 'REQUEST_BUDGET_EXHAUSTED' };
    let result: Envelope['result'];
    try {
      const evidence = await fetchEvidence(kind, symbol, from, to, async endpoint => {
        if (this.requests >= this.maxRequests) throw new Error('REQUEST_BUDGET_EXHAUSTED');
        this.requests++;
        return this.transport(endpoint);
      }, this.baseUrl);
      result = { ok: true, evidence, digest: digest(evidence) };
    } catch (error) {
      // Production transport errors are sanitized; never retain arbitrary provider bodies/URLs.
      const message = error instanceof Error ? error.message : '';
      const safe = /^[A-Z_]+$/.test(message) || /^Massive evidence: request (returned HTTP \d{3}( \(requested history is outside the Massive subscription entitlement\))?|failed or timed out)$/.test(message);
      result = { ok: false, error: safe ? message : 'PROVIDER_EVIDENCE_FAILURE' };
    }
    // Budget exhaustion is local, transient, and must not poison a resumed run.
    if (!result.ok && result.error === 'REQUEST_BUDGET_EXHAUSTED') return result;
    await mkdir(this.directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, key, fetchedAt: new Date().toISOString(), result } satisfies Envelope));
    await rename(temporary, file);
    return result;
  }
}
