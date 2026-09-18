import { describe, expect, it } from 'vitest';
import { normalizeSplits, type NormalizedBar } from './trend-calculation.js';
import { advanceVolatility, calculateVolatility, classifyVolatility, instrumentMeasurements, instrumentRawState, logReturn, marketRawState, realizedVolatility, sampleStandardDeviation, summarizeVolatility, trueRange, VOLATILITY_DEFINITION, VOLATILITY_STATES, wilderAtr, type VolatilityHistory, type VolatilityState } from './volatility-calculation.js';

const bars = (count: number): NormalizedBar[] => Array.from({ length: count }, (_, i) => ({ id: i + 1, date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10), open: 100, high: 101, low: 99, close: 100, volume: 1000, normalizationFactor: 1 }));
const calculate = (a: (NormalizedBar | null)[], b = a, dates = bars(a.length).map(bar => bar.date)) => calculateVolatility(dates, a, b);
const advance = (state: VolatilityState | null, raw: VolatilityState | null, confirmation = 0) => advanceVolatility({ effectiveState: state, confirmation }, raw);

describe('Volatility formulas', () => {
  it('uses natural log returns', () => {
    expect(logReturn(110, 100)).toBeCloseTo(Math.log(1.1), 14);
    expect(logReturn(100, 110)).toBeCloseTo(-Math.log(1.1), 14);
    expect(logReturn(100, 100)).toBe(0);
  });
  it('uses sample rather than population standard deviation', () => {
    expect(sampleStandardDeviation([1, 2, 3])).toBe(1);
    expect(sampleStandardDeviation([4, 4, 4])).toBe(0);
  });
  it.each([10, 20] as const)('RV%s uses N latest log returns and sqrt(252) * 100', period => {
    // Alternating +/-0.01 has mean zero and sample variance N*0.0001/(N-1).
    const closes = Array.from({ length: period + 1 }, (_, i) => 100 * Math.exp(i % 2 ? 0.01 : 0));
    const expected = Math.sqrt(period * 0.0001 / (period - 1)) * Math.sqrt(252) * 100;
    expect(realizedVolatility(closes, period)).toBeCloseTo(expected, 10);
    expect(realizedVolatility([999, ...closes], period)).toBeCloseTo(expected, 10);
    expect(realizedVolatility(closes.slice(1), period)).toBeNull();
  });
  it.each([[105, 95, 100, 10], [112, 108, 100, 12], [92, 88, 100, 12]])('true range high=%s low=%s previous=%s', (high, low, previous, expected) => {
    expect(trueRange(high, low, previous)).toBe(expected);
  });
  it('seeds Wilder with exactly 14 TRs and applies recurrence', () => {
    const ranges = Array.from({ length: 14 }, (_, i) => i + 1);
    const atr = wilderAtr([...ranges, 20, 4]);
    expect(atr.slice(0, 13)).toEqual(Array(13).fill(null));
    expect(atr[13]).toBe(7.5);
    expect(atr[14]).toBe((7.5 * 13 + 20) / 14);
    expect(atr[15]).toBe((((7.5 * 13 + 20) / 14) * 13 + 4) / 14);
  });
  it('ATR needs previous close, seeds on bar 15 and divides by current close', () => {
    const evidence = instrumentMeasurements(bars(21));
    expect(evidence[13]!.ATR14Pct).toBeNull();
    expect(evidence[14]!.atr14).toBe(2);
    expect(evidence[14]!.ATR14Pct!.value).toBe(2);
    expect(evidence[9]!.RV10).toBeNull();
    expect(evidence[10]!.RV10!.value).toBe(0);
    expect(evidence[19]!.RV20).toBeNull();
    expect(evidence[20]!.RV20!.value).toBe(0);
    const changing = bars(16); changing[15] = { ...changing[15]!, close: 105, high: 106 };
    expect(instrumentMeasurements(changing)[15]!.ATR14Pct!.value).toBeCloseTo(((2 * 13 + 7) / 14) / 105 * 100, 12);
  });
  it('requires exactly 21 consecutive bars for both instruments', () => {
    const a = bars(21), b: (NormalizedBar | null)[] = [...a]; b[0] = null;
    expect(calculate(a).slice(0, 20).every(day => day.status === 'UNAVAILABLE')).toBe(true);
    expect(calculate(a)[20]!.status).toBe('VALID');
    expect(calculate(a, b)[20]!.status).toBe('UNAVAILABLE');
  });
  it('resets metrics after missing or invalid evidence without carrying a close', () => {
    const a: (NormalizedBar | null)[] = bars(44); a[21] = null;
    const days = calculate(a, bars(44));
    expect(days[20]!.status).toBe('VALID');
    expect(days.slice(21, 42).every(day => day.status === 'UNAVAILABLE')).toBe(true);
    expect(days[42]!.status).toBe('VALID');
    expect(days[35]!.spy.ATR14Pct).toBeNull();
    expect(days[36]!.spy.atr14).toBe(2);
    expect(days[41]!.hysteresis.effectiveState).toBe(days[20]!.effectiveState);
    const invalid = bars(44); invalid[21] = { ...invalid[21]!, close: Number.NaN };
    expect(calculate(invalid).map(d => d.status)).toEqual(calculate(a).map(d => d.status));
  });
  it('split normalization prevents false split-only volatility and preserves inputs', () => {
    const baseline = bars(45), raw = baseline.map((bar, i) => i < 25 ? { ...bar, open: 200, high: 202, low: 198, close: 200, volume: 500 } : bar);
    const original = JSON.stringify(raw);
    const splits = [{ id: 'split', executionDate: raw[25]!.date, splitFrom: 1, splitTo: 2, priceFactor: 0.5 }];
    const adjusted = normalizeSplits(raw, splits, raw.at(-1)!.date);
    const actual = calculate(adjusted), expected = calculate(baseline);
    expect(actual).toEqual(expected);
    expect(JSON.stringify(raw)).toBe(original);
    expect(calculate(raw)[25]!.spy.RV10!.value).toBeGreaterThan(30);
  });
  it('rejects invalid primitive inputs', () => {
    expect(() => logReturn(0, 100)).toThrow();
    expect(() => sampleStandardDeviation([1])).toThrow();
    expect(() => trueRange(90, 100, 100)).toThrow();
    expect(() => wilderAtr([-1])).toThrow();
    expect(() => classifyVolatility(Infinity, 'RV')).toThrow();
  });
});

