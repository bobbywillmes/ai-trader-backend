import { describe, expect, it } from 'vitest';
import { etInstant } from '../services/market-calendar.js';
import { baseline } from './intraday-stress-data.js';
import { researchCalendar } from './intraday-stress-calendar.js';
import { classify, measureSession, recover, validDaily, type Bar, type Candidate } from './intraday-stress-calculation.js';
const calendar = researchCalendar([]), date = '2026-09-17';
const bars = (n = 26): Bar[] => Array.from({ length: n }, (_, i) => ({ symbol: 'SPY', timeframe: 'MINUTE_15',
  t: etInstant(date, 570 + i * 15).getTime(), open: 100, high: 101, low: 99, close: 100, volume: 100 }));
const candidate: Candidate = { name: 'synthetic', shock: [0.5, 1], rolling: [0.4, 0.8], drawdown: [0.8, 1.2],
  acute: { ratio: 2, floor: 0.02, emergency: 0.04 }, session: { ratio: 3, floor: 0.03, emergency: 0.05 } };
describe('intraday research evidence and formulas', () => {
  it('uses first open, never overnight gap; exactly four arithmetic returns', () => {
    const input = bars(); input[0] = { ...input[0]!, open: 200, high: 204, low: 198, close: 202 };
    input[1] = { ...input[1]!, open: 202, high: 204, low: 200, close: 200 };
    const r = measureSession('SPY', date, input, 0.02, calendar);
    expect(r[0]!.shockPct).toBeCloseTo(6 / 200); expect(r[0]!.shockAtrRatio).toBeCloseTo(1.5);
    expect(r[0]!.downsideExcursionPct).toBeCloseTo(2 / 200);
    expect(r.slice(0, 3).every(t => t.rollingStatus === 'NOT_APPLICABLE_SESSION_WARMUP')).toBe(true);
    expect(r[3]!.realizedMovement60Pct).toBeCloseTo(Math.sqrt(0.01 ** 2 + (200 / 202 - 1) ** 2 + 0.5 ** 2));
    expect(r[3]!.sessionDrawdownPct).toBeCloseTo(104 / 204);
  });
  it('never bridges a missing interval and cannot recover an unknown session peak', () => {
    const input = bars().filter((_, i) => i !== 3), r = measureSession('SPY', date, input, 0.01, calendar);
    expect(r[3]!.status).toBe('UNAVAILABLE'); expect(r[4]!.shockPct).toBeNull();
    expect(r[7]!.realizedMovement60Pct).toBeNull(); expect(r[8]!.realizedMovement60Pct).not.toBeNull();
    expect(r.slice(3).every(t => t.sessionDrawdownPct === null && t.status === 'UNAVAILABLE')).toBe(true);
  });
  it('rejects malformed, duplicate and misidentified evidence', () => {
    const input = bars(); input[1]!.low = 102;
    expect(measureSession('SPY', date, input, 0.01, calendar)[1]!.status).toBe('UNAVAILABLE');
    expect(measureSession('SPY', date, [...bars(), bars()[0]!], 0.01, calendar)[0]!.status).toBe('UNAVAILABLE');
    expect(() => measureSession('RSP', date, bars(), 0.01, calendar)).toThrow('identity');
    expect(() => measureSession('SPY', date, [{ ...bars()[0]!, t: etInstant(date, 571).getTime() }], 0.01, calendar)).toThrow('interval');
    expect(() => measureSession('SPY', date, [{ ...bars()[0]!, timeframe: 'DAY_1' }], 0.01, calendar)).toThrow('identity');
  });
  it('handles early closes, DST and closing-bar exclusion', () => {
    const d = '2025-11-28';
    const r = measureSession('SPY', d, [], 0.01, calendar);
    expect(r).toHaveLength(14); expect(r.filter(t => !t.closing)).toHaveLength(13);
    expect(r.at(-1)!.targetAt).toBe('2025-11-28T18:00:00.000Z');
    expect(measureSession('SPY', date, bars(), 0.01, calendar).filter(t => !t.closing)).toHaveLength(25);
    expect(() => researchCalendar([{ sessionDate: d, type: 'EARLY_CLOSE', closeTimeMinutesEt: 900 }])).toThrow('conflict');
  });
  it('freezes prior Wilder ATR, handles split scaling, and resets after absent daily evidence', () => {
    const dates = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10))
      .filter(d => ![0, 6].includes(new Date(d).getUTCDay()) && !calendar.some(e => e.sessionDate === d && e.type === 'CLOSED'));
    const daily: Bar[] = dates.map(d => ({ ...bars()[0]!, timeframe: 'DAY_1', t: etInstant(d, 0).getTime(), high: 101, low: 99 }));
    const a = baseline(daily, [], dates, 'SPY', calendar); expect(a.get(dates[14]!)).toBeNull(); expect(a.get(dates[15]!)).toBeCloseTo(0.02);
    daily[15]!.high = 150;
    const b = baseline(daily, [], dates, 'SPY', calendar); expect(b.get(dates[15]!)).toBe(a.get(dates[15]!));
    expect(b.get(dates[16]!)).toBeGreaterThan(0.02);
    const splitDate = dates[16]!;
    const split = { id: 'split', executionDate: splitDate, splitFrom: 1, splitTo: 2, priceFactor: 0.5 };
    const splitBars = daily.map((x, i) => i < 16 ? x : { ...x, open: x.open / 2, high: x.high / 2, low: x.low / 2, close: x.close / 2 });
    expect(baseline(splitBars, [split], dates, 'SPY', calendar).get(dates[18]!)).toBeCloseTo(b.get(dates[18]!)!);
    expect(baseline(daily.filter((_, i) => i !== 17), [], dates, 'SPY', calendar).get(dates[18]!)).toBeNull();
    expect(validDaily({ ...daily[0]!, t: etInstant(dates[0]!, 570).getTime() }, 'SPY', calendar)).toBe(false);
  });
  it('uses worst measurement, collapse floors and absolute emergency, with upside capped HIGH', () => {
    const t = measureSession('SPY', date, bars(), 0.01, calendar)[0]!;
    expect(classify({ ...t, shockAtrRatio: 9, downsideExcursionAtrRatio: 0, downsideExcursionPct: 0, sessionDrawdownAtrRatio: 0, sessionDrawdownPct: 0 }, candidate)).toBe(2);
    expect(classify({ ...t, downsideExcursionAtrRatio: 3, downsideExcursionPct: 0.01 }, candidate)).toBe(2);
    expect(classify({ ...t, downsideExcursionAtrRatio: 3, downsideExcursionPct: 0.025 }, candidate)).toBe(3);
    expect(classify({ ...t, downsideExcursionAtrRatio: 0.5, downsideExcursionPct: 0.04 }, candidate)).toBe(3);
  });
  it('bounds recovery to two or three confirmations, resetting per step and after gaps', () => {
    expect(recover([0, 3, 0, 0, 0, 0, 0, 0], 2)).toEqual([0, 3, 3, 2, 2, 1, 1, 0]);
    expect(recover([3, 0, 0, 0, 0, 0, 0], 3)).toEqual([3, 3, 3, 2, 2, 2, 1]);
    expect(recover([3, 0, null, 0, 0], 2)).toEqual([3, 3, null, 3, 2]);
    expect(recover([0], 2)).toEqual([0]);
  });
});
