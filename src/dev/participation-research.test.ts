import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { etInstant } from '../services/market-calendar.js';
import { fetchEvidence, ParticipationCache, parseDaily, parseSplits, type RawPage } from './participation-research-data.js';
import { parseParticipationArgs, runParticipationResearch } from './participation-research-runner.js';
import { fullSessionDates } from './participation-calculation.js';
import { researchCalendar } from './intraday-stress-calendar.js';

const dirs: string[] = [];
async function directory() { const dir = await mkdtemp(path.join(os.tmpdir(), 'participation-test-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const base = 'https://api.massive.com';
const empty: RawPage = { status: 'OK', adjusted: false, ticker: 'SPY', results: [] };
const bar = { t: etInstant('2024-01-02', 0).getTime(), o: 10, h: 12, l: 8, c: 11, v: 100 };
describe('Participation research boundary and orchestration', () => {
  it('is cache-only unless explicitly enabled; refresh requires fetch', async () => {
    const dir = await directory(), get = vi.fn(async () => empty);
    const c = new ParticipationCache(dir, false, false, 10, get, base);
    expect(await c.load('daily', 'SPY', '2024-01-01', '2024-12-31')).toEqual({ ok: false, error: 'NOT_CACHED' });
    expect(get).not.toHaveBeenCalled(); expect(() => new ParticipationCache(dir, false, true, 10, get, base)).toThrow();
  });
  it('resumes successes/failures, refreshes explicitly, and counts actual calls', async () => {
    const dir = await directory(), get = vi.fn(async () => empty);
    const c = new ParticipationCache(dir, true, false, 10, get, base);
    await c.load('daily', 'SPY', '2024-01-01', '2024-12-31');
    await c.load('daily', 'SPY', '2024-01-01', '2024-12-31');
    expect(get).toHaveBeenCalledTimes(1); expect(c.requests).toBe(1);
    const fail = vi.fn(async () => { throw new Error('Massive evidence: request returned HTTP 403 (requested history is outside the Massive subscription entitlement)'); });
    const f = new ParticipationCache(dir, true, false, 10, fail, base);
    expect((await f.load('splits', 'QQQ', '2024-01-01', '2024-12-31')).ok).toBe(false);
    await f.load('splits', 'QQQ', '2024-01-01', '2024-12-31'); expect(fail).toHaveBeenCalledTimes(1);
    const refreshed = new ParticipationCache(dir, true, true, 10, get, base);
    await refreshed.load('daily', 'SPY', '2024-01-01', '2024-12-31'); expect(get).toHaveBeenCalledTimes(2);
  });
  it('caps calls including pagination and does not cache budget exhaustion', async () => {
    const dir = await directory(), get = vi.fn(async () => ({ ...empty, next_url: `${base}/v2/aggs/ticker/SPY/range/1/day/2024-01-01/2024-12-31?cursor=next` }));
    const c = new ParticipationCache(dir, true, false, 1, get, base);
    expect(await c.load('daily', 'SPY', '2024-01-01', '2024-12-31')).toEqual({ ok: false, error: 'REQUEST_BUDGET_EXHAUSTED' });
    expect(c.requests).toBe(1); expect(get).toHaveBeenCalledTimes(1);
    const resume = new ParticipationCache(dir, true, false, 10, async () => empty, base);
    expect((await resume.load('daily', 'SPY', '2024-01-01', '2024-12-31')).ok).toBe(true);
  });
  it('rejects unsafe pagination and malformed/conflicting provider evidence', async () => {
    await expect(fetchEvidence('daily', 'SPY', '2024-01-01', '2024-12-31', async () => ({ ...empty, next_url: 'https://evil.example/x' }), base)).rejects.toThrow('UNSAFE');
    expect(() => parseDaily({ pages: [{ ...empty, adjusted: true }] }, 'SPY', '2024-01-01', '2024-12-31')).toThrow();
    expect(() => parseDaily({ pages: [{ ...empty, results: [bar, bar] }] }, 'SPY', '2024-01-01', '2024-12-31')).toThrow('DUPLICATE');
    const split = { ticker: 'DIA', id: 's', execution_date: '2024-02-01', split_from: 1, split_to: 2 };
    expect(() => parseSplits({ pages: [{ status: 'OK', results: [split, split] }] }, 'DIA', '2024-01-01', '2024-12-31')).toThrow();
    expect(() => parseSplits({ pages: [{ status: 'OK', results: [{ ...split, split_to: 0 }] }] }, 'DIA', '2024-01-01', '2024-12-31')).toThrow();
  });
  it('keeps raw OHLCV while valid price changes cannot alter volume observations', () => {
    const original = parseDaily({ pages: [{ ...empty, results: [bar] }] }, 'SPY', '2024-01-01', '2024-12-31');
    const reversed = parseDaily({ pages: [{ ...empty, results: [{ ...bar, o: 11, c: 9 }] }] }, 'SPY', '2024-01-01', '2024-12-31');
    expect(original[0]!.v).toBe(reversed[0]!.v); expect(original[0]!.c).not.toBe(reversed[0]!.c);
  });
  it('fails closed on cache corruption without provider fallback', async () => {
    const dir = await directory(), get = vi.fn(async () => empty);
    await writeFile(path.join(dir, 'v1-SPY-daily-2024-01-01-2024-12-31.json'), '{}');
    const c = new ParticipationCache(dir, true, false, 10, get, base);
    expect(await c.load('daily', 'SPY', '2024-01-01', '2024-12-31')).toEqual({ ok: false, error: 'INVALID_CACHE_USE_REFRESH' });
    expect(get).not.toHaveBeenCalled();
  });
  it('enforces completed targets, reviewed horizon, and CLI options', () => {
    const now = new Date('2024-07-05T20:29:00Z');
    expect(parseParticipationArgs([], now).to).toBe('2024-07-02');
    expect(() => parseParticipationArgs(['--to', '2024-07-05'], now)).toThrow('not complete');
    expect(() => parseParticipationArgs(['--to', '2027-01-02'], now)).toThrow();
    expect(() => parseParticipationArgs(['--max-requests', '301'], now)).toThrow();
    expect(() => parseParticipationArgs(['--typo'], now)).toThrow();
    expect(() => parseParticipationArgs(['--refresh'], now)).toThrow();
  });
  it('writes auditable unavailable output offline and stable identity on rerun', async () => {
    const dir = await directory(), now = new Date('2025-01-01T00:00:00Z'), get = vi.fn(async () => empty);
    const options = parseParticipationArgs(['--from', '2024-07-01', '--to', '2024-07-05', '--cache-dir', dir, '--output', path.join(dir, 'report.json')], now);
    const a = await runParticipationResearch(options, now, get, base);
    const b = await runParticipationResearch(options, new Date('2025-02-01T00:00:00Z'), get, base);
    expect(a.datasetId).toBe(b.datasetId); expect(a.actualProviderRequests).toBe(0); expect(get).not.toHaveBeenCalled();
    expect(a.excludedEarlyCloseDates).toEqual(['2024-07-03']); expect(a.summary.targetCount).toBe(3);
    expect(a.summary.panels[20]!.available).toBe(0); expect(a.providerGaps).toHaveLength(10);
    expect(JSON.parse(await readFile(options.output, 'utf8')).datasetId).toBe(a.datasetId);
  });
  it('fetches all five through injected transport, replays identically offline, and identities change with evidence', async () => {
    const dir = await directory(), now = new Date('2025-01-01T00:00:00Z');
    const ds = fullSessionDates('2024-01-01', '2024-07-05', researchCalendar([]));
    let volume = 100;
    const get = vi.fn(async (endpoint: string): Promise<RawPage> => {
      const url = new URL(endpoint, base);
      if (url.pathname === '/stocks/v1/splits') return { status: 'OK', results: [] };
      expect(url.searchParams.get('adjusted')).toBe('false');
      return { status: 'OK', adjusted: false, ticker: url.pathname.split('/')[4],
        results: ds.map(date => ({ ...bar, t: etInstant(date, 0).getTime(), v: volume })) };
    });
    const options = parseParticipationArgs(['--fetch', '--from', '2024-07-01', '--to', '2024-07-05', '--cache-dir', dir, '--output', path.join(dir, 'report.json')], now);
    const first = await runParticipationResearch(options, now, get, base);
    expect(first.actualProviderRequests).toBe(10); expect(first.providerGaps).toEqual([]);
    expect(first.days.every(d => d.panel20?.panelMedianRvol === 1 && d.panel40?.panelMedianRvol === 1)).toBe(true);
    const offline = await runParticipationResearch({ ...options, fetch: false }, now, get, base);
    expect(offline.datasetId).toBe(first.datasetId); expect(offline.days).toEqual(first.days);
    expect(offline.actualProviderRequests).toBe(0); expect(get).toHaveBeenCalledTimes(10);
    volume = 200;
    const refreshed = await runParticipationResearch({ ...options, refresh: true }, now, get, base);
    expect(refreshed.datasetId).not.toBe(first.datasetId);
  });
  it('contains no database/trading imports or writes in research implementation', async () => {
    for (const name of ['participation-calculation', 'participation-research-data', 'participation-research-runner']) {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from ['"].*(?:db\/|workers\/|risk-gate|place-order|signal-evaluation|entry-decision)/);
      expect(source).not.toMatch(/prisma|\$transaction|\.(?:create|createMany|upsert|deleteMany)\(/);
    }
  });
});
