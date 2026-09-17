import type { BreadthDay } from '../services/breadth-calculation.js';
import { assertCacheComplete, PERIODS } from './breadth-threshold-comparison.js';
import { runBreadthResearch, type BreadthResearchOptions } from './breadth-research-runner.js';
import { describe, iqr, meanAbsDiff, pearsonCorrelation, STATISTICS_CONVENTION, type Distribution } from './breadth-statistics.js';

/** Descriptive-only diagnostic: are breadth1/breadth5/breadth20 actually centered near 0.50,
 * or does one or more horizon carry a persistent directional offset? Reuses the already
 * cached, already-computed Breadth measurements (`day.breadth{1,5,20}.value`) from
 * `runBreadthResearch` rather than duplicating any classifier or observation logic. Never
 * calls Massive: `runBreadthResearch` is invoked with `fetchFromProvider: false`, and this
 * module asserts the resulting `actualRequests` are exactly zero before reporting anything.
 * Proposes and selects nothing: no thresholds, no classifier, no BREADTH_V1 decision. */

export type HorizonKey = 'breadth1' | 'breadth5' | 'breadth20';
export const HORIZON_KEYS: readonly HorizonKey[] = ['breadth1', 'breadth5', 'breadth20'];

export type CenteringDiagnostic = {
  meanOffsetFrom50: number | null; medianOffsetFrom50: number | null;
  bandPercentages: { below45: number; from45to50: number; exactly50: number; from50to55: number; atOrAbove55: number };
  belowAboveEqual: { belowPct: number; abovePct: number; equalPct: number };
  withinBand: { p49_51: number; p48_52: number; p47_53: number; p45_55: number };
};

export type HistogramBucket = { label: string; count: number; pct: number };

export type HorizonDiagnostic = {
  overall: Distribution; byYear: Record<string, Distribution>;
  centering: CenteringDiagnostic; histogram: HistogramBucket[];
};

export type HorizonPairStats = { pairedSessions: number; correlation: number | null; meanAbsDiff: number | null };

export type PeriodHorizonStats = { count: number; mean: number | null; median: number | null; p25: number | null; p75: number | null };
export type PeriodDiagnostic = {
  label: string; from: string; to: string;
  breadth1: PeriodHorizonStats; breadth5: PeriodHorizonStats; breadth20: PeriodHorizonStats;
};

export type BreadthDistributionDiagnostic = {
  requestedRange: { from: string; to: string }; actualRequests: { grouped: number; universe: number };
  sessionsConsidered: number; statisticsConvention: string;
  horizons: Record<HorizonKey, HorizonDiagnostic>;
  compression: {
    stddev: Record<HorizonKey, number | null>; ratio5over1: number | null; ratio20over1: number | null;
    iqr: Record<HorizonKey, number | null>;
  };
  relationships: { breadth1_breadth5: HorizonPairStats; breadth1_breadth20: HorizonPairStats; breadth5_breadth20: HorizonPairStats };
  periods: PeriodDiagnostic[];
};

type ValueSeries = { date: string; value: number }[];

function horizonSeries(days: readonly BreadthDay[], key: HorizonKey): ValueSeries {
  return days.filter(day => day[key] !== null).map(day => ({ date: day.date, value: day[key]!.value }));
}

function byYearDistribution(series: ValueSeries): Record<string, Distribution> {
  const years = [...new Set(series.map(entry => entry.date.slice(0, 4)))].sort();
  return Object.fromEntries(years.map(year => [year, describe(series.filter(entry => entry.date.startsWith(year)).map(entry => entry.value))]));
}

const HISTOGRAM_BOUNDARIES = [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65];
const HISTOGRAM_LABELS = ['<0.35', '0.35-<0.40', '0.40-<0.45', '0.45-<0.50', '0.50-<0.55', '0.55-<0.60', '0.60-<0.65', '>=0.65'];
function histogramOf(values: readonly number[]): HistogramBucket[] {
  const counts = new Array(HISTOGRAM_LABELS.length).fill(0);
  for (const value of values) {
    let bucket = HISTOGRAM_BOUNDARIES.length;
    for (let i = 0; i < HISTOGRAM_BOUNDARIES.length; i++) { if (value < HISTOGRAM_BOUNDARIES[i]!) { bucket = i; break; } }
    counts[bucket]++;
  }
  return HISTOGRAM_LABELS.map((label, i) => ({ label, count: counts[i], pct: values.length ? counts[i] / values.length * 100 : 0 }));
}

