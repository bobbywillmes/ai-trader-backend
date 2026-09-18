import { describe, expect, it } from 'vitest';
import { calculateTrend, calculateTrendWithThresholds, TREND_PROFILES } from './trend-calculation.js';
import { TREND_ALGORITHM_VERSION, TREND_V1_THRESHOLDS, TREND_V1_THRESHOLD_EVIDENCE } from './trend-v1.definition.js';

describe('frozen production TREND_V1', () => {
  it('freezes exact percentage-point values independently of research', () => {
    expect(TREND_ALGORITHM_VERSION).toBe('TREND_V1');
    expect(TREND_V1_THRESHOLDS).toEqual([.10, .02, .30, .15, .02, .10, .25, .01, .15]);
    expect(TREND_V1_THRESHOLDS).toEqual(TREND_PROFILES.TIGHT);
    expect(TREND_V1_THRESHOLDS).not.toBe(TREND_PROFILES.TIGHT);
    expect(Object.isFrozen(TREND_V1_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(TREND_V1_THRESHOLD_EVIDENCE)).toBe(true);
    expect(Object.values(TREND_V1_THRESHOLD_EVIDENCE)).toEqual(TREND_V1_THRESHOLDS);
  });
  it('preserves the selected calibration math, including hysteresis', () => {
    const bars = Array.from({ length: 140 }, (_, i) => ({ id: i, date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i + Math.sin(i) * 10, volume: 1000, normalizationFactor: 1 }));
    const dates = bars.map(b => b.date);
    expect(calculateTrendWithThresholds(dates, bars, bars, TREND_V1_THRESHOLDS)).toEqual(calculateTrend(dates, bars, bars, 'TIGHT'));
    expect(() => calculateTrendWithThresholds(dates, bars, bars, [1])).toThrow('nine');
  });
});
