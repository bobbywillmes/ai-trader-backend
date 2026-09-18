import {
  applyMildDeteriorationConfirmation, BREADTH_STATES, CANDIDATE_STRUCTURAL_V3_BANDS,
  type BreadthDay, type BreadthState, type MildDeteriorationTransition,
} from '../services/breadth-calculation.js';
import { median } from './breadth-statistics.js';
import { runBreadthResearch, type BreadthResearchOptions, type BreadthResearchReport } from './breadth-research-runner.js';
import { meanRunLength, transitionStats } from './breadth-structural-v3-comparison.js';
import {
  assertCacheComplete, byYear, CANDIDATE_HORIZON_V2, distributionOf, longestRunByState, pct, PERIODS, periodStats, transitionCategories,
  type Distribution,
} from './breadth-threshold-comparison.js';

/** Hysteresis-only experiment: replays a new effective-state rule
 * (STRUCTURAL_V3_MILD_DETERIORATION_CONFIRMATION) over CANDIDATE_STRUCTURAL_V3's *unmodified*
 * raw-state sequence — the raw sequence is never recomputed here, only read from
 * `v3.days[].rawState` and fed straight into `applyMildDeteriorationConfirmation`, so identity
 * with STRUCTURAL_V3's raw states holds by construction, not merely by assertion. Never calls
 * Massive: all three underlying research runs (BASELINE, CANDIDATE_HORIZON_V2,
 * CANDIDATE_STRUCTURAL_V3) use `fetchFromProvider: false`. Evidence for the owner's decision,
 * not a decision, and not permission to try a fifth definition. */

export type MildDay = {
  date: string; observation: BreadthDay['observation'];
  breadth1: BreadthDay['breadth1']; breadth5: BreadthDay['breadth5']; breadth20: BreadthDay['breadth20'];
  rawState: BreadthState | null; effectiveState: BreadthState | null; hysteresis: MildDeteriorationTransition;
};

function runsOf(days: readonly MildDay[]): { state: BreadthState; validSessions: number }[] {
  const classified = days.filter(day => day.effectiveState !== null);
  const runs: { state: BreadthState; validSessions: number }[] = [];
  for (const day of classified) {
    const last = runs.at(-1);
    if (last?.state === day.effectiveState) last.validSessions++;
    else runs.push({ state: day.effectiveState!, validSessions: 1 });
  }
  return runs;
}

function transitionStatsOfMild(days: readonly MildDay[]) {
  const runs = runsOf(days);
  const runLengths = runs.map(run => run.validSessions);
  return {
    total: days.filter(day => day.hysteresis.transitioned).length, medianRun: median(runLengths), meanRun: meanRunLength(runs),
    oneDayRuns: runLengths.filter(length => length === 1).length, twoDayOrShorterRuns: runLengths.filter(length => length <= 2).length,
    longestRunByState: longestRunByState(runs), runs, ...transitionCategories(days),
  };
}

export type MildDeteriorationDiagnostic = {
  encounteredMixedFromPositive: number; firstDayHolds: number; returnedToPositiveBeforeSecondMixed: number;
  secondMixedTransitionedToMixed: number; negativeCausedImmediateDropToMixed: number;
};
function mildDeteriorationDiagnosticOf(days: readonly MildDay[]): MildDeteriorationDiagnostic {
  let encounteredMixedFromPositive = 0, firstDayHolds = 0, returnedToPositiveBeforeSecondMixed = 0, secondMixedTransitionedToMixed = 0, negativeCausedImmediateDropToMixed = 0;
  for (const day of days) {
    const h = day.hysteresis;
    if (h.previousEffectiveState === 'POSITIVE' && h.rawState === 'MIXED') {
      encounteredMixedFromPositive++;
      if (h.mildDeteriorationConfirmationBefore === 0) firstDayHolds++;
      else secondMixedTransitionedToMixed++;
    }
    if (h.previousEffectiveState === 'POSITIVE' && h.rawState === 'POSITIVE' && h.mildDeteriorationConfirmationBefore === 1) returnedToPositiveBeforeSecondMixed++;
    if (h.previousEffectiveState === 'POSITIVE' && h.rawState === 'NEGATIVE') negativeCausedImmediateDropToMixed++;
  }
  return { encounteredMixedFromPositive, firstDayHolds, returnedToPositiveBeforeSecondMixed, secondMixedTransitionedToMixed, negativeCausedImmediateDropToMixed };
}

