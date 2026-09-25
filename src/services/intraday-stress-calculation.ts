/** Pure INTRADAY_STRESS_V1 calculation. No database, clock, HTTP or trading dependencies.
 * Ports the frozen research algorithm (research/intraday-stress-v1, commits 8a5514b/b2a9d9d)
 * into the production evidence shape: named states instead of numeric severities, and
 * classification folded into the same pass as measurement.
 */
import { marketSession, type CalendarException } from './market-calendar.js';
import { trueRange } from './volatility-calculation.js';

export const INTRADAY_STRESS_STATES = ['NORMAL', 'ELEVATED', 'HIGH', 'SEVERE'] as const;
export type IntradayStressState = typeof INTRADAY_STRESS_STATES[number];
export const INTRADAY_STRESS_SEVERITY = Object.freeze({ NORMAL: 0, ELEVATED: 1, HIGH: 2, SEVERE: 3 } satisfies Record<IntradayStressState, number>);
const severity = (state: IntradayStressState) => INTRADAY_STRESS_SEVERITY[state];

export const INTRADAY_STRESS_DEFINITION = Object.freeze({
  evidenceSchemaVersion: 1,
  symbols: Object.freeze(['SPY', 'RSP'] as const),
  timeframe: 'MINUTE_15',
  intervalMs: 900_000,
  baseline: 'priorAtr14Pct = prior completed regular-session ATR14 (Wilder, VOLATILITY_V1 semantics) / prior completed session close; frozen for the entire current session',
  shock: Object.freeze({ thresholds: Object.freeze([0.40, 0.70] as const) }),
  rolling: Object.freeze({ thresholds: Object.freeze([0.45, 0.80] as const), windowIntervals: 4, warmupTargets: 3 }),
  drawdown: Object.freeze({ thresholds: Object.freeze([1.00, 1.75] as const) }),
  absoluteHigh: Object.freeze({ acuteCloseDownsidePct: 0.01, sessionDrawdownPct: 0.025 }),
  acuteCollapse: Object.freeze({ ratio: 1.20, floor: 0.02, emergency: 0.03 }),
  sessionCollapse: Object.freeze({ ratio: 2.50, floor: 0.025, emergency: 0.04 }),
  boundaryRule: 'Lower bounds inclusive; upper bounds exclusive',
  instrumentRule: 'worst(shock, rolling-when-applicable, drawdown, absolute-HIGH safeguards); acuteCollapse or sessionCollapse overrides to SEVERE regardless of the general ladder',
  marketRule: 'worse(SPY, RSP) instrument raw state; either instrument SEVERE is sufficient for market SEVERE; no averaging or voting',
  recoverySessions: 2,
  severity: INTRADAY_STRESS_SEVERITY,
  normalization: 'Massive splitFrom/splitTo applied to pre-execution OHLC; stored bars unchanged',
});

export type IntradayStressBar = { barStartAtMs: number; open: number; high: number; low: number; close: number; volume: number };
function validIntradayBar(b: IntradayStressBar): boolean {
  return [b.open, b.high, b.low, b.close].every(x => Number.isFinite(x) && x > 0)
    && Number.isFinite(b.volume) && b.volume >= 0 && Number.isSafeInteger(b.barStartAtMs)
    && b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close) && b.high >= b.low;
}

export type IntradayStressIssue = 'MISSING_INVALID_OR_DUPLICATE_BAR' | 'MISSING_REFERENCE' | 'INCOMPLETE_SESSION_PREFIX' | 'PRIOR_ATR_UNAVAILABLE' | 'ROLLING_CONTINUITY_FAILURE';

export type IntradayStressComponentStates = {
  shockState: IntradayStressState;
  rollingState: IntradayStressState | 'NOT_APPLICABLE_SESSION_WARMUP';
  drawdownState: IntradayStressState;
  absoluteHighTriggered: { acuteCloseDownside: boolean; sessionDrawdown: boolean };
  acuteCollapse: { triggered: boolean; reason: 'EMERGENCY_3PCT_ACUTE_CLOSE_DOWNSIDE' | 'NORMALIZED_1_2ATR_AND_2PCT_FLOOR' | null };
  sessionCollapse: { triggered: boolean; reason: 'EMERGENCY_4PCT_SESSION_DRAWDOWN' | 'NORMALIZED_2_5ATR_AND_2_5PCT_FLOOR' | null };
};

