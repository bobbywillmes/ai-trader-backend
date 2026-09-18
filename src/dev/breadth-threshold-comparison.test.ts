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
import { runBreadthResearch } from './breadth-research-runner.js';
import { CANDIDATE_HORIZON_V2, compareBreadthThresholds, MissingCacheError } from './breadth-threshold-comparison.js';
import { BASELINE_BREADTH_BANDS } from '../services/breadth-calculation.js';

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
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'breadth-comparison-test-'));
});
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

function seedFetchers() {
  // Values oscillate around the baseline/candidate band boundaries so both raw
  // classifications and effective-state transitions actually occur under both definitions.
  const fetchGrouped = async (date: string) => {
    const day = Date.parse(date) / 86_400_000;
    const wobble = Math.sin(day / 3) * 12;
    return new Map([['A', 100 + wobble], ['B', 100 + wobble * 0.6], ['C', 100 - wobble * 0.4]]);
  };
  const fetchUniverse = async () => ['A', 'B', 'C'];
  return { fetchGrouped, fetchUniverse };
}

describe('Breadth threshold comparison (cache-only)', () => {
  it('STOPs with an exact list of missing dates rather than fetching them', async () => {
    await expect(compareBreadthThresholds({ from: FROM, to: TO, cacheDir })).rejects.toThrow(MissingCacheError);
    try {
      await compareBreadthThresholds({ from: FROM, to: TO, cacheDir });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MissingCacheError);
      const missing = error as MissingCacheError;
      expect(missing.missingGroupedDates.length).toBeGreaterThan(0);
      expect(missing.missingUniverseDates.length).toBeGreaterThan(0);
    }
  });

  it('compares baseline vs CANDIDATE_HORIZON_V2 against identical cached evidence, making zero provider calls', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });

    const comparison = await compareBreadthThresholds({ from: FROM, to: TO, cacheDir });

    expect(comparison.baseline.actualRequests).toEqual({ grouped: 0, universe: 0 });
    expect(comparison.candidate.actualRequests).toEqual({ grouped: 0, universe: 0 });
    expect(comparison.baseline.bandsByHorizon).toEqual(BASELINE_BREADTH_BANDS);
    expect(comparison.candidate.bandsByHorizon).toEqual(CANDIDATE_HORIZON_V2);
    // Identical underlying evidence: only the classification bands differ.
    expect(comparison.baseline.days.map(day => day.observation)).toEqual(comparison.candidate.days.map(day => day.observation));
    expect(comparison.strongestDailyUnchanged).toBe(true);

    // Structural sanity: category counts sum to the total changed-date count.
    const summed = comparison.changedDateCategoryCounts.reduce((sum, [, count]) => sum + count, 0);
    expect(summed).toBe(comparison.changedDates.length);

    // The 1-day band is identical between definitions, so its raw distribution must match exactly.
    expect(comparison.rawHorizonDistribution.breadth1.baseline).toEqual(comparison.rawHorizonDistribution.breadth1.candidate);

    // NEGATIVE -> POSITIVE can never occur under one-step-recovery hysteresis, for either definition.
    expect(comparison.transitions.baseline.categories['NEGATIVE -> POSITIVE']).toBeUndefined();
    expect(comparison.transitions.candidate.categories['NEGATIVE -> POSITIVE']).toBeUndefined();

    // Read-only DB access was exercised (proves no trading/assessment write capability was used).
    expect(mocks.readOnly).toHaveBeenCalled();
  });
});
