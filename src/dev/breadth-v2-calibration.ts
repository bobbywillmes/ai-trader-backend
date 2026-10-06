import { BREADTH_STATES, advanceBreadth, type BreadthState } from '../services/breadth-calculation.js';
import { aggregateBreadthV2Structural, classifyBreadthV2Share, replayBreadthV2MildConfirmation } from '../services/breadth-v2.definition.js';
import { mean, median, pearsonCorrelation, percentile } from './breadth-statistics.js';
import { HORIZONS, type BreadthCounts } from './breadth-v2-calculation.js';

export const BREADTH_V2_CALIBRATION_VERSION = 'BREADTH_V2_CALIBRATION_5B_V1';
export const THRESHOLD_FAMILIES = { QUARTILE: [0.25, 0.75], TERTILE: [1 / 3, 2 / 3], NARROW: [0.4, 0.6] } as const;
export const HYSTERESIS_VARIANTS = ['RAW', 'ASYMMETRIC_ONE_LEVEL', 'MILD_POSITIVE_MIXED_CONFIRMATION'] as const;
export type Family = keyof typeof THRESHOLD_FAMILIES;
export type Variant = typeof HYSTERESIS_VARIANTS[number];
export type HorizonName = `DAY_${typeof HORIZONS[number]}`;
export type Metric = { sessionDate: string; horizon: HorizonName } & BreadthCounts;
export type Band = { lower: number; upper: number; lowerPercentile: number; upperPercentile: number };
export type Bands = Record<Family, Record<HorizonName, Band>>;
export type CandidateDay = { sessionDate: string; family: Family; variant: Variant; values: Record<HorizonName, number | null>; horizonStates: Record<HorizonName, BreadthState | null>; rawState: BreadthState | null; effectiveState: BreadthState | null; transition: string | null };
const horizonNames = HORIZONS.map(h => `DAY_${h}` as HorizonName);
const families = Object.keys(THRESHOLD_FAMILIES) as Family[];
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function deriveBands(metrics: readonly Metric[], calibrationThrough: string): Bands {
  return Object.fromEntries(families.map(family => [family, Object.fromEntries(horizonNames.map(horizon => {
    const values = metrics.filter(row => row.horizon === horizon && row.sessionDate <= calibrationThrough && row.advanceShare !== null).map(row => row.advanceShare!).sort((a, b) => a - b);
    if (!values.length) throw new Error(`No calibration advanceShare evidence for ${horizon}.`);
    const [lowerPercentile, upperPercentile] = THRESHOLD_FAMILIES[family];
    const lower = percentile(values, lowerPercentile)!, upper = percentile(values, upperPercentile)!;
    if (lower >= upper) throw new Error(`Calibration ${family} ${horizon} bands overlap; more diverse calibration evidence is required.`);
    return [horizon, { lower, upper, lowerPercentile, upperPercentile }];
  }))])) as Bands;
}

export function classifyShare(value: number | null, band: Band): BreadthState | null {
  return classifyBreadthV2Share(value, band);
}

export function validationPercentile(sortedValues: readonly number[], threshold: number): number | null {
  if (!sortedValues.length) return null;
  let below = 0, equal = 0;
  for (const value of sortedValues) { if (value < threshold) below++; else if (value === threshold) equal++; }
  return (below + equal / 2) / sortedValues.length;
}

