import { describe as suite, expect, it } from 'vitest';
import { describe, iqr, mean, meanAbsDiff, pearsonCorrelation, percentile, stddev } from './breadth-statistics.js';

suite('percentile', () => {
  it('interpolates linearly between closest ranks (index = p * (n - 1))', () => {
    const sorted = [1, 2, 3, 4];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 1)).toBe(4);
    expect(percentile(sorted, 0.5)).toBe(2.5); // index 1.5 -> midpoint of 2 and 3
    expect(percentile(sorted, 0.25)).toBe(1.75); // index 0.75 -> 1 + 0.75*(2-1)
    expect(percentile(sorted, 0.75)).toBe(3.25);
  });

  it('returns the single value for a one-element series regardless of p', () => {
    expect(percentile([7], 0.1)).toBe(7);
    expect(percentile([7], 0.9)).toBe(7);
  });

  it('returns null for an empty series', () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it('rejects a fraction outside [0, 1]', () => {
    expect(() => percentile([1, 2, 3], 1.5)).toThrow('Percentile fraction must be within [0, 1].');
    expect(() => percentile([1, 2, 3], -0.1)).toThrow('Percentile fraction must be within [0, 1].');
  });
});

suite('mean', () => {
  it('computes the arithmetic mean', () => { expect(mean([2, 4, 6])).toBe(4); });
  it('returns null for an empty series', () => { expect(mean([])).toBeNull(); });
});

suite('median via describe', () => {
  it('matches the midpoint for an even-length series and the middle for odd', () => {
    expect(describe([1, 2, 3, 4]).median).toBe(2.5);
    expect(describe([1, 2, 3]).median).toBe(2);
  });
});

suite('stddev', () => {
  it('computes the sample (n - 1) standard deviation for a known fixture', () => {
    // Textbook fixture: population {2,4,4,4,5,5,7,9}, mean 5, sample variance 32/7.
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(stddev(values)).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('is null below two values', () => {
    expect(stddev([])).toBeNull();
    expect(stddev([5])).toBeNull();
  });
});

suite('describe / iqr', () => {
  it('reports count, min, max, and all requested percentiles for a deterministic fixture', () => {
    const d = describe([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(d.count).toBe(10);
    expect(d.mean).toBe(55);
    expect(d.min).toBe(10);
    expect(d.max).toBe(100);
    expect(d.p10).toBeCloseTo(19, 10); // index 0.9 -> 10 + 0.9*(20-10)
    expect(d.p90).toBeCloseTo(91, 10); // index 8.1 -> 90 + 0.1*(100-90)
  });

  it('computes IQR as P75 - P25', () => {
    const d = describe([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(iqr(d)).toBeCloseTo(d.p75! - d.p25!, 10);
    expect(iqr(d)).toBeGreaterThan(0);
  });

  it('returns null fields throughout for an empty series', () => {
    const d = describe([]);
    expect(d).toEqual({ count: 0, mean: null, median: null, stddev: null, min: null, max: null, p10: null, p25: null, p50: null, p75: null, p90: null });
  });
});

suite('pearsonCorrelation', () => {
  it('is 1 for a perfectly increasing linear relationship', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
  });

  it('is -1 for a perfectly decreasing linear relationship', () => {
    expect(pearsonCorrelation([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('is null when either series has zero variance', () => {
    expect(pearsonCorrelation([5, 5, 5], [1, 2, 3])).toBeNull();
  });

  it('rejects mismatched series lengths', () => {
    expect(() => pearsonCorrelation([1, 2], [1, 2, 3])).toThrow('Paired series of equal length required.');
  });
});

suite('meanAbsDiff', () => {
  it('averages the absolute pairwise difference', () => {
    expect(meanAbsDiff([1, 2, 3], [2, 2, 6])).toBeCloseTo((1 + 0 + 3) / 3, 10);
  });

  it('is null for empty paired series', () => {
    expect(meanAbsDiff([], [])).toBeNull();
  });

  it('rejects mismatched series lengths', () => {
    expect(() => meanAbsDiff([1], [1, 2])).toThrow('Paired series of equal length required.');
  });
});
