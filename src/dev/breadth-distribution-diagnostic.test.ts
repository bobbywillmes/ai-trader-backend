import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), readOnly: vi.fn(), exceptions: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: new Proxy({ $transaction: mocks.transaction }, {
  get(target, property) {
    if (property === '$transaction') return target.$transaction;
    throw new Error(`Forbidden database access outside read-only transaction: ${String(property)}`);
  },
}) }));
import { diagnoseBreadthDistribution } from './breadth-distribution-diagnostic.js';
import { runBreadthResearch } from './breadth-research-runner.js';
import { MissingCacheError } from './breadth-threshold-comparison.js';

const FROM = '2024-01-02', TO = '2024-03-29'; // enough weekdays to clear the 20-session warm-up

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
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'breadth-diagnostic-test-'));
});
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

function seedFetchers() {
  // Values oscillate below and above 0.50 so both the centering bins and the histogram
  // buckets actually get populated on both sides.
  const fetchGrouped = async (date: string) => {
    const day = Date.parse(date) / 86_400_000;
    const wobble = Math.sin(day / 3) * 12;
    return new Map([['A', 100 + wobble], ['B', 100 + wobble * 0.6], ['C', 100 - wobble * 0.4]]);
  };
  const fetchUniverse = async () => ['A', 'B', 'C'];
  return { fetchGrouped, fetchUniverse };
}

describe('Breadth distribution diagnostic (cache-only)', () => {
  it('STOPs with an exact list of missing dates rather than fetching them', async () => {
    await expect(diagnoseBreadthDistribution({ from: FROM, to: TO, cacheDir })).rejects.toThrow(MissingCacheError);
  });

  it('reports zero provider requests and leaves cached observation evidence unmutated', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });
    const before = await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: false });

    const diagnostic = await diagnoseBreadthDistribution({ from: FROM, to: TO, cacheDir });
    expect(diagnostic.actualRequests).toEqual({ grouped: 0, universe: 0 });

    const after = await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: false });
    expect(after.days.map(day => day.observation)).toEqual(before.days.map(day => day.observation));

    // Read-only DB access was exercised (proves no trading/assessment write capability was used).
    expect(mocks.readOnly).toHaveBeenCalled();
  });

  it('filters valid sessions per horizon: breadth1 becomes valid before breadth5, which becomes valid before breadth20', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });

    const diagnostic = await diagnoseBreadthDistribution({ from: FROM, to: TO, cacheDir });
    expect(diagnostic.horizons.breadth1.overall.count).toBeGreaterThan(diagnostic.horizons.breadth5.overall.count);
    expect(diagnostic.horizons.breadth5.overall.count).toBeGreaterThan(diagnostic.horizons.breadth20.overall.count);
    expect(diagnostic.horizons.breadth20.overall.count).toBeGreaterThan(0);
  });

  it('restricts horizon-pair correlation/mean-abs-diff to sessions where both measurements are jointly valid', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });

    const diagnostic = await diagnoseBreadthDistribution({ from: FROM, to: TO, cacheDir });
    // breadth20 validity implies breadth1 validity (20 consecutive sessions >= 1), so the
    // breadth1-vs-breadth20 paired count must equal the (smaller) breadth20 overall count,
    // not the (larger) breadth1 overall count.
    expect(diagnostic.relationships.breadth1_breadth20.pairedSessions).toBe(diagnostic.horizons.breadth20.overall.count);
    expect(diagnostic.relationships.breadth1_breadth20.pairedSessions).toBeLessThan(diagnostic.horizons.breadth1.overall.count);
    expect(diagnostic.relationships.breadth1_breadth5.pairedSessions).toBe(diagnostic.horizons.breadth5.overall.count);
    expect(diagnostic.relationships.breadth5_breadth20.pairedSessions).toBe(diagnostic.horizons.breadth20.overall.count);
    expect(diagnostic.relationships.breadth1_breadth20.correlation).not.toBeNull();
  });

  it('never proposes or selects a threshold or classifier: output carries only descriptive statistics', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });

    const diagnostic = await diagnoseBreadthDistribution({ from: FROM, to: TO, cacheDir });
    expect(diagnostic).not.toHaveProperty('recommendedBand');
    expect(diagnostic).not.toHaveProperty('selectedCandidate');
    expect(Object.keys(diagnostic).sort()).toEqual(['actualRequests', 'compression', 'horizons', 'periods', 'relationships', 'requestedRange', 'sessionsConsidered', 'statisticsConvention'].sort());
  });
});