describe('candidate classification', () => {
  it.each([
    ['RV', 0, 'LOW'], ['RV', 11.999999, 'LOW'], ['RV', 12, 'NORMAL'], ['RV', 19.999999, 'NORMAL'], ['RV', 20, 'HIGH'], ['RV', 29.999999, 'HIGH'], ['RV', 30, 'EXTREME'],
    ['ATR14Pct', 0, 'LOW'], ['ATR14Pct', 0.999999, 'LOW'], ['ATR14Pct', 1, 'NORMAL'], ['ATR14Pct', 1.499999, 'NORMAL'], ['ATR14Pct', 1.5, 'HIGH'], ['ATR14Pct', 2.499999, 'HIGH'], ['ATR14Pct', 2.5, 'EXTREME'],
  ] as const)('%s %s maps to %s', (kind, value, expected) => expect(classifyVolatility(value, kind)).toBe(expected));
  it('uses median severity for every combination, independent of order', () => {
    for (const a of VOLATILITY_STATES) for (const b of VOLATILITY_STATES) for (const c of VOLATILITY_STATES) {
      const result = instrumentRawState([a, b, c]);
      const index = VOLATILITY_STATES.indexOf(result);
      expect([a, b, c].filter(s => VOLATILITY_STATES.indexOf(s) <= index).length).toBeGreaterThanOrEqual(2);
      expect([a, b, c].filter(s => VOLATILITY_STATES.indexOf(s) >= index).length).toBeGreaterThanOrEqual(2);
    }
    expect(instrumentRawState(['HIGH', 'NORMAL', 'NORMAL'])).toBe('NORMAL');
    expect(instrumentRawState(['HIGH', 'HIGH', 'NORMAL'])).toBe('HIGH');
    expect(instrumentRawState(['EXTREME', 'HIGH', 'EXTREME'])).toBe('EXTREME');
  });
  it('uses maximum instrument severity for every SPY/RSP pair', () => {
    for (const a of VOLATILITY_STATES) for (const b of VOLATILITY_STATES) {
      expect(marketRawState(a, b)).toBe(VOLATILITY_STATES[Math.max(VOLATILITY_STATES.indexOf(a), VOLATILITY_STATES.indexOf(b))]);
    }
  });
});

