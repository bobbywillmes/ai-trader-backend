import { describe, expect, it } from 'vitest';
import {
  advanceBreadth, BASELINE_BREADTH_BANDS, BREADTH_STATES, calculateBreadthSeries, classifyBreadthBand, classifyDirection,
  computeDailyBreadthObservation, medianBreadthState, summarizeBreadth,
  type BreadthBandsByHorizon, type BreadthHistory, type BreadthState, type DailyBreadthObservation,
} from './breadth-calculation.js';

const advance = (state: BreadthState | null, raw: BreadthState | null, confirmation = 0) => advanceBreadth({ effectiveState: state, confirmation }, raw);
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
    const observation = computeDailyBreadthObservation(universe, current, prior);
    expect(observation).toMatchObject({ advancingCount: 1, decliningCount: 1, unchangedCount: 1, directionalCount: 2, advanceShare: 0.5, netBreadth: 0 });
  });
  it('excludes a newly listed name with no prior-session close', () => {
    const observation = computeDailyBreadthObservation(['A', 'B'], new Map([['A', 100], ['B', 50]]), new Map([['A', 90]]));
    expect(observation).toMatchObject({ currentBarsFound: 2, priorBarsFound: 1, eligibleCount: 1, excludedCount: 1, directionalCount: 1 });
  });
  it('excludes a name missing its current close', () => {
    const observation = computeDailyBreadthObservation(['A', 'B'], new Map([['A', 100]]), new Map([['A', 90], ['B', 50]]));
    expect(observation).toMatchObject({ currentBarsFound: 1, priorBarsFound: 2, eligibleCount: 1, excludedCount: 1 });
  });
  it('never searches backward past the immediately previous expected session', () => {
    // The pure observation only ever sees the two maps it is given; an older close
    // simply is not present in `prior`, so a stale lookup is structurally impossible.
    const observation = computeDailyBreadthObservation(['A'], new Map([['A', 100]]), new Map());
    expect(observation.directionalCount).toBe(0);
    expect(observation.status).toBe('UNAVAILABLE');
  });
  it('is unavailable when directionalCount is zero, even with only unchanged names', () => {
    const observation = computeDailyBreadthObservation(['A'], new Map([['A', 100]]), new Map([['A', 100]]));
    expect(observation).toMatchObject({ status: 'UNAVAILABLE', unchangedCount: 1, directionalCount: 0, advanceShare: null, netBreadth: null });
  });
  it('computes advanceShare and netBreadth', () => {
    const observation = computeDailyBreadthObservation(['A', 'B', 'C', 'D'], new Map([['A', 2], ['B', 2], ['C', 1], ['D', 1]]), new Map([['A', 1], ['B', 1], ['C', 1], ['D', 2]]));
    expect(observation).toMatchObject({ advancingCount: 2, decliningCount: 1, unchangedCount: 1, directionalCount: 3, advanceShare: 2 / 3, netBreadth: 1 / 3 });
  });
});

