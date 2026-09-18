import { env } from '../../config/env.js';
import { HttpError } from '../../errors/http-error.js';

/** Massive point-in-time common-stock/reference data client: broad-market grouped daily
 * bars and the point-in-time common-stock reference universe. Shared, generic Massive I/O
 * with no research-specific logic — used by both the Breadth research pass and production
 * BREADTH_V1 live observation ingestion (`breadth-observation-ingestion.service.ts`), which
 * does persist its output into the immutable `MarketBreadthObservation` table. Separate from
 * the strict Trend/Volatility evidence boundary. */

type Page = { status?: unknown; results?: unknown; resultsCount?: unknown; next_url?: unknown };
export type MassiveBreadthTransport = (path: string) => Promise<Page>;
export type GroupedDailyBars = ReadonlyMap<string, number>;
const fail = (message: string): never => { throw new HttpError(502, `Massive breadth reference: ${message}`); };

export async function massiveBreadthGet(path: string): Promise<Page> {
  const base = new URL(env.MASSIVE_BASE_URL);
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.username || url.password) fail('unsafe request destination');
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${env.MASSIVE_API_KEY}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  } catch { return fail('request failed or timed out'); }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'message' in body ? String(body.message) : '';
    const hint = response.status === 403 && /entitle|plan|subscription|upgrade/i.test(message) ? ' (requested date is outside the Massive historical entitlement)' : '';
    return fail(`request returned HTTP ${response.status}${hint}${message ? `: ${message}` : ''}`);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid response object');
  return data as Page;
}
function results(page: Page): unknown[] {
  if (page.status !== 'OK' && page.status !== 'DELAYED') fail('non-success response status');
  if (page.results === undefined && page.resultsCount === 0) return [];
  if (!Array.isArray(page.results)) return fail('missing results array');
  return page.results;
}
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('malformed result');
  return raw as Record<string, unknown>;
}
function positiveFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/** One unpaginated snapshot of every ticker (any type) that traded on `date`.
 * `adjusted=true` keeps adjacent-session comparisons continuous across splits;
 * this research pass accepts Massive's own point-in-time split adjustment rather
 * than fetching per-symbol split evidence for thousands of names. Duplicate
 * tickers in a single page are rejected rather than silently deduplicated. */
export async function fetchGroupedDailyBars(date: string, get: MassiveBreadthTransport = massiveBreadthGet): Promise<GroupedDailyBars> {
  const page = await get(`/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`);
  const bars = new Map<string, number>();
  for (const raw of results(page)) {
    const row = record(raw);
    if (typeof row.T !== 'string' || !row.T) fail('missing ticker symbol');
    const ticker = row.T as string;
    const close = positiveFiniteNumber(row.c);
    if (close === null) fail(`invalid close for ${ticker}`);
    if (bars.has(ticker)) fail(`duplicate ticker ${ticker} in grouped response`);
    bars.set(ticker, close as number);
  }
  return bars;
}

/** The point-in-time eligible common-stock universe: locale=US, market=stocks, type=CS,
 * active as of `date`. Paginated at the provider's maximum page size; a request is never
 * silently short of the full listing. Never call with today's date to infer a past universe. */
export async function fetchCommonStockUniverse(date: string, get: MassiveBreadthTransport = massiveBreadthGet): Promise<readonly string[]> {
  const endpoint = '/v3/reference/tickers';
  let path: string | null = `${endpoint}?locale=us&market=stocks&type=CS&active=true&date=${date}&sort=ticker&limit=1000`;
  const seen = new Set<string>();
  const tickers = new Set<string>();
  while (path) {
    if (seen.has(path) || seen.size >= 50) fail('universe pagination loop or limit');
    seen.add(path);
    const page = await get(path);
    for (const raw of results(page)) {
      const row = record(raw);
      if (typeof row.ticker !== 'string' || !row.ticker) fail('missing ticker in universe result');
      const ticker = row.ticker as string;
      if (row.type !== 'CS' || row.active !== true) fail(`unexpected non-CS/inactive row for ${ticker}`);
      if (tickers.has(ticker)) fail(`duplicate ticker ${ticker} in universe response`);
      tickers.add(ticker);
    }
    const next = page.next_url;
    if (next === undefined || next === null) { path = null; continue; }
    if (typeof next !== 'string' || !next) return fail('invalid universe pagination link');
    const base = new URL(env.MASSIVE_BASE_URL);
    const url = new URL(next, base);
    if (url.origin !== base.origin || url.pathname !== endpoint || url.username || url.password) return fail('unexpected universe pagination destination');
    path = url.pathname + url.search;
  }
  return [...tickers].sort();
}
