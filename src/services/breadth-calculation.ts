/** Pure daily background Breadth candidate; no persistence, fetch or trading dependencies.
 * "How much of the stock market is participating directionally?" Deliberately distinct from
 * SPY/RSP (already Trend's confirmation pair) and from future PARTICIPATION/LEADERSHIP. */

export const BREADTH_STATES = ['NEGATIVE', 'MIXED', 'POSITIVE'] as const;
export type BreadthState = typeof BREADTH_STATES[number];
export const BREADTH_DEFINITION = Object.freeze({
  evidenceSchemaVersion: 1, candidate: 'BREADTH_V1_CALIBRATION',
  universe: 'locale=US, market=stocks, type=CS, active as of the assessed session date (Massive /v3/reference/tickers point-in-time)',
  universeDefinitionVersion: 1,
  provider: 'MASSIVE', groupedBarsAdjustment: 'adjusted=true grouped daily bars; no per-symbol split lookup',
  horizons: Object.freeze([1, 5, 20] as const),
  bands: Object.freeze({ negative: 0.45, positive: 0.55 }),
  boundaryRule: 'value <= 0.45 -> NEGATIVE; 0.45 < value < 0.55 -> MIXED; value >= 0.55 -> POSITIVE',
  severity: Object.freeze({ NEGATIVE: -1, MIXED: 0, POSITIVE: 1 }),
  minimumConsecutiveSessions: 20, recoverySessions: 2,
  horizonRule: 'median of breadth1/breadth5/breadth20 classification severities',
  eligibilityRule: 'point-in-time CS universe member with a valid close on T and on the immediately previous expected session; no backward search for an older prior close',
});
const BREADTH_RANK: Record<BreadthState, number> = { NEGATIVE: 0, MIXED: 1, POSITIVE: 2 };
const rankOf = (state: BreadthState) => BREADTH_RANK[state];

/** A classification band is an explicit, per-horizon research parameter, not a hard-coded
 * constant, so alternative candidates can be compared against the same cached evidence. */
export type BreadthBand = { negativeMax: number; positiveMin: number };
export type BreadthBandsByHorizon = { breadth1: BreadthBand; breadth5: BreadthBand; breadth20: BreadthBand };
export const BASELINE_BREADTH_BANDS: BreadthBandsByHorizon = Object.freeze({
  breadth1: Object.freeze({ negativeMax: 0.45, positiveMin: 0.55 }),
  breadth5: Object.freeze({ negativeMax: 0.45, positiveMin: 0.55 }),
  breadth20: Object.freeze({ negativeMax: 0.45, positiveMin: 0.55 }),
});

export type Direction = 'ADVANCING' | 'DECLINING' | 'UNCHANGED';
export function classifyDirection(current: number, previous: number): Direction {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current <= 0 || previous <= 0) throw new Error('Positive finite closes required.');
  return current > previous ? 'ADVANCING' : current < previous ? 'DECLINING' : 'UNCHANGED';
}

export type DailyBreadthObservation = {
  status: 'VALID' | 'UNAVAILABLE';
  universeCount: number; currentBarsFound: number; priorBarsFound: number;
  eligibleCount: number; excludedCount: number;
  advancingCount: number; decliningCount: number; unchangedCount: number; directionalCount: number;
  advanceShare: number | null; netBreadth: number | null;
};

/** `universe` is the point-in-time eligible CS list for T; `current`/`prior` are grouped
 * daily close maps for T and the immediately previous expected session respectively.
 * Membership in `prior`'s own universe is not required, only a valid close there. */
