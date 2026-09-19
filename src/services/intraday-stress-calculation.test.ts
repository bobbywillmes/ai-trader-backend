import { describe, expect, it } from 'vitest';
import { etInstant } from './market-calendar.js';
import {
  advanceIntradayStress, marketRawState, measureIntradaySession,
  type IntradayStressBar, type IntradayStressState,
} from './intraday-stress-calculation.js';

const DATE = '2024-01-02'; // Ordinary Tuesday regular session, no exceptions.
const OPEN_MS = etInstant(DATE, 570).getTime(); // 09:30 ET
const INTERVAL = 900_000;
function bar(index: number, open: number, high: number, low: number, close: number, volume = 1_000): IntradayStressBar {
  return { barStartAtMs: OPEN_MS + index * INTERVAL, open, high, low, close, volume };
}
/** Build a flat, no-stress session up through `count` bars (index 0-based), then override some bars. */
function flatBars(count: number, price = 100, overrides: Record<number, IntradayStressBar> = {}): IntradayStressBar[] {
  const bars: IntradayStressBar[] = [];
  for (let i = 0; i < count; i++) bars.push(overrides[i] ?? bar(i, price, price + 0.01, price - 0.01, price));
  return bars;
}
const ATR_PCT = 0.01; // 1% prior ATR baseline.

