import { describe, expect, it } from 'vitest';
import { advanceBreadth, aggregateStructuralV3, applyMildDeteriorationConfirmation } from '../services/breadth-calculation.js';
import { buildCandidateDays, classifyShare, coverageDiagnostics, deriveBands, periodSummary, sensitivity, validationPercentile, validationStability, type Bands, type Metric } from './breadth-v2-calibration.js';

const metric = (sessionDate: string, horizon: Metric['horizon'], advanceShare: number | null): Metric => ({ sessionDate, horizon, universeCount: 10, eligibleCount: 10, excludedCount: 0, advancingCount: 5, decliningCount: 5, unchangedCount: 0, directionalCount: 10, advanceShare, netBreadth: advanceShare === null ? null : 2 * advanceShare - 1, coverageRatio: 1 });
const series = (values: readonly number[][]) => values.flatMap((row, i) => (['DAY_1', 'DAY_5', 'DAY_20'] as const).map((h, j) => metric(`2024-01-${String(i + 1).padStart(2, '0')}`, h, row[j]!)));

describe('BREADTH_V2 Phase 5B pure calibration', () => {
  it('derives exactly three independent calibration-only horizon families and freezes boundaries', () => {
    const rows = series([[0, 0.1, 0.2], [0.2, 0.3, 0.4], [0.4, 0.5, 0.6], [0.6, 0.7, 0.8], [1, 1, 1], [0, 0, 0]]);
    const bands = deriveBands(rows, '2024-01-05');
    expect(Object.keys(bands)).toEqual(['QUARTILE', 'TERTILE', 'NARROW']);
    expect(bands.QUARTILE.DAY_1).toMatchObject({ lower: 0.2, upper: 0.6 });
    expect(bands.TERTILE.DAY_1.lower).toBeCloseTo(0.26666666666666666);
    expect(bands.NARROW.DAY_1.lower).toBeCloseTo(0.32);
    expect(bands.NARROW.DAY_1.upper).toBeCloseTo(0.48);
    expect(bands.QUARTILE.DAY_5.lower).toBe(0.3);
    expect(bands.QUARTILE.DAY_20.lower).toBe(0.4);
    expect(classifyShare(bands.QUARTILE.DAY_1.lower, bands.QUARTILE.DAY_1)).toBe('NEGATIVE');
    expect(classifyShare(bands.QUARTILE.DAY_1.upper, bands.QUARTILE.DAY_1)).toBe('POSITIVE');
    expect(classifyShare(0.5, bands.QUARTILE.DAY_1)).toBe('MIXED');
    expect(classifyShare(null, bands.QUARTILE.DAY_1)).toBeNull();
    const stability = validationStability(rows, bands, '2024-01-05');
    expect(stability.find(row => row.family === 'QUARTILE' && row.horizon === 'DAY_1')).toMatchObject({ lowerThreshold: 0.2, upperThreshold: 0.6, validationSampleCount: 1 });
  });
  it('uses midrank percentile lookup at validation ties', () => {
    expect(validationPercentile([0.1, 0.2, 0.2, 0.4], 0.2)).toBe(0.5);
    expect(validationPercentile([0.1, 0.2, 0.4], 0.3)).toBe(2 / 3);
    expect(validationPercentile([], 0.2)).toBeNull();
  });
  it('rejects overlapping bands when calibration has no separable three-state range', () => {
    expect(() => deriveBands(series([[0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]), '2024-01-02')).toThrow('bands overlap');
  });
  it('keeps 1d confirmation-only and opposite structural horizons MIXED', () => {
    for (const one of ['NEGATIVE', 'MIXED', 'POSITIVE'] as const) {
      expect(aggregateStructuralV3(one, 'MIXED', 'MIXED')).toBe('MIXED');
      expect(aggregateStructuralV3(one, 'POSITIVE', 'NEGATIVE')).toBe('MIXED');
      expect(aggregateStructuralV3(one, 'NEGATIVE', 'POSITIVE')).toBe('MIXED');
      expect(aggregateStructuralV3(one, 'POSITIVE', 'POSITIVE')).toBe('POSITIVE');
      expect(aggregateStructuralV3(one, 'NEGATIVE', 'NEGATIVE')).toBe('NEGATIVE');
      expect(aggregateStructuralV3(one, 'MIXED', 'POSITIVE')).toBe(one === 'POSITIVE' ? 'POSITIVE' : 'MIXED');
      expect(aggregateStructuralV3(one, 'NEGATIVE', 'MIXED')).toBe(one === 'NEGATIVE' ? 'NEGATIVE' : 'MIXED');
    }
  });
  it('reports raw, one-level, and mild transitions without a direct smoothed two-level flip', () => {
    const rows = series([[0, 0, 0], [1, 1, 1], [1, 1, 1], [1, 1, 1], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]);
    const band = { lower: 0.25, upper: 0.75, lowerPercentile: 0.25, upperPercentile: 0.75 };
    const horizons = { DAY_1: band, DAY_5: band, DAY_20: band };
    const bands: Bands = { QUARTILE: horizons, TERTILE: horizons, NARROW: horizons };
    const days = buildCandidateDays(rows, bands);
    expect(days).toHaveLength(54);
    const raw = days.filter(day => day.family === 'QUARTILE' && day.variant === 'RAW');
    const asymmetric = days.filter(day => day.family === 'QUARTILE' && day.variant === 'ASYMMETRIC_ONE_LEVEL');
    const mild = days.filter(day => day.family === 'QUARTILE' && day.variant === 'MILD_POSITIVE_MIXED_CONFIRMATION');
    expect(raw[1]?.transition).toBe('NEGATIVE -> POSITIVE');
    expect(asymmetric[1]?.effectiveState).toBe('NEGATIVE');
    expect(asymmetric[2]?.effectiveState).toBe('MIXED');
    expect(asymmetric[3]?.effectiveState).toBe('MIXED');
    expect(periodSummary(mild).directTwoLevelFlips).toBe(0);
    expect(periodSummary(asymmetric).directTwoLevelFlips).toBe(0);
    expect(periodSummary(raw).directTwoLevelFlips).toBe(1);
    expect(periodSummary(raw)).toMatchObject({ oneSessionRuns: 1, atMostTwoSessionRuns: 2, unavailableStateSessions: 0 });
    expect(buildCandidateDays(rows, bands)).toEqual(days);
  });
  it('keeps strict full-revision and stable-core sensitivity separate', () => {
    const full = series([[0.2, 0.3, 0.4], [0.8, 0.7, 0.6], [0.5, 0.5, 0.5]]);
    const core = series([[0.3, 0.4, 0.5], [0.7, 0.6, 0.5], [0.5, 0.5, 0.5]]);
    const bands = deriveBands(full, '2024-01-02');
    const result = sensitivity(full, core, buildCandidateDays(full, bands), buildCandidateDays(core, bands));
    expect(result.byHorizon.DAY_1).toMatchObject({ pairedSessions: 3, meanFullEligibleCount: 10, meanStableCoreEligibleCount: 10 });
    expect(result.byHorizon.DAY_1!.meanAbsoluteDifference).toBeCloseTo(1 / 15);
    expect(result.disagreements.QUARTILE!.rawStructuralStateDisagreementRate).not.toBeNull();
    expect(coverageDiagnostics(full).DAY_20).toMatchObject({ min: 1, below75: 0, below80: 0, below85: 0, below90: 0 });
  });
  it('holds the first mild MIXED from POSITIVE but drops immediately on raw NEGATIVE', () => {
    const mild = applyMildDeteriorationConfirmation(['POSITIVE', 'MIXED', 'MIXED', 'POSITIVE', 'NEGATIVE']);
    expect(mild.map(row => row.effectiveState)).toEqual(['POSITIVE', 'POSITIVE', 'MIXED', 'MIXED', 'NEGATIVE']);
    const first = advanceBreadth({ effectiveState: 'POSITIVE', confirmation: 0 }, 'NEGATIVE', { deteriorationMode: 'ONE_LEVEL_PER_ASSESSMENT' });
    expect(first.effectiveState).toBe('MIXED');
    const second = advanceBreadth({ effectiveState: first.effectiveState, confirmation: first.confirmationAfter }, 'NEGATIVE', { deteriorationMode: 'ONE_LEVEL_PER_ASSESSMENT' });
    expect(second.effectiveState).toBe('NEGATIVE');
  });
});
