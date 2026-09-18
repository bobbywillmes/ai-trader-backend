/** Research only: no persistence, assessments, or trading dependencies. All Pct values are fractions. */
import { etDate, etInstant, marketSession, type CalendarException } from '../services/market-calendar.js';
import { trueRange } from '../services/volatility-calculation.js';

export type Symbol = 'SPY' | 'RSP' | 'QQQ' | 'IWM';
export type Bar = { symbol: Symbol; timeframe: 'DAY_1' | 'MINUTE_15'; t: number; open: number; high: number; low: number; close: number; volume: number };
export function validBar(b: Bar): boolean {
  return [b.open, b.high, b.low, b.close].every(x => Number.isFinite(x) && x > 0)
    && Number.isFinite(b.volume) && b.volume >= 0 && Number.isSafeInteger(b.t)
    && b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close) && b.high >= b.low;
}
export type Target = {
  symbol: Symbol; date: string; index: number; targetAt: string; closing: boolean;
  priorAtr14Pct: number | null; status: 'VALID' | 'UNAVAILABLE'; issues: string[];
  referencePrice: number | null; trueRange15: number | null; return15: number | null;
  sessionOpen: number | null; sessionPeak: number | null; currentClose: number | null;
  rollingStatus: 'VALID' | 'NOT_APPLICABLE_SESSION_WARMUP' | 'UNAVAILABLE';
  shockPct: number | null; shockAtrRatio: number | null;
  downsideExcursionPct: number | null; downsideExcursionAtrRatio: number | null;
  realizedMovement60Pct: number | null; realizedMovement60AtrRatio: number | null;
  sessionDrawdownPct: number | null; sessionDrawdownAtrRatio: number | null;
  pathLength60: number | null; openToCurrentPct: number | null; peakFromOpenPct: number | null;
};
export function measureSession(symbol: Symbol, date: string, bars: readonly Bar[], priorAtr14Pct: number | null, exceptions: readonly CalendarException[]): Target[] {
  const session = marketSession(date, exceptions);
  if (!session) throw new Error('Expected open session.');
  const interval = 900_000, count = (session.closeAt.getTime() - session.openAt.getTime()) / interval;
  if (!Number.isInteger(count)) throw new Error('Session must align to 15 minutes.');
  const map = new Map<number, Bar>(), duplicates = new Set<number>();
  for (const b of bars) {
    if (b.symbol !== symbol || b.timeframe !== 'MINUTE_15' || etDate(new Date(b.t)) !== date
      || b.t < session.openAt.getTime() || b.t >= session.closeAt.getTime() || (b.t - session.openAt.getTime()) % interval !== 0) throw new Error('Unexpected bar identity/session/interval.');
    if (map.has(b.t)) duplicates.add(b.t);
    map.set(b.t, b);
  }
  const aligned = Array.from({ length: count }, (_, i) => {
    const t = session.openAt.getTime() + i * interval, b = map.get(t);
    return b && validBar(b) && !duplicates.has(t) ? b : null;
  });
  const open = aligned[0]?.open ?? null;
  let peak = open, prefixComplete = true;
  const returns: (number | null)[] = [];
  return aligned.map((bar, i) => {
    const reference = i === 0 ? open : aligned[i - 1]?.close ?? null;
    prefixComplete &&= bar !== null;
    if (bar && peak !== null) peak = Math.max(peak, bar.high);
    const r = bar && reference ? bar.close / reference - 1 : null;
    returns.push(r);
    const shock = bar && reference ? trueRange(bar.high, bar.low, reference) / reference : null;
    const downside = bar && reference ? Math.max(0, reference - bar.low) / reference : null;
    const window = returns.slice(-4);
    const rolling = i >= 3 && window.every(x => x !== null) ? Math.sqrt(window.reduce<number>((sum, x) => sum + x! ** 2, 0)) : null;
    const drawdown = prefixComplete && bar && peak ? Math.max(0, peak - bar.close) / peak : null;
    const baseline = priorAtr14Pct !== null && Number.isFinite(priorAtr14Pct) && priorAtr14Pct > 0 ? priorAtr14Pct : null;
    const ratio = (value: number | null) => value === null || baseline === null ? null : value / baseline;
    const issues = [!bar ? 'MISSING_INVALID_OR_DUPLICATE_BAR' : '', reference === null ? 'MISSING_REFERENCE' : '',
      !prefixComplete ? 'INCOMPLETE_SESSION_PREFIX' : '', baseline === null ? 'PRIOR_ATR_UNAVAILABLE' : '',
      i >= 3 && rolling === null ? 'ROLLING_CONTINUITY_FAILURE' : ''].filter(Boolean);
    return { symbol, date, index: i + 1, targetAt: new Date(session.openAt.getTime() + (i + 1) * interval).toISOString(),
      closing: i === count - 1, priorAtr14Pct: baseline, status: issues.length ? 'UNAVAILABLE' : 'VALID', issues,
      referencePrice: reference, trueRange15: bar && reference ? trueRange(bar.high, bar.low, reference) : null, return15: r,
      sessionOpen: open, sessionPeak: prefixComplete ? peak : null, currentClose: bar?.close ?? null,
      rollingStatus: i < 3 ? 'NOT_APPLICABLE_SESSION_WARMUP' : rolling === null ? 'UNAVAILABLE' : 'VALID',
      shockPct: shock, shockAtrRatio: ratio(shock), downsideExcursionPct: downside, downsideExcursionAtrRatio: ratio(downside),
      realizedMovement60Pct: rolling, realizedMovement60AtrRatio: ratio(rolling), sessionDrawdownPct: drawdown,
      sessionDrawdownAtrRatio: ratio(drawdown), pathLength60: rolling === null ? null : window.reduce<number>((sum, x) => sum + Math.abs(x!), 0),
      openToCurrentPct: bar && open ? bar.close / open - 1 : null, peakFromOpenPct: prefixComplete && peak && open ? peak / open - 1 : null };
  });
}
export function validDaily(b: Bar, symbol: Symbol, exceptions: readonly CalendarException[]): boolean {
  const date = etDate(new Date(b.t));
  return validBar(b) && b.symbol === symbol && b.timeframe === 'DAY_1' && !!marketSession(date, exceptions) && b.t === etInstant(date, 0).getTime();
}
export const STATES = ['NORMAL', 'ELEVATED', 'HIGH', 'SEVERE'] as const;
export type Candidate = { name: string; shock: [number, number]; rolling: [number, number]; drawdown: [number, number];
  acute: { ratio: number; floor: number; emergency: number }; session: { ratio: number; floor: number; emergency: number } };