describe('measureIntradaySession', () => {
  it('uses sessionOpen as the first-bar reference', () => {
    const bars = flatBars(1, 100);
    const [t1] = measureIntradaySession(DATE, bars, ATR_PCT, []);
    expect(t1!.referencePrice).toBe(100);
    expect(t1!.sessionOpen).toBe(100);
  });

  it('uses the previous contiguous 15m close as later reference, excluding the overnight gap', () => {
    const bars = flatBars(2, 100, { 1: bar(1, 105, 106, 104, 105) });
    const [, t2] = measureIntradaySession(DATE, bars, ATR_PCT, []);
    expect(t2!.referencePrice).toBe(100); // First bar's close, not any prior-session close.
  });

  it('computes shockPct/shockAtrRatio and applies frozen shock thresholds', () => {
    // Reference 100; true range 0.5 => shockPct 0.005; ratio vs 1% ATR = 0.5 -> ELEVATED (>=0.40 and <0.70).
    const bars = flatBars(1, 100, { 0: bar(0, 100, 100.5, 100, 100.2) });
    const [t] = measureIntradaySession(DATE, bars, ATR_PCT, []);
    expect(t!.shockAtrRatio).toBeCloseTo(0.5, 6);
    expect(t!.componentStates!.shockState).toBe('ELEVATED');
  });

  it('classifies HIGH shock at or above 0.70 ATR ratio', () => {
    const bars = flatBars(1, 100, { 0: bar(0, 100, 100.7, 100, 100.3) });
    const [t] = measureIntradaySession(DATE, bars, ATR_PCT, []);
    expect(t!.shockAtrRatio).toBeCloseTo(0.7, 6);
    expect(t!.componentStates!.shockState).toBe('HIGH');
  });

  it('marks rolling60 as session warm-up for the first three actionable targets', () => {
    const bars = flatBars(3);
    const targets = measureIntradaySession(DATE, bars, ATR_PCT, []).slice(0, 3);
    for (const t of targets) {
      expect(t.rollingStatus).toBe('NOT_APPLICABLE_SESSION_WARMUP');
      expect(t.status).toBe('VALID'); // Warm-up must not invalidate an otherwise valid assessment.
    }
  });

  it('computes the exact four-return rolling realized movement at the fourth target', () => {
    const prices = [100, 101, 99, 100.5, 102]; // opens sessionOpen=100, then four contiguous closes
    const bars = prices.slice(1).map((close, i) => bar(i, prices[i]!, Math.max(prices[i]!, close) + 0.01, Math.min(prices[i]!, close) - 0.01, close));
    const targets = measureIntradaySession(DATE, bars, ATR_PCT, []);
    const r1 = 101 / 100 - 1, r2 = 99 / 101 - 1, r3 = 100.5 / 99 - 1, r4 = 102 / 100.5 - 1;
    const expected = Math.sqrt(r1 ** 2 + r2 ** 2 + r3 ** 2 + r4 ** 2);
    expect(targets[3]!.rollingStatus).toBe('VALID');
    expect(targets[3]!.realizedMovement60Pct).toBeCloseTo(expected, 10);
  });

  it('fails rolling continuity when a required prior bar is missing after warm-up', () => {
    const bars = [bar(0, 100, 100.5, 99.5, 100), bar(1, 100, 100.5, 99.5, 100), bar(3, 100, 100.5, 99.5, 100)]; // index 2 missing
    const targets = measureIntradaySession(DATE, bars, ATR_PCT, []);
    expect(targets[3]!.status).toBe('UNAVAILABLE');
    expect(targets[3]!.issues).toContain('ROLLING_CONTINUITY_FAILURE');
  });

  it('tracks sessionPeak/sessionDrawdown from session open through the target', () => {
    const bars = [bar(0, 100, 110, 99, 105), bar(1, 105, 105, 95, 96)];
    const targets = measureIntradaySession(DATE, bars, ATR_PCT, []);
    expect(targets[0]!.sessionPeak).toBe(110);
    expect(targets[1]!.sessionPeak).toBe(110);
    expect(targets[1]!.sessionDrawdownPct).toBeCloseTo((110 - 96) / 110, 10);
  });

  it('upgrades to at least HIGH via the 1% acute closing downside safeguard even with a low ATR ratio', () => {
    // referencePrice 100, close 98.9 => acuteCloseDownsidePct = 1.1%, ratio vs 5% ATR baseline is tiny.
    const bars = flatBars(1, 100, { 0: bar(0, 100, 100.1, 98.8, 98.9) });
    const [t] = measureIntradaySession(DATE, bars, 0.05, []);
    expect(t!.acuteCloseDownsidePct).toBeGreaterThanOrEqual(0.01);
    expect(t!.instrumentGeneralState === 'HIGH' || t!.instrumentGeneralState === 'SEVERE').toBe(true);
    expect(t!.componentStates!.absoluteHighTriggered.acuteCloseDownside).toBe(true);
  });

  it('upgrades to at least HIGH via the 2.5% session drawdown safeguard', () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 97.4, 97.4)];
    const targets = measureIntradaySession(DATE, bars, 0.10, []);
    expect(targets[1]!.sessionDrawdownPct).toBeGreaterThanOrEqual(0.025);
    expect(targets[1]!.componentStates!.absoluteHighTriggered.sessionDrawdown).toBe(true);
  });

  it('retains a recovered intrabar low as evidence without creating SEVERE', () => {
    // Deep intrabar low but the bar recovers to close near open: no current-close or session collapse.
    const bars = flatBars(1, 100, { 0: bar(0, 100, 100.1, 90, 100) });
    const [t] = measureIntradaySession(DATE, bars, 0.01, []);
    expect(t!.downsideExcursionPct).toBeCloseTo(0.10, 6); // Immutable evidence preserved.
    expect(t!.instrumentRawState).not.toBe('SEVERE');
    expect(t!.componentStates!.acuteCollapse.triggered).toBe(false);
  });

  it('classifies acute SEVERE via the normalized-ratio-plus-floor rule', () => {
    // acuteCloseDownsidePct 2.4% (>= 2% floor), ratio vs 2% ATR = 1.2 (>= 1.20 ratio threshold).
    const bars = flatBars(1, 100, { 0: bar(0, 100, 100.1, 97.5, 97.6) });
    const [t] = measureIntradaySession(DATE, bars, 0.02, []);
    expect(t!.acuteCloseDownsideAtrRatio).toBeGreaterThanOrEqual(1.20);
    expect(t!.acuteCloseDownsidePct).toBeGreaterThanOrEqual(0.02);
    expect(t!.instrumentRawState).toBe('SEVERE');
    expect(t!.componentStates!.acuteCollapse.reason).toBe('NORMALIZED_1_2ATR_AND_2PCT_FLOOR');
  });

  it('classifies acute SEVERE via the fixed 3% emergency floor regardless of ATR ratio', () => {
    const bars = flatBars(1, 100, { 0: bar(0, 100, 100.1, 96.8, 96.9) }); // 3.1% acute downside, huge ATR baseline dilutes ratio
    const [t] = measureIntradaySession(DATE, bars, 0.20, []);
    expect(t!.acuteCloseDownsidePct).toBeGreaterThanOrEqual(0.03);
    expect(t!.instrumentRawState).toBe('SEVERE');
    expect(t!.componentStates!.acuteCollapse.reason).toBe('EMERGENCY_3PCT_ACUTE_CLOSE_DOWNSIDE');
  });

  it('classifies session SEVERE via the normalized-ratio-plus-floor rule', () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 97.4, 97.4)]; // 2.6% session drawdown
    const targets = measureIntradaySession(DATE, bars, 0.01, []); // ratio = 2.6 >= 2.5
    expect(targets[1]!.sessionDrawdownAtrRatio).toBeGreaterThanOrEqual(2.5);
    expect(targets[1]!.sessionDrawdownPct).toBeGreaterThanOrEqual(0.025);
    expect(targets[1]!.instrumentRawState).toBe('SEVERE');
    expect(targets[1]!.componentStates!.sessionCollapse.reason).toBe('NORMALIZED_2_5ATR_AND_2_5PCT_FLOOR');
  });

  it('classifies session SEVERE via the fixed 4% emergency floor regardless of ATR ratio', () => {
    const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 95.9, 95.9)]; // 4.1% session drawdown
    const targets = measureIntradaySession(DATE, bars, 0.30, []); // huge ATR baseline dilutes ratio
    expect(targets[1]!.sessionDrawdownPct).toBeGreaterThanOrEqual(0.04);
    expect(targets[1]!.instrumentRawState).toBe('SEVERE');
    expect(targets[1]!.componentStates!.sessionCollapse.reason).toBe('EMERGENCY_4PCT_SESSION_DRAWDOWN');
  });

  it('allows a large upside shock to reach HIGH but never SEVERE', () => {
    const bars = flatBars(1, 100, { 0: bar(0, 100, 101, 100, 100.9) }); // Pure upside; no downside at all.
    const [t] = measureIntradaySession(DATE, bars, 0.005, []); // Small ATR baseline -> large ratio
    expect(t!.shockAtrRatio).toBeGreaterThanOrEqual(0.70);
    expect(t!.instrumentGeneralState).toBe('HIGH');
    expect(t!.instrumentRawState).toBe('HIGH');
    expect(t!.acuteCloseDownsidePct).toBe(0);
  });

  it('reports evidence failure when a required expected bar is missing', () => {
    const bars: IntradayStressBar[] = []; // No bars at all for a session requiring at least one target
    const [t] = measureIntradaySession(DATE, bars, ATR_PCT, []);
    expect(t!.status).toBe('UNAVAILABLE');
    expect(t!.issues).toContain('MISSING_INVALID_OR_DUPLICATE_BAR');
  });

  it('reports evidence failure when the prior daily ATR baseline is missing', () => {
    const bars = flatBars(1);
    const [t] = measureIntradaySession(DATE, bars, null, []);
    expect(t!.status).toBe('UNAVAILABLE');
    expect(t!.issues).toContain('PRIOR_ATR_UNAVAILABLE');
  });

  it('excludes the bar ending exactly at session close from actionable targets', () => {
    // 09:30-16:00 regular session = 26 fifteen-minute intervals; 25 are actionable.
    const targets = measureIntradaySession(DATE, [], ATR_PCT, []);
    expect(targets).toHaveLength(25);
    expect(targets.at(-1)!.targetAt).toBe(new Date(OPEN_MS + 25 * INTERVAL).toISOString());
  });

  it('produces 13 actionable targets for a 13:00 early close', () => {
    const targets = measureIntradaySession(DATE, [], ATR_PCT, [{ sessionDate: DATE, type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }]);
    expect(targets).toHaveLength(13);
  });
});

