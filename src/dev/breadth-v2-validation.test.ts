import { describe, expect, it } from 'vitest';
import { datesBetween, marketSession } from '../services/market-calendar.js';
import { buildCandidateDays, deriveBands, type CandidateDay, type Metric } from './breadth-v2-calibration.js';
import { benchmarkOutcomes, candidateDisagreements, outcomeStatistics, regimeEntries, transitionEvents, type BenchmarkBar } from './breadth-v2-validation.js';

const sessions = Array.from({ length: 22 }, (_, i) => `s${String(i).padStart(2, '0')}`);
const bars = (closes: readonly number[], splitAt: Record<number, string> = {}): BenchmarkBar[] => closes.map((close, i) => ({ date: sessions[i]!, close: String(close), splitFactor: splitAt[i] ?? '1', provider: 'TIINGO' }));
const day = (sessionDate: string, family: CandidateDay['family'], state: CandidateDay['effectiveState'], transition: string | null = null): CandidateDay => ({ sessionDate, family, variant: 'MILD_POSITIVE_MIXED_CONFIRMATION', values: { DAY_1: null, DAY_5: null, DAY_20: null }, horizonStates: { DAY_1: null, DAY_5: null, DAY_20: null }, rawState: state, effectiveState: state, transition });

describe('BREADTH_V2 Phase 5C validation arithmetic', () => {
  it('uses exact forward market-session offsets, split normalization, and complete windows', () => {
    const prices = Array.from({ length: 22 }, (_, i) => i < 5 ? 100 : i < 10 ? 50 : 25);
    const outcomes = benchmarkOutcomes(sessions, 'SPY', bars(prices, { 5: '2', 10: '2' }), [], []);
    expect(outcomes.find(row => row.sessionDate === 's00' && row.horizon === 1)).toMatchObject({ forwardReturn: 0, forwardMaxDrawdown: null, forwardMaxGain: null });
    expect(outcomes.find(row => row.sessionDate === 's00' && row.horizon === 5)).toMatchObject({ forwardReturn: 0, forwardMaxDrawdown: 0, forwardMaxGain: 0 });
    expect(outcomes.find(row => row.sessionDate === 's00' && row.horizon === 20)).toMatchObject({ forwardReturn: 0, forwardMaxDrawdown: 0, forwardMaxGain: 0 });
    expect(outcomes.find(row => row.sessionDate === 's02' && row.horizon === 20)?.forwardReturn).toBeNull();
    expect(outcomes.find(row => row.sessionDate === 's02' && row.horizon === 20)?.unavailableReason).toBe('INCOMPLETE_FORWARD_WINDOW');
  });
  it('crosses weekends and reviewed closures by market session, not calendar day', () => {
    const dates = datesBetween('2026-09-03', '2026-09-11').filter(date => marketSession(date, [{ sessionDate: '2026-09-07', type: 'CLOSED', closeTimeMinutesEt: null }]));
    const rows = dates.map((date, i) => ({ date, close: String(100 + i), splitFactor: '1', provider: 'TIINGO' as const }));
    expect(dates).toEqual(['2026-09-03', '2026-09-04', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
    expect(benchmarkOutcomes(dates, 'SPY', rows, [], []).find(row => row.sessionDate === '2026-09-03' && row.horizon === 5)?.forwardReturn).toBe(0.05);
  });
  it('fails closed on a benchmark provider seam or missing Massive split coverage', () => {
    const seam = [bars([100, 101])[0]!, { date: 's01', close: '102', splitFactor: '1', provider: 'MASSIVE' as const }];
    expect(benchmarkOutcomes(sessions, 'SPY', seam, [], [])[0]?.unavailableReason).toBe('PROVIDER_SEAM');
    const massive: BenchmarkBar[] = [{ date: 's00', close: '100', splitFactor: null, provider: 'MASSIVE' }, { date: 's01', close: '50', splitFactor: null, provider: 'MASSIVE' }];
    expect(benchmarkOutcomes(sessions, 'SPY', massive, [{ date: 's01', factor: '2', provider: 'MASSIVE' }], [])[0]?.unavailableReason).toBe('SPLIT_COVERAGE_UNAVAILABLE');
    expect(benchmarkOutcomes(sessions, 'SPY', massive, [{ date: 's01', factor: '2', provider: 'MASSIVE' }], [{ from: 's00', through: 's01', provider: 'MASSIVE' }])[0]?.forwardReturn).toBe(0);
  });
  it('summarizes outcomes and leaves one-session extrema unavailable', () => {
    const rows = benchmarkOutcomes(sessions, 'RSP', bars(Array.from({ length: 22 }, (_, i) => 100 + i)), [], []).filter(row => row.horizon === 1 && ['s00', 's01'].includes(row.sessionDate));
    expect(outcomeStatistics(rows)).toMatchObject({ sampleCount: 2, positiveReturnRate: 1, meanMaxDrawdown: null, medianMaxGain: null });
    expect(outcomeStatistics([])).toMatchObject({ sampleCount: 0, meanReturn: null, positiveReturnRate: null });
  });
  it('separates all sessions, regime entries, and explicit transition events', () => {
    const rows = [day('a', 'QUARTILE', 'POSITIVE'), day('b', 'QUARTILE', 'POSITIVE'), day('c', 'QUARTILE', 'MIXED', 'POSITIVE -> MIXED'), day('d', 'QUARTILE', 'NEGATIVE', 'MIXED -> NEGATIVE'), day('e', 'QUARTILE', null), day('f', 'QUARTILE', 'NEGATIVE')];
    expect(regimeEntries(rows).map(row => row.sessionDate)).toEqual(['a', 'c', 'd', 'f']);
    expect(transitionEvents(rows).map(row => row.transition)).toEqual(['POSITIVE -> MIXED', 'MIXED -> NEGATIVE']);
  });
  it('categorizes confidence disagreements and surfaces opposite directions', () => {
    const rows = [
      day('a', 'QUARTILE', 'MIXED'), day('a', 'TERTILE', 'MIXED'), day('a', 'NARROW', 'POSITIVE'),
      day('b', 'QUARTILE', 'MIXED'), day('b', 'TERTILE', 'NEGATIVE'), day('b', 'NARROW', 'NEGATIVE'),
      day('c', 'QUARTILE', 'POSITIVE'), day('c', 'TERTILE', 'NEGATIVE'), day('c', 'NARROW', 'MIXED'),
      day('d', 'QUARTILE', 'MIXED'), day('d', 'TERTILE', 'MIXED'), day('d', 'NARROW', 'MIXED'),
    ];
    expect(candidateDisagreements(rows).map(row => row.category)).toEqual(['NARROW_DIRECTIONAL_ONLY', 'NARROW_TERTILE_DIRECTIONAL', 'OPPOSITE_DIRECTIONAL', 'ALL_AGREE']);
    expect(candidateDisagreements(rows).filter(row => row.oppositeDirectional).map(row => row.sessionDate)).toEqual(['c']);
  });
  it('keeps frozen Phase 5B states independent of later benchmark bars', () => {
    const metric = (sessionDate: string, horizon: Metric['horizon'], value: number): Metric => ({ sessionDate, horizon, universeCount: 2, eligibleCount: 2, excludedCount: 0, advancingCount: 1, decliningCount: 1, unchangedCount: 0, directionalCount: 2, advanceShare: value, netBreadth: 2 * value - 1, coverageRatio: 1 });
    const rows = ['2024-01-01', '2024-01-02', '2024-01-03'].flatMap((date, i) => (['DAY_1', 'DAY_5', 'DAY_20'] as const).map(h => metric(date, h, i / 2)));
    const frozen = buildCandidateDays(rows, deriveBands(rows, '2024-01-02'));
    const before = benchmarkOutcomes(sessions, 'SPY', bars(Array.from({ length: 22 }, () => 100)), [], []);
    const after = benchmarkOutcomes(sessions, 'SPY', bars(Array.from({ length: 22 }, (_, i) => i > 0 ? 200 : 100)), [], []);
    expect(before[0]?.forwardReturn).not.toBe(after[0]?.forwardReturn);
    expect(buildCandidateDays(rows, deriveBands(rows, '2024-01-02'))).toEqual(frozen);
  });
});