function centeringOf(values: readonly number[]): CenteringDiagnostic {
  const n = values.length;
  const pct = (count: number) => n ? count / n * 100 : 0;
  const within = (lo: number, hi: number) => pct(values.filter(v => v >= lo && v <= hi).length);
  const d = describe(values);
  return {
    meanOffsetFrom50: d.mean === null ? null : d.mean - 0.5,
    medianOffsetFrom50: d.median === null ? null : d.median - 0.5,
    bandPercentages: {
      below45: pct(values.filter(v => v < 0.45).length),
      from45to50: pct(values.filter(v => v >= 0.45 && v < 0.50).length),
      exactly50: pct(values.filter(v => v === 0.50).length),
      from50to55: pct(values.filter(v => v > 0.50 && v < 0.55).length),
      atOrAbove55: pct(values.filter(v => v >= 0.55).length),
    },
    belowAboveEqual: {
      belowPct: pct(values.filter(v => v < 0.50).length), abovePct: pct(values.filter(v => v > 0.50).length),
      equalPct: pct(values.filter(v => v === 0.50).length),
    },
    withinBand: { p49_51: within(0.49, 0.51), p48_52: within(0.48, 0.52), p47_53: within(0.47, 0.53), p45_55: within(0.45, 0.55) },
  };
}

function pairStats(days: readonly BreadthDay[], keyA: HorizonKey, keyB: HorizonKey): HorizonPairStats {
  const pairs = days.filter(day => day[keyA] !== null && day[keyB] !== null).map(day => ({ a: day[keyA]!.value, b: day[keyB]!.value }));
  const as = pairs.map(pair => pair.a), bs = pairs.map(pair => pair.b);
  return { pairedSessions: pairs.length, correlation: pearsonCorrelation(as, bs), meanAbsDiff: meanAbsDiff(as, bs) };
}

function periodHorizonStats(series: ValueSeries, from: string, to: string): PeriodHorizonStats {
  const d = describe(series.filter(entry => entry.date >= from && entry.date <= to).map(entry => entry.value));
  return { count: d.count, mean: d.mean, median: d.median, p25: d.p25, p75: d.p75 };
}

export async function diagnoseBreadthDistribution(
  options: Pick<BreadthResearchOptions, 'from' | 'to' | 'db' | 'cacheDir'>,
): Promise<BreadthDistributionDiagnostic> {
  await assertCacheComplete(options);
  const report = await runBreadthResearch({ ...options, fetchFromProvider: false });
  if (report.actualRequests.grouped !== 0 || report.actualRequests.universe !== 0) {
    throw new Error('Cache-only diagnostic unexpectedly made a provider request; refusing to report on evidence that may not be cache-stable.');
  }

  const series = Object.fromEntries(HORIZON_KEYS.map(key => [key, horizonSeries(report.days, key)])) as Record<HorizonKey, ValueSeries>;
  const horizons = Object.fromEntries(HORIZON_KEYS.map(key => {
    const values = series[key].map(entry => entry.value);
    return [key, { overall: describe(values), byYear: byYearDistribution(series[key]), centering: centeringOf(values), histogram: histogramOf(values) }];
  })) as Record<HorizonKey, HorizonDiagnostic>;

  const stddev = Object.fromEntries(HORIZON_KEYS.map(key => [key, horizons[key].overall.stddev])) as Record<HorizonKey, number | null>;
  const iqrByHorizon = Object.fromEntries(HORIZON_KEYS.map(key => [key, iqr(horizons[key].overall)])) as Record<HorizonKey, number | null>;

  return {
    requestedRange: report.requestedRange, actualRequests: report.actualRequests, sessionsConsidered: report.days.length,
    statisticsConvention: STATISTICS_CONVENTION,
    horizons,
    compression: {
      stddev,
      ratio5over1: stddev.breadth5 !== null && stddev.breadth1 ? stddev.breadth5 / stddev.breadth1 : null,
      ratio20over1: stddev.breadth20 !== null && stddev.breadth1 ? stddev.breadth20 / stddev.breadth1 : null,
      iqr: iqrByHorizon,
    },
    relationships: {
      breadth1_breadth5: pairStats(report.days, 'breadth1', 'breadth5'),
      breadth1_breadth20: pairStats(report.days, 'breadth1', 'breadth20'),
      breadth5_breadth20: pairStats(report.days, 'breadth5', 'breadth20'),
    },
    periods: PERIODS.map(period => ({
      label: period.label, from: period.from, to: period.to,
      breadth1: periodHorizonStats(series.breadth1, period.from, period.to),
      breadth5: periodHorizonStats(series.breadth5, period.from, period.to),
      breadth20: periodHorizonStats(series.breadth20, period.from, period.to),
    })),
  };
}
