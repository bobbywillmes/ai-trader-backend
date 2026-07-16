import { describe, expect, it } from 'vitest';
import { scoreMomentumSetupQuality, type MomentumSetupQualityInput } from './momentum-setup-quality-score.js';

function input(overrides: Partial<MomentumSetupQualityInput> = {}): MomentumSetupQualityInput {
  return {
    extensionFromVwapPct: 3,
    distanceFromHighPct: 1,
    recentMovePct: 1,
    candidateAgeMinutes: 60,
    marketSession: 'REGULAR',
    newYorkMinuteOfDay: 11 * 60,
    dollarVolume: 20_000_000,
    minimumDollarVolume: 5_000_000,
    ...overrides,
  };
}

describe('momentum setup-quality scoring', () => {
  it.each([
    ['clean setup', {}, 100, []],
    ['elevated extension', { extensionFromVwapPct: 5 }, 85, []],
    ['excessive extension', { extensionFromVwapPct: 9 }, 60, ['EXCESSIVE_SETUP_EXTENSION']],
    ['sharp fade and instability', { distanceFromHighPct: 6, recentMovePct: -5 }, 55, []],
    ['late session', { newYorkMinuteOfDay: 15 * 60 + 45 }, 90, []],
    ['weak liquidity', { dollarVolume: 500_000 }, 70, []],
    ['missing context', { distanceFromHighPct: null }, 75, ['MISSING_SETUP_CONTEXT']],
    ['stale candidate', { candidateAgeMinutes: 1_500 }, 70, ['STALE_CANDIDATE_CONTEXT']],
  ])('%s', (_label, overrides, score, hardBlocks) => {
    const result = scoreMomentumSetupQuality(input(overrides));
    expect(result.score).toBe(score);
    expect(result.hardBlocks).toEqual(hardBlocks);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('does not accept account-risk inputs', () => {
    expect(Object.keys(scoreMomentumSetupQuality(input()).inputs)).not.toEqual(
      expect.arrayContaining(['buyingPower', 'allocation', 'subscription'])
    );
  });
});
