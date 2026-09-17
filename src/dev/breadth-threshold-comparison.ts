import { BREADTH_STATES, type BreadthBandsByHorizon, type BreadthDay, type BreadthState } from '../services/breadth-calculation.js';
import { estimateBreadthResearch, runBreadthResearch, type BreadthResearchOptions, type BreadthResearchReport } from './breadth-research-runner.js';

/** A single controlled comparison against the already-cached BREADTH research dataset.
 * Never calls Massive: both runs use `fetchFromProvider: false`, reading only the local
 * disk cache populated by the prior full research pass. Only the classification bands
 * differ between the two runs; every other Breadth semantic (universe, observation,
 * warm-up, median-of-three, hysteresis) is exercised identically because both runs share
 * the exact same underlying `days[].observation` evidence. */
export const CANDIDATE_HORIZON_V2: BreadthBandsByHorizon = Object.freeze({
  breadth1: Object.freeze({ negativeMax: 0.45, positiveMin: 0.55 }),
  breadth5: Object.freeze({ negativeMax: 0.47, positiveMin: 0.53 }),
  breadth20: Object.freeze({ negativeMax: 0.48, positiveMin: 0.52 }),
});

export class MissingCacheError extends Error {
  constructor(public readonly missingGroupedDates: readonly string[], public readonly missingUniverseDates: readonly string[]) {
    super(`Required cached Breadth evidence is missing (never fetched): ${missingGroupedDates.length} grouped date(s), ${missingUniverseDates.length} universe date(s). Run 'npm run research:breadth -- --fetch' first; this comparison never calls Massive itself.`);
    this.name = 'MissingCacheError';
  }
}

/** Fails closed rather than silently falling back to a provider fetch. */
export async function assertCacheComplete(options: Pick<BreadthResearchOptions, 'from' | 'to' | 'db' | 'cacheDir'>): Promise<void> {
  const estimate = await estimateBreadthResearch(options);
  if (estimate.missingGroupedDates.length || estimate.missingUniverseDates.length) {
    throw new MissingCacheError(estimate.missingGroupedDates, estimate.missingUniverseDates);
  }
}

export const pct = (count: number, total: number): number => total ? count / total * 100 : 0;
export type Distribution = { sessions: number; percentages: Record<BreadthState, number> };
/** Generic over the day-record shape (not just `BreadthDay`) so the same comparison
 * machinery can be reused for hysteresis-only variants that replay a different effective
 * state over the identical `rawState` sequence — see breadth-mild-deterioration-comparison.ts. */
export function distributionOf<T>(days: readonly T[], pick: (day: T) => BreadthState | null): Distribution {
  const withState = days.filter(day => pick(day) !== null);
  const counts: Record<BreadthState, number> = { NEGATIVE: 0, MIXED: 0, POSITIVE: 0 };
  for (const day of withState) counts[pick(day)!]++;
  return { sessions: withState.length, percentages: {
    NEGATIVE: pct(counts.NEGATIVE, withState.length), MIXED: pct(counts.MIXED, withState.length), POSITIVE: pct(counts.POSITIVE, withState.length),
  } };
}
export function byYear<T extends { date: string }>(days: readonly T[], pick: (day: T) => BreadthState | null): Record<string, Distribution> {
  const years = [...new Set(days.map(day => day.date.slice(0, 4)))].sort();
  return Object.fromEntries(years.map(year => [year, distributionOf(days.filter(day => day.date.startsWith(year)), pick)]));
}
export function transitionCategories<T extends { hysteresis: { transitioned: boolean; previousEffectiveState: BreadthState | null }; effectiveState: BreadthState | null }>(
  days: readonly T[],
): { categories: Record<string, number>; deteriorationCount: number; recoveryCount: number } {
  const categories: Record<string, number> = {};
  let deteriorationCount = 0, recoveryCount = 0;
  for (const day of days) {
    if (!day.hysteresis.transitioned || day.hysteresis.previousEffectiveState === null || day.effectiveState === null) continue;
    const key = `${day.hysteresis.previousEffectiveState} -> ${day.effectiveState}`;
    categories[key] = (categories[key] ?? 0) + 1;
    if (BREADTH_STATES.indexOf(day.effectiveState) < BREADTH_STATES.indexOf(day.hysteresis.previousEffectiveState)) deteriorationCount++;
    else recoveryCount++;
  }
  return { categories, deteriorationCount, recoveryCount };
}
export function longestRunByState(runs: readonly { state: BreadthState; validSessions: number }[]): Record<BreadthState, number> {
  const longest: Record<BreadthState, number> = { NEGATIVE: 0, MIXED: 0, POSITIVE: 0 };
  for (const run of runs) longest[run.state] = Math.max(longest[run.state], run.validSessions);
  return longest;
}
export function periodStats<T extends {
  date: string; effectiveState: BreadthState | null; hysteresis: { transitioned: boolean };
  breadth1: { state: BreadthState } | null; breadth5: { state: BreadthState } | null; breadth20: { state: BreadthState } | null;
}>(days: readonly T[], from: string, to: string) {
  const scoped = days.filter(day => day.date >= from && day.date <= to);
  return { ...distributionOf(scoped, day => day.effectiveState), transitions: scoped.filter(day => day.hysteresis.transitioned).length,
    breadth1: distributionOf(scoped, day => day.breadth1?.state ?? null), breadth5: distributionOf(scoped, day => day.breadth5?.state ?? null),
    breadth20: distributionOf(scoped, day => day.breadth20?.state ?? null) };
}
export const PERIODS: { label: string; from: string; to: string }[] = [
  { label: '2022', from: '2022-01-01', to: '2022-12-31' },
  { label: '2023', from: '2023-01-01', to: '2023-12-31' },
  { label: '2024', from: '2024-01-01', to: '2024-12-31' },
  { label: '2025-04-01..2025-05-15', from: '2025-04-01', to: '2025-05-15' },
];