export type NegativeResponseSpeed = {
  immediateDropCount: number; immediateDropVerified: number;
  sustainedNegativeCount: number; sustainedNegativeVerified: number;
};
function negativeResponseSpeedOf(days: readonly MildDay[]): NegativeResponseSpeed {
  let immediateDropCount = 0, immediateDropVerified = 0, sustainedNegativeCount = 0, sustainedNegativeVerified = 0;
  for (let i = 0; i < days.length; i++) {
    const h = days[i]!.hysteresis;
    if (h.previousEffectiveState === 'POSITIVE' && h.rawState === 'NEGATIVE') {
      immediateDropCount++;
      if (days[i]!.effectiveState === 'MIXED') immediateDropVerified++;
      let j = i + 1;
      while (j < days.length && days[j]!.rawState === null) j++;
      if (j < days.length && days[j]!.rawState === 'NEGATIVE') {
        sustainedNegativeCount++;
        if (days[j]!.effectiveState === 'NEGATIVE') sustainedNegativeVerified++;
      }
    }
  }
  return { immediateDropCount, immediateDropVerified, sustainedNegativeCount, sustainedNegativeVerified };
}

function changedDatesBetween(a: readonly { date: string; effectiveState: BreadthState | null }[], b: readonly { date: string; effectiveState: BreadthState | null }[]) {
  const changedDates: { date: string; from: BreadthState | null; to: BreadthState | null }[] = [];
  for (let i = 0; i < a.length; i++) {
    const dayA = a[i]!, dayB = b[i]!;
    if (dayA.date !== dayB.date) throw new Error('Misaligned comparison series.');
    if (dayA.effectiveState !== dayB.effectiveState) changedDates.push({ date: dayA.date, from: dayA.effectiveState, to: dayB.effectiveState });
  }
  const categoryCounts = new Map<string, number>();
  for (const change of changedDates) {
    const key = `${change.from ?? 'UNAVAILABLE'} -> ${change.to ?? 'UNAVAILABLE'}`;
    categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
  }
  return { changedDates, categoryCounts: [...categoryCounts.entries()].sort((x, y) => y[1] - x[1]) };
}

type RunKey = 'baseline' | 'v2' | 'v3' | 'mild';
export type BreadthMildDeteriorationComparison = {
  baseline: BreadthResearchReport; v2: BreadthResearchReport; v3: BreadthResearchReport; mildDays: readonly MildDay[];
  effectiveStateDistribution: Record<RunKey, { overall: Distribution; byYear: Record<string, Distribution> }>;
  transitions: Record<RunKey, ReturnType<typeof transitionStats> | ReturnType<typeof transitionStatsOfMild>>;
  directPositiveNegativeFlips: Record<RunKey, number>;
  mildDeteriorationDiagnostic: MildDeteriorationDiagnostic;
  negativeResponseSpeed: NegativeResponseSpeed;
  periods: { label: string; from: string; to: string; v3: ReturnType<typeof periodStats>; mild: ReturnType<typeof periodStats> }[];
  changedVsV3: ReturnType<typeof changedDatesBetween>;
};

