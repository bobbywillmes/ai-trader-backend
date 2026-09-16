/** Pure Trend calculation. No database, clock, HTTP or trading dependencies. */
export type TrendState = 'DOWN' | 'NEUTRAL' | 'UP';
export type MeasurementSign = 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE';
export type TrendProfile = 'TIGHT' | 'MIDDLE' | 'LOOSE';
export type Horizon = 'SHORT' | 'MEDIUM' | 'STRUCTURAL';
export type TrendThresholds = readonly number[];
export const TREND_MINIMUM_SESSIONS = 60; // EMA50 seed (50) + ten-session slope.
export const TREND_EVIDENCE_SCHEMA_VERSION = 1;
export const MEASUREMENT_DEFINITIONS = [
  { key: 'closeVsEma10Pct', label: 'Close vs EMA10', horizon: 'SHORT' },
  { key: 'ema10Slope3PctPerSession', label: 'EMA10 slope / session (3 sessions)', horizon: 'SHORT' },
  { key: 'return5Pct', label: '5-session return', horizon: 'SHORT' },
  { key: 'closeVsEma20Pct', label: 'Close vs EMA20', horizon: 'MEDIUM' },
  { key: 'ema20Slope5PctPerSession', label: 'EMA20 slope / session (5 sessions)', horizon: 'MEDIUM' },
  { key: 'ema10VsEma20Pct', label: 'EMA10 vs EMA20', horizon: 'MEDIUM' },
  { key: 'closeVsEma50Pct', label: 'Close vs EMA50', horizon: 'STRUCTURAL' },
  { key: 'ema50Slope10PctPerSession', label: 'EMA50 slope / session (10 sessions)', horizon: 'STRUCTURAL' },
  { key: 'ema20VsEma50Pct', label: 'EMA20 vs EMA50', horizon: 'STRUCTURAL' },
] as const;
export const TREND_PROFILES = Object.freeze({
  TIGHT: Object.freeze([0.10, 0.02, 0.30, 0.15, 0.02, 0.10, 0.25, 0.01, 0.15]),
  MIDDLE: Object.freeze([0.20, 0.05, 0.60, 0.30, 0.04, 0.20, 0.50, 0.03, 0.30]),
  LOOSE: Object.freeze([0.30, 0.08, 1.00, 0.50, 0.07, 0.35, 0.75, 0.05, 0.50]),
});
export type ResearchBar = { id: number; date: string; open: number; high: number; low: number; close: number; volume: number };
export type ResearchSplit = { id: string; executionDate: string; splitFrom: number; splitTo: number; priceFactor: number };
export type NormalizedBar = ResearchBar & { normalizationFactor: number };
export function normalizeSplits(bars: readonly ResearchBar[], splits: readonly ResearchSplit[], through: string): NormalizedBar[] {
  for (const split of splits) if (!(split.splitFrom > 0 && split.splitTo > 0 && Number.isFinite(split.priceFactor) && split.priceFactor > 0 && Math.abs(split.priceFactor - split.splitFrom / split.splitTo) < 1e-12)) throw new Error('Invalid split factor.');
  return bars.map(bar => {
    const factor = splits.filter(split => split.executionDate > bar.date && split.executionDate <= through).reduce((value, split) => value * split.priceFactor, 1);
    const result = { ...bar, open: bar.open * factor, high: bar.high * factor, low: bar.low * factor, close: bar.close * factor, volume: bar.volume / factor, normalizationFactor: factor };
    if (![result.open, result.high, result.low, result.close, result.volume].every(Number.isFinite) || result.close <= 0) throw new Error('Invalid normalized series.');
    return result;
  });
}
/** Null input denotes an expected but absent session. Re-seed rather than invent a close. */
export function emaSeries(closes: readonly (number | null)[], period: number): (number | null)[] {
  if (!Number.isInteger(period) || period <= 0) throw new Error('Invalid EMA period.');
  let ema: number | null = null; let seed: number[] = [];
  const alpha = 2 / (period + 1);
  return closes.map(close => {
    if (close === null) { ema = null; seed = []; return null; }
    if (!Number.isFinite(close) || close <= 0) throw new Error('Closes must be finite and positive.');
    if (ema === null) {
      seed.push(close);
      if (seed.length < period) return null;
      ema = seed.reduce((sum, x) => sum + x, 0) / period;
    } else ema = alpha * close + (1 - alpha) * ema;
    return ema;
  });
}
export function measurementSign(value: number, deadband: number): MeasurementSign {
  return value > deadband ? 'POSITIVE' : value < -deadband ? 'NEGATIVE' : 'NEUTRAL';
}
export function horizonState(signs: readonly MeasurementSign[]): TrendState {
  if (signs.length !== 3) throw new Error('Each horizon requires exactly three measurements.');
  return signs.filter(x => x === 'POSITIVE').length >= 2 ? 'UP' : signs.filter(x => x === 'NEGATIVE').length >= 2 ? 'DOWN' : 'NEUTRAL';
}
export function instrumentState(short: TrendState, medium: TrendState, structural: TrendState): TrendState {
  if (medium === structural) return medium;
  if (medium !== 'NEUTRAL' && structural !== 'NEUTRAL') return 'NEUTRAL';
  const direction = medium === 'NEUTRAL' ? structural : medium;
  return short === direction ? direction : 'NEUTRAL';
}
export function marketRawState(spy: TrendState, rsp: TrendState): TrendState {
  return spy === rsp ? spy : 'NEUTRAL';
}
export type HysteresisState = { effective: TrendState | null; recoveryConfirmation: number };
export type TransitionEvidence = {
  previousEffectiveState: TrendState | null; rawState: TrendState | null; effectiveState: TrendState | null;
  confirmationBefore: number; supportingCount: number; recoveryConfirmation: number;
  nextRecoveryTarget: TrendState | null; transitioned: boolean; reason: string;
};
const ORDER: TrendState[] = ['DOWN', 'NEUTRAL', 'UP'];
export function advanceTrend(previous: HysteresisState, raw: TrendState | null): TransitionEvidence {
  const before = previous.effective;
  const result: TransitionEvidence = { previousEffectiveState: before, rawState: raw, effectiveState: before, confirmationBefore: previous.recoveryConfirmation, supportingCount: previous.recoveryConfirmation, recoveryConfirmation: previous.recoveryConfirmation, nextRecoveryTarget: before === null || before === 'UP' ? null : ORDER[ORDER.indexOf(before) + 1]!, transitioned: false, reason: '' };
  if (raw === null) return { ...result, reason: 'Unavailable daily evidence: effective state and recovery confirmation are paused.' };
  if (before === null) return { ...result, effectiveState: raw, recoveryConfirmation: 0, supportingCount: 0, nextRecoveryTarget: null, reason: `Bootstrap this independent profile from the first valid raw state: ${raw}.` };
  if (raw === before) return { ...result, recoveryConfirmation: 0, supportingCount: 0, reason: `Raw ${raw} equals effective ${before}; hold and reset recovery confirmation.` };
  if (ORDER.indexOf(raw) < ORDER.indexOf(before)) return { ...result, effectiveState: ORDER[ORDER.indexOf(before) - 1]!, recoveryConfirmation: 0, supportingCount: 0, transitioned: true, reason: `Raw ${raw} is worse than ${before}; deteriorate exactly one state immediately.` };
  const confirmation = previous.recoveryConfirmation + 1;
  return confirmation >= 2
    ? { ...result, effectiveState: result.nextRecoveryTarget, recoveryConfirmation: 0, supportingCount: confirmation, transitioned: true, reason: `Two valid daily assessments support at least ${result.nextRecoveryTarget}; recover one state and reset confirmation.` }
    : { ...result, recoveryConfirmation: confirmation, supportingCount: confirmation, reason: `Raw ${raw} supports recovery to ${result.nextRecoveryTarget}; hold ${before} while confirmation is ${confirmation}/2.` };
}
export type MeasurementEvidence = { key: string; label: string; horizon: Horizon; value: number; deadband: number; classification: MeasurementSign };
export type InstrumentEvidence = {
  state: TrendState | null; horizons: Record<Horizon, TrendState> | null;
  measurements: MeasurementEvidence[]; ema10: number | null; ema20: number | null; ema50: number | null;
  consecutiveSessions: number; reason: string;
};
const pct = (a: number, b: number) => (a / b - 1) * 100;
function instrumentMeasurements(bars: readonly (NormalizedBar | null)[]) {
  const closes = bars.map(bar => bar?.close ?? null);
  const ema10 = emaSeries(closes, 10), ema20 = emaSeries(closes, 20), ema50 = emaSeries(closes, 50);
  let consecutive = 0;
  return bars.map((bar, i) => {
    consecutive = bar ? consecutive + 1 : 0;
    const e10 = ema10[i] ?? null, e20 = ema20[i] ?? null, e50 = ema50[i] ?? null;
    const values = consecutive < TREND_MINIMUM_SESSIONS ? null : [
      pct(bar!.close, e10!), pct(e10!, ema10[i - 3]!) / 3, pct(bar!.close, closes[i - 5]!),
      pct(bar!.close, e20!), pct(e20!, ema20[i - 5]!) / 5, pct(e10!, e20!),
      pct(bar!.close, e50!), pct(e50!, ema50[i - 10]!) / 10, pct(e20!, e50!),
    ];
    return { values, ema10: e10, ema20: e20, ema50: e50, consecutiveSessions: consecutive };
  });
}
function classifyInstrument(input: ReturnType<typeof instrumentMeasurements>[number], thresholds: TrendThresholds): InstrumentEvidence {
  const { values, ...base } = input;
  if (!values) return { ...base, state: null, horizons: null, measurements: [], reason: `Unavailable: ${base.consecutiveSessions}/${TREND_MINIMUM_SESSIONS} consecutive sessions; EMA50 plus its 10-session slope requires 60.` };
  const measurements = values.map((value, i) => ({ ...MEASUREMENT_DEFINITIONS[i]!, value, deadband: thresholds[i]!, classification: measurementSign(value, thresholds[i]!) }));
  if (measurements.some(m => !Number.isFinite(m.value))) throw new Error('Non-finite Trend measurement.');
  const horizons = Object.fromEntries((['SHORT', 'MEDIUM', 'STRUCTURAL'] as const).map(h => [h, horizonState(measurements.filter(m => m.horizon === h).map(m => m.classification))])) as Record<Horizon, TrendState>;
  const state = instrumentState(horizons.SHORT, horizons.MEDIUM, horizons.STRUCTURAL);
  const reason = horizons.MEDIUM === horizons.STRUCTURAL
    ? `Medium and structural both classify ${horizons.MEDIUM}; instrument Trend is ${state}.`
    : horizons.MEDIUM !== 'NEUTRAL' && horizons.STRUCTURAL !== 'NEUTRAL'
      ? `Medium ${horizons.MEDIUM} conflicts with structural ${horizons.STRUCTURAL}; instrument Trend is NEUTRAL regardless of short-term direction.`
      : `Medium ${horizons.MEDIUM} and structural ${horizons.STRUCTURAL} need short-term confirmation. Short is ${horizons.SHORT}; instrument Trend is ${state}.`;
  return { ...base, state, horizons, measurements, reason };
}
export type TrendDay = { date: string; status: 'VALID' | 'UNAVAILABLE'; spy: InstrumentEvidence; rsp: InstrumentEvidence; rawState: TrendState | null; effectiveState: TrendState | null; marketReason: string; transition: TransitionEvidence };
export function calculateTrend(dates: readonly string[], spy: readonly (NormalizedBar | null)[], rsp: readonly (NormalizedBar | null)[], profile: TrendProfile): TrendDay[] {
  return calculateTrendWithThresholds(dates, spy, rsp, TREND_PROFILES[profile]);
}
export function calculateTrendWithThresholds(dates: readonly string[], spy: readonly (NormalizedBar | null)[], rsp: readonly (NormalizedBar | null)[], thresholds: TrendThresholds): TrendDay[] {
  if (thresholds.length !== 9 || thresholds.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Trend requires nine finite nonnegative thresholds.');
  if (dates.length !== spy.length || dates.length !== rsp.length || dates.some((date, i) => i > 0 && date <= dates[i - 1]!)) throw new Error('Trend requires aligned, unique chronological daily sessions.');
  if (spy.some((bar, i) => bar && bar.date !== dates[i]) || rsp.some((bar, i) => bar && bar.date !== dates[i])) throw new Error('Instrument session identity mismatch.');
  const a = instrumentMeasurements(spy), b = instrumentMeasurements(rsp);
  let history: HysteresisState = { effective: null, recoveryConfirmation: 0 };
  return dates.map((date, i) => {
    const spyEvidence = classifyInstrument(a[i]!, thresholds), rspEvidence = classifyInstrument(b[i]!, thresholds);
    const rawState = spyEvidence.state === null || rspEvidence.state === null ? null : marketRawState(spyEvidence.state, rspEvidence.state);
    const transition = advanceTrend(history, rawState);
    history = { effective: transition.effectiveState, recoveryConfirmation: transition.recoveryConfirmation };
    const marketReason = rawState === null ? 'Required SPY/RSP evidence is unavailable; this is not a NEUTRAL classification.' : spyEvidence.state === rspEvidence.state ? `SPY and RSP both classify ${rawState}; market raw Trend is ${rawState}.` : `SPY is ${spyEvidence.state}; RSP is ${rspEvidence.state}. Cap-weighted and equal-weight confirmation is incomplete, so raw market Trend is NEUTRAL.`;
    // The held historical state is in transition evidence, never exposed as a valid classification on a missing day.
    return { date, status: rawState === null ? 'UNAVAILABLE' : 'VALID', spy: spyEvidence, rsp: rspEvidence, rawState, effectiveState: rawState === null ? null : transition.effectiveState, marketReason, transition };
  });
}
export function summarizeTrend(days: readonly TrendDay[]) {
  const valid = days.filter(day => day.status === 'VALID');
  const counts = { UP: 0, NEUTRAL: 0, DOWN: 0 }; const transitionsPerYear: Record<string, number> = {};
  const runs: number[] = []; let previous: TrendState | null = null; let length = 0; let transitions = 0;
  for (const day of valid) {
    const state = day.effectiveState!; counts[state]++;
    const year = day.date.slice(0, 4); transitionsPerYear[year] ??= 0;
    if (day.transition.transitioned) { transitions++; transitionsPerYear[year]++; }
    if (previous !== null && previous !== state) { runs.push(length); length = 0; }
    length++; previous = state;
  }
  if (length) runs.push(length);
  runs.sort((a, b) => a - b);
  const mid = Math.floor(runs.length / 2);
  return {
    validDays: valid.length, unavailableDays: days.length - valid.length,
    statePercentages: Object.fromEntries(Object.entries(counts).map(([state, count]) => [state, valid.length ? count / valid.length * 100 : 0])) as Record<TrendState, number>,
    transitions, transitionsPerYear, annualizedTransitions: valid.length ? transitions * 252 / valid.length : 0,
    medianRunDuration: runs.length ? runs.length % 2 ? runs[mid]! : (runs[mid - 1]! + runs[mid]!) / 2 : null,
    oneDayRuns: runs.filter(n => n === 1).length, twoDayOrShorterRuns: runs.filter(n => n <= 2).length,
    runDefinition: 'Valid sessions in the displayed interval; unavailable sessions pause runs. Boundary runs are included and may be censored.',
  };
}
