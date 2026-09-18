import { describe, expect, it } from 'vitest';
import {
  advanceBreadthV1, aggregateBreadthV1RawState, BREADTH_STATES, BREADTH_V1_DEFINITION,
  calculateBreadthV1Series, classifyBreadthV1Band, classifyDirection, computeDailyBreadthV1Observation,
  type BreadthState, type BreadthV1History, type DailyBreadthV1Observation,
} from './breadth-v1-calculation.js';

const advance = (state: BreadthState | null, raw: BreadthState | null, recoveryConfirmation = 0, mildDeteriorationConfirmation = 0) =>
  advanceBreadthV1({ effectiveState: state, recoveryConfirmation, mildDeteriorationConfirmation }, raw);
const dates = (count: number) => Array.from({ length: count }, (_, i) => new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10));

describe('daily observation', () => {
  it('classifies advancing, declining and unchanged', () => {
    expect(classifyDirection(101, 100)).toBe('ADVANCING');
    expect(classifyDirection(99, 100)).toBe('DECLINING');
    expect(classifyDirection(100, 100)).toBe('UNCHANGED');
  });
  it('excludes unchanged names from the directional denominator', () => {
    const universe = ['A', 'B', 'C'];
    const current = new Map([['A', 100], ['B', 99], ['C', 100]]);
    const prior = new Map([['A', 90], ['B', 100], ['C', 100]]);
    const observation = computeDailyBreadthV1Observation(universe, current, prior);
    expect(observation).toMatchObject({ advancingCount: 1, decliningCount: 1, unchangedCount: 1, directionalCount: 2, advanceShare: 0.5, netBreadth: 0 });
  });
  it('excludes a newly listed name with no prior-session close', () => {
    const observation = computeDailyBreadthV1Observation(['A', 'B'], new Map([['A', 100], ['B', 50]]), new Map([['A', 90]]));
    expect(observation).toMatchObject({ currentBarsFound: 2, priorBarsFound: 1, eligibleCount: 1, excludedCount: 1, directionalCount: 1 });
  });
  it('excludes a name missing its current close', () => {
    const observation = computeDailyBreadthV1Observation(['A', 'B'], new Map([['A', 100]]), new Map([['A', 90], ['B', 50]]));
    expect(observation).toMatchObject({ currentBarsFound: 1, priorBarsFound: 2, eligibleCount: 1, excludedCount: 1 });
  });
  it('never searches backward past the immediately previous expected session', () => {
    const observation = computeDailyBreadthV1Observation(['A'], new Map([['A', 100]]), new Map());
    expect(observation.directionalCount).toBe(0);
    expect(observation.status).toBe('UNAVAILABLE');
  });
  it('is unavailable when directionalCount is zero, even with only unchanged names', () => {
    const observation = computeDailyBreadthV1Observation(['A'], new Map([['A', 100]]), new Map([['A', 100]]));
    expect(observation).toMatchObject({ status: 'UNAVAILABLE', unchangedCount: 1, directionalCount: 0, advanceShare: null, netBreadth: null });
  });
  it('computes advanceShare and netBreadth', () => {
    const observation = computeDailyBreadthV1Observation(['A', 'B', 'C', 'D'], new Map([['A', 2], ['B', 2], ['C', 1], ['D', 1]]), new Map([['A', 1], ['B', 1], ['C', 1], ['D', 2]]));
    expect(observation).toMatchObject({ advancingCount: 2, decliningCount: 1, unchangedCount: 1, directionalCount: 3, advanceShare: 2 / 3, netBreadth: 1 / 3 });
  });
});

describe('BREADTH_V1 frozen thresholds', () => {
  it.each([
    [0.44, 'NEGATIVE'], [0.440001, 'MIXED'], [0.539999, 'MIXED'], [0.54, 'POSITIVE'],
  ] as const)('breadth1: %s -> %s', (value, expected) => {
    expect(classifyBreadthV1Band(value, BREADTH_V1_DEFINITION.bands.breadth1)).toBe(expected);
  });
  it.each([
    [0.46, 'NEGATIVE'], [0.460001, 'MIXED'], [0.519999, 'MIXED'], [0.52, 'POSITIVE'],
  ] as const)('breadth5: %s -> %s', (value, expected) => {
    expect(classifyBreadthV1Band(value, BREADTH_V1_DEFINITION.bands.breadth5)).toBe(expected);
  });
  it.each([
    [0.47, 'NEGATIVE'], [0.470001, 'MIXED'], [0.509999, 'MIXED'], [0.51, 'POSITIVE'],
  ] as const)('breadth20: %s -> %s', (value, expected) => {
    expect(classifyBreadthV1Band(value, BREADTH_V1_DEFINITION.bands.breadth20)).toBe(expected);
  });
  it('is frozen and immutable', () => {
    expect(Object.isFrozen(BREADTH_V1_DEFINITION)).toBe(true);
    expect(Object.isFrozen(BREADTH_V1_DEFINITION.bands)).toBe(true);
    expect(Object.isFrozen(BREADTH_V1_DEFINITION.bands.breadth1)).toBe(true);
  });
});

