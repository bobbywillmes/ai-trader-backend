/** Pure daily background Volatility candidate; no persistence or trading dependencies. */
import type { NormalizedBar } from './trend-calculation.js';

export const VOLATILITY_STATES = ['LOW', 'NORMAL', 'HIGH', 'EXTREME'] as const;
export type VolatilityState = typeof VOLATILITY_STATES[number];
export const VOLATILITY_DEFINITION = Object.freeze({
  evidenceSchemaVersion: 1, candidate: 'VOLATILITY_V1_CALIBRATION',
  symbols: Object.freeze(['SPY', 'RSP'] as const), timeframe: 'DAY_1',
  returnFormula: 'ln(close[t] / close[t-1])', standardDeviation: 'sample (n - 1)',
  annualizationSessions: 252, rvPeriods: Object.freeze([10, 20] as const),
  atrPeriod: 14, atrSeed: 'mean of first 14 true ranges (15 bars)', atrSmoothing: 'Wilder',
  minimumConsecutiveSessions: 21, recoverySessions: 2,
  rvThresholds: Object.freeze([12, 20, 30] as const),
  atrPctThresholds: Object.freeze([1, 1.5, 2.5] as const),
  boundaryRule: 'Lower bounds inclusive; upper bounds exclusive',
  severity: Object.freeze({ LOW: 0, NORMAL: 1, HIGH: 2, EXTREME: 3 }),
  instrumentRule: 'median of RV10, RV20, ATR14Pct severities', marketRule: 'max(SPY, RSP)',
  normalization: 'Massive splitFrom/splitTo applied to pre-execution OHLC; stored bars unchanged',
});
const severity = (state: VolatilityState) => VOLATILITY_DEFINITION.severity[state];
export function logReturn(close: number, previousClose: number): number {
  if (![close, previousClose].every(x => Number.isFinite(x) && x > 0)) throw new Error('Positive finite closes required.');
  return Math.log(close / previousClose);
}
export function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2 || !values.every(Number.isFinite)) throw new Error('At least two finite samples required.');
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}
export function realizedVolatility(closes: readonly number[], period: 10 | 20): number | null {
  if (closes.length < period + 1) return null;
  const window = closes.slice(-(period + 1));
  const returns = window.slice(1).map((close, i) => logReturn(close, window[i]!));
  return sampleStandardDeviation(returns) * Math.sqrt(VOLATILITY_DEFINITION.annualizationSessions) * 100;
}
export function trueRange(high: number, low: number, previousClose: number): number {
  if (![high, low, previousClose].every(x => Number.isFinite(x) && x > 0) || high < low) throw new Error('Invalid true-range inputs.');
  return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
}
export function wilderAtr(ranges: readonly (number | null)[]): (number | null)[] {
  let atr: number | null = null;
  let seed: number[] = [];
  return ranges.map(range => {
    if (range === null) { atr = null; seed = []; return null; }
    if (!Number.isFinite(range) || range < 0) throw new Error('Invalid true range.');
    if (atr === null) {
      seed.push(range);
      if (seed.length < 14) return null;
      atr = seed.reduce((sum, value) => sum + value, 0) / 14;
    } else atr = (atr * 13 + range) / 14;
    return atr;
  });
}
export function classifyVolatility(value: number, measurement: 'RV' | 'ATR14Pct'): VolatilityState {
  if (!Number.isFinite(value) || value < 0) throw new Error('Finite nonnegative measurement required.');
  const thresholds = measurement === 'RV' ? VOLATILITY_DEFINITION.rvThresholds : VOLATILITY_DEFINITION.atrPctThresholds;
  return VOLATILITY_STATES[thresholds.filter(boundary => value >= boundary).length]!;
}
export function instrumentRawState(states: readonly [VolatilityState, VolatilityState, VolatilityState]): VolatilityState {
  return VOLATILITY_STATES[states.map(severity).sort((a, b) => a - b)[1]!]!;
}
export function marketRawState(spy: VolatilityState, rsp: VolatilityState): VolatilityState {
  return VOLATILITY_STATES[Math.max(severity(spy), severity(rsp))]!;
}
export type VolatilityHistory = { effectiveState: VolatilityState | null; confirmation: number };
export type VolatilityTransition = {
  previousEffectiveState: VolatilityState | null; rawState: VolatilityState | null;
  confirmationBefore: number; recoveryTarget: VolatilityState | null; confirmationAfter: number;
  effectiveState: VolatilityState | null; transitioned: boolean; reason: string;
};
export function advanceVolatility(previous: VolatilityHistory, raw: VolatilityState | null): VolatilityTransition {
  if (![0, 1].includes(previous.confirmation) || (previous.effectiveState === null && previous.confirmation !== 0)) throw new Error('Invalid hysteresis continuation.');
  const before = previous.effectiveState;
  const target = before === null || before === 'LOW' ? null : VOLATILITY_STATES[severity(before) - 1]!;
  const base: VolatilityTransition = { previousEffectiveState: before, rawState: raw,
    confirmationBefore: previous.confirmation, recoveryTarget: target, confirmationAfter: previous.confirmation,
    effectiveState: before, transitioned: false, reason: '' };
  if (raw === null) return { ...base, reason: 'Unavailable evidence: pause effective state and recovery confirmation.' };
  if (before === null) return { ...base, effectiveState: raw, confirmationAfter: 0, reason: `Bootstrap from first valid raw state ${raw}.` };
  if (severity(raw) > severity(before)) return { ...base, effectiveState: raw, confirmationAfter: 0, transitioned: true, reason: `Raw ${raw} is more severe than ${before}; jump immediately to ${raw} and reset recovery.` };
  if (raw === before) return { ...base, confirmationAfter: 0, reason: `Raw equals effective ${before}; hold and reset recovery.` };
  if (previous.confirmation === 1) return { ...base, effectiveState: target, confirmationAfter: 0, transitioned: true, reason: `Two valid assessments support at least ${target}; recover exactly one state and reset confirmation.` };
  return { ...base, confirmationAfter: 1, reason: `Raw ${raw} supports ${target}; hold ${before} with recovery confirmation 1/2.` };
}
type Measurement = { value: number; state: VolatilityState };
export type VolatilityInstrument = {
  consecutiveSessions: number; RV10: Measurement | null; RV20: Measurement | null;
  ATR14Pct: Measurement | null; atr14: number | null; rawState: VolatilityState | null; reason: string;
};
function usable(bar: NormalizedBar | null): bar is NormalizedBar {
  return bar !== null && [bar.open, bar.high, bar.low, bar.close].every(x => Number.isFinite(x) && x > 0)
    && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close);
}
export function instrumentMeasurements(bars: readonly (NormalizedBar | null)[]): VolatilityInstrument[] {
  const ranges = bars.map((bar, i) => usable(bar) && usable(bars[i - 1] ?? null)
    ? trueRange(bar.high, bar.low, bars[i - 1]!.close) : null);
  const atr = wilderAtr(ranges);
  let closes: number[] = [];
  let consecutive = 0;
  return bars.map((bar, i) => {
    if (!usable(bar)) { closes = []; consecutive = 0; }
    else { closes.push(bar.close); closes = closes.slice(-21); consecutive++; }
    const rv10 = realizedVolatility(closes, 10), rv20 = realizedVolatility(closes, 20);
    const atr14 = atr[i] ?? null;
    const atrPct = atr14 === null || !usable(bar) ? null : atr14 / bar.close * 100;
    const measurement = (value: number | null, kind: 'RV' | 'ATR14Pct'): Measurement | null => value === null ? null : { value, state: classifyVolatility(value, kind) };
    const RV10 = measurement(rv10, 'RV'), RV20 = measurement(rv20, 'RV'), ATR14Pct = measurement(atrPct, 'ATR14Pct');
    const rawState = RV10 && RV20 && ATR14Pct ? instrumentRawState([RV10.state, RV20.state, ATR14Pct.state]) : null;
    return { consecutiveSessions: consecutive, RV10, RV20, ATR14Pct, atr14, rawState,
      reason: rawState === null ? `Unavailable: ${consecutive}/21 consecutive usable sessions; RV20 needs 21 closes, ATR14 needs 15 bars.` : 'Median severity of RV10, RV20 and ATR14Pct.' };
  });
}
export type VolatilityDay = {
  date: string; status: 'VALID' | 'UNAVAILABLE'; spy: VolatilityInstrument; rsp: VolatilityInstrument;
  rawState: VolatilityState | null; effectiveState: VolatilityState | null;
  hysteresis: VolatilityTransition; definition: typeof VOLATILITY_DEFINITION;
};
/** Caller supplies every expected session, including null inputs for gaps. */
export function calculateVolatility(dates: readonly string[], spy: readonly (NormalizedBar | null)[], rsp: readonly (NormalizedBar | null)[]): VolatilityDay[] {
  if (dates.length !== spy.length || dates.length !== rsp.length || dates.some((date, i) => i > 0 && date <= dates[i - 1]!)
    || spy.some((bar, i) => bar && bar.date !== dates[i]) || rsp.some((bar, i) => bar && bar.date !== dates[i])) throw new Error('Aligned, unique chronological sessions required.');
  const a = instrumentMeasurements(spy), b = instrumentMeasurements(rsp);
  let history: VolatilityHistory = { effectiveState: null, confirmation: 0 };
  return dates.map((date, i) => {
    const s = a[i]!, r = b[i]!;
    const raw = s.rawState === null || r.rawState === null ? null : marketRawState(s.rawState, r.rawState);
    const hysteresis = advanceVolatility(history, raw);
    history = { effectiveState: hysteresis.effectiveState, confirmation: hysteresis.confirmationAfter };
    return { date, status: raw === null ? 'UNAVAILABLE' : 'VALID', spy: s, rsp: r, rawState: raw,
      effectiveState: raw === null ? null : hysteresis.effectiveState, hysteresis, definition: VOLATILITY_DEFINITION };
  });
}