export type IntradayStressTarget = {
  date: string; index: number; targetAt: string; status: 'VALID' | 'UNAVAILABLE'; issues: IntradayStressIssue[];
  priorAtr14Pct: number | null;
  interval: { barStartAt: string; barEndAt: string; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null };
  referencePrice: number | null;
  shockPct: number | null; shockAtrRatio: number | null;
  downsideExcursionPct: number | null; downsideExcursionAtrRatio: number | null;
  acuteCloseDownsidePct: number | null; acuteCloseDownsideAtrRatio: number | null;
  rollingStatus: 'VALID' | 'NOT_APPLICABLE_SESSION_WARMUP' | 'UNAVAILABLE';
  rollingReturns: (number | null)[] | null;
  realizedMovement60Pct: number | null; realizedMovement60AtrRatio: number | null;
  sessionOpen: number | null; sessionPeak: number | null; currentClose: number | null;
  sessionDrawdownPct: number | null; sessionDrawdownAtrRatio: number | null;
  componentStates: IntradayStressComponentStates | null;
  instrumentGeneralState: IntradayStressState | null;
  instrumentRawState: IntradayStressState | null;
};

/** Caller supplies every bar actually stored for the session; gaps are represented by absence.
 * The bar ending exactly at session close is structurally excluded: it is not an actionable target.
 */
