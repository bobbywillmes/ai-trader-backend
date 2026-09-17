/** Tiny research-only descriptive-statistics helper for the Breadth distribution
 * diagnostic. Deliberately minimal — not a general statistics framework. */

export type Distribution = {
  count: number; mean: number | null; median: number | null; stddev: number | null;
  min: number | null; max: number | null;
  p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null;
};

/** Documented explicitly since both choices are deliberate, not silent library defaults.
 * Percentile: linear interpolation between closest ranks over sorted values
 * (index = p * (n - 1)); equivalent to NumPy's default "linear" method and Excel's
 * PERCENTILE.INC. Standard deviation: sample convention (n - 1 divisor), matching the
 * convention already documented for Volatility (`VOLATILITY_DEFINITION.standardDeviation`). */
export const STATISTICS_CONVENTION =
  'Percentile: linear interpolation between closest ranks, index = p * (n - 1) (NumPy "linear" / Excel PERCENTILE.INC). ' +
  'Standard deviation: sample convention, n - 1 divisor (matches VOLATILITY_DEFINITION.standardDeviation).';

function toSorted(values: readonly number[]): number[] { return [...values].sort((a, b) => a - b); }

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Sample standard deviation (n - 1 divisor); null below 2 values, where it is undefined. */
export function stddev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** `sortedValues` must already be sorted ascending; `p` is a fraction in [0, 1]. */
export function percentile(sortedValues: readonly number[], p: number): number | null {
  if (!sortedValues.length) return null;
  if (p < 0 || p > 1) throw new Error('Percentile fraction must be within [0, 1].');
  if (sortedValues.length === 1) return sortedValues[0]!;
  const index = p * (sortedValues.length - 1);
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower]!;
  const fraction = index - lower;
  return sortedValues[lower]! + (sortedValues[upper]! - sortedValues[lower]!) * fraction;
}

export function median(values: readonly number[]): number | null {
  return percentile(toSorted(values), 0.5);
}

export function describe(values: readonly number[]): Distribution {
  const sorted = toSorted(values);
  return {
    count: values.length, mean: mean(values), median: percentile(sorted, 0.5), stddev: stddev(values),
    min: sorted.length ? sorted[0]! : null, max: sorted.length ? sorted.at(-1)! : null,
    p10: percentile(sorted, 0.10), p25: percentile(sorted, 0.25), p50: percentile(sorted, 0.50),
    p75: percentile(sorted, 0.75), p90: percentile(sorted, 0.90),
  };
}

export function iqr(distribution: Pick<Distribution, 'p25' | 'p75'>): number | null {
  return distribution.p25 !== null && distribution.p75 !== null ? distribution.p75 - distribution.p25 : null;
}

/** Requires paired (same-length, index-aligned) series; callers filter for joint validity first. */
export function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length) throw new Error('Paired series of equal length required.');
  if (xs.length < 2) return null;
  const mx = mean(xs)!, my = mean(ys)!;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

export function meanAbsDiff(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length) throw new Error('Paired series of equal length required.');
  return xs.length ? mean(xs.map((x, i) => Math.abs(x - ys[i]!))) : null;
}
