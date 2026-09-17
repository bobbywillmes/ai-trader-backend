/** Frozen production BREADTH_V1 classifier/aggregation/hysteresis. Pure, no persistence,
 * fetch, or trading dependencies. Deliberately self-contained: this module does not import
 * anything from the Breadth research modules (`src/dev/breadth-*`, and
 * `src/services/breadth-calculation.ts`), so a later research pass can freely change or
 * remove those without ever affecting this frozen production definition. Any future
 * threshold/aggregation/hysteresis change requires a new algorithm version, not an edit here. */

export const BREADTH_V1_ALGORITHM_VERSION = 'BREADTH_V1';
export const BREADTH_V1_EVIDENCE_SCHEMA_VERSION = 1;
export const BREADTH_V1_UNIVERSE_DEFINITION_VERSION = 'BREADTH_UNIVERSE_V1';

export const BREADTH_STATES = ['NEGATIVE', 'MIXED', 'POSITIVE'] as const;
export type BreadthState = typeof BREADTH_STATES[number];
const RANK: Record<BreadthState, number> = { NEGATIVE: 0, MIXED: 1, POSITIVE: 2 };
const rankOf = (state: BreadthState) => RANK[state];

export type BreadthV1Band = { negativeMax: number; positiveMin: number };
export const BREADTH_V1_DEFINITION = Object.freeze({
  algorithmVersion: BREADTH_V1_ALGORITHM_VERSION, evidenceSchemaVersion: BREADTH_V1_EVIDENCE_SCHEMA_VERSION,
  provider: 'MASSIVE',
  universe: 'locale=us, market=stocks, type=CS, active=true as of the assessed session date (point-in-time; Massive /v3/reference/tickers, cursor-paginated)',
  universeDefinitionVersion: BREADTH_V1_UNIVERSE_DEFINITION_VERSION,
  groupedBarsAdjustment: 'Massive /v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=true',
  horizons: Object.freeze([1, 5, 20] as const),
  bands: Object.freeze({
    breadth1: Object.freeze<BreadthV1Band>({ negativeMax: 0.44, positiveMin: 0.54 }),
    breadth5: Object.freeze<BreadthV1Band>({ negativeMax: 0.46, positiveMin: 0.52 }),
    breadth20: Object.freeze<BreadthV1Band>({ negativeMax: 0.47, positiveMin: 0.51 }),
  }),
  boundaryRule: 'value <= negativeMax -> NEGATIVE; negativeMax < value < positiveMin -> MIXED; value >= positiveMin -> POSITIVE',
  minimumConsecutiveSessions: 20,
  aggregationRule: '5d and 20d are structural breadth: identical state wins outright; opposite states -> MIXED; '
    + 'one directional + one MIXED requires 1d to confirm the same direction, otherwise MIXED; both MIXED -> MIXED. 1d never creates a directional raw state alone.',
  hysteresisRule: 'NEGATIVE < MIXED < POSITIVE. Deterioration is always immediate, moving exactly one severity level per valid '
    + 'assessment (never a two-level teleport in one step). A single ambiguous raw MIXED reading against an established POSITIVE '
    + 'effective state holds for one assessment (mildDeteriorationConfirmation) rather than deteriorating immediately; a second '
    + 'consecutive raw MIXED then confirms the drop to MIXED. A raw NEGATIVE reading is never mild: it always drops one level '
    + 'immediately with no confirmation delay. Recovery always requires two consecutive supporting valid assessments '
    + '(recoveryConfirmation) and moves exactly one level.',
  eligibilityRule: 'Point-in-time CS universe member with a valid close on the session date T and on the immediately previous '
    + 'expected session P; no backward search for an older prior close.',
});

export type Direction = 'ADVANCING' | 'DECLINING' | 'UNCHANGED';
export function classifyDirection(current: number, previous: number): Direction {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current <= 0 || previous <= 0) throw new Error('Positive finite closes required.');
  return current > previous ? 'ADVANCING' : current < previous ? 'DECLINING' : 'UNCHANGED';
}

export type DailyBreadthV1Observation = {
  status: 'VALID' | 'UNAVAILABLE';
  universeCount: number; currentBarsFound: number; priorBarsFound: number;
  eligibleCount: number; excludedCount: number;
  advancingCount: number; decliningCount: number; unchangedCount: number; directionalCount: number;
  advanceShare: number | null; netBreadth: number | null;
};
/** `universe` is the point-in-time eligible CS list for T; `current`/`prior` are grouped
 * daily close maps for T and the immediately previous expected session respectively. */
