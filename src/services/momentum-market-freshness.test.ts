import { describe, expect, it } from 'vitest';

import { evaluateMarketFreshness } from './momentum-market-freshness.js';

describe('momentum market freshness', () => {
  it.each([
    ['fresh regular DST', '2026-07-06T14:31:00Z', '2026-07-06T14:30:00Z', 'REGULAR', null],
    ['stale regular', '2026-07-06T14:40:01Z', '2026-07-06T14:30:00Z', 'REGULAR', 'AWAITING_FRESH_PRICE_DATA'],
    ['current premarket DST', '2026-07-06T12:00:00Z', '2026-07-06T11:50:00Z', 'PREMARKET', null],
    ['premarket prior session', '2026-07-06T12:00:00Z', '2026-07-03T19:59:00Z', 'PREMARKET', 'AWAITING_FRESH_PRICE_DATA'],
    ['current after hours standard time', '2026-01-06T22:30:00Z', '2026-01-06T22:20:00Z', 'AFTER_HOURS', null],
    ['closed overnight', '2026-07-06T07:00:00Z', '2026-07-03T19:59:00Z', 'CLOSED', 'AWAITING_MARKET_SESSION'],
    ['weekend', '2026-07-05T15:00:00Z', '2026-07-03T19:59:00Z', 'CLOSED', 'AWAITING_MARKET_SESSION'],
    ['missing timestamp', '2026-07-06T14:31:00Z', null, 'REGULAR', 'AWAITING_FRESH_PRICE_DATA'],
  ])('%s', (_name, evaluatedAt, observedAt, session, incompleteReason) => {
    const result = evaluateMarketFreshness({
      evaluatedAt: new Date(evaluatedAt),
      marketObservationAt: observedAt ? new Date(observedAt) : null,
      marketObservationSource: observedAt ? 'LAST_TRADE' : 'UNKNOWN',
      extendedHoursRequested: true,
    });

    expect(result.marketSession).toBe(session);
    expect(result.incompleteReason).toBe(incompleteReason);
  });
});
