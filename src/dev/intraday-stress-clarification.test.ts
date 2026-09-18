import { describe, expect, it } from 'vitest';
import { etInstant } from '../services/market-calendar.js';
import { researchCalendar } from './intraday-stress-calendar.js';
import { acuteClosingDownside, classify, classifyCurrentCollapse, measureSession, type Bar, type Candidate, type Target } from './intraday-stress-calculation.js';
import { compareIntradaySemantics } from './intraday-stress-clarification.js';
const b: Candidate = { name: 'B', shock: [0.4, 0.7], rolling: [0.45, 0.8], drawdown: [1, 1.75],
  acute: { ratio: 1.2, floor: 0.02, emergency: 0.03 }, session: { ratio: 2.5, floor: 0.025, emergency: 0.04 } };
const date = '2026-09-17', calendar = researchCalendar([]);
function target(close: number, atr = 0.04, low = close, high = 100): Target {
  const bar: Bar = { symbol: 'SPY', timeframe: 'MINUTE_15', t: etInstant(date, 570).getTime(), open: 100, high, low, close, volume: 1 };
  return measureSession('SPY', date, [bar], atr, calendar)[0]!;
}
describe('fixed current-state intraday clarification', () => {
  it('calculates current closing downside without changing evidence and clamps upward closes at zero', () => {
    const t = target(99), before = JSON.stringify(t);
    expect(acuteClosingDownside(t)).toEqual({ acuteCloseDownsidePct: 0.01, acuteCloseDownsideAtrRatio: 0.25 });
    expect(acuteClosingDownside({ ...t, currentClose: 101 }).acuteCloseDownsidePct).toBe(0);
    expect(JSON.stringify(t)).toBe(before);
    expect(acuteClosingDownside({ ...t, referencePrice: null }).acuteCloseDownsidePct).toBeNull();
    expect(acuteClosingDownside({ ...t, priorAtr14Pct: 0 }).acuteCloseDownsideAtrRatio).toBeNull();
    expect(classifyCurrentCollapse({ ...t, status: 'UNAVAILABLE' }, b, true)).toBeNull();
  });
  it('inherits session-open / contiguous previous-close references and never crosses a gap', () => {
    const bars: Bar[] = [100, 99, 98].map((close, i) => ({ symbol: 'SPY', timeframe: 'MINUTE_15', t: etInstant(date, 570 + i * 15).getTime(), open: 100, high: 101, low: 97, close, volume: 1 }));
    const full = measureSession('SPY', date, bars, 0.02, calendar);
    expect(acuteClosingDownside(full[0]!).acuteCloseDownsidePct).toBe(0);
    expect(acuteClosingDownside(full[2]!).acuteCloseDownsidePct).toBeCloseTo(1 / 99);
    const missing = measureSession('SPY', date, [bars[0]!, bars[2]!], 0.02, calendar);
    expect(acuteClosingDownside(missing[2]!).acuteCloseDownsidePct).toBeNull();
  });
  it('keeps a recovered low in shock/HIGH while removing its sole SEVERE authority', () => {
    const t = target(100, 0.02, 95), before = JSON.stringify(t);
    expect(classify(t, b)).toBe(3);
    expect(classifyCurrentCollapse(t, b)).toBe(2);
    expect(classifyCurrentCollapse(t, b, true)).toBe(2);
    expect(t.downsideExcursionPct).toBe(0.05);
    expect(JSON.stringify(t)).toBe(before);
  });
  it('preserves the specified acute conjunction and absolute emergency, inclusively', () => {
    expect(classifyCurrentCollapse(target(98, 1 / 60), b)).toBe(3); // 2% and 1.2 ATR exactly.
    expect(classifyCurrentCollapse(target(98, 0.017), b)).toBe(2); // Ratio below 1.2.
    expect(classifyCurrentCollapse(target(98.1, 0.01), b)).toBe(2); // Absolute below 2%.
    expect(classifyCurrentCollapse(target(97, 0.05), b)).toBe(3); // 3% emergency despite 0.6 ATR.
  });
  it('makes the fixed 1% / 2.5% absolute boundaries HIGH, never independently SEVERE', () => {
    expect(classifyCurrentCollapse(target(99.001), b, true)).toBe(0);
    expect(classifyCurrentCollapse(target(99), b)).toBe(0);
    expect(classifyCurrentCollapse(target(99), b, true)).toBe(2);
    const dd = { ...target(99), referencePrice: 99, sessionDrawdownPct: 0.025, sessionDrawdownAtrRatio: 0.625 };
    expect(classifyCurrentCollapse(dd, b)).toBe(0);
    expect(classifyCurrentCollapse(dd, b, true)).toBe(2);
    expect(classifyCurrentCollapse({ ...dd, sessionDrawdownPct: 0.024999 }, b, true)).toBe(0);
  });
  it('keeps session-collapse authority after a large rally, even above session open', () => {
    const t = target(104, 0.02, 100, 110);
    expect(t.openToCurrentPct).toBeGreaterThan(0);
    expect(acuteClosingDownside(t).acuteCloseDownsidePct).toBe(0);
    expect(classifyCurrentCollapse(t, b)).toBe(3);
    expect(classifyCurrentCollapse(t, b, true)).toBe(3);
  });
  it('uses either authoritative instrument and resets two-confirmation recovery per session', () => {
    const first = target(99), calm = target(100), secondDate = '2026-09-18';
    const series = [first, { ...calm, index: 2, targetAt: etInstant(date, 600).toISOString() },
      { ...calm, index: 3, targetAt: etInstant(date, 615).toISOString() },
      { ...calm, date: secondDate, targetAt: etInstant(secondDate, 585).toISOString() }];
    const rsp = series.map(t => ({ ...calm, symbol: 'RSP' as const, date: t.date, index: t.index, targetAt: t.targetAt }));
    const result = compareIntradaySemantics([...series, ...rsp], b);
    expect(result.records.map(r => r.raw.absoluteHigh)).toEqual([2, 0, 0, 0]);
    expect(result.records.map(r => r.effective.absoluteHigh)).toEqual([2, 2, 1, 0]);
    expect(result.summary.safeguards.upgradedTargets).toBe(1);
    expect(result.summary.absoluteConcern.resolvedTargets).toBe(1);
    expect(() => compareIntradaySemantics([...series, ...rsp], { ...b, shock: [0.4, 0.8] })).toThrow('only recorded Candidate B');
  });
  it('reproduces the documented recovered-low and large-current-drawdown edges', () => {
    const recovered = { ...target(100), referencePrice: 468.18, currentClose: 467.925, priorAtr14Pct: 0.013831707240608897,
      shockAtrRatio: 1.5249866792967692, downsideExcursionPct: 0.02034559357512066, downsideExcursionAtrRatio: 1.4709387077964937,
      sessionDrawdownPct: 0.0020367684695444124, sessionDrawdownAtrRatio: 0.14725358439951697 };
    expect(classify(recovered, b)).toBe(3); expect(classifyCurrentCollapse(recovered, b, true)).toBe(2);
    expect(acuteClosingDownside(recovered).acuteCloseDownsidePct).toBeCloseTo(0.000544662309368182);
    const concern = { ...target(100), priorAtr14Pct: 0.026861764989266077, shockAtrRatio: 0.16914141064606344,
      realizedMovement60AtrRatio: 0.2319278942120865, sessionDrawdownPct: 0.038510943757398595, sessionDrawdownAtrRatio: 1.4336713828293677 };
    expect(classifyCurrentCollapse(concern, b)).toBe(1); expect(classifyCurrentCollapse(concern, b, true)).toBe(2);
  });
});