export type BreadthThresholdComparison = {
  baseline: BreadthResearchReport; candidate: BreadthResearchReport;
  effectiveStateDistribution: { baseline: Distribution; candidate: Distribution; baselineByYear: Record<string, Distribution>; candidateByYear: Record<string, Distribution> };
  rawHorizonDistribution: Record<'breadth1' | 'breadth5' | 'breadth20', { baseline: Distribution; candidate: Distribution; baselineByYear: Record<string, Distribution>; candidateByYear: Record<string, Distribution> }>;
  horizonAgreement: {
    baseline: NonNullable<BreadthResearchReport['summary']['horizonAgreement']>; candidate: NonNullable<BreadthResearchReport['summary']['horizonAgreement']>;
    fiveTwentyAgreePct: { baseline: number; candidate: number };
    bothFiveTwenty: Record<BreadthState, { baseline: number; candidate: number }>;
  };
  transitions: {
    baseline: { total: number; medianRun: number | null; oneDayRuns: number; twoDayOrShorterRuns: number; longestRunByState: Record<BreadthState, number>; deteriorationCount: number; recoveryCount: number; categories: Record<string, number> };
    candidate: { total: number; medianRun: number | null; oneDayRuns: number; twoDayOrShorterRuns: number; longestRunByState: Record<BreadthState, number>; deteriorationCount: number; recoveryCount: number; categories: Record<string, number> };
  };
  periods: { label: string; from: string; to: string; baseline: ReturnType<typeof periodStats>; candidate: ReturnType<typeof periodStats> }[];
  strongestDailyUnchanged: boolean;
  changedDates: { date: string; from: BreadthState | null; to: BreadthState | null }[];
  changedDateCategoryCounts: [string, number][];
};