export function summarizeVolatility(days: readonly VolatilityDay[]) {
  const valid = days.filter(day => day.status === 'VALID');
  const distribution = (rows: readonly VolatilityDay[]) => ({ validSessions: rows.length,
    percentages: Object.fromEntries(VOLATILITY_STATES.map(state => [state, rows.length ? rows.filter(day => day.effectiveState === state).length / rows.length * 100 : 0])) });
  const transitions = valid.filter(day => day.hysteresis.transitioned).map(day => ({ date: day.date,
    from: day.hysteresis.previousEffectiveState, to: day.effectiveState, raw: day.rawState, hysteresis: day.hysteresis }));
  const runs: { state: VolatilityState; firstDate: string; lastDate: string; validSessions: number }[] = [];
  for (const day of valid) {
    const last = runs.at(-1);
    if (last?.state === day.effectiveState) { last.lastDate = day.date; last.validSessions++; }
    else runs.push({ state: day.effectiveState!, firstDate: day.date, lastDate: day.date, validSessions: 1 });
  }
  const lengths = runs.map(run => run.validSessions).sort((a, b) => a - b), mid = Math.floor(lengths.length / 2);
  return { availableDateRange: { first: days[0]?.date ?? null, last: days.at(-1)?.date ?? null },
    validDateRange: { first: valid[0]?.date ?? null, last: valid.at(-1)?.date ?? null },
    ...distribution(valid), unavailableSessions: days.length - valid.length,
    byYear: Object.fromEntries([...new Set(days.map(day => day.date.slice(0, 4)))].map(year => [year, {
      ...distribution(valid.filter(day => day.date.startsWith(year))), unavailableSessions: days.filter(day => day.date.startsWith(year) && day.status === 'UNAVAILABLE').length,
      transitions: transitions.filter(day => day.date.startsWith(year)).length,
    }])),
    transitionCount: transitions.length, transitions, runCount: runs.length,
    medianRunDuration: lengths.length ? lengths.length % 2 ? lengths[mid]! : (lengths[mid - 1]! + lengths[mid]!) / 2 : null,
    oneDayRuns: runs.filter(run => run.validSessions === 1).length,
    twoDayOrShorterRuns: runs.filter(run => run.validSessions <= 2).length,
    extremeRuns: runs.filter(run => run.state === 'EXTREME'), runs,
    runDefinition: 'Valid assessed sessions; unavailable sessions pause runs. First and last runs may be censored. Bootstrap is not a transition.',
  };
}