describe('marketRawState', () => {
  it('is the worse of SPY and RSP; either SEVERE is sufficient', () => {
    expect(marketRawState('NORMAL', 'SEVERE')).toBe('SEVERE');
    expect(marketRawState('SEVERE', 'NORMAL')).toBe('SEVERE');
    expect(marketRawState('ELEVATED', 'HIGH')).toBe('HIGH');
  });
});

describe('advanceIntradayStress', () => {
  function run(raws: (IntradayStressState | null)[]) {
    let history: { effectiveState: IntradayStressState | null; confirmation: number } = { effectiveState: null, confirmation: 0 };
    const results = [];
    for (const raw of raws) {
      const t = advanceIntradayStress(history, raw);
      history = { effectiveState: t.effectiveState, confirmation: t.confirmationAfter };
      results.push(t.effectiveState);
    }
    return results;
  }

  it('worsens immediately on first bootstrap and on any more severe raw', () => {
    expect(run(['HIGH'])).toEqual(['HIGH']);
    expect(run(['ELEVATED', 'SEVERE'])).toEqual(['ELEVATED', 'SEVERE']);
  });

  it('recovers exactly one level after two supporting lower assessments, then resets confirmation', () => {
    expect(run(['SEVERE', 'NORMAL', 'NORMAL'])).toEqual(['SEVERE', 'SEVERE', 'HIGH']);
  });

  it('steps down one level at a time through the full ladder', () => {
    // SEVERE -> two NORMALs -> HIGH -> two NORMALs -> ELEVATED -> two NORMALs -> NORMAL
    expect(run(['SEVERE', 'NORMAL', 'NORMAL', 'NORMAL', 'NORMAL', 'NORMAL', 'NORMAL']))
      .toEqual(['SEVERE', 'SEVERE', 'HIGH', 'HIGH', 'ELEVATED', 'ELEVATED', 'NORMAL']);
  });

  it('resets confirmation when raw regresses to equal the effective state', () => {
    // First lower reading starts confirmation 1/2, then a reading equal to effective resets it.
    expect(run(['HIGH', 'NORMAL', 'HIGH', 'NORMAL', 'NORMAL'])).toEqual(['HIGH', 'HIGH', 'HIGH', 'HIGH', 'ELEVATED']);
  });

  it('never applies hysteresis across sessions: callers must bootstrap fresh per session', () => {
    // A new session's first target ignores whatever the previous session's effective state was.
    const firstTargetOfNewSession = advanceIntradayStress({ effectiveState: null, confirmation: 0 }, 'ELEVATED');
    expect(firstTargetOfNewSession.effectiveState).toBe('ELEVATED');
    expect(firstTargetOfNewSession.transitioned).toBe(false);
  });

  it('a missing assessment does not advance recovery: confirmation restarts after the gap', () => {
    // The first NORMAL builds confirmation 1/2; the gap resets it; two more NORMALs are required from scratch.
    expect(run(['SEVERE', 'NORMAL', null, 'NORMAL', 'NORMAL'])).toEqual(['SEVERE', 'SEVERE', 'SEVERE', 'SEVERE', 'HIGH']);
  });

  it('pauses (holds) effective state while raw is unavailable, rather than blanking it', () => {
    expect(run(['HIGH', null, null])).toEqual(['HIGH', 'HIGH', 'HIGH']);
  });
});