export async function compareBreadthThresholds(options: Pick<BreadthResearchOptions, 'from' | 'to' | 'db' | 'cacheDir'>): Promise<BreadthThresholdComparison> {
  await assertCacheComplete(options);
  const shared = { ...options, fetchFromProvider: false as const };
  const baseline = await runBreadthResearch(shared);
  const candidate = await runBreadthResearch({ ...shared, bandsByHorizon: CANDIDATE_HORIZON_V2 });
  if (baseline.actualRequests.grouped !== 0 || baseline.actualRequests.universe !== 0 || candidate.actualRequests.grouped !== 0 || candidate.actualRequests.universe !== 0) {
    throw new Error('Cache-only comparison unexpectedly made a provider request; refusing to report a result that may not have been evidence-stable.');
  }
  if (JSON.stringify(baseline.days.map(day => day.observation)) !== JSON.stringify(candidate.days.map(day => day.observation))) {
    throw new Error('Underlying observation evidence differs between runs; the comparison is not isolated to thresholds.');
  }

  const horizonKeys = ['breadth1', 'breadth5', 'breadth20'] as const;
  const rawHorizonDistribution = Object.fromEntries(horizonKeys.map(key => [key, {
    baseline: distributionOf(baseline.days, day => day[key]?.state ?? null), candidate: distributionOf(candidate.days, day => day[key]?.state ?? null),
    baselineByYear: byYear(baseline.days, day => day[key]?.state ?? null), candidateByYear: byYear(candidate.days, day => day[key]?.state ?? null),
  }])) as BreadthThresholdComparison['rawHorizonDistribution'];

  const fiveTwentyEligible = { baseline: baseline.days.filter(day => day.breadth5 && day.breadth20), candidate: candidate.days.filter(day => day.breadth5 && day.breadth20) };
  const fiveTwentyAgree = (days: readonly BreadthDay[]) => pct(days.filter(day => day.breadth5!.state === day.breadth20!.state).length, days.length);
  const bothFiveTwenty = Object.fromEntries(BREADTH_STATES.map(state => [state, {
    baseline: pct(fiveTwentyEligible.baseline.filter(day => day.breadth5!.state === state && day.breadth20!.state === state).length, fiveTwentyEligible.baseline.length),
    candidate: pct(fiveTwentyEligible.candidate.filter(day => day.breadth5!.state === state && day.breadth20!.state === state).length, fiveTwentyEligible.candidate.length),
  }])) as Record<BreadthState, { baseline: number; candidate: number }>;

  const baselineTransitions = transitionCategories(baseline.days);
  const candidateTransitions = transitionCategories(candidate.days);

  const strongestDailyUnchanged = JSON.stringify(baseline.summary.rawDailyBreadth.strongestPositive) === JSON.stringify(candidate.summary.rawDailyBreadth.strongestPositive)
    && JSON.stringify(baseline.summary.rawDailyBreadth.strongestNegative) === JSON.stringify(candidate.summary.rawDailyBreadth.strongestNegative);

  const changedDates: BreadthThresholdComparison['changedDates'] = [];
  for (let i = 0; i < baseline.days.length; i++) {
    const b = baseline.days[i]!, c = candidate.days[i]!;
    if (b.date !== c.date) throw new Error('Misaligned comparison series.');
    if (b.effectiveState !== c.effectiveState) changedDates.push({ date: b.date, from: b.effectiveState, to: c.effectiveState });
  }
  const changedDateCategoryCounts = new Map<string, number>();
  for (const change of changedDates) {
    const key = `${change.from ?? 'UNAVAILABLE'} -> ${change.to ?? 'UNAVAILABLE'}`;
    changedDateCategoryCounts.set(key, (changedDateCategoryCounts.get(key) ?? 0) + 1);
  }

  return {
    baseline, candidate,
    effectiveStateDistribution: {
      baseline: distributionOf(baseline.days, day => day.effectiveState), candidate: distributionOf(candidate.days, day => day.effectiveState),
      baselineByYear: byYear(baseline.days, day => day.effectiveState), candidateByYear: byYear(candidate.days, day => day.effectiveState),
    },
    rawHorizonDistribution,
    horizonAgreement: {
      baseline: baseline.summary.horizonAgreement!, candidate: candidate.summary.horizonAgreement!,
      fiveTwentyAgreePct: { baseline: fiveTwentyAgree(fiveTwentyEligible.baseline), candidate: fiveTwentyAgree(fiveTwentyEligible.candidate) },
      bothFiveTwenty,
    },
    transitions: {
      baseline: { total: baseline.summary.transitionCount, medianRun: baseline.summary.medianRunDuration, oneDayRuns: baseline.summary.oneDayRuns,
        twoDayOrShorterRuns: baseline.summary.twoDayOrShorterRuns, longestRunByState: longestRunByState(baseline.summary.runs), ...baselineTransitions },
      candidate: { total: candidate.summary.transitionCount, medianRun: candidate.summary.medianRunDuration, oneDayRuns: candidate.summary.oneDayRuns,
        twoDayOrShorterRuns: candidate.summary.twoDayOrShorterRuns, longestRunByState: longestRunByState(candidate.summary.runs), ...candidateTransitions },
    },
    periods: PERIODS.map(period => ({ ...period, baseline: periodStats(baseline.days, period.from, period.to), candidate: periodStats(candidate.days, period.from, period.to) })),
    strongestDailyUnchanged, changedDates, changedDateCategoryCounts: [...changedDateCategoryCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}
