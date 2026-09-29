import { describe, expect, it } from 'vitest';
import { aggregateStructuralV3, applyMildDeteriorationConfirmation, type BreadthState } from './breadth-calculation.js';
import { BREADTH_V2_TERTILE_V1, aggregateBreadthV2Structural, classifyBreadthV2Share, classifyFrozenBreadthV2Shares, replayBreadthV2MildConfirmation } from './breadth-v2.definition.js';
import { buildCandidateDays, type Bands, type Metric } from '../dev/breadth-v2-calibration.js';

const thresholds = BREADTH_V2_TERTILE_V1.thresholds;
const metric = (sessionDate: string, horizon: Metric['horizon'], advanceShare: number | null): Metric => ({ sessionDate, horizon, universeCount: 10, eligibleCount: 10, excludedCount: 0, advancingCount: 5, decliningCount: 5, unchangedCount: 0, directionalCount: 10, advanceShare, netBreadth: advanceShare === null ? null : 2 * advanceShare - 1, coverageRatio: 1 });

describe('proposed BREADTH_V2_TERTILE_V1 frozen definition', () => {
  it('retains every full-precision calibration threshold and versioned contract', () => {
    expect(BREADTH_V2_TERTILE_V1).toMatchObject({ algorithmVersion: 'BREADTH_V2_TERTILE_V1', selectedFamily: 'TERTILE', gapPolicy: 'STRICT', provider: 'TIINGO', timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED', splitNormalizationVersion: 'RAW_CLOSE_CUMULATIVE_TIINGO_SPLIT_V1', weighting: 'EQUAL_WEIGHT_ONE_SECURITY_ONE_VOTE', allowedStates: ['POSITIVE', 'MIXED', 'NEGATIVE'] });
    expect(thresholds.DAY_1.lower.toString()).toBe('0.3775183266753999');
    expect(thresholds.DAY_1.upper.toString()).toBe('0.6256031216081678');
    expect(thresholds.DAY_5.lower.toString()).toBe('0.4075077399380805');
    expect(thresholds.DAY_5.upper.toString()).toBe('0.6133782078249895');
    expect(thresholds.DAY_20.lower.toString()).toBe('0.41043083900226757');
    expect(thresholds.DAY_20.upper.toString()).toBe('0.6142910587355032');
    expect(Object.isFrozen(BREADTH_V2_TERTILE_V1)).toBe(true);
    expect(Object.isFrozen(thresholds.DAY_20)).toBe(true);
  });
  it('classifies just below, at, and just above both boundaries without rounding', () => {
    for (const band of Object.values(thresholds)) {
      expect(classifyBreadthV2Share(band.lower - Number.EPSILON, band)).toBe('NEGATIVE');
      expect(classifyBreadthV2Share(band.lower, band)).toBe('NEGATIVE');
      expect(classifyBreadthV2Share(band.lower + Number.EPSILON, band)).toBe('MIXED');
      expect(classifyBreadthV2Share(band.upper - Number.EPSILON, band)).toBe('MIXED');
      expect(classifyBreadthV2Share(band.upper, band)).toBe('POSITIVE');
      expect(classifyBreadthV2Share(band.upper + Number.EPSILON, band)).toBe('POSITIVE');
      expect(classifyBreadthV2Share(null, band)).toBeNull();
    }
  });
  it('matches the researched structural truth table for all 27 state combinations', () => {
    const states: BreadthState[] = ['NEGATIVE', 'MIXED', 'POSITIVE'];
    for (const day1 of states) for (const day5 of states) for (const day20 of states) {
      expect(aggregateBreadthV2Structural(day1, day5, day20)).toBe(aggregateStructuralV3(day1, day5, day20));
    }
    expect(aggregateBreadthV2Structural('POSITIVE', 'MIXED', 'MIXED')).toBe('MIXED');
    expect(aggregateBreadthV2Structural('POSITIVE', 'POSITIVE', 'NEGATIVE')).toBe('MIXED');
    expect(aggregateBreadthV2Structural('NEGATIVE', 'NEGATIVE', 'POSITIVE')).toBe('MIXED');
    expect(aggregateBreadthV2Structural('POSITIVE', 'MIXED', 'POSITIVE')).toBe('POSITIVE');
    expect(aggregateBreadthV2Structural('NEGATIVE', 'NEGATIVE', 'MIXED')).toBe('NEGATIVE');
    expect(aggregateBreadthV2Structural('MIXED', 'MIXED', 'POSITIVE')).toBe('MIXED');
  });
  it('fails closed when any required strict horizon observation is absent', () => {
    expect(classifyFrozenBreadthV2Shares({ DAY_1: null, DAY_5: 0.5, DAY_20: 0.5 }).rawState).toBeNull();
    expect(classifyFrozenBreadthV2Shares({ DAY_1: 0.5, DAY_5: null, DAY_20: 0.5 }).rawState).toBeNull();
    expect(classifyFrozenBreadthV2Shares({ DAY_1: 0.5, DAY_5: 0.5, DAY_20: null }).rawState).toBeNull();
    expect(aggregateBreadthV2Structural(null, 'POSITIVE', 'POSITIVE')).toBeNull();
  });
  it('preserves Phase 5B/5C TERTILE raw and mild effective classifications', () => {
    const values = [0.2, 0.5, 0.8, 0.6, 0.4, null, 0.7];
    const rows = values.flatMap((value, i) => (['DAY_1', 'DAY_5', 'DAY_20'] as const).map(horizon => metric(`2024-01-${String(i + 1).padStart(2, '0')}`, horizon, value)));
    const band = (horizon: keyof typeof thresholds) => ({ ...thresholds[horizon], lowerPercentile: 1 / 3, upperPercentile: 2 / 3 });
    const horizons = { DAY_1: band('DAY_1'), DAY_5: band('DAY_5'), DAY_20: band('DAY_20') };
    const bands: Bands = { QUARTILE: horizons, TERTILE: horizons, NARROW: horizons };
    const researched = buildCandidateDays(rows, bands).filter(day => day.family === 'TERTILE' && day.variant === 'MILD_POSITIVE_MIXED_CONFIRMATION');
    const frozen = values.map(value => classifyFrozenBreadthV2Shares({ DAY_1: value, DAY_5: value, DAY_20: value }));
    expect(researched.map(day => ({ horizonStates: day.horizonStates, rawState: day.rawState }))).toEqual(frozen);
    const raw = frozen.map(day => day.rawState);
    expect(replayBreadthV2MildConfirmation(raw)).toEqual(applyMildDeteriorationConfirmation(raw));
    expect(researched.map(day => day.effectiveState)).toEqual(replayBreadthV2MildConfirmation(raw).map(day => day.effectiveState));
  });
});
