import { describe, expect, it } from 'vitest';
import { advanceTrend, calculateTrend, emaSeries, horizonState, instrumentState, marketRawState, measurementSign, normalizeSplits, summarizeTrend, TREND_PROFILES, type HysteresisState, type NormalizedBar, type TrendState } from './trend-calculation.js';
const states: TrendState[] = ['DOWN', 'NEUTRAL', 'UP'];
function series(n: number, close: (i: number) => number): NormalizedBar[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10), open: close(i), high: close(i), low: close(i), close: close(i), volume: 1000, normalizationFactor: 1 }));
}
function replay(raws: (TrendState | null)[]) {
  let history: HysteresisState = { effective: null, recoveryConfirmation: 0 };
  return raws.map(raw => { const step = advanceTrend(history, raw); history = { effective: step.effectiveState, recoveryConfirmation: step.recoveryConfirmation }; return step; });
}
describe('pure Trend research math', () => {
  it('initializes EMA using SMA then standard alpha', () => {
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(emaSeries([1, 2, null, 3, 4, 5], 3)).toEqual([null, null, null, null, null, 4]);
  });
  it.each(Object.keys(TREND_PROFILES) as (keyof typeof TREND_PROFILES)[])('has exactly nine frozen deadbands and neutral equality for %s', profile => {
    expect(TREND_PROFILES[profile]).toHaveLength(9); expect(Object.isFrozen(TREND_PROFILES[profile])).toBe(true);
    for (const threshold of TREND_PROFILES[profile]) {
      expect(measurementSign(threshold, threshold)).toBe('NEUTRAL'); expect(measurementSign(-threshold, threshold)).toBe('NEUTRAL');
      expect(measurementSign(threshold + 1e-8, threshold)).toBe('POSITIVE'); expect(measurementSign(-threshold - 1e-8, threshold)).toBe('NEGATIVE');
    }
  });
  it('uses the specified profile values', () => {
    expect(TREND_PROFILES.TIGHT).toEqual([.1,.02,.3,.15,.02,.1,.25,.01,.15]);
    expect(TREND_PROFILES.MIDDLE).toEqual([.2,.05,.6,.3,.04,.2,.5,.03,.3]);
    expect(TREND_PROFILES.LOOSE).toEqual([.3,.08,1,.5,.07,.35,.75,.05,.5]);
  });
  it('validates all nine formulas and explicit 60-session minimum', () => {
    const bars = series(70, i => 100 + i); const closes = bars.map(x => x.close);
    const ten = emaSeries(closes, 10), twenty = emaSeries(closes, 20), fifty = emaSeries(closes, 50);
    const result = calculateTrend(bars.map(x => x.date), bars, bars, 'MIDDLE');
    expect(result[58]?.status).toBe('UNAVAILABLE'); expect(result[59]?.status).toBe('VALID');
    const pct = (x: number, y: number) => (x/y-1)*100; const i = 69;
    const expected = [pct(169,ten[i]!),pct(ten[i]!,ten[i-3]!)/3,pct(169,164),pct(169,twenty[i]!),pct(twenty[i]!,twenty[i-5]!)/5,pct(ten[i]!,twenty[i]!),pct(169,fifty[i]!),pct(fifty[i]!,fifty[i-10]!)/10,pct(twenty[i]!,fifty[i]!)];
    result[i]!.spy.measurements.forEach((m,index) => expect(m.value).toBeCloseTo(expected[index]!, 12));
  });
  it('uses two-of-three horizon voting', () => {
    expect(horizonState(['POSITIVE','POSITIVE','NEGATIVE'])).toBe('UP');
    expect(horizonState(['NEGATIVE','NEUTRAL','NEGATIVE'])).toBe('DOWN');
    expect(horizonState(['POSITIVE','NEUTRAL','NEGATIVE'])).toBe('NEUTRAL');
  });
  for (const short of states) for (const medium of states) for (const structural of states) {
    it(`instrument matrix ${short}/${medium}/${structural}`, () => {
      const expected = medium === 'UP' && structural === 'UP' ? 'UP' : medium === 'DOWN' && structural === 'DOWN' ? 'DOWN' :
        [medium, structural].includes('NEUTRAL') && [medium, structural].includes(short) && short !== 'NEUTRAL' ? short : 'NEUTRAL';
      expect(instrumentState(short, medium, structural)).toBe(expected);
    });
  }
  for (const spy of states) for (const rsp of states) it(`market confirmation ${spy}/${rsp}`, () => { expect(marketRawState(spy,rsp)).toBe(spy === rsp ? spy : 'NEUTRAL'); });
  it('does not expose a paused old state as valid on a missing date', () => {
    const bars = series(80, i => 100+i); const a: (NormalizedBar|null)[] = [...bars]; a[70] = null;
    const days = calculateTrend(bars.map(x => x.date), a, bars, 'TIGHT');
    expect(days[70]).toMatchObject({ status: 'UNAVAILABLE', effectiveState: null, transition: { effectiveState: 'UP' } });
  });
});
describe('asymmetric daily hysteresis', () => {
  it('bootstraps independently and resets on equality', () => {
    expect(replay(['DOWN','UP','DOWN']).at(-1)).toMatchObject({ effectiveState: 'DOWN', recoveryConfirmation: 0 });
    expect(replay(['UP'])[0]).toMatchObject({ effectiveState: 'UP', recoveryConfirmation: 0, transitioned: false });
    expect(replay(['DOWN'])[0]?.effectiveState).toBe('DOWN');
  });
  it('deteriorates immediately exactly one step', () => {
    expect(replay(['UP','DOWN','DOWN']).map(x=>x.effectiveState)).toEqual(['UP','NEUTRAL','DOWN']);
    expect(replay(['UP','NEUTRAL']).at(-1)?.effectiveState).toBe('NEUTRAL');
  });
  it('counts stronger raw states toward the next target and stages recovery', () => {
    expect(replay(['DOWN','UP','NEUTRAL','UP','UP']).map(x=>x.effectiveState)).toEqual(['DOWN','DOWN','NEUTRAL','NEUTRAL','UP']);
    expect(replay(['DOWN','UP','NEUTRAL'])[2]).toMatchObject({ supportingCount: 2, recoveryConfirmation: 0 });
  });
  it('pauses confirmation on missing/failed/unavailable evidence', () => {
    const steps = replay(['NEUTRAL','UP',null,null,'UP']);
    expect(steps[2]).toMatchObject({ recoveryConfirmation: 1, effectiveState: 'NEUTRAL' });
    expect(steps.at(-1)?.effectiveState).toBe('UP');
  });
  it('resets recovery on contrary/equal valid raw states', () => {
    expect(replay(['NEUTRAL','UP','DOWN']).at(-1)).toMatchObject({ effectiveState:'DOWN', recoveryConfirmation:0 });
    expect(replay(['NEUTRAL','UP','NEUTRAL','UP']).at(-1)).toMatchObject({ effectiveState:'NEUTRAL', recoveryConfirmation:1 });
  });
  it('does not inherit another candidate or algorithm history', () => {
    const bars = series(100,i=>200-i);
    const first = calculateTrend(bars.map(x=>x.date),bars,bars,'TIGHT');
    calculateTrend(bars.map(x=>x.date),bars,bars,'LOOSE');
    expect(calculateTrend(bars.map(x=>x.date),bars,bars,'TIGHT')).toEqual(first);
  });
});
describe('split normalization and research statistics', () => {
  it('normalizes a split without a mechanics-only crash', () => {
    const raw = series(100,i=>i<75?100:50);
    const normalized = normalizeSplits(raw,[{id:'s',executionDate:raw[75]!.date,splitFrom:1,splitTo:2,priceFactor:.5}],raw[99]!.date);
    expect(normalized.every(x=>x.close===50)).toBe(true);
    expect(normalized[74]?.volume).toBe(2000); expect(normalized[75]?.volume).toBe(1000);
    expect(calculateTrend(raw.map(x=>x.date),normalized,normalized,'MIDDLE').slice(59).every(day=>day.rawState==='NEUTRAL')).toBe(true);
    expect(raw[0]?.close).toBe(100);
  });
  it('does not apply splits beyond research range and handles reverse splits', () => {
    const raw = series(2,()=>100);
    const split = {id:'s',executionDate:raw[1]!.date,splitFrom:2,splitTo:1,priceFactor:2};
    expect(normalizeSplits(raw,[split],raw[0]!.date)[0]?.close).toBe(100);
    expect(normalizeSplits(raw,[split],raw[1]!.date)[0]?.close).toBe(200);
  });
  it('reports unavailable days and state distributions without choosing a winner', () => {
    const bars=series(100,()=>100); const result=summarizeTrend(calculateTrend(bars.map(x=>x.date),bars,bars,'MIDDLE'));
    expect(result).toMatchObject({validDays:41,unavailableDays:59,transitions:0,medianRunDuration:41,statePercentages:{NEUTRAL:100,UP:0,DOWN:0}});
  });
});
