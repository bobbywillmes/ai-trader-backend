import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { HttpError } from '../../errors/http-error.js';
import { etDate, etInstant, etMinutesOfDay, SESSION_OPEN_MINUTES, SESSION_CLOSE_MINUTES, validDate } from '../../services/market-calendar.js';
import type { TrendSymbol } from '../../services/trend-lab.config.js';

type Page = { status?: unknown; adjusted?: unknown; ticker?: unknown; results?: unknown; resultsCount?: unknown; next_url?: unknown };
export type DailyEvidenceBar = { barStartAt: Date; open: string; high: string; low: string; close: string; volume: string; receivedAt: Date };
export type SplitEvent = { id: string; symbol: TrendSymbol; executionDate: string; splitFrom: number; splitTo: number; priceFactor: number };
export type MassiveEvidenceTransport = (path: string) => Promise<Page>;
const fail = (message: string): never => { throw new HttpError(502, `Massive evidence: ${message}`); };

/** Separate strict boundary: chart/live normalizers remain unchanged. Credentials use the existing Massive configuration. */
export async function massiveEvidenceGet(path: string): Promise<Page> {
  const base = new URL(env.MASSIVE_BASE_URL);
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.username || url.password) fail('unsafe pagination destination');
  url.searchParams.delete('apiKey');
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${env.MASSIVE_API_KEY}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  } catch { return fail('request failed or timed out'); }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'message' in body ? String(body.message) : '';
    const hint = response.status === 403 && /plan|subscription|entitle|upgrade|timeframe/i.test(message) ? ' (requested history is outside the Massive subscription entitlement)' : '';
    return fail(`request returned HTTP ${response.status}${hint}`);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid response object');
  return data as Page;
}
function decimal(value: unknown, name: string, positive: boolean): string {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return fail(`invalid ${name}`);
  let parsed: Prisma.Decimal;
  try { parsed = new Prisma.Decimal(value); } catch { return fail(`invalid ${name}`); }
  const scale = name === 'volume' ? 6 : 10;
  const integerDigits = name === 'volume' ? 24 : 14;
  if (!parsed.isFinite() || (positive ? parsed.lte(0) : parsed.lt(0)) || parsed.decimalPlaces() > scale || parsed.gte(new Prisma.Decimal(10).pow(integerDigits))) return fail(`invalid or unrepresentable ${name}`);
  return parsed.toFixed();
}
function results(page: Page): unknown[] {
  if (page.status !== 'OK' && page.status !== 'DELAYED') fail('non-success response status');
  if (page.results === undefined && page.resultsCount === 0) return [];
  if (!Array.isArray(page.results)) return fail('missing results array');
  return page.results;
}
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('malformed observation');
  return raw as Record<string, unknown>;
}
function nextPage(page: Page, endpoint: string, adjusted: boolean): string | null {
  if (page.next_url === undefined || page.next_url === null) return null;
  if (typeof page.next_url !== 'string' || !page.next_url) return fail('invalid pagination link');
  const base = new URL(env.MASSIVE_BASE_URL);
  const url = new URL(page.next_url, base);
  const aggregatePrefix = endpoint.split('/').slice(0, 8).join('/') + '/';
  const matchingEndpoint = adjusted ? url.pathname.startsWith(aggregatePrefix) && url.pathname.split('/').length === 10 : url.pathname === endpoint;
  if (url.origin !== base.origin || !matchingEndpoint || url.username || url.password) return fail('unexpected pagination destination');
  url.searchParams.delete('apiKey');
  if (adjusted) url.searchParams.set('adjusted', 'false');
  return url.pathname + url.search;
}
export async function fetchDailyEvidence(symbol: TrendSymbol, from: string, to: string, get: MassiveEvidenceTransport = massiveEvidenceGet): Promise<DailyEvidenceBar[]> {
  const endpoint = `/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}`;
  let path: string | null = `${endpoint}?adjusted=false&sort=asc&limit=50000`;
  const seen = new Set<string>(); const bars = new Map<number, DailyEvidenceBar>();
  while (path) {
    if (seen.has(path) || seen.size >= 100) fail('pagination loop or limit');
    seen.add(path);
    const page = await get(path); const receivedAt = new Date();
    if (page.adjusted !== false || page.ticker !== symbol) fail('adjustment mode or ticker mismatch');
    for (const raw of results(page)) {
      const row = record(raw);
      if (typeof row.t !== 'number' || !Number.isSafeInteger(row.t)) fail('invalid aggregate timestamp');
      const barStartAt = new Date(row.t as number);
      if (!Number.isFinite(barStartAt.getTime())) fail('invalid aggregate timestamp');
      const date = etDate(barStartAt);
      if (date < from || date > to || etInstant(date, 0).getTime() !== barStartAt.getTime()) fail('daily timestamp outside requested range or not Eastern midnight');
      const bar: DailyEvidenceBar = { barStartAt, open: decimal(row.o, 'open', true), high: decimal(row.h, 'high', true), low: decimal(row.l, 'low', true), close: decimal(row.c, 'close', true), volume: decimal(row.v, 'volume', false), receivedAt };
      if (new Prisma.Decimal(bar.low).gt(bar.open) || new Prisma.Decimal(bar.low).gt(bar.close) || new Prisma.Decimal(bar.high).lt(bar.open) || new Prisma.Decimal(bar.high).lt(bar.close) || new Prisma.Decimal(bar.low).gt(bar.high)) fail(`invalid OHLC relationships on ${date}`);
      const prior = bars.get(barStartAt.getTime());
      if (prior && ['open', 'high', 'low', 'close', 'volume'].some(k => prior[k as keyof DailyEvidenceBar] !== bar[k as keyof DailyEvidenceBar])) fail(`conflicting observations within response on ${date}`);
      bars.set(barStartAt.getTime(), bar);
    }
    path = nextPage(page, endpoint, true);
  }
  return [...bars.values()].sort((a, b) => a.barStartAt.getTime() - b.barStartAt.getTime());
}
/** Regular-session 15-minute bars only. Alignment/window is validated against the fixed
 * 09:30-16:00 ET session shape (early-close narrowing is a downstream eligibility concern,
 * not a raw-evidence storage concern; MarketBar never encodes calendar exceptions itself).
 */