describe('BREADTH_V1 raw aggregation (5d/20d structural, 1d confirms only)', () => {
  it('5d/20d POSITIVE agreement wins regardless of 1d', () => {
    expect(aggregateBreadthV1RawState('POSITIVE', 'POSITIVE', 'POSITIVE')).toBe('POSITIVE');
    expect(aggregateBreadthV1RawState('NEGATIVE', 'POSITIVE', 'POSITIVE')).toBe('POSITIVE');
  });
  it('5d/20d NEGATIVE agreement wins regardless of 1d', () => {
    expect(aggregateBreadthV1RawState('POSITIVE', 'NEGATIVE', 'NEGATIVE')).toBe('NEGATIVE');
    expect(aggregateBreadthV1RawState('NEGATIVE', 'NEGATIVE', 'NEGATIVE')).toBe('NEGATIVE');
  });
  it('5d/20d opposite is always MIXED, 1d cannot break the tie', () => {
    expect(aggregateBreadthV1RawState('POSITIVE', 'POSITIVE', 'NEGATIVE')).toBe('MIXED');
    expect(aggregateBreadthV1RawState('NEGATIVE', 'NEGATIVE', 'POSITIVE')).toBe('MIXED');
  });
  it('one structural POSITIVE + one MIXED is POSITIVE only when 1d confirms POSITIVE', () => {
    expect(aggregateBreadthV1RawState('POSITIVE', 'POSITIVE', 'MIXED')).toBe('POSITIVE');
    expect(aggregateBreadthV1RawState('POSITIVE', 'MIXED', 'POSITIVE')).toBe('POSITIVE');
    expect(aggregateBreadthV1RawState('MIXED', 'POSITIVE', 'MIXED')).toBe('MIXED');
    expect(aggregateBreadthV1RawState('NEGATIVE', 'POSITIVE', 'MIXED')).toBe('MIXED');
  });
  it('one structural NEGATIVE + one MIXED is NEGATIVE only when 1d confirms NEGATIVE', () => {
    expect(aggregateBreadthV1RawState('NEGATIVE', 'NEGATIVE', 'MIXED')).toBe('NEGATIVE');
    expect(aggregateBreadthV1RawState('MIXED', 'NEGATIVE', 'MIXED')).toBe('MIXED');
    expect(aggregateBreadthV1RawState('POSITIVE', 'NEGATIVE', 'MIXED')).toBe('MIXED');
  });
  it('both structural horizons MIXED is always MIXED regardless of 1d', () => {
    expect(aggregateBreadthV1RawState('POSITIVE', 'MIXED', 'MIXED')).toBe('MIXED');
    expect(aggregateBreadthV1RawState('NEGATIVE', 'MIXED', 'MIXED')).toBe('MIXED');
    expect(aggregateBreadthV1RawState('MIXED', 'MIXED', 'MIXED')).toBe('MIXED');
  });
  it('1d alone can never create a directional raw state', () => {
    // Every directional raw outcome above requires 5d or 20d to already be non-MIXED.
    expect(aggregateBreadthV1RawState('POSITIVE', 'MIXED', 'MIXED')).not.toBe('POSITIVE');
    expect(aggregateBreadthV1RawState('NEGATIVE', 'MIXED', 'MIXED')).not.toBe('NEGATIVE');
  });
});