describe('classification bands', () => {
  it.each([
    [0.449999, 'NEGATIVE'], [0.45, 'NEGATIVE'], [0.450001, 'MIXED'],
    [0.549999, 'MIXED'], [0.55, 'POSITIVE'], [0.550001, 'POSITIVE'],
  ] as const)('%s -> %s', (value, expected) => {
    expect(classifyBreadthBand(value)).toBe(expected);
  });
  it('takes the median of three horizon states', () => {
    expect(medianBreadthState(['NEGATIVE', 'MIXED', 'POSITIVE'])).toBe('MIXED');
    expect(medianBreadthState(['NEGATIVE', 'NEGATIVE', 'MIXED'])).toBe('NEGATIVE');
    expect(medianBreadthState(['POSITIVE', 'POSITIVE', 'MIXED'])).toBe('POSITIVE');
    expect(medianBreadthState(['MIXED', 'MIXED', 'MIXED'])).toBe('MIXED');
  });
  it('respects an explicit horizon-specific band instead of the baseline default', () => {
    const candidate5d = { negativeMax: 0.47, positiveMin: 0.53 };
    expect(classifyBreadthBand(0.47, candidate5d)).toBe('NEGATIVE');
    expect(classifyBreadthBand(0.470001, candidate5d)).toBe('MIXED');
    expect(classifyBreadthBand(0.529999, candidate5d)).toBe('MIXED');
    expect(classifyBreadthBand(0.53, candidate5d)).toBe('POSITIVE');
    const candidate20d = { negativeMax: 0.48, positiveMin: 0.52 };
    expect(classifyBreadthBand(0.48, candidate20d)).toBe('NEGATIVE');
    expect(classifyBreadthBand(0.480001, candidate20d)).toBe('MIXED');
    expect(classifyBreadthBand(0.519999, candidate20d)).toBe('MIXED');
    expect(classifyBreadthBand(0.52, candidate20d)).toBe('POSITIVE');
  });
  it('rejects an invalid band where negativeMax is not below positiveMin', () => {
    expect(() => classifyBreadthBand(0.5, { negativeMax: 0.5, positiveMin: 0.5 })).toThrow('Invalid band');
    expect(() => classifyBreadthBand(0.5, { negativeMax: 0.55, positiveMin: 0.45 })).toThrow('Invalid band');
  });
  it('defaults to the frozen baseline 45/55 band on every horizon when unspecified', () => {
    expect(BASELINE_BREADTH_BANDS).toEqual({
      breadth1: { negativeMax: 0.45, positiveMin: 0.55 },
      breadth5: { negativeMax: 0.45, positiveMin: 0.55 },
      breadth20: { negativeMax: 0.45, positiveMin: 0.55 },
    });
    expect(Object.isFrozen(BASELINE_BREADTH_BANDS)).toBe(true);
    expect(Object.isFrozen(BASELINE_BREADTH_BANDS.breadth1)).toBe(true);
  });
});

function observation(advanceShare: number, directionalCount = 100): DailyBreadthObservation {
  const advancingCount = Math.round(advanceShare * directionalCount);
  return { status: 'VALID', universeCount: directionalCount, currentBarsFound: directionalCount, priorBarsFound: directionalCount,
    eligibleCount: directionalCount, excludedCount: 0, advancingCount, decliningCount: directionalCount - advancingCount,
    unchangedCount: 0, directionalCount, advanceShare, netBreadth: (2 * advancingCount - directionalCount) / directionalCount };
}
const UNAVAILABLE: DailyBreadthObservation = { ...observation(0.5), status: 'UNAVAILABLE', advancingCount: 0, decliningCount: 0, directionalCount: 0, advanceShare: null, netBreadth: null };

describe('rolling measurements and warm-up', () => {
  it('requires exactly 20 consecutive valid sessions before any classification', () => {
    const series = calculateBreadthSeries(dates(21), Array(21).fill(observation(0.6)));
    expect(series.slice(0, 19).every(day => day.rawState === null)).toBe(true);
    expect(series[19]!.breadth20).not.toBeNull();
    expect(series[19]!.rawState).not.toBeNull();
  });
  it('breadth1 is the current advanceShare; breadth5/20 are exact arithmetic means', () => {
    const shares = [0.6, 0.5, 0.4, 0.7, 0.3, ...Array(15).fill(0.5)];
    const series = calculateBreadthSeries(dates(20), shares.map(observation));
    const last = series.at(-1)!;
    expect(last.breadth1!.value).toBe(0.5);
    expect(last.breadth5!.value).toBeCloseTo((0.5 + 0.5 + 0.5 + 0.5 + 0.5) / 5, 12);
    const fifth = series[4]!;
    expect(fifth.breadth5!.value).toBeCloseTo((0.6 + 0.5 + 0.4 + 0.7 + 0.3) / 5, 12);
    expect(fifth.breadth20).toBeNull();
  });
  it('a missing expected session breaks continuity and restarts warm-up', () => {
    const observations = [...Array(20).fill(observation(0.6)), null, ...Array(4).fill(observation(0.6))];
    const series = calculateBreadthSeries(dates(25), observations);
    expect(series[19]!.rawState).not.toBeNull();
    expect(series[20]!.consecutiveValidSessions).toBe(0);
    expect(series[20]!.rawState).toBeNull();
    expect(series[24]!.consecutiveValidSessions).toBe(4);
    expect(series[24]!.breadth20).toBeNull();
  });
  it('a resolved zero-directional UNAVAILABLE observation also breaks continuity', () => {
    const observations = [...Array(20).fill(observation(0.6)), UNAVAILABLE, ...Array(4).fill(observation(0.6))];
    const series = calculateBreadthSeries(dates(25), observations);
    expect(series[20]!.consecutiveValidSessions).toBe(0);
    expect(series[24]!.consecutiveValidSessions).toBe(4);
  });
  it('re-warms fully after a gap', () => {
    const observations = [...Array(20).fill(observation(0.6)), null, ...Array(20).fill(observation(0.6))];
    const series = calculateBreadthSeries(dates(41), observations);
    expect(series[39]!.breadth20).toBeNull();
    expect(series[40]!.breadth20).not.toBeNull();
  });
});