export function measureIntradaySession(date: string, bars: readonly IntradayStressBar[], priorAtr14Pct: number | null, exceptions: readonly CalendarException[]): IntradayStressTarget[] {
  const session = marketSession(date, exceptions);
  if (!session) throw new Error('Expected an open regular session.');
  const interval = INTRADAY_STRESS_DEFINITION.intervalMs;
  const totalIntervals = (session.closeAt.getTime() - session.openAt.getTime()) / interval;
  if (!Number.isInteger(totalIntervals)) throw new Error('Session must align to 15-minute intervals.');
  const actionableCount = totalIntervals - 1;
  const map = new Map<number, IntradayStressBar>();
  const duplicates = new Set<number>();
  for (const bar of bars) {
    if (bar.barStartAtMs < session.openAt.getTime() || bar.barStartAtMs >= session.closeAt.getTime() || (bar.barStartAtMs - session.openAt.getTime()) % interval !== 0) throw new Error('Bar outside session or misaligned to a 15-minute interval.');
    if (map.has(bar.barStartAtMs)) duplicates.add(bar.barStartAtMs);
    map.set(bar.barStartAtMs, bar);
  }
  const aligned = Array.from({ length: actionableCount }, (_, i) => {
    const t = session.openAt.getTime() + i * interval;
    const bar = map.get(t);
    return bar && validIntradayBar(bar) && !duplicates.has(t) ? bar : null;
  });
  const baseline = priorAtr14Pct !== null && Number.isFinite(priorAtr14Pct) && priorAtr14Pct > 0 ? priorAtr14Pct : null;
  const open = aligned[0]?.open ?? null;
  let peak = open;
  let prefixComplete = true;
  const returns: (number | null)[] = [];
  return aligned.map((bar, i) => {
    const reference = i === 0 ? open : aligned[i - 1]?.close ?? null;
    prefixComplete &&= bar !== null;
    if (bar && peak !== null) peak = Math.max(peak, bar.high);
    const r = bar && reference ? bar.close / reference - 1 : null;
    returns.push(r);
    const shockPct = bar && reference ? trueRange(bar.high, bar.low, reference) / reference : null;
    const downsideExcursionPct = bar && reference ? Math.max(0, reference - bar.low) / reference : null;
    const window = returns.slice(-4);
    const rollingApplicable = i >= INTRADAY_STRESS_DEFINITION.rolling.warmupTargets;
    const realizedMovement60Pct = rollingApplicable && window.every(x => x !== null) ? Math.sqrt(window.reduce<number>((sum, x) => sum + x! ** 2, 0)) : null;
    const sessionDrawdownPct = prefixComplete && bar && peak ? Math.max(0, peak - bar.close) / peak : null;
    const ratio = (value: number | null) => value === null || baseline === null ? null : value / baseline;
    const currentClose = bar?.close ?? null;
    const acuteCloseDownsidePct = reference !== null && currentClose !== null ? Math.max(0, reference - currentClose) / reference : null;
    const shockAtrRatio = ratio(shockPct);
    const downsideExcursionAtrRatio = ratio(downsideExcursionPct);
    const acuteCloseDownsideAtrRatio = ratio(acuteCloseDownsidePct);
    const realizedMovement60AtrRatio = ratio(realizedMovement60Pct);
    const sessionDrawdownAtrRatio = ratio(sessionDrawdownPct);
    const issues: IntradayStressIssue[] = [
      ...(!bar ? ['MISSING_INVALID_OR_DUPLICATE_BAR' as const] : []),
      ...(reference === null ? ['MISSING_REFERENCE' as const] : []),
      ...(!prefixComplete ? ['INCOMPLETE_SESSION_PREFIX' as const] : []),
      ...(baseline === null ? ['PRIOR_ATR_UNAVAILABLE' as const] : []),
      ...(rollingApplicable && realizedMovement60Pct === null ? ['ROLLING_CONTINUITY_FAILURE' as const] : []),
    ];
    const status: 'VALID' | 'UNAVAILABLE' = issues.length ? 'UNAVAILABLE' : 'VALID';
    let componentStates: IntradayStressComponentStates | null = null;
    let instrumentGeneralState: IntradayStressState | null = null;
    let instrumentRawState: IntradayStressState | null = null;
    if (status === 'VALID') {
      const ladder = (v: number | null, bounds: readonly number[]) => v === null ? 0 : bounds.filter(b => v >= b).length;
      const shockLadder = ladder(shockAtrRatio, INTRADAY_STRESS_DEFINITION.shock.thresholds);
      const rollingLadder = ladder(realizedMovement60AtrRatio, INTRADAY_STRESS_DEFINITION.rolling.thresholds);
      const drawdownLadder = ladder(sessionDrawdownAtrRatio, INTRADAY_STRESS_DEFINITION.drawdown.thresholds);
      const acuteHighTrigger = acuteCloseDownsidePct !== null && acuteCloseDownsidePct >= INTRADAY_STRESS_DEFINITION.absoluteHigh.acuteCloseDownsidePct;
      const sessionHighTrigger = sessionDrawdownPct !== null && sessionDrawdownPct >= INTRADAY_STRESS_DEFINITION.absoluteHigh.sessionDrawdownPct;
      const generalSeverity = Math.max(shockLadder, rollingLadder, drawdownLadder, (acuteHighTrigger || sessionHighTrigger) ? 2 : 0);
      instrumentGeneralState = INTRADAY_STRESS_STATES[generalSeverity]!;
      const collapses = (ratioValue: number | null, absolute: number | null, rule: { ratio: number; floor: number; emergency: number }) =>
        ratioValue !== null && absolute !== null && ((ratioValue >= rule.ratio && absolute >= rule.floor) || absolute >= rule.emergency);
      const acute = collapses(acuteCloseDownsideAtrRatio, acuteCloseDownsidePct, INTRADAY_STRESS_DEFINITION.acuteCollapse);
      const sessionC = collapses(sessionDrawdownAtrRatio, sessionDrawdownPct, INTRADAY_STRESS_DEFINITION.sessionCollapse);
      instrumentRawState = acute || sessionC ? 'SEVERE' : instrumentGeneralState;
      componentStates = {
        shockState: INTRADAY_STRESS_STATES[shockLadder]!,
        rollingState: rollingApplicable ? INTRADAY_STRESS_STATES[rollingLadder]! : 'NOT_APPLICABLE_SESSION_WARMUP',
        drawdownState: INTRADAY_STRESS_STATES[drawdownLadder]!,
        absoluteHighTriggered: { acuteCloseDownside: acuteHighTrigger, sessionDrawdown: sessionHighTrigger },
        acuteCollapse: { triggered: acute, reason: !acute ? null : acuteCloseDownsidePct! >= INTRADAY_STRESS_DEFINITION.acuteCollapse.emergency ? 'EMERGENCY_3PCT_ACUTE_CLOSE_DOWNSIDE' : 'NORMALIZED_1_2ATR_AND_2PCT_FLOOR' },
        sessionCollapse: { triggered: sessionC, reason: !sessionC ? null : sessionDrawdownPct! >= INTRADAY_STRESS_DEFINITION.sessionCollapse.emergency ? 'EMERGENCY_4PCT_SESSION_DRAWDOWN' : 'NORMALIZED_2_5ATR_AND_2_5PCT_FLOOR' },
      };
    }
    return {
      date, index: i + 1, targetAt: new Date(session.openAt.getTime() + (i + 1) * interval).toISOString(), status, issues,
      priorAtr14Pct: baseline,
      interval: {
        barStartAt: new Date(session.openAt.getTime() + i * interval).toISOString(), barEndAt: new Date(session.openAt.getTime() + (i + 1) * interval).toISOString(),
        open: bar?.open ?? null, high: bar?.high ?? null, low: bar?.low ?? null, close: bar?.close ?? null, volume: bar?.volume ?? null,
      },
      referencePrice: reference, shockPct, shockAtrRatio, downsideExcursionPct, downsideExcursionAtrRatio,
      acuteCloseDownsidePct, acuteCloseDownsideAtrRatio,
      rollingStatus: !rollingApplicable ? 'NOT_APPLICABLE_SESSION_WARMUP' : realizedMovement60Pct === null ? 'UNAVAILABLE' : 'VALID',
      rollingReturns: rollingApplicable ? window : null,
      realizedMovement60Pct, realizedMovement60AtrRatio,
      sessionOpen: open, sessionPeak: prefixComplete ? peak : null, currentClose,
      sessionDrawdownPct, sessionDrawdownAtrRatio,
      componentStates, instrumentGeneralState, instrumentRawState,
    };
  });
}