export function computeDailyBreadthV1Observation(universe: readonly string[], current: ReadonlyMap<string, number>, prior: ReadonlyMap<string, number>): DailyBreadthV1Observation {
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

export function classifyBreadthV1Band(value: number, band: BreadthV1Band): BreadthState {
  if (!Number.isFinite(value)) throw new Error('Finite advance-share value required.');
  if (value <= band.negativeMax) return 'NEGATIVE';
  if (value >= band.positiveMin) return 'POSITIVE';
  return 'MIXED';
}

/** 5d/20d are structural breadth and decide the raw state whenever they agree (directly, or
 * one directional + the other MIXED confirmed by 1d); 1d never breaks a 5d/20d tie and never
 * creates a directional raw state on its own. */
export function aggregateBreadthV1RawState(breadth1: BreadthState, breadth5: BreadthState, breadth20: BreadthState): BreadthState {
  if (breadth5 === breadth20) return breadth5;
  if (breadth5 !== 'MIXED' && breadth20 !== 'MIXED') return 'MIXED'; // opposite directional states
  const directional = breadth5 === 'MIXED' ? breadth20 : breadth5; // exactly one of the two is MIXED
  if (directional === 'POSITIVE') return breadth1 === 'POSITIVE' ? 'POSITIVE' : 'MIXED';
  return breadth1 === 'NEGATIVE' ? 'NEGATIVE' : 'MIXED';
}

export type BreadthV1History = { effectiveState: BreadthState | null; recoveryConfirmation: number; mildDeteriorationConfirmation: number };
export type BreadthV1Transition = {
  previousEffectiveState: BreadthState | null; rawState: BreadthState | null;
  recoveryConfirmationBefore: number; mildDeteriorationConfirmationBefore: number;
  recoveryConfirmationAfter: number; mildDeteriorationConfirmationAfter: number;
  effectiveState: BreadthState | null; transitioned: boolean; reason: string;
};
/** Two independent confirmation counters, never conflated. `mildDeteriorationConfirmation`
 * gates a single ambiguous raw MIXED day against an established POSITIVE effective state
 * (one day holds, two consecutive days confirm the drop to MIXED). `recoveryConfirmation`
 * gates every rise: two consecutive supporting valid assessments, exactly one level. A raw
 * NEGATIVE reading is never mild — it always drops one level immediately with no
 * confirmation, so POSITIVE -> NEGATIVE (or NEGATIVE -> POSITIVE) in a single assessment is
 * structurally impossible. */
export function advanceBreadthV1(previous: BreadthV1History, raw: BreadthState | null): BreadthV1Transition {
  if (![0, 1].includes(previous.recoveryConfirmation) || ![0, 1].includes(previous.mildDeteriorationConfirmation)
    || (previous.effectiveState === null && (previous.recoveryConfirmation !== 0 || previous.mildDeteriorationConfirmation !== 0))) {
    throw new Error('Invalid hysteresis continuation.');
  }
  const before = previous.effectiveState;
  const base: BreadthV1Transition = {
    previousEffectiveState: before, rawState: raw,
    recoveryConfirmationBefore: previous.recoveryConfirmation, mildDeteriorationConfirmationBefore: previous.mildDeteriorationConfirmation,
    recoveryConfirmationAfter: previous.recoveryConfirmation, mildDeteriorationConfirmationAfter: previous.mildDeteriorationConfirmation,
    effectiveState: before, transitioned: false, reason: '',
  };
  if (raw === null) return { ...base, reason: 'Unavailable evidence: pause both recovery and mild-deterioration confirmation.' };
  if (before === null) return { ...base, effectiveState: raw, recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, reason: `Bootstrap from first valid raw state ${raw}.` };

  if (before === 'POSITIVE') {
    if (raw === 'POSITIVE') return { ...base, recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, reason: 'Raw POSITIVE confirms effective POSITIVE; hold and reset both counters.' };
    if (raw === 'NEGATIVE') return { ...base, effectiveState: 'MIXED', recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, transitioned: true, reason: 'Raw NEGATIVE is genuine deterioration, never mild; move immediately one level to MIXED and reset both counters.' };
    if (previous.mildDeteriorationConfirmation === 1) return { ...base, effectiveState: 'MIXED', recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, transitioned: true, reason: 'Second consecutive raw MIXED confirms mild deterioration; move to MIXED and reset both counters.' };
    return { ...base, mildDeteriorationConfirmationAfter: 1, reason: 'First raw MIXED is ambiguous, not deterioration; hold POSITIVE with mild-deterioration confirmation 1/2.' };
  }
  if (before === 'MIXED') {
    if (raw === 'NEGATIVE') return { ...base, effectiveState: 'NEGATIVE', recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, transitioned: true, reason: 'Raw NEGATIVE is genuine deterioration; move immediately to NEGATIVE and reset both counters.' };
    if (raw === 'MIXED') return { ...base, recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, reason: 'Raw MIXED confirms effective MIXED; hold and reset both counters.' };
    if (previous.recoveryConfirmation === 1) return { ...base, effectiveState: 'POSITIVE', recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, transitioned: true, reason: 'Second consecutive raw POSITIVE confirms recovery; move to POSITIVE and reset both counters.' };
    return { ...base, recoveryConfirmationAfter: 1, reason: 'First raw POSITIVE supports recovery; hold MIXED with recovery confirmation 1/2.' };
  }
  // before === 'NEGATIVE'
  if (raw === 'NEGATIVE') return { ...base, recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, reason: 'Raw NEGATIVE confirms effective NEGATIVE; hold and reset both counters.' };
  if (previous.recoveryConfirmation === 1) return { ...base, effectiveState: 'MIXED', recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0, transitioned: true, reason: `Second consecutive raw ${raw} supports recovery; move exactly one level to MIXED (never further) and reset both counters.` };
  return { ...base, recoveryConfirmationAfter: 1, reason: `First raw ${raw} supports recovery; hold NEGATIVE with recovery confirmation 1/2.` };
}

export type BreadthV1Measurement = { value: number; state: BreadthState };
export type BreadthV1Day = {
  date: string; observation: DailyBreadthV1Observation | null; consecutiveValidSessions: number;
  breadth1: BreadthV1Measurement | null; breadth5: BreadthV1Measurement | null; breadth20: BreadthV1Measurement | null;
  rawState: BreadthState | null; effectiveState: BreadthState | null; hysteresis: BreadthV1Transition;
};
/** `observations[i]` is null when evidence for that expected session could not be obtained at
 * all (provider gap / no stored MarketBreadthObservation); `status: 'UNAVAILABLE'` is a
 * resolved observation with zero directional names, which in production never actually
 * occurs as a stored row (see MarketBreadthObservation's "no fake row" invariant) but is kept
 * here for symmetry with the pure observation type. Both break rolling continuity
 * identically; only a VALID observation extends it. */
export function calculateBreadthV1Series(dates: readonly string[], observations: readonly (DailyBreadthV1Observation | null)[]): BreadthV1Day[] {
  if (dates.length !== observations.length) throw new Error('Aligned dates and observations required.');
  if (dates.some((date, i) => i > 0 && date <= dates[i - 1]!)) throw new Error('Unique chronological dates required.');
  const bands = BREADTH_V1_DEFINITION.bands;
  let shares: number[] = [];
  let consecutive = 0;
  let history: BreadthV1History = { effectiveState: null, recoveryConfirmation: 0, mildDeteriorationConfirmation: 0 };
  return dates.map((date, i) => {
    const observation = observations[i]!;
    const isValid = observation !== null && observation.status === 'VALID';
    if (!isValid) { shares = []; consecutive = 0; }
    else { shares.push(observation.advanceShare!); shares = shares.slice(-20); consecutive++; }
    const measure = (period: number, band: BreadthV1Band): BreadthV1Measurement | null => {
      if (consecutive < period) return null;
      const window = shares.slice(-period);
      const value = window.reduce((sum, share) => sum + share, 0) / window.length;
      return { value, state: classifyBreadthV1Band(value, band) };
    };
    const breadth1 = measure(1, bands.breadth1), breadth5 = measure(5, bands.breadth5), breadth20 = measure(20, bands.breadth20);
    const raw = breadth1 && breadth5 && breadth20 ? aggregateBreadthV1RawState(breadth1.state, breadth5.state, breadth20.state) : null;
    const hysteresis = advanceBreadthV1(history, raw);
    history = { effectiveState: hysteresis.effectiveState, recoveryConfirmation: hysteresis.recoveryConfirmationAfter, mildDeteriorationConfirmation: hysteresis.mildDeteriorationConfirmationAfter };
    return { date, observation, consecutiveValidSessions: consecutive, breadth1, breadth5, breadth20,
      rawState: raw, effectiveState: raw === null ? null : hysteresis.effectiveState, hysteresis };
  });
}

export function rankOfBreadthV1State(state: BreadthState): number { return rankOf(state); }