export function computeDailyBreadthObservation(universe: readonly string[], current: ReadonlyMap<string, number>, prior: ReadonlyMap<string, number>): DailyBreadthObservation {
  let currentBarsFound = 0, priorBarsFound = 0, advancingCount = 0, decliningCount = 0, unchangedCount = 0;
  for (const ticker of universe) {
    const currentClose = current.get(ticker);
    const priorClose = prior.get(ticker);
    if (currentClose !== undefined) currentBarsFound++;
    if (priorClose !== undefined) priorBarsFound++;
    if (currentClose === undefined || priorClose === undefined) continue;
    const direction = classifyDirection(currentClose, priorClose);
    if (direction === 'ADVANCING') advancingCount++;
    else if (direction === 'DECLINING') decliningCount++;
    else unchangedCount++;
  }
  const eligibleCount = advancingCount + decliningCount + unchangedCount;
  const directionalCount = advancingCount + decliningCount;
  return {
    status: directionalCount > 0 ? 'VALID' : 'UNAVAILABLE',
    universeCount: universe.length, currentBarsFound, priorBarsFound,
    eligibleCount, excludedCount: universe.length - eligibleCount,
    advancingCount, decliningCount, unchangedCount, directionalCount,
    advanceShare: directionalCount > 0 ? advancingCount / directionalCount : null,
    netBreadth: directionalCount > 0 ? (advancingCount - decliningCount) / directionalCount : null,
  };
}

export function classifyBreadthBand(value: number, band: BreadthBand = BASELINE_BREADTH_BANDS.breadth1): BreadthState {
  if (!Number.isFinite(value)) throw new Error('Finite advance-share value required.');
  if (!(band.negativeMax < band.positiveMin)) throw new Error('Invalid band: negativeMax must be less than positiveMin.');
  if (value <= band.negativeMax) return 'NEGATIVE';
  if (value >= band.positiveMin) return 'POSITIVE';
  return 'MIXED';
}
export function medianBreadthState(states: readonly [BreadthState, BreadthState, BreadthState]): BreadthState {
  return BREADTH_STATES[states.map(rankOf).sort((a, b) => a - b)[1]!]!;
}

export type BreadthHistory = { effectiveState: BreadthState | null; confirmation: number };
export type BreadthTransition = {
  previousEffectiveState: BreadthState | null; rawState: BreadthState | null;
  confirmationBefore: number; recoveryTarget: BreadthState | null; confirmationAfter: number;
  effectiveState: BreadthState | null; transitioned: boolean; reason: string;
};
/** Asymmetric hysteresis: NEGATIVE < MIXED < POSITIVE. Any drop is immediate; a rise
 * requires two supporting valid sessions and then recovers exactly one level. */
export function advanceBreadth(previous: BreadthHistory, raw: BreadthState | null): BreadthTransition {
  if (![0, 1].includes(previous.confirmation) || (previous.effectiveState === null && previous.confirmation !== 0)) throw new Error('Invalid hysteresis continuation.');
  const before = previous.effectiveState;
  const target = before === null || before === 'POSITIVE' ? null : BREADTH_STATES[rankOf(before) + 1]!;
  const base: BreadthTransition = { previousEffectiveState: before, rawState: raw,
    confirmationBefore: previous.confirmation, recoveryTarget: target, confirmationAfter: previous.confirmation,
    effectiveState: before, transitioned: false, reason: '' };
  if (raw === null) return { ...base, reason: 'Unavailable evidence: pause effective state and recovery confirmation.' };
  if (before === null) return { ...base, effectiveState: raw, confirmationAfter: 0, reason: `Bootstrap from first valid raw state ${raw}.` };
  if (rankOf(raw) < rankOf(before)) return { ...base, effectiveState: raw, confirmationAfter: 0, transitioned: true, reason: `Raw ${raw} is below effective ${before}; move immediately to ${raw} and reset recovery.` };
  if (raw === before) return { ...base, confirmationAfter: 0, reason: `Raw equals effective ${before}; hold and reset recovery.` };
  if (previous.confirmation === 1) return { ...base, effectiveState: target, confirmationAfter: 0, transitioned: true, reason: `Two valid assessments support at least ${target}; recover exactly one state and reset confirmation.` };
  return { ...base, confirmationAfter: 1, reason: `Raw ${raw} supports ${target}; hold ${before} with recovery confirmation 1/2.` };
}

