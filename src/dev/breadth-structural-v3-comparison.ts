import { CANDIDATE_STRUCTURAL_V3_BANDS, type BreadthDay, type BreadthState } from '../services/breadth-calculation.js';
import { runBreadthResearch, type BreadthResearchOptions, type BreadthResearchReport } from './breadth-research-runner.js';
import {
  assertCacheComplete, byYear, CANDIDATE_HORIZON_V2, distributionOf, longestRunByState, pct, PERIODS, periodStats, transitionCategories,
  type Distribution,
} from './breadth-threshold-comparison.js';

/** Compares exactly three fixed Breadth definitions against the identical cached research
 * dataset: BASELINE, CANDIDATE_HORIZON_V2 (already rejected — see breadth-threshold-comparison.md),
 * and CANDIDATE_STRUCTURAL_V3 (bands recentered near 0.49, 5d/20d-structural raw aggregation
 * with 1d confirmation-only, and one-level-per-assessment deterioration). Never calls Massive:
 * all three runs use `fetchFromProvider: false`, reading only the already-populated disk
 * cache. Evidence for the owner's decision, not a decision, and not a wider search. */

type RunKey = 'baseline' | 'v2' | 'v3';
function distributionByYear(days: readonly BreadthDay[], pick: (day: BreadthDay) => BreadthState | null): { overall: Distribution; byYear: Record<string, Distribution> } {
  return { overall: distributionOf(days, pick), byYear: byYear(days, pick) };
}

function meanRunLength(runs: readonly { validSessions: number }[]): number | null {
  return runs.length ? runs.reduce((sum, run) => sum + run.validSessions, 0) / runs.length : null;
}

function transitionStats(report: BreadthResearchReport) {
  return {
    total: report.summary.transitionCount, medianRun: report.summary.medianRunDuration, meanRun: meanRunLength(report.summary.runs),
    oneDayRuns: report.summary.oneDayRuns, twoDayOrShorterRuns: report.summary.twoDayOrShorterRuns,
    longestRunByState: longestRunByState(report.summary.runs), ...transitionCategories(report.days),
  };
}