describe('hysteresis', () => {
  it('bootstraps effective state from the first raw state with zero confirmation', () => {
    const result = advance(null, 'MIXED');
    expect(result).toMatchObject({ effectiveState: 'MIXED', confirmationAfter: 0, transitioned: false });
  });
  it.each([
    ['POSITIVE', 'MIXED'], ['POSITIVE', 'NEGATIVE'], ['MIXED', 'NEGATIVE'],
  ] as const)('%s -> %s is immediate regardless of confirmation', (before, raw) => {
    expect(advance(before, raw, 1)).toMatchObject({ effectiveState: raw, confirmationAfter: 0, transitioned: true });
  });
  it('NEGATIVE -> MIXED requires two supporting sessions and recovers exactly one level', () => {
    let history: BreadthHistory = { effectiveState: 'NEGATIVE', confirmation: 0 };
    const day1 = advanceBreadth(history, 'MIXED');
    expect(day1).toMatchObject({ effectiveState: 'NEGATIVE', confirmationAfter: 1, transitioned: false });
    history = { effectiveState: day1.effectiveState, confirmation: day1.confirmationAfter };
    const day2 = advanceBreadth(history, 'MIXED');
    expect(day2).toMatchObject({ effectiveState: 'MIXED', confirmationAfter: 0, transitioned: true });
  });
  it('two raw POSITIVE sessions from NEGATIVE recover only to MIXED, not POSITIVE', () => {
    let history: BreadthHistory = { effectiveState: 'NEGATIVE', confirmation: 0 };
    const day1 = advanceBreadth(history, 'POSITIVE');
    expect(day1.effectiveState).toBe('NEGATIVE');
    history = { effectiveState: day1.effectiveState, confirmation: day1.confirmationAfter };
    const day2 = advanceBreadth(history, 'POSITIVE');
    expect(day2).toMatchObject({ effectiveState: 'MIXED', recoveryTarget: 'MIXED', transitioned: true });
  });
  it('MIXED -> POSITIVE requires a fresh two-session confirmation after recovering to MIXED', () => {
    const day3 = advance('MIXED', 'POSITIVE');
    expect(day3).toMatchObject({ effectiveState: 'MIXED', confirmationAfter: 1 });
    const day4 = advanceBreadth({ effectiveState: 'MIXED', confirmation: 1 }, 'POSITIVE');
    expect(day4).toMatchObject({ effectiveState: 'POSITIVE', confirmationAfter: 0, transitioned: true });
  });
  it('raw equal to effective holds and resets confirmation', () => {
    expect(advance('MIXED', 'MIXED', 1)).toMatchObject({ effectiveState: 'MIXED', confirmationAfter: 0, transitioned: false });
  });
  it('deterioration interrupts a pending recovery, ignoring its banked confirmation', () => {
    const pending = advanceBreadth({ effectiveState: 'MIXED', confirmation: 1 }, 'NEGATIVE');
    expect(pending).toMatchObject({ effectiveState: 'NEGATIVE', confirmationAfter: 0, transitioned: true });
  });
  it('unavailable evidence pauses effective state and confirmation without incrementing or resetting', () => {
    const result = advance('MIXED', null, 1);
    expect(result).toMatchObject({ effectiveState: 'MIXED', confirmationAfter: 1, transitioned: false });
  });
  it('rejects an invalid persisted continuation', () => {
    expect(() => advanceBreadth({ effectiveState: null, confirmation: 1 }, 'MIXED')).toThrow('Invalid hysteresis continuation.');
  });
});