describe('BREADTH_V1 hysteresis', () => {
  it('bootstraps effective state from the first raw state with both counters zero', () => {
    expect(advance(null, 'MIXED')).toMatchObject({ effectiveState: 'MIXED', recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, transitioned: false });
  });
  it('POSITIVE + first raw MIXED holds POSITIVE with mild-deterioration confirmation 1', () => {
    expect(advance('POSITIVE', 'MIXED')).toMatchObject({ effectiveState: 'POSITIVE', mildDeteriorationConfirmationAfter: 1, transitioned: false });
  });
  it('POSITIVE + second consecutive raw MIXED moves to MIXED', () => {
    expect(advance('POSITIVE', 'MIXED', 0, 1)).toMatchObject({ effectiveState: 'MIXED', recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, transitioned: true });
  });
  it('POSITIVE / raw MIXED / raw POSITIVE never leaves POSITIVE and resets the mild counter', () => {
    const day1 = advance('POSITIVE', 'MIXED');
    const day2 = advance(day1.effectiveState, 'POSITIVE', day1.recoveryConfirmationAfter, day1.mildDeteriorationConfirmationAfter);
    expect(day2).toMatchObject({ effectiveState: 'POSITIVE', mildDeteriorationConfirmationAfter: 0, transitioned: false });
  });
  it('POSITIVE / raw MIXED / raw NEGATIVE drops to MIXED immediately, not waiting for a second MIXED', () => {
    const day1 = advance('POSITIVE', 'MIXED');
    const day2 = advance(day1.effectiveState, 'NEGATIVE', day1.recoveryConfirmationAfter, day1.mildDeteriorationConfirmationAfter);
    expect(day2).toMatchObject({ effectiveState: 'MIXED', recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, transitioned: true });
  });
  it('POSITIVE + raw NEGATIVE drops to MIXED immediately with no confirmation delay', () => {
    expect(advance('POSITIVE', 'NEGATIVE')).toMatchObject({ effectiveState: 'MIXED', transitioned: true });
  });
  it('a following raw NEGATIVE then drops MIXED -> NEGATIVE immediately', () => {
    const day1 = advance('POSITIVE', 'NEGATIVE');
    const day2 = advance(day1.effectiveState, 'NEGATIVE', day1.recoveryConfirmationAfter, day1.mildDeteriorationConfirmationAfter);
    expect(day2).toMatchObject({ effectiveState: 'NEGATIVE', transitioned: true });
  });
  it('direct POSITIVE -> NEGATIVE in one assessment is structurally impossible', () => {
    expect(advance('POSITIVE', 'NEGATIVE').effectiveState).toBe('MIXED');
  });
  it('MIXED + raw NEGATIVE drops to NEGATIVE immediately', () => {
    expect(advance('MIXED', 'NEGATIVE')).toMatchObject({ effectiveState: 'NEGATIVE', transitioned: true });
  });
  it('MIXED recovery to POSITIVE requires two consecutive supporting raw POSITIVE assessments', () => {
    const day1 = advance('MIXED', 'POSITIVE');
    expect(day1).toMatchObject({ effectiveState: 'MIXED', recoveryConfirmationAfter: 1, transitioned: false });
    const day2 = advance(day1.effectiveState, 'POSITIVE', day1.recoveryConfirmationAfter, day1.mildDeteriorationConfirmationAfter);
    expect(day2).toMatchObject({ effectiveState: 'POSITIVE', recoveryConfirmationAfter: 0, transitioned: true });
  });
  it('MIXED holds and resets counters on raw MIXED', () => {
    expect(advance('MIXED', 'MIXED', 1, 0)).toMatchObject({ effectiveState: 'MIXED', recoveryConfirmationAfter: 0, transitioned: false });
  });
  it('NEGATIVE recovery requires two consecutive supporting raw MIXED (or POSITIVE) assessments', () => {
    const day1 = advance('NEGATIVE', 'MIXED');
    expect(day1).toMatchObject({ effectiveState: 'NEGATIVE', recoveryConfirmationAfter: 1, transitioned: false });
    const day2 = advance(day1.effectiveState, 'MIXED', day1.recoveryConfirmationAfter, day1.mildDeteriorationConfirmationAfter);
    expect(day2).toMatchObject({ effectiveState: 'MIXED', recoveryConfirmationAfter: 0, transitioned: true });
  });
  it('NEGATIVE + two consecutive raw POSITIVE recovers only to MIXED, never straight to POSITIVE', () => {
    const day1 = advance('NEGATIVE', 'POSITIVE');
    const day2 = advance(day1.effectiveState, 'POSITIVE', day1.recoveryConfirmationAfter, day1.mildDeteriorationConfirmationAfter);
    expect(day2).toMatchObject({ effectiveState: 'MIXED', transitioned: true });
    const day3 = advance(day2.effectiveState, 'POSITIVE', day2.recoveryConfirmationAfter, day2.mildDeteriorationConfirmationAfter);
    expect(day3).toMatchObject({ effectiveState: 'MIXED', recoveryConfirmationAfter: 1, transitioned: false });
  });
  it('unavailable evidence pauses both confirmation counters without incrementing, resetting, or transitioning', () => {
    expect(advance('POSITIVE', null, 0, 1)).toMatchObject({ effectiveState: 'POSITIVE', recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 1, transitioned: false });
    expect(advance('MIXED', null, 1, 0)).toMatchObject({ effectiveState: 'MIXED', recoveryConfirmationAfter: 1, transitioned: false });
  });
  it('rejects an invalid persisted continuation', () => {
    const invalid: BreadthV1History = { effectiveState: null, recoveryConfirmation: 1, mildDeteriorationConfirmation: 0 };
    expect(() => advanceBreadthV1(invalid, 'MIXED')).toThrow('Invalid hysteresis continuation.');
  });
  it('never produces a NEGATIVE -> POSITIVE effective transition regardless of raw evidence', () => {
    // Recovery always moves exactly one level, so NEGATIVE can only ever reach MIXED next.
    const day1 = advance('NEGATIVE', 'POSITIVE');
    const day2 = advance(day1.effectiveState, 'POSITIVE', day1.recoveryConfirmationAfter, day1.mildDeteriorationConfirmationAfter);
    expect(day2.effectiveState).not.toBe('POSITIVE');
  });
});

