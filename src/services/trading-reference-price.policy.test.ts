import { describe, expect, it } from 'vitest';
import { evaluateTradingReferencePrice, tradingPricePhase } from './trading-reference-price.policy.js';
import type { ReferencePriceEvidence } from './live-market-data.contracts.js';
import type { CalendarException } from './market-calendar.js';

const now = new Date('2026-10-02T16:00:00.000Z'); // Friday, noon ET.
const base: ReferencePriceEvidence = { symbol: 'SPY', provider: 'TIINGO_CONSOLIDATED', basis: 'TIINGO_TNGO_LAST',
  price: 100, observedAt: '2026-10-02T15:59:00.000Z', fetchedAt: now.toISOString(),
  freshness: 'FRESH', available: true, unavailableReason: null, providerError: null };
const evaluate = (patch: Partial<ReferencePriceEvidence> = {}, at = now, exceptions: CalendarException[] = []) =>
  evaluateTradingReferencePrice('spy', { ...base, ...patch }, at, exceptions);

describe('trading reference-price eligibility', () => {
  it('accepts fresh TNGO_LAST in the regular session', () => {
    expect(evaluate()).toMatchObject({ usable: true, rejectionReason: null, ageMs: 60_000, clockSkewMs: null, sessionPhase: 'REGULAR' });
  });
  it.each([
    [{ basis: 'TIINGO_LQ_REF_PRICE' }, 'UNACCEPTED_BASIS'],
    [{ provider: 'MASSIVE' }, 'PROVIDER_MISMATCH'],
    [{ symbol: 'QQQ' }, 'SYMBOL_MISMATCH'],
    [{ price: 0 }, 'INVALID_PRICE'],
    [{ price: Number.POSITIVE_INFINITY }, 'INVALID_PRICE'],
    [{ observedAt: null }, 'MISSING_OBSERVATION_TIMESTAMP'],
    [{ observedAt: 'not-a-date' }, 'MISSING_OBSERVATION_TIMESTAMP'],
    [{ fetchedAt: '' }, 'MISSING_FETCH_TIMESTAMP'],
    [{ providerError: 'HTTP_429' }, 'PROVIDER_ERROR'],
    [{ unavailableReason: 'MALFORMED_RESPONSE' }, 'MALFORMED_EVIDENCE'],
    [{ observedAt: '2026-10-02T15:54:59.999Z' }, 'STALE_OBSERVATION'],
    [{ observedAt: '2026-10-02T16:00:30.001Z' }, 'FUTURE_OBSERVATION'],
  ] as const)('rejects %j with %s', (patch, reason) => {
    expect(evaluate(patch as Partial<ReferencePriceEvidence>)).toMatchObject({ usable: false, rejectionReason: reason });
  });
  it('accepts exactly five minutes old even when fetch-time normalization marked it stale', () => {
    expect(evaluate({ observedAt: '2026-10-02T15:55:00.000Z', freshness: 'STALE', available: false,
      unavailableReason: 'STALE_OBSERVATION' })).toMatchObject({ usable: true, ageMs: 300_000 });
  });
  it('preserves tolerated positive clock skew, independently of fetch-time availability', () => {
    expect(evaluate({ observedAt: '2026-10-02T16:00:30.000Z', freshness: 'FUTURE', available: false,
      unavailableReason: 'FUTURE_TIMESTAMP' })).toMatchObject({ usable: true, ageMs: -30_000, clockSkewMs: 30_000 });
  });
  it('rejects a recent premarket observation after the regular open', () => {
    const opening = new Date('2026-10-02T13:31:00.000Z');
    expect(evaluate({ observedAt: '2026-10-02T13:29:59.000Z', fetchedAt: opening.toISOString() }, opening))
      .toMatchObject({ sessionPhase: 'REGULAR', rejectionReason: 'OBSERVATION_OUTSIDE_TRADING_SESSION' });
  });
  it('classifies expected closed-market unavailability separately from provider failure', () => {
    const weekend = new Date('2026-10-03T16:00:00.000Z');
    expect(evaluate({ price: null, observedAt: null, providerError: 'HTTP_429', unavailableReason: 'PROVIDER_ERROR' }, weekend))
      .toMatchObject({ rejectionReason: 'OUTSIDE_TRADING_PRICE_SESSION', usable: false });
  });
  it.each([
    ['premarket', '2026-10-02T12:00:00.000Z', 'PREMARKET'],
    ['postmarket', '2026-10-02T21:00:00.000Z', 'POSTMARKET'],
    ['overnight', '2026-10-02T07:00:00.000Z', 'OVERNIGHT'],
    ['weekend', '2026-10-03T16:00:00.000Z', 'CLOSED'],
  ] as const)('rejects %s by actual session', (_label, time, phase) => {
    const at = new Date(time);
    expect(evaluate({ observedAt: at.toISOString(), fetchedAt: at.toISOString() }, at)).toMatchObject({
      sessionPhase: phase, usable: false, rejectionReason: 'OUTSIDE_TRADING_PRICE_SESSION' });
  });
  it('rejects a reviewed holiday and honors a reviewed early close', () => {
    const holiday: CalendarException[] = [{ sessionDate: '2026-10-02', type: 'CLOSED', closeTimeMinutesEt: null }];
    expect(evaluate({}, now, holiday)).toMatchObject({ sessionPhase: 'CLOSED', rejectionReason: 'OUTSIDE_TRADING_PRICE_SESSION' });
    const early: CalendarException[] = [{ sessionDate: '2026-10-02', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }];
    const before = new Date('2026-10-02T16:59:00.000Z');
    const after = new Date('2026-10-02T17:00:00.000Z');
    expect(evaluate({ observedAt: before.toISOString(), fetchedAt: before.toISOString() }, before, early).usable).toBe(true);
    expect(evaluate({ observedAt: after.toISOString(), fetchedAt: after.toISOString() }, after, early))
      .toMatchObject({ sessionPhase: 'POSTMARKET', rejectionReason: 'OUTSIDE_TRADING_PRICE_SESSION' });
    expect(tradingPricePhase(after, early)).toBe('POSTMARKET');
  });
});
