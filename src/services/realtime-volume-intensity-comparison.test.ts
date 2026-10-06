import { describe, expect, it } from 'vitest';
import { compareVolumeIntensity, v6IntensityBucket, v6LiquidityBucket, type VolumeMinute } from './realtime-volume-intensity-comparison.js';

const at = (hour: number, minute: number) => new Date(Date.UTC(2026, 8, 24, hour, minute)).toISOString();
const rows = (startHour: number, startMinute: number, count: number, volume: (index: number) => number, close = 100): VolumeMinute[] => {
  const start = Date.UTC(2026, 8, 24, startHour, startMinute);
  return Array.from({ length: count }, (_, i) => ({ time: new Date(start + i * 60_000).toISOString(), volume: volume(i), close }));
};
const compare = (massive: VolumeMinute[], tiingo: VolumeMinute[], cutoff: string | null, minimumDollarVolume = 5_000_000) =>
  compareVolumeIntensity({ massive, tiingo, cutoff, minimumDollarVolume, configuredRecentWindowMinutes: 30 });

describe('shadow Momentum V6 relative-volume diagnostics', () => {
  it('uses exact 5/15/30 slots and provider-internal denominators at the delayed common cutoff', () => {
    const massive = rows(14, 0, 100, i => i < 70 ? 27 : 7);
    const tiingo = rows(14, 0, 115, i => i < 70 ? 97 : 7);
    const result = compare(massive, tiingo, massive.at(-1)!.time);
    expect(result.cumulativeVolumeThroughCutoff).toEqual({ massive: 2100, tiingo: 7000 });
    expect(result.windows['5']).toMatchObject({ expectedMinuteCount: 5, massiveObservedMinuteCount: 5, tiingoObservedMinuteCount: 5, sharedMinuteCount: 5 });
    expect(result.windows['15']).toMatchObject({ expectedMinuteCount: 15, massiveObservedMinuteCount: 15, tiingoObservedMinuteCount: 15 });
    expect(result.windows['30'].massive).toMatchObject({ recentVolume: 210, volumeIntensity: .1 });
    expect(result.windows['30'].tiingo).toMatchObject({ recentVolume: 210, volumeIntensity: .03 });
    expect(result.v6ThirtyMinuteParity).toMatchObject({ massiveBucket: 'STRONG', tiingoBucket: 'MODERATE',
      massiveIntensityPoints: 20, tiingoIntensityPoints: 10, sameBucket: false, sameIntensityPoints: false, absoluteIntensityDifference: .07 });
    expect(result.cumulativeVolumeThroughCutoff.tiingo).toBe(7000); // Never divide by Massive's 2100.
    expect(result.cumulativeCheckpoints.at(-1)).toMatchObject({ checkpoint: 'COMMON_CUTOFF', tiingoToMassiveRatio: 3.33333333 });
  });
  it('does not turn a provider-missing or null-volume minute into zero', () => {
    const massive = rows(14, 0, 40, () => 10);
    const tiingo = rows(14, 0, 40, () => 5).filter((_, i) => i !== 25);
    const r = compare(massive, tiingo, massive.at(-1)!.time);
    expect(r.windows['15']).toMatchObject({ massiveObservedMinuteCount: 15, tiingoObservedMinuteCount: 14, sharedMinuteCount: 14 });
    expect(r.windows['15'].tiingo).toMatchObject({ available: false, availability: 'INCOMPLETE_RECENT_WINDOW',
      recentVolume: null, observedRecentVolume: 70, cumulativeVolumeThroughCutoff: null, volumeIntensity: null });
    expect(r.windows['5'].massive).toMatchObject({ available: false, availability: 'INCOMPLETE_CUMULATIVE_COVERAGE' });
    expect(r.v6ThirtyMinuteParity.sameBucket).toBeNull();
    const nullVolume = compare(massive, rows(14, 0, 40, () => 5).map((row, i) => i === 39 ? { ...row, volume: null } : row), massive.at(-1)!.time);
    expect(nullVolume.windows['5'].tiingo.volumeIntensity).toBeNull();
    expect(nullVolume.liquidity.tiingoEstimatedDollarVolume).toBeNull();
    const noCutoff = compare(massive, tiingo, null);
    expect(noCutoff.windows['30'].massive).toMatchObject({ available: false, availability: 'NO_COMMON_CUTOFF' });
  });
  it('mirrors V6 intensity and dollar-liquidity boundaries exactly', () => {
    expect(v6IntensityBucket(.029999)).toEqual({ bucket: 'LOW', points: 0 });
    expect(v6IntensityBucket(.03)).toEqual({ bucket: 'MODERATE', points: 10 });
    expect(v6IntensityBucket(.1)).toEqual({ bucket: 'STRONG', points: 20 });
    expect(v6LiquidityBucket(999_999, 5_000_000)).toBe('INSUFFICIENT_DOLLAR_LIQUIDITY');
    expect(v6LiquidityBucket(1_000_000, 5_000_000)).toBe('BELOW_HALF_MINIMUM');
    expect(v6LiquidityBucket(2_500_000, 5_000_000)).toBe('MODERATE_DOLLAR_LIQUIDITY');
    expect(v6LiquidityBucket(5_000_000, 5_000_000)).toBe('MINIMUM_MET');
  });
  it('uses the common-cutoff minute close for each provider dollar-liquidity decision', () => {
    const m = rows(14, 0, 30, () => 10, 100);
    const t = rows(14, 0, 30, () => 1, 100);
    const r = compare(m, t, m.at(-1)!.time, 100_000);
    expect(r.liquidity).toMatchObject({ massiveEstimatedDollarVolume: 30_000, tiingoEstimatedDollarVolume: 3_000,
      massiveLiquidityBucket: 'BELOW_HALF_MINIMUM', tiingoLiquidityBucket: 'INSUFFICIENT_DOLLAR_LIQUIDITY',
      sameLiquidityDecision: false, referencePriceSource: 'COMMON_CUTOFF_MINUTE_CLOSE' });
  });
  it('reports reached checkpoints and premarket-to-regular windows without filling the boundary', () => {
    // 09:15–10:14 ET, including the 09:30 boundary; Tiingo is current through 10:29.
    const m = rows(13, 15, 60, () => 10);
    const t = rows(13, 15, 75, () => 20);
    const r = compare(m, t, m.at(-1)!.time);
    expect(r.windows['30']).toMatchObject({ expectedMinuteCount: 30, sharedMinuteCount: 30 });
    expect(r.cumulativeCheckpoints.map(point => point.checkpoint)).toEqual(['10:00', 'COMMON_CUTOFF']);
    expect(r.cumulativeCheckpoints[0]).toMatchObject({ tiingoToMassiveRatio: 2, coverage: 'COMPLETE_ON_OBSERVED_UNION' });
    const boundary = compare(rows(13, 15, 30, () => 10), rows(13, 15, 30, () => 20), at(13, 44));
    expect(boundary.windows['30'].sharedMinuteCount).toBe(30);
    expect(boundary.cumulativeCheckpoints.map(point => point.checkpoint)).toEqual(['COMMON_CUTOFF']);
  });
  it('keeps strict extended parity unavailable while complete regular-session parity is available', () => {
    const m = rows(13, 30, 60, () => 10); // 09:30–10:29 ET
    const t = [{ time: at(13, 29), volume: 5, close: 100 }, ...rows(13, 30, 60, () => 20)];
    const r = compare(m, t, m.at(-1)!.time);
    expect(r.v6ThirtyMinuteParity.sameBucket).toBeNull();
    expect(r.regularSessionVolumeParity).toMatchObject({ availability: 'EVALUATED',
      cumulative: { massive: { expectedMinuteCount: 60, observedMinuteCount: 60, cumulativeVolumeThroughCutoff: 600 },
        tiingo: { expectedMinuteCount: 60, observedMinuteCount: 60, cumulativeVolumeThroughCutoff: 1200 } },
      thirtyMinuteParity: { massiveBucket: 'STRONG', tiingoBucket: 'STRONG', sameBucket: true,
        massiveIntensityPoints: 20, tiingoIntensityPoints: 20, sameIntensityPoints: true } });
    expect(r.regularSessionVolumeParity.windows['5']).toMatchObject({ expectedMinuteCount: 5, sharedMinuteCount: 5,
      massive: { recentVolume: 50 }, tiingo: { recentVolume: 100 } });
    expect(r.regularSessionVolumeParity.windows['15'].massive.volumeIntensity).toBe(.25);
    expect(r.regularSessionVolumeParity.windows['30'].tiingo.volumeIntensity).toBe(.5);
    expect(r.regularSessionVolumeParity.cumulativeCheckpoints).toMatchObject([
      { checkpoint: '10:00', tiingoToMassiveRatio: 2, availability: 'COMPLETE' },
      { checkpoint: 'EFFECTIVE_REGULAR_CUTOFF', tiingoToMassiveRatio: 2, availability: 'COMPLETE' },
    ]);
    expect(r.OBSERVED_EXTENDED_DIAGNOSTIC).toMatchObject({ researchOnly: true, authoritativeParity: false,
      massive: { observedCumulativeVolume: 600 }, tiingo: { observedCumulativeVolume: 1205 } });
  });
  it('fails regular parity on any missing minute from 09:30, including outside recent windows', () => {
    const m = rows(13, 30, 60, () => 10);
    const t = rows(13, 30, 60, () => 20).filter((_, i) => i !== 1);
    const r = compare(m, t, m.at(-1)!.time);
    expect(r.regularSessionVolumeParity.cumulative.tiingo).toMatchObject({ expectedMinuteCount: 60,
      observedMinuteCount: 59, complete: false, cumulativeVolumeThroughCutoff: null });
    expect(r.regularSessionVolumeParity.windows['5'].tiingo).toMatchObject({ recentVolume: 100,
      volumeIntensity: null, availability: 'INCOMPLETE_REGULAR_CUMULATIVE' });
    expect(r.regularSessionVolumeParity.thirtyMinuteParity.sameBucket).toBeNull();
    expect(r.regularSessionVolumeParity.cumulativeCheckpoints[0]).toMatchObject({ checkpoint: '10:00',
      tiingoToMassiveRatio: null, availability: 'INCOMPLETE_REGULAR_EVIDENCE' });
  });
  it('does not borrow premarket minutes and clamps an after-close source cutoff to 15:59', () => {
    const m = rows(13, 30, 5, () => 10);
    const t = rows(13, 30, 5, () => 20);
    const early = compare(m, t, at(13, 34));
    expect(early.regularSessionVolumeParity.windows['5'].massive.volumeIntensity).toBe(1);
    expect(early.regularSessionVolumeParity.windows['15'].massive).toMatchObject({ volumeIntensity: null, availability: 'WINDOW_CROSSES_OPEN' });
    expect(early.regularSessionVolumeParity.thirtyMinuteParity.sameBucket).toBeNull();
    const after = compare(rows(13, 30, 391, () => 10), rows(13, 30, 391, () => 20), at(20, 0));
    expect(after.regularSessionVolumeParity).toMatchObject({ availability: 'EVALUATED',
      sourceCommonCutoff: at(20, 0), effectiveRegularCutoff: at(19, 59), cutoffAdjustment: 'CLAMPED_TO_REGULAR_SESSION_END',
      cumulative: { massive: { expectedMinuteCount: 390, observedMinuteCount: 390, cumulativeVolumeThroughCutoff: 3900 },
        tiingo: { expectedMinuteCount: 390, observedMinuteCount: 390, cumulativeVolumeThroughCutoff: 7800 } },
      thirtyMinuteParity: { sameBucket: true, sameIntensityPoints: true } });
    expect(after.regularSessionVolumeParity.windows['30'].massive.recentVolume).toBe(300);
    expect(after.regularSessionVolumeParity.cumulativeCheckpoints.find(point => point.checkpoint === '15:00')).toMatchObject({
      tiingoToMassiveRatio: 2, availability: 'COMPLETE' });
    expect(after.regularSessionVolumeParity.cumulativeCheckpoints.at(-1)).toMatchObject({
      checkpoint: 'EFFECTIVE_REGULAR_CUTOFF', checkpointAt: at(19, 59), expectedMinuteCount: 390, tiingoToMassiveRatio: 2 });
    expect(after.cumulativeVolumeThroughCutoff).toEqual({ massive: 3910, tiingo: 7820 }); // Strict extended view still includes 16:00.
    const before = compare(rows(13, 0, 30, () => 10), rows(13, 0, 30, () => 20), at(13, 29));
    expect(before.regularSessionVolumeParity).toMatchObject({ sourceCommonCutoff: at(13, 29),
      effectiveRegularCutoff: null, cutoffAdjustment: 'NONE', availability: 'CUTOFF_BEFORE_REGULAR_OPEN' });
  });
  it('evaluates the exact 15:59 cutoff without adjustment and ignores all postmarket volume', () => {
    const m = [...rows(13, 30, 390, () => 10), ...rows(20, 0, 10, () => 50_000)];
    const t = [...rows(13, 30, 390, () => 20), ...rows(20, 0, 10, () => 90_000)];
    const atClose = compare(m, t, at(19, 59));
    const afterClose = compare(m, t, at(20, 9));
    expect(atClose.regularSessionVolumeParity).toMatchObject({ sourceCommonCutoff: at(19, 59),
      effectiveRegularCutoff: at(19, 59), cutoffAdjustment: 'NONE', availability: 'EVALUATED' });
    expect(afterClose.regularSessionVolumeParity.cumulative).toEqual(atClose.regularSessionVolumeParity.cumulative);
    expect(afterClose.regularSessionVolumeParity.windows).toEqual(atClose.regularSessionVolumeParity.windows);
    expect(afterClose.regularSessionVolumeParity.cumulative.massive.cumulativeVolumeThroughCutoff).toBe(3900);
    expect(afterClose.OBSERVED_EXTENDED_DIAGNOSTIC.authoritativeParity).toBe(false);
  });
  it('still fails closed for a missing regular minute after the source cutoff is clamped', () => {
    const m = rows(13, 30, 391, () => 10);
    const t = rows(13, 30, 391, () => 20).filter((_, index) => index !== 100);
    const r = compare(m, t, at(20, 0));
    expect(r.regularSessionVolumeParity).toMatchObject({ effectiveRegularCutoff: at(19, 59),
      cumulative: { tiingo: { expectedMinuteCount: 390, observedMinuteCount: 389, complete: false,
        cumulativeVolumeThroughCutoff: null } }, thirtyMinuteParity: { sameBucket: null, sameIntensityPoints: null } });
  });
});
