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
import { compareBreadthMildDeteriorationConfirmation } from './breadth-mild-deterioration-comparison.js';
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
  cacheDir = await mkdtemp(path.join(os.tmpdir(), 'breadth-mild-deterioration-test-'));
});
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

function seedFetchers() {
  // Values oscillate across every classification band boundary at all three horizons so
  // STRUCTURAL_V3's raw states cover POSITIVE/MIXED/NEGATIVE and the mild-deterioration
  // hold/confirm/reset paths all get exercised.
  const fetchGrouped = async (date: string) => {
    const day = Date.parse(date) / 86_400_000;
    const wobble = Math.sin(day / 3) * 12;
    return new Map([['A', 100 + wobble], ['B', 100 + wobble * 0.6], ['C', 100 - wobble * 0.4]]);
  };
  const fetchUniverse = async () => ['A', 'B', 'C'];
  return { fetchGrouped, fetchUniverse };
}

describe('Breadth mild-deterioration hysteresis comparison (cache-only)', () => {
  it('STOPs with an exact list of missing dates rather than fetching them', async () => {
    await expect(compareBreadthMildDeteriorationConfirmation({ from: FROM, to: TO, cacheDir })).rejects.toThrow(MissingCacheError);
  });

  it('reuses CANDIDATE_STRUCTURAL_V3\'s raw states unmodified, makes zero provider calls, and writes nothing but effective-state/hysteresis fields', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });

    const comparison = await compareBreadthMildDeteriorationConfirmation({ from: FROM, to: TO, cacheDir });

    expect(comparison.baseline.actualRequests).toEqual({ grouped: 0, universe: 0 });
    expect(comparison.v2.actualRequests).toEqual({ grouped: 0, universe: 0 });
    expect(comparison.v3.actualRequests).toEqual({ grouped: 0, universe: 0 });

    // Raw-state identity: the mild variant's raw states must equal STRUCTURAL_V3's exactly.
    expect(comparison.mildDays.map(day => day.rawState)).toEqual(comparison.v3.days.map(day => day.rawState));
    // Underlying observation evidence is untouched (only breadth1/5/20/observation carried through).
    expect(comparison.mildDays.map(day => day.observation)).toEqual(comparison.v3.days.map(day => day.observation));

    // The structurally-impossible direct flip must be exactly zero for the mild variant.
    expect(comparison.directPositiveNegativeFlips.mild).toBe(0);

    // Genuine-NEGATIVE response speed must be fully verified (no confirmation delay).
    expect(comparison.negativeResponseSpeed.immediateDropVerified).toBe(comparison.negativeResponseSpeed.immediateDropCount);
    expect(comparison.negativeResponseSpeed.sustainedNegativeVerified).toBe(comparison.negativeResponseSpeed.sustainedNegativeCount);

    // Mild-deterioration diagnostic counts must be internally consistent.
    const d = comparison.mildDeteriorationDiagnostic;
    expect(d.firstDayHolds + d.secondMixedTransitionedToMixed).toBe(d.encounteredMixedFromPositive);

    // Read-only DB access was exercised (proves no trading/assessment write capability was used).
    expect(mocks.readOnly).toHaveBeenCalled();
  });

  it('produces changed-date and effective-state-distribution output that reflects only hysteresis, never raw evidence', async () => {
    const { fetchGrouped, fetchUniverse } = seedFetchers();
    await runBreadthResearch({ from: FROM, to: TO, cacheDir, fetchFromProvider: true, fetchGrouped, fetchUniverse });

    const comparison = await compareBreadthMildDeteriorationConfirmation({ from: FROM, to: TO, cacheDir });
    const summed = comparison.changedVsV3.categoryCounts.reduce((sum, [, count]) => sum + count, 0);
    expect(summed).toBe(comparison.changedVsV3.changedDates.length);
    // The distribution totals (all classified sessions) must be identical between STRUCTURAL_V3
    // and the mild variant, since only the effective-state assignment differs, not eligibility.
    expect(comparison.effectiveStateDistribution.v3.overall.sessions).toBe(comparison.effectiveStateDistribution.mild.overall.sessions);
  });
});
