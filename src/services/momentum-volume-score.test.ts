import { describe, expect, it } from 'vitest';
import { scoreMomentumVolume, type MomentumVolumeScoreInput } from './momentum-volume-score.js';

function input(overrides: Partial<MomentumVolumeScoreInput> = {}): MomentumVolumeScoreInput {
  return {
    dayVolume: 1_000_000,
    recentVolume: 150_000,
    dollarVolume: 20_000_000,
    relativeVolume: null,
    minimumDollarVolume: 5_000_000,
    ...overrides,
  };
}

describe('momentum volume-intensity scoring', () => {
  it.each([
    ['strong volume without fabricated RVOL', {}, 90, []],
    ['weak liquidity', { dollarVolume: 500_000 }, 55, ['INSUFFICIENT_DOLLAR_LIQUIDITY']],
    ['falling participation', { recentVolume: 10_000 }, 70, []],
    ['missing context', { recentVolume: null }, 50, ['MISSING_VOLUME_CONTEXT']],
    ['true RVOL when supplied', { relativeVolume: 2.5 }, 100, []],
  ])('%s', (_label, overrides, score, hardBlocks) => {
    const result = scoreMomentumVolume(input(overrides));
    expect(result.score).toBe(score);
    expect(result.hardBlocks).toEqual(hardBlocks);
    expect(result.volumeMetricType).toBe('VOLUME_INTENSITY_V1');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('keeps relative volume null and reports an honest intensity ratio', () => {
    expect(scoreMomentumVolume(input())).toMatchObject({
      relativeVolume: null,
      volumeIntensity: 0.15,
      reasons: expect.arrayContaining(['TRUE_RELATIVE_VOLUME_UNAVAILABLE']),
    });
  });
});
