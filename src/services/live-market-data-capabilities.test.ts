import { describe, expect, it, vi } from 'vitest';
import { normalizeReferencePrice, normalizeRegularMinutes, verifyReferencePrice, verifyRegularSessionMinutes } from './live-market-data-capabilities.js';
import { TiingoRequestError, type TiingoRealtimeSnapshot } from '../integrations/tiingo/rest.client.js';

const now = new Date('2026-10-01T20:00:00Z');
const tiingo: TiingoRealtimeSnapshot = { provider: 'TIINGO_CONSOLIDATED', symbol: 'SPY', observedAt: new Date('2026-10-01T19:59:00Z'),
  fetchedAt: now, referencePrice: 650, referencePriceSource: 'TNGO_LAST', previousClose: null, open: null, high: null,
  low: null, volume: null, extendedHours: true };
const massive = { symbol: 'SPY', latestPrice: 650, latestPriceAt: '2026-10-01T19:59:00.000Z', latestPriceSource: 'lastTrade' as const };

describe('read-only reference price capability', () => {
  it('keeps Massive last-trade selection and Tiingo reference-price provenance distinct', () => {
    expect(normalizeReferencePrice('SPY', 'MASSIVE', massive, now)).toMatchObject({ available: true, basis: 'LAST_TRADE', price: 650, observedAt: massive.latestPriceAt });
    expect(normalizeReferencePrice('SPY', 'TIINGO_CONSOLIDATED', tiingo, now)).toMatchObject({ available: true, basis: 'TIINGO_TNGO_LAST', price: 650, observedAt: '2026-10-01T19:59:00.000Z' });
  });
  it('does not call a previous close a current price', () => {
    expect(normalizeReferencePrice('SPY', 'MASSIVE', { ...massive, latestPriceSource: 'previousClose' }, now))
      .toMatchObject({ price: 650, basis: 'PREVIOUS_CLOSE', available: false, unavailableReason: 'PREVIOUS_CLOSE_ONLY' });
  });
  it('fails safely for stale, future, missing, and null evidence', () => {
    expect(normalizeReferencePrice('SPY', 'MASSIVE', { ...massive, latestPriceAt: '2026-10-01T19:50:00Z' }, now)).toMatchObject({ freshness: 'STALE', available: false, unavailableReason: 'STALE_OBSERVATION' });
    expect(normalizeReferencePrice('SPY', 'MASSIVE', { ...massive, latestPriceAt: '2026-10-01T20:01:00Z' }, now)).toMatchObject({ freshness: 'FUTURE', available: false, unavailableReason: 'FUTURE_TIMESTAMP' });
    expect(normalizeReferencePrice('SPY', 'TIINGO_CONSOLIDATED', { ...tiingo, observedAt: null }, now)).toMatchObject({ freshness: 'UNKNOWN', available: false, unavailableReason: 'MISSING_TIMESTAMP' });
    expect(normalizeReferencePrice('SPY', 'TIINGO_CONSOLIDATED', { ...tiingo, referencePrice: null }, now)).toMatchObject({ price: null, available: false, unavailableReason: 'NO_PRICE' });
  });
  it('never falls back across providers on failure or malformed identity', async () => {
    const other = vi.fn(async () => tiingo);
    expect(await verifyReferencePrice('SPY', 'MASSIVE', now, { massive: async () => { throw new Error('offline'); }, tiingo: other })).toMatchObject({ provider: 'MASSIVE', available: false, unavailableReason: 'PROVIDER_ERROR' });
    expect(other).not.toHaveBeenCalled();
    expect(await verifyReferencePrice('SPY', 'TIINGO_CONSOLIDATED', now, { tiingo: async () => ({ ...tiingo, symbol: 'QQQ' }) })).toMatchObject({ available: false, unavailableReason: 'MALFORMED_RESPONSE' });
    expect(await verifyReferencePrice('SPY', 'TIINGO_CONSOLIDATED', now, { tiingo: async () => { throw new TiingoRequestError(429); } }))
      .toMatchObject({ available: false, unavailableReason: 'PROVIDER_ERROR', providerError: 'HTTP_429' });
  });
});

const start = Date.parse('2026-10-01T13:30:00Z');
const rows = Array.from({ length: 390 }, (_, i) => ({ barStartAt: new Date(start + i * 60_000), open: 100, high: 101, low: 99, close: 100, volume: 10 }));
describe('regular-session raw minute capability', () => {
  it('normalizes the full 390-minute session and excludes extended hours and 16:00 ET', () => {
    const extra = [-1, 390, 391].map(i => ({ ...rows[0]!, barStartAt: new Date(start + i * 60_000) }));
    const result = normalizeRegularMinutes('SPY', 'MASSIVE', '2026-10-01', [...extra, ...rows], now, now);
    expect(result).toMatchObject({ complete: true, adjustmentMode: 'UNADJUSTED', expectedMinuteCount: 390, observedMinuteCount: 390 });
    expect(result.minutes[0]?.time).toBe('2026-10-01T13:30:00.000Z');
    expect(result.minutes.at(-1)?.time).toBe('2026-10-01T19:59:00.000Z');
  });
  it('marks missing or invalid regular minutes incomplete without filling them', () => {
    expect(normalizeRegularMinutes('SPY', 'TIINGO_CONSOLIDATED', '2026-10-01', rows.slice(1), now, now)).toMatchObject({ complete: false, observedMinuteCount: 389, unavailableReason: 'INCOMPLETE_MINUTES' });
    expect(normalizeRegularMinutes('SPY', 'MASSIVE', '2026-10-01', [{ ...rows[0]!, volume: -1 }], now, now)).toMatchObject({ complete: false, unavailableReason: 'INVALID_MINUTE' });
  });
  it('uses the requested cutoff and preserves raw split-sensitive prices and volumes', () => {
    const cutoff = new Date('2026-10-01T14:00:00Z');
    const partial = rows.slice(0, 31).map((row, i) => i === 0 ? { ...row, close: 50, open: 50, high: 51, low: 49, volume: 20 } : row);
    const result = normalizeRegularMinutes('SPY', 'TIINGO_CONSOLIDATED', '2026-10-01', partial, now, cutoff);
    expect(result).toMatchObject({ complete: true, expectedMinuteCount: 31, observedMinuteCount: 31, cutoff: cutoff.toISOString() });
    expect(result.minutes[0]).toMatchObject({ close: 50, volume: 20 });
  });
  it('retains one-minute raw volume and makes provider failure local', async () => {
    const result = await verifyRegularSessionMinutes('SPY', 'TIINGO_CONSOLIDATED', '2026-10-01', now, now, { tiingo: async () => rows });
    expect(result).toMatchObject({ complete: true, provider: 'TIINGO_CONSOLIDATED' });
    expect(result.minutes[0]?.volume).toBe(10);
    const other = vi.fn(async () => rows);
    expect(await verifyRegularSessionMinutes('SPY', 'MASSIVE', '2026-10-01', now, now, { massive: async () => { throw new Error('offline'); }, tiingo: other })).toMatchObject({ complete: false, provider: 'MASSIVE', unavailableReason: 'PROVIDER_ERROR' });
    expect(other).not.toHaveBeenCalled();
  });
});