export function buildCandidateDays(metrics: readonly Metric[], bands: Bands): CandidateDay[] {
  const byDate = new Map<string, Map<HorizonName, Metric>>();
  for (const metric of metrics) {
    const row = byDate.get(metric.sessionDate) ?? new Map<HorizonName, Metric>();
    if (row.has(metric.horizon)) throw new Error('Duplicate horizon metric.');
    row.set(metric.horizon, metric); byDate.set(metric.sessionDate, row);
  }
  const dates = [...byDate.keys()].sort(compareText);
  for (const date of dates) if (byDate.get(date)!.size !== HORIZONS.length) throw new Error(`Incomplete horizon metrics for ${date}.`);
  const result: CandidateDay[] = [];
  for (const family of families) {
    const base = dates.map(sessionDate => {
      const metricsForDate = byDate.get(sessionDate)!;
      const values = Object.fromEntries(horizonNames.map(h => [h, metricsForDate.get(h)!.advanceShare])) as Record<HorizonName, number | null>;
      const horizonStates = Object.fromEntries(horizonNames.map(h => [h, classifyShare(values[h], bands[family][h])])) as Record<HorizonName, BreadthState | null>;
      const rawState = aggregateBreadthV2Structural(horizonStates.DAY_1, horizonStates.DAY_5, horizonStates.DAY_20);
      return { sessionDate, values, horizonStates, rawState };
    });
    for (const variant of HYSTERESIS_VARIANTS) {
      let history: { effectiveState: BreadthState | null; confirmation: number } = { effectiveState: null, confirmation: 0 };
      const mild = variant === 'MILD_POSITIVE_MIXED_CONFIRMATION' ? replayBreadthV2MildConfirmation(base.map(row => row.rawState)) : null;
      for (let i = 0; i < base.length; i++) {
        const row = base[i]!;
        const previous: BreadthState | null = history.effectiveState;
        let effectiveState: BreadthState | null;
        if (variant === 'RAW') effectiveState = row.rawState;
        else if (mild) effectiveState = mild[i]!.effectiveState;
        else {
          const advanced = advanceBreadth(history, row.rawState, { deteriorationMode: 'ONE_LEVEL_PER_ASSESSMENT' });
          history = { effectiveState: advanced.effectiveState, confirmation: advanced.confirmationAfter };
          effectiveState = row.rawState === null ? null : advanced.effectiveState;
        }
        const transition = previous !== null && effectiveState !== null && previous !== effectiveState ? `${previous} -> ${effectiveState}` : null;
        if (variant === 'RAW' || mild) history = { effectiveState: mild ? mild[i]!.hysteresis.effectiveState : effectiveState, confirmation: 0 };
        if (variant !== 'RAW' && transition && Math.abs(BREADTH_STATES.indexOf(previous!) - BREADTH_STATES.indexOf(effectiveState!)) !== 1) throw new Error('Smoothed breadth jumped two levels.');
        result.push({ ...row, family, variant, effectiveState, transition });
      }
    }
  }
  return result.sort((a, b) => compareText(a.sessionDate, b.sessionDate) || compareText(a.family, b.family) || compareText(a.variant, b.variant));
}

export function periodSummary(days: readonly CandidateDay[]) {
  const distribution = (pick: (day: CandidateDay) => BreadthState | null) => Object.fromEntries([...BREADTH_STATES, 'UNAVAILABLE'].map(state => [state, days.filter(day => (pick(day) ?? 'UNAVAILABLE') === state).length]));
  const horizonDistributions = Object.fromEntries(horizonNames.map(h => [h, distribution(day => day.horizonStates[h])]));
  const rawDistribution = distribution(day => day.rawState), effectiveDistribution = distribution(day => day.effectiveState);
  const transitions = Object.fromEntries([...new Set(days.map(day => day.transition).filter((value): value is string => value !== null))].sort(compareText).map(category => [category, days.filter(day => day.transition === category).length]));
  const runs: { state: BreadthState; fromSession: string; throughSession: string; lengthSessions: number }[] = [];
  for (const day of days) {
    if (day.effectiveState === null) continue;
    const last = runs.at(-1);
    if (last?.state === day.effectiveState) { last.throughSession = day.sessionDate; last.lengthSessions++; }
    else runs.push({ state: day.effectiveState, fromSession: day.sessionDate, throughSession: day.sessionDate, lengthSessions: 1 });
  }
  const lengths = runs.map(run => run.lengthSessions);
  const agreement = { bothPositive: 0, bothNegative: 0, bothMixed: 0, oppositeDirectional: 0, oneDirectionalOneMixed: 0, confirmedByDay1: 0 };
  for (const day of days) {
    const one = day.horizonStates.DAY_1, five = day.horizonStates.DAY_5, twenty = day.horizonStates.DAY_20;
    if (one === null || five === null || twenty === null) continue;
    if (five === twenty) { if (five === 'POSITIVE') agreement.bothPositive++; else if (five === 'NEGATIVE') agreement.bothNegative++; else agreement.bothMixed++; }
    else if (five !== 'MIXED' && twenty !== 'MIXED') agreement.oppositeDirectional++;
    else { agreement.oneDirectionalOneMixed++; if (one === (five === 'MIXED' ? twenty : five)) agreement.confirmedByDay1++; }
  }
  return { sessions: days.length, horizonDistributions, rawDistribution, effectiveDistribution, transitionCount: days.filter(day => day.transition !== null).length, transitionCategories: transitions,
    oneSessionRuns: lengths.filter(n => n === 1).length, atMostTwoSessionRuns: lengths.filter(n => n <= 2).length, medianRunDuration: median(lengths), meanRunDuration: mean(lengths),
    longestRunByState: Object.fromEntries(BREADTH_STATES.map(state => [state, Math.max(0, ...runs.filter(run => run.state === state).map(run => run.lengthSessions))])),
    directTwoLevelFlips: (transitions['POSITIVE -> NEGATIVE'] ?? 0) + (transitions['NEGATIVE -> POSITIVE'] ?? 0),
    unavailableStateSessions: days.filter(day => day.rawState === null).length,
    effectiveDiffersFromRawPercent: days.length ? 100 * days.filter(day => day.rawState !== null && day.effectiveState !== day.rawState).length / days.length : null,
    structuralAgreement: agreement, runs };
}