export function classify(t: Target, c: Candidate): number | null {
  if (t.status !== 'VALID') return null;
  const collapse = (ratio: number | null, absolute: number | null, rule: Candidate['acute']) => ratio !== null && absolute !== null
    && ((ratio >= rule.ratio && absolute >= rule.floor) || absolute >= rule.emergency);
  if (collapse(t.downsideExcursionAtrRatio, t.downsideExcursionPct, c.acute)
    || collapse(t.sessionDrawdownAtrRatio, t.sessionDrawdownPct, c.session)) return 3;
  const ladder = (v: number | null, bounds: number[]) => v === null ? 0 : bounds.filter(b => v >= b).length;
  return Math.max(ladder(t.shockAtrRatio, c.shock), ladder(t.realizedMovement60AtrRatio, c.rolling), ladder(t.sessionDrawdownAtrRatio, c.drawdown));
}
/** Missing assessments break consecutive confirmations; emitted state remains unavailable. */
export function recover(raw: readonly (number | null)[], confirmations: 2 | 3): (number | null)[] {
  let effective: number | null = null, count = 0;
  return raw.map(value => {
    if (value === null) { count = 0; return null; }
    if (effective === null || value > effective) { effective = value; count = 0; }
    else if (value === effective) count = 0;
    else if (++count >= confirmations) { effective--; count = 0; }
    return effective;
  });
}
