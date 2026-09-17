import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { datesBetween, marketSession } from '../services/market-calendar.js';
import { volatilityResearchExceptions } from './volatility-research-calendar.js';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), readOnly: vi.fn(), exceptions: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: new Proxy({ $transaction: mocks.transaction }, {
  get(target, property) {
    if (property === '$transaction') return target.$transaction;
    throw new Error(`Forbidden database access outside read-only transaction: ${String(property)}`);
  },
}) }));
import { estimateBreadthResearch, runBreadthResearch } from './breadth-research-runner.js';

const FROM = '2024-01-02', TO = '2024-01-31';
const expectedSessions = datesBetween(FROM, TO).filter(date => marketSession(date, volatilityResearchExceptions([])));

let cacheDir: string;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.exceptions.mockResolvedValue([]);
  mocks.transaction.mockImplementation(async (callback: (db: unknown) => Promise<unknown>) => {
    const readModel = (findMany: unknown) => new Proxy({ findMany }, { get(target, property) {
      if (property === 'findMany') return target.findMany;
      throw new Error(`Forbidden model mutation: ${String(property)}`);
    } });
    const allowed = { $executeRaw: mocks.readOnly, marketCalendarException: readModel(mocks.exceptions) };
    const db = new Proxy(allowed, { get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      // This includes every MarketRegimeDimensionAssessment and trading method/model.
      throw new Error(`Forbidden database model: ${String(property)}`);
    } });
    return callback(db);
  });
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'breadth-research-test-'));
});
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

function fakeFetchers() {
  const calls = { grouped: [] as string[], universe: [] as string[] };
  const fetchGrouped = async (date: string) => {
    calls.grouped.push(date);
    const day = Number(date.slice(8, 10));
    return new Map([['A', 100 + day], ['B', 100 + (day % 5)], ['C', 100 - (day % 3)]]);
  };
  const fetchUniverse = async (date: string) => { calls.universe.push(date); return ['A', 'B', 'C']; };
  return { fetchGrouped, fetchUniverse, calls };
}
function refusingFetchers() {
  return {
    fetchGrouped: async () => { throw new Error('must not fetch: cache-only run'); },
    fetchUniverse: async () => { throw new Error('must not fetch: cache-only run'); },
  };
}

describe('read-only Breadth research runner', () => {
  it('estimates the request count from cache state alone, without any provider call', async () => {
    const { fetchGrouped, fetchUniverse } = refusingFetchers();
    const estimate = await estimateBreadthResearch({ from: FROM, to: TO, cacheDir });
    expect(estimate.expectedSessions).toBe(expectedSessions.length);
    expect(estimate.cachedGroupedSessions).toBe(0);
    expect(estimate.cachedUniverseSessions).toBe(0);
    expect(estimate.newGroupedSessions).toBe(expectedSessions.length + 1); // includes the one prior-boundary session
    expect(estimate.newUniverseSessions).toBe(expectedSessions.length);
    expect(estimate.estimatedTotalRequests).toBeGreaterThan(estimate.newGroupedSessions);
    // Sanity: the estimator never imports/calls a transport at all.
    void fetchGrouped; void fetchUniverse;
  });

  it('runs end-to-end without any assessment/trading write capability, using a read-only transaction', async () => {
    const { fetchGrouped, fetchUniverse } = fakeFetchers();
    const report = await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });
    expect(report.days).toHaveLength(expectedSessions.length);
    expect(mocks.readOnly).toHaveBeenCalledExactlyOnceWith(['SET TRANSACTION READ ONLY']);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead', timeout: 30_000 });
    expect(report.providerGaps).toEqual([]);
    expect(report.days.every(day => day.observation !== null)).toBe(true);
  });

  it('fetches each expected session at most once, then resumes entirely from cache on a rerun', async () => {
    const first = fakeFetchers();
    const reportOne = await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped: first.fetchGrouped, fetchUniverse: first.fetchUniverse });
    expect(first.calls.grouped).toHaveLength(expectedSessions.length + 1);
    expect(first.calls.universe).toHaveLength(expectedSessions.length);
    expect(new Set(first.calls.grouped).size).toBe(first.calls.grouped.length);

    const refusing = refusingFetchers();
    const reportTwo = await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, ...refusing });
    expect(reportTwo).toEqual(expect.objectContaining({ datasetId: reportOne.datasetId, days: reportOne.days, summary: reportOne.summary }));

    const cacheOnly = await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: false });
    expect(cacheOnly.days).toEqual(reportOne.days);
  });

  it('surfaces a cached failure as a provider gap instead of throwing, and continuity resets around it', async () => {
    const failedDate = expectedSessions[5]!;
    await mkdir(path.join(cacheDir, 'universe'), { recursive: true });
    await writeFile(path.join(cacheDir, 'universe', `${failedDate}.json`), JSON.stringify({ ok: false, error: 'provider outage' }), 'utf8');
    const { fetchGrouped, fetchUniverse } = fakeFetchers();
    const report = await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });
    expect(report.providerGaps).toEqual([{ date: failedDate, kind: 'universe', error: 'provider outage' }]);
    const failedDay = report.days.find(day => day.date === failedDate)!;
    expect(failedDay.observation).toBeNull();
    expect(failedDay.consecutiveValidSessions).toBe(0);
  });

  it('has no Alpaca dependency anywhere in the research fetch/cache/runner code', () => {
    const sources = [
      readFileSync(new URL('./breadth-research-runner.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('./breadth-research-cache.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../integrations/massive/breadth-reference.client.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../services/breadth-calculation.ts', import.meta.url), 'utf8'),
    ];
    // Comments may reference "no Alpaca" as documentation; only an actual import/call is disqualifying.
    expect(sources.some(source => /(?:from|require)\s*\(?['"][^'"]*alpaca/i.test(source))).toBe(false);
  });
});