describe('asymmetric hysteresis', () => {
  it.each(VOLATILITY_STATES)('bootstraps %s without counting a transition', state => {
    expect(advance(null, state)).toMatchObject({ effectiveState: state, confirmationAfter: 0, transitioned: false });
  });
  it('jumps NORMAL to EXTREME immediately', () => {
    expect(advance('NORMAL', 'EXTREME')).toMatchObject({ effectiveState: 'EXTREME', confirmationAfter: 0, transitioned: true });
  });
  it('requires two valid sessions, recovers one step, and counts lower raw support', () => {
    let history: VolatilityHistory = { effectiveState: 'EXTREME', confirmation: 0 };
    const results = (['NORMAL', 'NORMAL', 'NORMAL', 'LOW'] as const).map(raw => {
      const result = advanceVolatility(history, raw);
      history = { effectiveState: result.effectiveState, confirmation: result.confirmationAfter }; return result;
    });
    expect(results.map(r => r.effectiveState)).toEqual(['EXTREME', 'HIGH', 'HIGH', 'NORMAL']);
    expect(results.map(r => r.confirmationAfter)).toEqual([1, 0, 1, 0]);
    expect(results.map(r => r.recoveryTarget)).toEqual(['HIGH', 'HIGH', 'NORMAL', 'NORMAL']);
    history = { effectiveState: 'EXTREME', confirmation: 0 };
    const states = Array.from({ length: 6 }, () => {
      const result = advanceVolatility(history, 'LOW');
      history = { effectiveState: result.effectiveState, confirmation: result.confirmationAfter };
      return result.effectiveState;
    });
    expect(states).toEqual(['EXTREME', 'HIGH', 'HIGH', 'NORMAL', 'NORMAL', 'LOW']);
  });
  it('equal raw resets recovery', () => expect(advance('HIGH', 'HIGH', 1)).toMatchObject({ effectiveState: 'HIGH', confirmationAfter: 0, transitioned: false }));
  it('worsening beyond effective interrupts recovery immediately', () => expect(advance('HIGH', 'EXTREME', 1)).toMatchObject({ effectiveState: 'EXTREME', confirmationAfter: 0, transitioned: true }));
  it('a rising raw state still below effective supports next target', () => expect(advance('EXTREME', 'HIGH', 1)).toMatchObject({ effectiveState: 'HIGH', confirmationAfter: 0, transitioned: true }));
  it('unavailable pauses confirmation and the next valid support completes recovery', () => {
    const paused = advance('EXTREME', null, 1);
    expect(paused).toMatchObject({ effectiveState: 'EXTREME', confirmationBefore: 1, confirmationAfter: 1, transitioned: false });
    expect(advanceVolatility({ effectiveState: paused.effectiveState, confirmation: paused.confirmationAfter }, 'LOW').effectiveState).toBe('HIGH');
    expect(advance(null, null).effectiveState).toBeNull();
  });
  it('has deterministic structured evidence and rejects misalignment', () => {
    const a = bars(40);
    expect(calculate(a)).toEqual(calculate(a));
    expect(calculate(a)[20]!.definition).toEqual(VOLATILITY_DEFINITION);
    expect(() => calculate(a, a.slice(1))).toThrow();
    expect(() => calculate(a, a, a.map(() => '2020-01-01'))).toThrow();
  });
  it('summarizes unavailable, annual distributions, transitions, and paused/censored runs', () => {
    const days = calculate(bars(28));
    let history: VolatilityHistory = { effectiveState: null, confirmation: 0 };
    const raws = ['EXTREME', 'LOW', null, 'LOW', 'LOW', 'LOW', 'HIGH', 'HIGH'] as const;
    const fixture = days.slice(20).map((day, i) => {
      const h = advanceVolatility(history, raws[i]!);
      history = { effectiveState: h.effectiveState, confirmation: h.confirmationAfter };
      return { ...day, status: raws[i] === null ? 'UNAVAILABLE' as const : 'VALID' as const, rawState: raws[i]!, effectiveState: raws[i] === null ? null : h.effectiveState, hysteresis: h };
    });
    const summary = summarizeVolatility(fixture);
    expect(summary).toMatchObject({ validSessions: 7, unavailableSessions: 1, transitionCount: 3, medianRunDuration: 2, oneDayRuns: 1, twoDayOrShorterRuns: 4 });
    expect(summary.extremeRuns).toEqual([{ state: 'EXTREME', firstDate: fixture[0]!.date, lastDate: fixture[1]!.date, validSessions: 2 }]);
    expect(summary.byYear['2020']!.transitions).toBe(3);
    expect(summary.transitions[0]).toMatchObject({ from: 'EXTREME', to: 'HIGH', raw: 'LOW' });
    expect(summarizeVolatility([]).medianRunDuration).toBeNull();
  });
});