export type BreadthMeasurement = { value: number; state: BreadthState };
export type BreadthDay = {
  date: string; observation: DailyBreadthObservation | null; consecutiveValidSessions: number;
  breadth1: BreadthMeasurement | null; breadth5: BreadthMeasurement | null; breadth20: BreadthMeasurement | null;
  rawState: BreadthState | null; effectiveState: BreadthState | null; hysteresis: BreadthTransition;
  definition: typeof BREADTH_DEFINITION;
};
/** `observations[i]` is null when evidence for that expected session could not be obtained at
 * all (provider gap); `status: 'UNAVAILABLE'` is a resolved observation with zero directional
 * names. Both break rolling continuity identically; only a VALID observation extends it. */
export function calculateBreadthSeries(dates: readonly string[], observations: readonly (DailyBreadthObservation | null)[], bandsByHorizon: BreadthBandsByHorizon = BASELINE_BREADTH_BANDS): BreadthDay[] {
  if (dates.length !== observations.length) throw new Error('Aligned dates and observations required.');
  if (dates.some((date, i) => i > 0 && date <= dates[i - 1]!)) throw new Error('Unique chronological dates required.');
  let shares: number[] = [];
  let consecutive = 0;
  let history: BreadthHistory = { effectiveState: null, confirmation: 0 };
  return dates.map((date, i) => {
    const observation = observations[i]!;
    const isValid = observation !== null && observation.status === 'VALID';
    if (!isValid) { shares = []; consecutive = 0; }
    else { shares.push(observation.advanceShare!); shares = shares.slice(-20); consecutive++; }
    const measure = (period: number, band: BreadthBand): BreadthMeasurement | null => {
      if (consecutive < period) return null;
      const window = shares.slice(-period);
      const value = window.reduce((sum, share) => sum + share, 0) / window.length;
      return { value, state: classifyBreadthBand(value, band) };
    };
    const breadth1 = measure(1, bandsByHorizon.breadth1), breadth5 = measure(5, bandsByHorizon.breadth5), breadth20 = measure(20, bandsByHorizon.breadth20);
    const raw = breadth1 && breadth5 && breadth20 ? medianBreadthState([breadth1.state, breadth5.state, breadth20.state]) : null;
    const hysteresis = advanceBreadth(history, raw);
    history = { effectiveState: hysteresis.effectiveState, confirmation: hysteresis.confirmationAfter };
    return { date, observation, consecutiveValidSessions: consecutive, breadth1, breadth5, breadth20,
      rawState: raw, effectiveState: raw === null ? null : hysteresis.effectiveState, hysteresis, definition: BREADTH_DEFINITION };
  });
}