function observation(advanceShare: number, directionalCount = 100): DailyBreadthV1Observation {
  const advancingCount = Math.round(advanceShare * directionalCount);
  return { status: 'VALID', universeCount: directionalCount, currentBarsFound: directionalCount, priorBarsFound: directionalCount,
    eligibleCount: directionalCount, excludedCount: 0, advancingCount, decliningCount: directionalCount - advancingCount,
    unchangedCount: 0, directionalCount, advanceShare, netBreadth: (2 * advancingCount - directionalCount) / directionalCount };
}
const UNAVAILABLE: DailyBreadthV1Observation = { ...observation(0.5), status: 'UNAVAILABLE', advancingCount: 0, decliningCount: 0, directionalCount: 0, advanceShare: null, netBreadth: null };

describe('BREADTH_V1 rolling measurements and warm-up', () => {
  it('requires exactly 20 consecutive valid sessions before any classification', () => {
    const series = calculateBreadthV1Series(dates(21), Array(21).fill(observation(0.6)));
    expect(series.slice(0, 19).every(day => day.rawState === null)).toBe(true);
    expect(series[19]!.breadth20).not.toBeNull();
    expect(series[19]!.rawState).not.toBeNull();
  });
  it('breadth1 is the current advanceShare; breadth5/20 are exact arithmetic means', () => {
    const shares = [0.6, 0.5, 0.4, 0.7, 0.3, ...Array(15).fill(0.5)];
    const series = calculateBreadthV1Series(dates(20), shares.map(observation));
    const last = series.at(-1)!;
    expect(last.breadth1!.value).toBe(0.5);
    expect(last.breadth5!.value).toBeCloseTo(0.5, 12);
    const fifth = series[4]!;
    expect(fifth.breadth5!.value).toBeCloseTo((0.6 + 0.5 + 0.4 + 0.7 + 0.3) / 5, 12);
    expect(fifth.breadth20).toBeNull();
  });
  it('a missing expected session breaks continuity and restarts warm-up', () => {
    const observations = [...Array(20).fill(observation(0.6)), null, ...Array(4).fill(observation(0.6))];
    const series = calculateBreadthV1Series(dates(25), observations);
    expect(series[19]!.rawState).not.toBeNull();
    expect(series[20]!.consecutiveValidSessions).toBe(0);
    expect(series[20]!.rawState).toBeNull();
    expect(series[24]!.consecutiveValidSessions).toBe(4);
    expect(series[24]!.breadth20).toBeNull();
  });
  it('a resolved zero-directional UNAVAILABLE observation also breaks continuity', () => {
    const observations = [...Array(20).fill(observation(0.6)), UNAVAILABLE, ...Array(4).fill(observation(0.6))];
    const series = calculateBreadthV1Series(dates(25), observations);
    expect(series[20]!.consecutiveValidSessions).toBe(0);
    expect(series[24]!.consecutiveValidSessions).toBe(4);
  });
  it('re-warms fully after a gap', () => {
    const observations = [...Array(20).fill(observation(0.6)), null, ...Array(20).fill(observation(0.6))];
    const series = calculateBreadthV1Series(dates(41), observations);
    expect(series[39]!.breadth20).toBeNull();
    expect(series[40]!.breadth20).not.toBeNull();
  });
  it('rejects mismatched dates/observations lengths and non-chronological dates', () => {
    expect(() => calculateBreadthV1Series(dates(3), [observation(0.5), observation(0.5)])).toThrow('Aligned dates and observations required.');
    expect(() => calculateBreadthV1Series(['2020-01-02', '2020-01-01'], [observation(0.5), observation(0.5)])).toThrow('Unique chronological dates required.');
  });
});

describe('BREADTH_V1 definition sanity', () => {
  it('exposes the frozen horizons and states used by the calculator', () => {
    expect(BREADTH_V1_DEFINITION.horizons).toEqual([1, 5, 20]);
    expect(BREADTH_STATES).toEqual(['NEGATIVE', 'MIXED', 'POSITIVE']);
  });
});
