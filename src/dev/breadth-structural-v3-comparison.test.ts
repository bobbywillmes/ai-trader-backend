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
import { compareBreadthStructuralV3 } from './breadth-structural-v3-comparison.js';
import { MissingCacheError } from './breadth-threshold-comparison.js';
import { CANDIDATE_STRUCTURAL_V3_BANDS } from '../services/breadth-calculation.js';

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
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'breadth-structural-v3-test-'));
});
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

function seedFetchers() {
  // Values oscillate across every classification band boundary at all three horizons so
  // aggregation, structural agreement, and both hysteresis directions all get exercised.
  const fetchGrouped = async (date: string) => {
    const day = Date.parse(date) / 86_400_000;
    const wobble = Math.sin(day / 3) * 12;
    return new Map([['A', 100 + wobble], ['B', 100 + wobble * 0.6], ['C', 100 - wobble * 0.4]]);
  };
  const fetchUniverse = async () => ['A', 'B', 'C'];
  return { fetchGrouped, fetchUniverse };
}

describe('Breadth structural V3 comparison (cache-only)', () => {
  it('STOPs with an exact list of missing dates rather than fetching them', async () => {
    await expect(compareBreadthStructuralV3({ from: FROM, to: TO, cacheDir })).rejects.toThrow(MissingCacheError);
  });

  it('compares BASELINE, CANDIDATE_HORIZON_V2 and CANDIDATE_STRUCTURAL_V3 against identical cached evidence, making zero provider calls', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });

    const comparison = await compareBreadthStructuralV3({ from: FROM, to: TO, cacheDir });

    expect(comparison.baseline.actualRequests).toEqual({ grouped: 0, universe: 0 });
    expect(comparison.v2.actualRequests).toEqual({ grouped: 0, universe: 0 });
    expect(comparison.v3.actualRequests).toEqual({ grouped: 0, universe: 0 });
    expect(comparison.v3.bandsByHorizon).toEqual(CANDIDATE_STRUCTURAL_V3_BANDS);
    expect(comparison.v3.aggregationOptions).toEqual({ aggregationRuleId: 'STRUCTURAL_V3', deteriorationMode: 'ONE_LEVEL_PER_ASSESSMENT' });
    // Identical underlying evidence: only classification/aggregation/hysteresis differ.
    expect(comparison.baseline.days.map(day => day.observation)).toEqual(comparison.v3.days.map(day => day.observation));
    expect(comparison.v2.days.map(day => day.observation)).toEqual(comparison.v3.days.map(day => day.observation));
    expect(comparison.strongestDailyUnchanged).toBe(true);

    // The structurally-impossible direct flip must be exactly zero for STRUCTURAL_V3.
    expect(comparison.directPositiveNegativeFlips.v3).toBe(0);

    // Structural agreement percentages must be internally consistent (mutually exclusive categories).
    const sa = comparison.structuralAgreementV3;
    const totalPct = sa.bothPositivePct + sa.bothNegativePct + sa.bothMixedPct + sa.oppositePct + sa.oneDirectionalOneMixedPct;
    expect(totalPct).toBeCloseTo(100, 6);
    expect(sa.confirmedByOneDay + sa.notConfirmedByOneDay).toBe(sa.oneDirectionalOneMixedSessions);

    // Read-only DB access was exercised (proves no trading/assessment write capability was used).
    expect(mocks.readOnly).toHaveBeenCalled();
  });

  it('reports raw aggregate (pre-hysteresis) and effective (post-hysteresis) distributions as distinct series for V3', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });

    const comparison = await compareBreadthStructuralV3({ from: FROM, to: TO, cacheDir });
    // Hysteresis (confirmation-gated recovery, one-level deterioration) makes the effective
    // series structurally different from the raw aggregate series whenever any transitions occur.
    expect(comparison.transitions.v3.total).toBeGreaterThan(0);
    expect(comparison.rawAggregateDistribution.v3.overall).not.toEqual(comparison.effectiveStateDistribution.v3.overall);
  });

  it('changed-date comparisons are computed against both BASELINE and CANDIDATE_HORIZON_V2', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });

    const comparison = await compareBreadthStructuralV3({ from: FROM, to: TO, cacheDir });
    const summedVsBaseline = comparison.changedVsBaseline.categoryCounts.reduce((sum, [, count]) => sum + count, 0);
    expect(summedVsBaseline).toBe(comparison.changedVsBaseline.changedDates.length);
    const summedVsV2 = comparison.changedVsV2.categoryCounts.reduce((sum, [, count]) => sum + count, 0);
    expect(summedVsV2).toBe(comparison.changedVsV2.changedDates.length);
  });
});