export function coverageDiagnostics(metrics: readonly Metric[]) {
  return Object.fromEntries(horizonNames.map(h => {
    const sorted = metrics.filter(row => row.horizon === h && row.coverageRatio !== null).map(row => row.coverageRatio!).sort((a, b) => a - b);
    return [h, { count: sorted.length, min: sorted[0] ?? null, p01: percentile(sorted, 0.01), p05: percentile(sorted, 0.05), p10: percentile(sorted, 0.10), p25: percentile(sorted, 0.25), median: percentile(sorted, 0.5), below75: sorted.filter(v => v < 0.75).length, below80: sorted.filter(v => v < 0.8).length, below85: sorted.filter(v => v < 0.85).length, below90: sorted.filter(v => v < 0.9).length }];
  }));
}

export function sensitivity(full: readonly Metric[], core: readonly Metric[], fullDays: readonly CandidateDay[], coreDays: readonly CandidateDay[]) {
  if (full.length !== core.length) throw new Error('Stable-core metrics are misaligned.');
  const byHorizon = Object.fromEntries(horizonNames.map(h => {
    const fullRows = full.filter(row => row.horizon === h), coreRows = core.filter(row => row.horizon === h);
    const pairs = fullRows.map((row, i) => [row, coreRows[i]!] as const).filter(([a, b]) => a.sessionDate === b.sessionDate && a.advanceShare !== null && b.advanceShare !== null);
    const xs = pairs.map(([a]) => a.advanceShare!), ys = pairs.map(([, b]) => b.advanceShare!);
    const ranked = pairs.map(([a, b]) => ({ sessionDate: a.sessionDate, absoluteDifference: Math.abs(a.advanceShare! - b.advanceShare!) })).sort((a, b) => b.absoluteDifference - a.absoluteDifference || compareText(a.sessionDate, b.sessionDate));
    return [h, { pairedSessions: pairs.length, meanFullEligibleCount: mean(fullRows.map(row => row.eligibleCount)), meanStableCoreEligibleCount: mean(coreRows.map(row => row.eligibleCount)), pearsonCorrelation: pearsonCorrelation(xs, ys), meanAbsoluteDifference: mean(ranked.map(row => row.absoluteDifference)), medianAbsoluteDifference: median(ranked.map(row => row.absoluteDifference)), maximumAbsoluteDifference: ranked[0] ?? null }];
  }));
  if (fullDays.length !== coreDays.length) throw new Error('Stable-core candidate days are misaligned.');
  const disagreements = Object.fromEntries(families.map(family => {
    const pairs = fullDays.map((day, i) => [day, coreDays[i]!] as const).filter(([a, b]) => a.family === family && a.variant === 'RAW' && a.sessionDate === b.sessionDate && a.family === b.family && a.variant === b.variant);
    return [family, { horizonStateDisagreementRate: Object.fromEntries(horizonNames.map(h => [h, pairs.length ? pairs.filter(([a, b]) => a.horizonStates[h] !== b.horizonStates[h]).length / pairs.length : null])), rawStructuralStateDisagreementRate: pairs.length ? pairs.filter(([a, b]) => a.rawState !== b.rawState).length / pairs.length : null }];
  }));
  return { byHorizon, disagreements };
}

export function validationStability(metrics: readonly Metric[], bands: Bands, calibrationThrough: string) {
  return families.flatMap(family => horizonNames.map(horizon => {
    const values = metrics.filter(row => row.horizon === horizon && row.sessionDate > calibrationThrough && row.advanceShare !== null).map(row => row.advanceShare!).sort((a, b) => a - b);
    const band = bands[family][horizon];
    return { family, horizon, validationSampleCount: values.length, lowerThreshold: band.lower, calibrationLowerPercentile: band.lowerPercentile, validationLowerPercentile: validationPercentile(values, band.lower), upperThreshold: band.upper, calibrationUpperPercentile: band.upperPercentile, validationUpperPercentile: validationPercentile(values, band.upper) };
  }));
}