export async function fetchMinuteEvidence(symbol: TrendSymbol, from: string, to: string, get: MassiveEvidenceTransport = massiveEvidenceGet): Promise<DailyEvidenceBar[]> {
  const endpoint = `/v2/aggs/ticker/${symbol}/range/15/minute/${from}/${to}`;
  let path: string | null = `${endpoint}?adjusted=false&sort=asc&limit=50000`;
  const seen = new Set<string>(); const bars = new Map<number, DailyEvidenceBar>();
  while (path) {
    if (seen.has(path) || seen.size >= 100) fail('pagination loop or limit');
    seen.add(path);
    const page = await get(path); const receivedAt = new Date();
    if (page.adjusted !== false || page.ticker !== symbol) fail('adjustment mode or ticker mismatch');
    for (const raw of results(page)) {
      const row = record(raw);
      if (typeof row.t !== 'number' || !Number.isSafeInteger(row.t)) fail('invalid aggregate timestamp');
      const barStartAt = new Date(row.t as number);
      if (!Number.isFinite(barStartAt.getTime())) fail('invalid aggregate timestamp');
      const date = etDate(barStartAt);
      if (date < from || date > to) fail('minute timestamp outside requested range');
      const minutesEt = etMinutesOfDay(barStartAt);
      if (minutesEt < SESSION_OPEN_MINUTES || minutesEt >= SESSION_CLOSE_MINUTES || (minutesEt - SESSION_OPEN_MINUTES) % 15 !== 0) fail(`minute timestamp on ${date} is not aligned to a regular-session 15-minute interval`);
      const bar: DailyEvidenceBar = { barStartAt, open: decimal(row.o, 'open', true), high: decimal(row.h, 'high', true), low: decimal(row.l, 'low', true), close: decimal(row.c, 'close', true), volume: decimal(row.v, 'volume', false), receivedAt };
      if (new Prisma.Decimal(bar.low).gt(bar.open) || new Prisma.Decimal(bar.low).gt(bar.close) || new Prisma.Decimal(bar.high).lt(bar.open) || new Prisma.Decimal(bar.high).lt(bar.close) || new Prisma.Decimal(bar.low).gt(bar.high)) fail(`invalid OHLC relationships on ${date}`);
      const prior = bars.get(barStartAt.getTime());
      if (prior && ['open', 'high', 'low', 'close', 'volume'].some(k => prior[k as keyof DailyEvidenceBar] !== bar[k as keyof DailyEvidenceBar])) fail(`conflicting observations within response on ${date}`);
      bars.set(barStartAt.getTime(), bar);
    }
    path = nextPage(page, endpoint, true);
  }
  return [...bars.values()].sort((a, b) => a.barStartAt.getTime() - b.barStartAt.getTime());
}
export async function fetchSplitEvidence(symbol: TrendSymbol, from: string, to: string, get: MassiveEvidenceTransport = massiveEvidenceGet): Promise<SplitEvent[]> {
  const endpoint = '/stocks/v1/splits';
  let path: string | null = `${endpoint}?ticker=${symbol}&execution_date.gte=${from}&execution_date.lte=${to}&sort=execution_date.asc&limit=1000`;
  const seen = new Set<string>(); const events = new Map<string, SplitEvent>();
  while (path) {
    if (seen.has(path) || seen.size >= 20) fail('split pagination loop or limit');
    seen.add(path); const page = await get(path);
    for (const raw of results(page)) {
      const row = record(raw);
      const date = row.execution_date;
      if (row.ticker !== symbol || typeof row.id !== 'string' || !row.id || typeof date !== 'string' || !validDate(date) || date < from || date > to) fail('invalid split identity/date');
      const splitFrom = Number(decimal(row.split_from, 'split ratio', true));
      const splitTo = Number(decimal(row.split_to, 'split ratio', true));
      const event: SplitEvent = { id: row.id as string, symbol, executionDate: date as string, splitFrom, splitTo, priceFactor: splitFrom / splitTo };
      const previous = events.get(event.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) fail('conflicting split events');
      events.set(event.id, event);
    }
    path = nextPage(page, endpoint, false);
  }
  return [...events.values()].sort((a, b) => a.executionDate.localeCompare(b.executionDate) || a.id.localeCompare(b.id));
}