export async function compareBreadthMildDeteriorationConfirmation(
  options: Pick<BreadthResearchOptions, 'from' | 'to' | 'db' | 'cacheDir'>,
): Promise<BreadthMildDeteriorationComparison> {
  await assertCacheComplete(options);
  const shared = { ...options, fetchFromProvider: false as const };
  const baseline = await runBreadthResearch(shared);
  const v2 = await runBreadthResearch({ ...shared, bandsByHorizon: CANDIDATE_HORIZON_V2 });
  const v3 = await runBreadthResearch({
    ...shared, bandsByHorizon: CANDIDATE_STRUCTURAL_V3_BANDS,
    aggregationOptions: { aggregationRuleId: 'STRUCTURAL_V3', deteriorationMode: 'ONE_LEVEL_PER_ASSESSMENT' },
  });
  for (const [key, report] of Object.entries({ baseline, v2, v3 })) {
    if (report.actualRequests.grouped !== 0 || report.actualRequests.universe !== 0) {
      throw new Error(`Cache-only comparison unexpectedly made a provider request for ${key}; refusing to report a result that may not have been evidence-stable.`);
    }
  }
  const evidence = (report: BreadthResearchReport) => JSON.stringify(report.days.map(day => day.observation));
  if (evidence(baseline) !== evidence(v2) || evidence(baseline) !== evidence(v3)) {
    throw new Error('Underlying observation evidence differs between runs; the comparison is not isolated to hysteresis.');
  }

  const rawStates = v3.days.map(day => day.rawState);
  const replay = applyMildDeteriorationConfirmation(rawStates);
  const mildDays: MildDay[] = v3.days.map((day, i) => ({
    date: day.date, observation: day.observation, breadth1: day.breadth1, breadth5: day.breadth5, breadth20: day.breadth20,
    rawState: day.rawState, effectiveState: replay[i]!.effectiveState, hysteresis: replay[i]!.hysteresis,
  }));

  // Section 1: raw-state identity. Holds by construction (replay consumes v3's own rawState
  // array directly) but is asserted anyway, per the research instructions, rather than trusted.
  if (JSON.stringify(mildDays.map(day => day.rawState)) !== JSON.stringify(v3.days.map(day => day.rawState))) {
    throw new Error('STRUCTURAL_V3_MILD_DETERIORATION_CONFIRMATION raw-state sequence diverged from CANDIDATE_STRUCTURAL_V3; refusing to report — this must never happen since the raw sequence is reused, not recomputed.');
  }
  // Structural invariant: every mild-variant transition moves exactly one severity level, so a
  // direct POSITIVE -> NEGATIVE (or NEGATIVE -> POSITIVE) effective transition is impossible.
  for (const day of mildDays) {
    if (day.hysteresis.transitioned && day.hysteresis.previousEffectiveState !== null && day.effectiveState !== null) {
      const delta = Math.abs(BREADTH_STATES.indexOf(day.effectiveState) - BREADTH_STATES.indexOf(day.hysteresis.previousEffectiveState));
      if (delta !== 1) throw new Error(`Mild-deterioration hysteresis produced a ${delta}-level jump on ${day.date}; this must never happen.`);
    }
  }

  const effectiveStateDistribution = {
    baseline: { overall: distributionOf(baseline.days, day => day.effectiveState), byYear: byYear(baseline.days, day => day.effectiveState) },
    v2: { overall: distributionOf(v2.days, day => day.effectiveState), byYear: byYear(v2.days, day => day.effectiveState) },
    v3: { overall: distributionOf(v3.days, day => day.effectiveState), byYear: byYear(v3.days, day => day.effectiveState) },
    mild: { overall: distributionOf(mildDays, day => day.effectiveState), byYear: byYear(mildDays, day => day.effectiveState) },
  };

  const transitions = { baseline: transitionStats(baseline), v2: transitionStats(v2), v3: transitionStats(v3), mild: transitionStatsOfMild(mildDays) };
  const directPositiveNegativeFlips = {
    baseline: transitions.baseline.categories['POSITIVE -> NEGATIVE'] ?? 0, v2: transitions.v2.categories['POSITIVE -> NEGATIVE'] ?? 0,
    v3: transitions.v3.categories['POSITIVE -> NEGATIVE'] ?? 0, mild: transitions.mild.categories['POSITIVE -> NEGATIVE'] ?? 0,
  };
  if (directPositiveNegativeFlips.mild !== 0) {
    throw new Error(`STRUCTURAL_V3_MILD_DETERIORATION_CONFIRMATION recorded ${directPositiveNegativeFlips.mild} direct POSITIVE -> NEGATIVE effective transition(s); structurally impossible and indicates an implementation defect.`);
  }

  const mildDeteriorationDiagnostic = mildDeteriorationDiagnosticOf(mildDays);
  const negativeResponseSpeed = negativeResponseSpeedOf(mildDays);
  if (negativeResponseSpeed.immediateDropVerified !== negativeResponseSpeed.immediateDropCount) {
    throw new Error('A POSITIVE-with-raw-NEGATIVE assessment did not drop to MIXED on the same assessment; genuine deterioration response-speed guarantee violated.');
  }
  if (negativeResponseSpeed.sustainedNegativeVerified !== negativeResponseSpeed.sustainedNegativeCount) {
    throw new Error('A sustained second raw NEGATIVE assessment did not reach effective NEGATIVE; genuine deterioration response-speed guarantee violated.');
  }

  const periods = PERIODS.map(period => ({
    label: period.label, from: period.from, to: period.to,
    v3: periodStats(v3.days, period.from, period.to), mild: periodStats(mildDays, period.from, period.to),
  }));

  return {
    baseline, v2, v3, mildDays, effectiveStateDistribution, transitions, directPositiveNegativeFlips,
    mildDeteriorationDiagnostic, negativeResponseSpeed, periods,
    changedVsV3: changedDatesBetween(v3.days, mildDays),
  };
}
