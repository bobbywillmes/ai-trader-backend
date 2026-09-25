import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, normalize, record, SYMBOLS, timestamp, values, type Symbol, type Values } from './model.js';
import type { DataConfig } from './config.js';

export type ReferenceBar = Values & { symbol: Symbol; startAt: string };
export type Range = { startAt: string; endAt: string };
export type PageMetadata = { fetchedAt: string; status: string; count: number; hasNext: boolean; tokenHash: string | null; request?: { endpoint: string; timeframe: string; startAt: string; endAt: string } };
export type Reference = { version: 1; authority: 'RESEARCH_ONLY'; provider: 'ALPACA' | 'MASSIVE'; feed?: 'IEX';
  fetchId: string; runId: string; sessionDate: string; fetchedAt: string; range: Range; complete: true;
  adjustment: 'raw'; pages: PageMetadata[]; minutes: ReferenceBar[]; bars: ReferenceBar[] };
export type Get = (url: URL, headers: Record<string, string>) => Promise<unknown>;
/** No retry: a failed request aborts the snapshot. Never expose response bodies or authenticated URLs. */
export function boundedGet(request = globalThis.fetch): Get {
  let count = 0, last = 0;
  return async (url, headers) => {
    if (++count > 24) throw new Error('Reference request budget exceeded');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 1000 - (Date.now() - last))));
    last = Date.now();
    try {
      const response = await request(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error('HTTP failure');
      return await response.json();
    } catch { throw new Error('Reference request failed; no retry or fallback'); }
  };
}
export function parseBar(row: unknown, symbol: Symbol, timeframe: '1Min' | '15Min'): ReferenceBar {
  if (!record(row)) throw new Error('Invalid reference bar');
  const parsed = normalize({ ...row, S: symbol, T: 'b' }, { runId: 'reference', connectionEpoch: 1, ordinal: 1,
    frameOrdinal: 1, elementIndex: 0, receivedAt: '2000-01-01T00:00:00Z', monotonicOffsetMs: 0 });
  if ('error' in parsed || Math.min(parsed.observation.open, parsed.observation.low) <= 0) throw new Error('Invalid reference OHLCV');
  if (Date.parse(parsed.observation.minuteStartAt) % (timeframe === '1Min' ? 60_000 : 900_000)) throw new Error('Misaligned reference timestamp');
  return { symbol, startAt: parsed.observation.minuteStartAt, ...values(parsed.observation) };
}
/** Massive permits fractional volume; preserve it rather than coercing to the IEX integer contract. */
export function parseMassiveBar(row: unknown, symbol: Symbol, timeframe: '1Min' | '15Min'): ReferenceBar {
  if (!record(row) || typeof row.v !== 'number' || !Number.isFinite(row.v) || row.v < 0 || row.v > Number.MAX_SAFE_INTEGER) throw new Error('Invalid Massive volume');
  return { ...parseBar({ ...row, v: 0 }, symbol, timeframe), volume: row.v };
}
function validateRange(range: Range) {
  timestamp(range.startAt, true); timestamp(range.endAt, true);
  if (range.endAt <= range.startAt || Date.parse(range.endAt) - Date.parse(range.startAt) > 86400_000) throw new Error('Bounded one-session range required');
}
function addBar(map: Map<string, ReferenceBar>, bar: ReferenceBar, range: Range) {
  if (bar.startAt < range.startAt || bar.startAt >= range.endAt) throw new Error('Reference outside range');
  const key = `${bar.symbol}/${bar.startAt}`;
  if (map.has(key)) throw new Error('Duplicate reference interval');
  map.set(key, bar);
}
export async function fetchAlpaca(config: DataConfig, range: Range, get: Get) {
  validateRange(range);
  if (config.feed !== 'iex') throw new Error('Only IEX permitted');
  const pages: PageMetadata[] = [], results: ReferenceBar[][] = [];
  for (const timeframe of ['1Min', '15Min'] as const) {
    const interval = timeframe === '1Min' ? 60000 : 900000;
    const requestRange = { startAt: new Date(Math.ceil(Date.parse(range.startAt) / interval) * interval).toISOString(),
      endAt: new Date(Math.floor(Date.parse(range.endAt) / interval) * interval).toISOString() };
    if (requestRange.endAt <= requestRange.startAt) { results.push([]); continue; }
    const map = new Map<string, ReferenceBar>(), seen = new Set<string>();
    let token: string | null = null;
    do {
      if (seen.size >= 8 || seen.has(token ?? '')) throw new Error('Pagination loop/limit');
      seen.add(token ?? '');
      const url = new URL('https://data.alpaca.markets/v2/stocks/bars');
      url.search = new URLSearchParams({ symbols: 'SPY,RSP', timeframe, feed: 'iex', adjustment: 'raw', asof: '-',
        start: requestRange.startAt, end: new Date(Date.parse(requestRange.endAt) - 1).toISOString(), limit: '10000', sort: 'asc', ...(token ? { page_token: token } : {}) }).toString();
      const page = await get(url, { 'APCA-API-KEY-ID': config.key, 'APCA-API-SECRET-KEY': config.secret });
      if (!record(page) || !record(page.bars) || Object.keys(page.bars).some(s => !SYMBOLS.includes(s as Symbol))) throw new Error('Invalid Alpaca page');
      let count = 0;
      for (const symbol of SYMBOLS) {
        const rows = page.bars[symbol] ?? [];
        if (!Array.isArray(rows)) throw new Error('Invalid Alpaca bars');
        for (const row of rows) { addBar(map, parseBar(row, symbol, timeframe), requestRange); count++; }
      }
      if (page.next_page_token !== null && page.next_page_token !== undefined && (typeof page.next_page_token !== 'string' || !page.next_page_token)) throw new Error('Invalid token');
      token = page.next_page_token as string | null ?? null;
      pages.push({ fetchedAt: new Date().toISOString(), status: `OK/${timeframe}`, count, hasNext: !!token, tokenHash: token ? hash(token) : null,
        request: { endpoint: url.origin + url.pathname, timeframe, ...requestRange } });
    } while (token);
    results.push([...map.values()].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.symbol.localeCompare(b.symbol)));
  }
  return { minutes: results[0]!, bars: results[1]!, pages };
}
export async function massivePages(path: string, key: string, get: Get) {
  const endpoint = new URL(path, 'https://api.massive.com');
  let url: URL | null = endpoint;
  const seen = new Set<string>(), output: Record<string, unknown>[] = [];
  while (url) {
    if (seen.has(url.href) || seen.size >= 8) throw new Error('Massive pagination loop/limit');
    seen.add(url.href);
    const page = await get(url, { Authorization: `Bearer ${key}` });
    if (!record(page) || !['OK', 'DELAYED'].includes(String(page.status))) throw new Error('Invalid Massive status');
    output.push(page);
    if (page.next_url == null) break;
    if (typeof page.next_url !== 'string') throw new Error('Invalid Massive next URL');
    url = new URL(page.next_url, endpoint);
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.username || url.password) throw new Error('Unsafe Massive pagination');
    url.searchParams.delete('apiKey');
    for (const [name, value] of endpoint.searchParams) if (name !== 'cursor') url.searchParams.set(name, value);
  }
  return output;
}
export async function fetchMassive(key: string, range: Range, get: Get) {
  validateRange(range);
  const map = new Map<string, ReferenceBar>(), pages: PageMetadata[] = [];
  for (const symbol of SYMBOLS) {
    const path = `/v2/aggs/ticker/${symbol}/range/15/minute/${Date.parse(range.startAt)}/${Date.parse(range.endAt) - 1}?adjusted=false&sort=asc&limit=50000`;
    for (const page of await massivePages(path, key, get)) {
      if (page.ticker !== symbol || page.adjusted !== false) throw new Error('Massive identity/adjustment mismatch');
      const rows = page.results ?? (page.resultsCount === 0 ? [] : null);
      if (!Array.isArray(rows)) throw new Error('Missing Massive results');
      let count = 0;
      for (const row of rows) {
        if (!record(row) || !Number.isSafeInteger(row.t)) throw new Error('Invalid Massive timestamp');
        const bar = parseMassiveBar({ ...row, t: new Date(row.t as number).toISOString() }, symbol, '15Min');
        // Massive snaps requests to complete aggregate boundaries. Keep only fully covered intervals.
        if (bar.startAt < range.startAt || Date.parse(bar.startAt) + 900_000 > Date.parse(range.endAt)) continue;
        addBar(map, bar, range); count++;
      }
      pages.push({ fetchedAt: new Date().toISOString(), status: String(page.status), count, hasNext: !!page.next_url, tokenHash: null,
        request: { endpoint: 'https://api.massive.com' + path.split('?')[0], timeframe: '15Min', ...range } });
    }
  }
  return { minutes: [], bars: [...map.values()], pages };
}
export async function writeReference(runDir: string, reference: Reference) {
  const directory = join(runDir, 'reference', reference.provider.toLowerCase(), reference.fetchId);
  await mkdir(join(runDir, 'reference', reference.provider.toLowerCase()), { recursive: true });
  await mkdir(directory);
  const files = reference.provider === 'ALPACA' ? { 'minute-bars.json': reference.minutes, 'fifteen-minute-bars.json': reference.bars } : { 'bars.json': reference.bars };
  const hashes: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    const artifact = { provider: reference.provider, ...(reference.feed ? { feed: reference.feed } : {}), bars: data };
    hashes[name] = hash(artifact); await writeFile(join(directory, name), JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
  }
  const { minutes: _minutes, bars: _bars, ...metadata } = reference;
  const manifest = { ...metadata, hashes };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, contentHash: hash(manifest) }, null, 2) + '\n', { flag: 'wx' });
  return directory;
}
export async function readReference(runDir: string, provider: Reference['provider'], fetchId: string): Promise<Reference> {
  if (!/^[a-zA-Z0-9_-]+$/.test(fetchId)) throw new Error('Invalid fetch ID');
  if (fetchId === 'latest') {
    const all = await readReferences(runDir, provider);
    if (!all.length) throw new Error('No reference snapshots');
    return all.at(-1)!;
  }
  const directory = join(runDir, 'reference', provider.toLowerCase(), fetchId);
  const { contentHash, ...metadata } = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (hash(metadata) !== contentHash || metadata.provider !== provider || metadata.fetchId !== fetchId || metadata.complete !== true
    || metadata.version !== 1 || metadata.adjustment !== 'raw' || (provider === 'ALPACA' && metadata.feed !== 'IEX')) throw new Error('Invalid reference manifest');
  validateRange(metadata.range);
  const read = async (name: string, timeframe: '1Min' | '15Min') => {
    const data = JSON.parse(await readFile(join(directory, name), 'utf8'));
    if (hash(data) !== metadata.hashes[name] || data.provider !== provider || (provider === 'ALPACA' && data.feed !== 'IEX') || !Array.isArray(data.bars)) throw new Error('Reference hash/provenance mismatch');
    const map = new Map<string, ReferenceBar>();
    for (const b of data.bars) {
      if (!SYMBOLS.includes(b.symbol)) throw new Error('Invalid reference symbol');
      addBar(map, (provider === 'MASSIVE' ? parseMassiveBar : parseBar)({ t: b.startAt, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, n: b.tradeCount, vw: b.vwap }, b.symbol, timeframe), metadata.range);
    }
    return [...map.values()];
  };
  return { ...metadata, minutes: provider === 'ALPACA' ? await read('minute-bars.json', '1Min') : [], bars: await read(provider === 'ALPACA' ? 'fifteen-minute-bars.json' : 'bars.json', '15Min') };
}
export async function readReferences(runDir: string, provider: Reference['provider']) {
  let names: string[];
  try { names = await readdir(join(runDir, 'reference', provider.toLowerCase())); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const refs = await Promise.all(names.map(id => readReference(runDir, provider, id)));
  return refs.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.fetchId.localeCompare(b.fetchId));
}
export const fetchIdentity = () => ({ fetchId: randomUUID(), fetchedAt: new Date().toISOString() });