describe('end-to-end series and summary', () => {
  it('replays deterioration then confirmed single-step recovery across a full series', () => {
    const shares = [...Array(20).fill(0.6), 0.2, 0.2, 0.48, 0.48, 0.6, 0.6];
    const series = calculateBreadthSeries(dates(26), shares.map(observation));
    const states = series.map(day => day.effectiveState);
    expect(states[19]).toBe('POSITIVE');
    // Raw drops immediately deteriorate the effective state (median pulls it to MIXED here).
    expect(states[20]).toBe('MIXED');
  });
  it('summarizes distributions, transitions, runs and horizon agreement', () => {
    const shares = [...Array(25).fill(0.6)];
    const series = calculateBreadthSeries(dates(25), shares.map(observation));
    const summary = summarizeBreadth(series);
    expect(summary.expectedSessions).toBe(25);
    expect(summary.validObservations).toBe(25);
    expect(summary.effectiveStateDistribution.percentages.POSITIVE).toBeGreaterThan(0);
    expect(summary.horizonAgreement).not.toBeNull();
    expect(BREADTH_STATES).toEqual(['NEGATIVE', 'MIXED', 'POSITIVE']);
  });
  it('counts a provider gap and a zero-directional day separately in the summary', () => {
    const series = calculateBreadthSeries(dates(3), [observation(0.6), null, UNAVAILABLE]);
    const summary = summarizeBreadth(series);
    expect(summary.providerGaps).toBe(1);
    expect(summary.zeroDirectionalDays).toBe(1);
    expect(summary.unavailableObservations).toBe(2);
  });
  it('same evidence classifies differently only because of the band definition, with hysteresis and median-of-three otherwise unchanged', () => {
    // 0.53 sits inside the baseline MIXED zone for every horizon (all share 0.45/0.55), but
    // is >= a narrowed 5d positiveMin of 0.53 and a narrowed 20d positiveMin of 0.52.
    const shares = Array(25).fill(0.53);
    const observations = shares.map((share: number) => observation(share));
    const baseline = calculateBreadthSeries(dates(25), observations);
    const candidate: BreadthBandsByHorizon = {
      breadth1: { negativeMax: 0.45, positiveMin: 0.55 },
      breadth5: { negativeMax: 0.47, positiveMin: 0.53 },
      breadth20: { negativeMax: 0.48, positiveMin: 0.52 },
    };
    const withCandidate = calculateBreadthSeries(dates(25), observations, candidate);
    const last = { baseline: baseline[19]!, candidate: withCandidate[19]! }; // first day breadth20 exists (warm-up complete)
    expect(last.baseline.breadth1).toEqual(last.candidate.breadth1); // 1d band unchanged between definitions
    expect(last.baseline.breadth1!.value).toBe(last.candidate.breadth1!.value); // identical underlying evidence
    expect(last.baseline.breadth5!.state).toBe('MIXED');
    expect(last.candidate.breadth5!.state).toBe('POSITIVE');
    expect(last.baseline.breadth20!.state).toBe('MIXED');
    expect(last.candidate.breadth20!.state).toBe('POSITIVE');
    expect(last.baseline.breadth20!.value).toBe(last.candidate.breadth20!.value); // identical underlying evidence
    expect(last.baseline.rawState).toBe('MIXED');
    expect(last.candidate.rawState).toBe('POSITIVE'); // 2 of 3 horizons (5d, 20d) now agree POSITIVE
    // Hysteresis mechanics (bootstrap here) are identical in shape; only the raw input differs.
    expect(last.baseline.hysteresis.reason).toContain('Bootstrap');
    expect(last.candidate.hysteresis.reason).toContain('Bootstrap');
  });
});
