import { describe, expect, it } from 'vitest';
import { getNewYorkMarketTiming, scoreMomentumPriceAction, type MomentumPriceScoreInput } from './momentum-price-score.js';

const observedAt = new Date('2026-07-16T14:30:00.000Z');
function input(overrides: Partial<MomentumPriceScoreInput> = {}): MomentumPriceScoreInput {
  return {
    percentFromPreviousClose: 4,
    aboveVwap: true,
    distanceFromHighPct: 1,
    recentMovePct: 1,
    extensionFromVwapPct: 3,
    observedAt,
    sourceObservedAt: new Date('2026-07-16T14:29:00.000Z'),
    marketSession: 'REGULAR',
    newYorkMinuteOfDay: 10 * 60 + 30,
    ...overrides,
  };
}

describe('momentum price-action scoring v2', () => {
  it.each([
    ['strong orderly momentum', {}, 100, []],
    ['below VWAP', { aboveVwap: false, extensionFromVwapPct: -1 }, 65, ['BELOW_VWAP']],
    ['excessive extension', { extensionFromVwapPct: 9 }, 90, ['EXCESSIVELY_EXTENDED']],
    ['sharp fade', { distanceFromHighPct: 7 }, 75, ['TOO_FAR_FROM_INTRADAY_HIGH']],
    ['negative recent move', { recentMovePct: -1.2 }, 80, ['NEGATIVE_RECENT_MOMENTUM']],
    ['missing context', { percentFromPreviousClose: null }, 80, ['MISSING_PRICE_CONTEXT']],
    ['stale observation', { sourceObservedAt: new Date('2026-07-16T14:20:00.000Z') }, 100, ['STALE_PRICE_DATA']],
    ['late session', { newYorkMinuteOfDay: 15 * 60 + 45 }, 90, []],
  ])('%s', (_label, overrides, expectedScore, expectedBlocks) => {
    const result = scoreMomentumPriceAction(input(overrides));
    expect(result.score).toBe(expectedScore);
    expect(result.hardBlocks).toEqual(expectedBlocks);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('derives New York session timing across EST and EDT', () => {
    expect(getNewYorkMarketTiming(new Date('2026-01-15T15:00:00.000Z'))).toEqual({
      marketSession: 'REGULAR', newYorkMinuteOfDay: 10 * 60,
    });
    expect(getNewYorkMarketTiming(new Date('2026-07-16T14:00:00.000Z'))).toEqual({
      marketSession: 'REGULAR', newYorkMinuteOfDay: 10 * 60,
    });
  });

  it('is deterministic and does not mutate its inputs', () => {
    const value = input();
    expect(scoreMomentumPriceAction(value)).toEqual(scoreMomentumPriceAction(value));
    expect(value.percentFromPreviousClose).toBe(4);
  });
});