function changedDatesBetween(a: BreadthResearchReport, b: BreadthResearchReport) {
  const changedDates: { date: string; from: BreadthState | null; to: BreadthState | null }[] = [];
  for (let i = 0; i < a.days.length; i++) {
    const dayA = a.days[i]!, dayB = b.days[i]!;
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

export type StructuralAgreementV3 = {
  eligibleSessions: number;
  bothPositivePct: number; bothNegativePct: number; bothMixedPct: number; oppositePct: number; oneDirectionalOneMixedPct: number;
  oneDirectionalOneMixedSessions: number; confirmedByOneDay: number; notConfirmedByOneDay: number; confirmedByOneDayPct: number;
};
function structuralAgreementOf(days: readonly BreadthDay[]): StructuralAgreementV3 {
  const eligible = days.filter(day => day.breadth1 && day.breadth5 && day.breadth20);
  let bothPositive = 0, bothNegative = 0, bothMixed = 0, opposite = 0, oneDirectionalOneMixed = 0, confirmedByOneDay = 0, notConfirmedByOneDay = 0;
  for (const day of eligible) {
    const b5 = day.breadth5!.state, b20 = day.breadth20!.state, b1 = day.breadth1!.state;
    if (b5 === b20) {
      if (b5 === 'POSITIVE') bothPositive++;
      else if (b5 === 'NEGATIVE') bothNegative++;
      else bothMixed++;
    } else if (b5 !== 'MIXED' && b20 !== 'MIXED') {
      opposite++;
    } else {
      oneDirectionalOneMixed++;
      const directional = b5 === 'MIXED' ? b20 : b5;
      if (b1 === directional) confirmedByOneDay++; else notConfirmedByOneDay++;
    }
  }
  const n = eligible.length;
  return {
    eligibleSessions: n,
    bothPositivePct: pct(bothPositive, n), bothNegativePct: pct(bothNegative, n), bothMixedPct: pct(bothMixed, n),
    oppositePct: pct(opposite, n), oneDirectionalOneMixedPct: pct(oneDirectionalOneMixed, n),
    oneDirectionalOneMixedSessions: oneDirectionalOneMixed, confirmedByOneDay, notConfirmedByOneDay,
    confirmedByOneDayPct: pct(confirmedByOneDay, oneDirectionalOneMixed),
  };
}

export type BreadthStructuralV3Comparison = {
  baseline: BreadthResearchReport; v2: BreadthResearchReport; v3: BreadthResearchReport;
  rawHorizonDistributionV3: Record<'breadth1' | 'breadth5' | 'breadth20', { overall: Distribution; byYear: Record<string, Distribution> }>;
  rawAggregateDistribution: Record<RunKey, { overall: Distribution; byYear: Record<string, Distribution> }>;
  effectiveStateDistribution: Record<RunKey, { overall: Distribution; byYear: Record<string, Distribution> }>;
  transitions: Record<RunKey, ReturnType<typeof transitionStats>>;
  directPositiveNegativeFlips: Record<RunKey, number>;
  structuralAgreementV3: StructuralAgreementV3;
  periods: { label: string; from: string; to: string; baseline: ReturnType<typeof periodStats>; v2: ReturnType<typeof periodStats>; v3: ReturnType<typeof periodStats> }[];
  changedVsBaseline: ReturnType<typeof changedDatesBetween>;
  changedVsV2: ReturnType<typeof changedDatesBetween>;
  strongestDailyUnchanged: boolean;
};

export async function compareBreadthStructuralV3(
  options: Pick<BreadthResearchOptions, 'from' | 'to' | 'db' | 'cacheDir'>,
): Promise<BreadthStructuralV3Comparison> {
  await assertCacheComplete(options);
  const shared = { ...options, fetchFromProvider: false as const };
  const baseline = await runBreadthResearch(shared);
  const v2 = await runBreadthResearch({ ...shared, bandsByHorizon: CANDIDATE_HORIZON_V2 });
  const v3 = await runBreadthResearch({
    ...shared, bandsByHorizon: CANDIDATE_STRUCTURAL_V3_BANDS,
    aggregationOptions: { aggregationRuleId: 'STRUCTURAL_V3', deteriorationMode: 'ONE_LEVEL_PER_ASSESSMENT' },
  });
  const reports = { baseline, v2, v3 };
  for (const [key, report] of Object.entries(reports)) {
    if (report.actualRequests.grouped !== 0 || report.actualRequests.universe !== 0) {
      throw new Error(`Cache-only comparison unexpectedly made a provider request for ${key}; refusing to report a result that may not have been evidence-stable.`);
    }
  }
  const evidence = (report: BreadthResearchReport) => JSON.stringify(report.days.map(day => day.observation));
  if (evidence(baseline) !== evidence(v2) || evidence(baseline) !== evidence(v3)) {
    throw new Error('Underlying observation evidence differs between runs; the comparison is not isolated to classification/aggregation/hysteresis.');
  }

  const horizonKeys = ['breadth1', 'breadth5', 'breadth20'] as const;
  const rawHorizonDistributionV3 = Object.fromEntries(horizonKeys.map(key => [key, distributionByYear(v3.days, day => day[key]?.state ?? null)])) as BreadthStructuralV3Comparison['rawHorizonDistributionV3'];

  const rawAggregateDistribution = Object.fromEntries((['baseline', 'v2', 'v3'] as const).map(key => [key, distributionByYear(reports[key].days, day => day.rawState)])) as BreadthStructuralV3Comparison['rawAggregateDistribution'];
  const effectiveStateDistribution = Object.fromEntries((['baseline', 'v2', 'v3'] as const).map(key => [key, distributionByYear(reports[key].days, day => day.effectiveState)])) as BreadthStructuralV3Comparison['effectiveStateDistribution'];
  const transitions = Object.fromEntries((['baseline', 'v2', 'v3'] as const).map(key => [key, transitionStats(reports[key])])) as BreadthStructuralV3Comparison['transitions'];
  const directPositiveNegativeFlips = Object.fromEntries((['baseline', 'v2', 'v3'] as const).map(key => [key, transitions[key].categories['POSITIVE -> NEGATIVE'] ?? 0])) as BreadthStructuralV3Comparison['directPositiveNegativeFlips'];
  if (directPositiveNegativeFlips.v3 !== 0) {
    throw new Error(`CANDIDATE_STRUCTURAL_V3 recorded ${directPositiveNegativeFlips.v3} direct POSITIVE -> NEGATIVE effective transition(s); this is structurally impossible under one-level-per-assessment deterioration and indicates an implementation defect.`);
  }

  const structuralAgreementV3 = structuralAgreementOf(v3.days);

  const periods = PERIODS.map(period => ({
    label: period.label, from: period.from, to: period.to,
    baseline: periodStats(baseline.days, period.from, period.to), v2: periodStats(v2.days, period.from, period.to), v3: periodStats(v3.days, period.from, period.to),
  }));

  const strongestDailyUnchanged = [v2, v3].every(report =>
    JSON.stringify(baseline.summary.rawDailyBreadth.strongestPositive) === JSON.stringify(report.summary.rawDailyBreadth.strongestPositive)
    && JSON.stringify(baseline.summary.rawDailyBreadth.strongestNegative) === JSON.stringify(report.summary.rawDailyBreadth.strongestNegative));

  return {
    baseline, v2, v3, rawHorizonDistributionV3, rawAggregateDistribution, effectiveStateDistribution, transitions,
    directPositiveNegativeFlips, structuralAgreementV3, periods,
    changedVsBaseline: changedDatesBetween(baseline, v3), changedVsV2: changedDatesBetween(v2, v3),
    strongestDailyUnchanged,
  };
}