export function marketRawState(spy: IntradayStressState, rsp: IntradayStressState): IntradayStressState {
  return INTRADAY_STRESS_STATES[Math.max(severity(spy), severity(rsp))]!;
}

export type IntradayStressHistory = { effectiveState: IntradayStressState | null; confirmation: number };
export type IntradayStressTransition = {
  previousEffectiveState: IntradayStressState | null; rawState: IntradayStressState | null;
  confirmationBefore: number; recoveryTarget: IntradayStressState | null; confirmationAfter: number;
  effectiveState: IntradayStressState | null; transitioned: boolean; reason: string;
};
/** No cross-session hysteresis: callers must pass { effectiveState: null, confirmation: 0 } for the
 * first target of a new session. Missing/unavailable raw state (null) pauses effective state and
 * resets pending recovery confirmation to zero: a gap never carries partial recovery progress forward.
 */
export function advanceIntradayStress(previous: IntradayStressHistory, raw: IntradayStressState | null): IntradayStressTransition {
  if (![0, 1].includes(previous.confirmation) || (previous.effectiveState === null && previous.confirmation !== 0)) throw new Error('Invalid hysteresis continuation.');
  const before = previous.effectiveState;
  const target = before === null || before === 'NORMAL' ? null : INTRADAY_STRESS_STATES[severity(before) - 1]!;
  const base: IntradayStressTransition = { previousEffectiveState: before, rawState: raw, confirmationBefore: previous.confirmation, recoveryTarget: target, confirmationAfter: 0, effectiveState: before, transitioned: false, reason: '' };
  if (raw === null) return { ...base, reason: 'Unavailable evidence: pause effective state and reset recovery confirmation.' };
  if (before === null) return { ...base, effectiveState: raw, reason: `Bootstrap from first valid raw state ${raw}.` };
  if (severity(raw) > severity(before)) return { ...base, effectiveState: raw, transitioned: true, reason: `Raw ${raw} is more severe than ${before}; jump immediately to ${raw} and reset recovery.` };
  if (raw === before) return { ...base, reason: `Raw equals effective ${before}; hold and reset recovery.` };
  if (previous.confirmation === 1) return { ...base, effectiveState: target, transitioned: true, reason: `Two valid assessments support at least ${target}; recover exactly one state and reset confirmation.` };
  return { ...base, confirmationAfter: 1, reason: `Raw ${raw} supports ${target}; hold ${before} with recovery confirmation 1/2.` };
}