function mean(values: readonly number[]): number | null { return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null; }
function minMax(values: readonly number[]): { min: number | null; median: number | null; max: number | null } {
  return { min: values.length ? Math.min(...values) : null, median: median(values), max: values.length ? Math.max(...values) : null };
}
function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizeBreadth(days: readonly BreadthDay[]) {
  const withObservation = days.filter(day => day.observation !== null);
  const valid = days.filter(day => day.observation?.status === 'VALID');
  const providerGaps = days.filter(day => day.observation === null);
  const zeroDirectional = days.filter(day => day.observation?.status === 'UNAVAILABLE');
  const unavailableClassification = days.filter(day => day.effectiveState === null);
  const shares = valid.map(day => day.observation!.advanceShare!);
  const distribution = (rows: readonly BreadthDay[]) => ({ validSessions: rows.length,
    percentages: Object.fromEntries(BREADTH_STATES.map(state => [state, rows.length ? rows.filter(day => day.effectiveState === state).length / rows.length * 100 : 0])) as Record<BreadthState, number> });
  const classified = days.filter(day => day.effectiveState !== null);
  const transitions = classified.filter(day => day.hysteresis.transitioned).map(day => ({
    date: day.date, previousEffective: day.hysteresis.previousEffectiveState, raw: day.rawState, effective: day.effectiveState,
    breadth1: day.breadth1, breadth5: day.breadth5, breadth20: day.breadth20,
  }));
  const runs: { state: BreadthState; firstDate: string; lastDate: string; validSessions: number }[] = [];
  for (const day of classified) {
    const last = runs.at(-1);
    if (last?.state === day.effectiveState) { last.lastDate = day.date; last.validSessions++; }
    else runs.push({ state: day.effectiveState!, firstDate: day.date, lastDate: day.date, validSessions: 1 });
  }
  const runLengths = runs.map(run => run.validSessions);
  const universeCounts = withObservation.map(day => day.observation!.universeCount);
  const directionalCounts = withObservation.map(day => day.observation!.directionalCount);
  const excludedCounts = withObservation.map(day => day.observation!.excludedCount);
  // Simple heuristic only: flag a large day-over-day universe-size swing for manual review.
  const universeDiscontinuities = withObservation.flatMap((day, i) => {
    if (i === 0) return [];
    const previous = withObservation[i - 1]!.observation!.universeCount;
    const delta = Math.abs(day.observation!.universeCount - previous);
    return previous > 0 && delta / previous > 0.1 ? [{ date: day.date, previousUniverseCount: previous, universeCount: day.observation!.universeCount }] : [];
  });
  const byYear = Object.fromEntries([...new Set(days.map(day => day.date.slice(0, 4)))].map(year => {
    const yearValid = valid.filter(day => day.date.startsWith(year));
    const yearShares = yearValid.map(day => day.observation!.advanceShare!);
    return [year, { ...distribution(classified.filter(day => day.date.startsWith(year))),
      meanAdvanceShare: mean(yearShares), medianAdvanceShare: median(yearShares),
      transitions: transitions.filter(t => t.date.startsWith(year)).length }];
  }));
  const ranked = [...valid].sort((a, b) => b.observation!.advanceShare! - a.observation!.advanceShare!);
  const horizonEligible = days.filter(day => day.breadth1 && day.breadth5 && day.breadth20);
  const allThreeAgree = horizonEligible.filter(day => new Set([day.breadth1!.state, day.breadth5!.state, day.breadth20!.state]).size === 1).length;
  const twoOfThree = horizonEligible.filter(day => new Set([day.breadth1!.state, day.breadth5!.state, day.breadth20!.state]).size === 2).length;
  const oneDayOutlier = horizonEligible.filter(day => day.breadth5!.state === day.breadth20!.state && day.breadth1!.state !== day.breadth5!.state).length;
  return {
    availableDateRange: { first: days[0]?.date ?? null, last: days.at(-1)?.date ?? null },
    expectedSessions: days.length, validObservations: valid.length,
    unavailableObservations: days.length - valid.length, providerGaps: providerGaps.length, zeroDirectionalDays: zeroDirectional.length,
    unavailableClassificationDays: unavailableClassification.length,
    universeQuality: {
      universeCount: minMax(universeCounts), directionalCount: minMax(directionalCounts), excludedCount: minMax(excludedCounts),
      discontinuities: universeDiscontinuities,
    },
    rawDailyBreadth: { mean: mean(shares), median: median(shares),
      strongestPositive: ranked.slice(0, 10).map(day => ({ date: day.date, advanceShare: day.observation!.advanceShare, netBreadth: day.observation!.netBreadth })),
      strongestNegative: ranked.slice(-10).reverse().map(day => ({ date: day.date, advanceShare: day.observation!.advanceShare, netBreadth: day.observation!.netBreadth })) },
    effectiveStateDistribution: { ...distribution(classified), byYear },
    transitionCount: transitions.length, transitions, runCount: runs.length,
    medianRunDuration: median(runLengths), oneDayRuns: runLengths.filter(length => length === 1).length,
    twoDayOrShorterRuns: runLengths.filter(length => length <= 2).length, runs,
    horizonAgreement: horizonEligible.length ? {
      eligibleSessions: horizonEligible.length,
      allThreeAgreePct: allThreeAgree / horizonEligible.length * 100,
      twoOfThreeAgreePct: twoOfThree / horizonEligible.length * 100,
      oneDayOutlierPct: oneDayOutlier / horizonEligible.length * 100,
    } : null,
  };
}
