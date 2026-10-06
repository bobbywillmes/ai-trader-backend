import { describe, expect, it } from 'vitest';
import { TiingoRequestError, normalizeTiingoDaily, tiingoSymbol } from '../integrations/tiingo/rest.client.js';
import { canonicalTiingoBar, retryDelay, tiingoDayEligible } from './tiingo-daily.service.js';

describe('Tiingo DAY_1 evidence boundary', () => {
  it('maps supported share classes without changing the canonical Security symbol', () => {
    expect(['BRK.B', 'MOG.A', 'GEF.B'].map(tiingoSymbol)).toEqual(['BRK-B', 'MOG-A', 'GEF-B']);
    expect(tiingoSymbol('AAPL')).toBe('AAPL');
    expect(() => tiingoSymbol('BRK.B.C')).toThrow();
    expect(() => tiingoSymbol('BRK-B')).toThrow();
  });
  it('uses raw OHLCV and requires splitFactor while ignoring adjusted fields', () => {
    const row = normalizeTiingoDaily([{ date: '2026-09-25T00:00:00Z', open: 10.123456789, high: 12, low: 9, close: 11, volume: 1234, splitFactor: 2, adjOpen: 5, adjClose: 5.5 }])[0]!;
    const canonical = canonicalTiingoBar(row);
    expect(canonical.open.toString()).toBe('10.123456789');
    expect(canonical.volume.toString()).toBe('1234');
    expect(canonical.splitFactor.toString()).toBe('2');
    expect(() => normalizeTiingoDaily([{ date: '2026-09-25T00:00:00Z', open: 10, high: 10, low: 10, close: 10, volume: 1 }])).toThrow();
    expect(() => canonicalTiingoBar({ ...row, splitFactor: 0 })).toThrow();
    expect(() => canonicalTiingoBar({ ...row, splitFactor: Infinity })).toThrow();
  });
  it('uses the 20:15 Eastern immutable acceptance boundary', () => {
    expect(tiingoDayEligible('2026-09-28', new Date('2026-09-29T00:14:59Z'))).toBe(false);
    expect(tiingoDayEligible('2026-09-28', new Date('2026-09-29T00:15:00Z'))).toBe(true);
    expect(tiingoDayEligible('2026-09-25', new Date('2026-09-28T12:00:00Z'))).toBe(true);
  });
  it('retries bounded transient status and transport errors only', () => {
    expect(retryDelay(new TiingoRequestError(429, 9000), 0)).toBe(9000);
    expect(retryDelay(new TiingoRequestError(503), 2)).toBe(2000);
    expect(retryDelay(new TiingoRequestError(null), 1)).toBe(1000);
    expect(retryDelay(new TiingoRequestError(404), 0)).toBeNull();
    expect(retryDelay(new Error('invalid data'), 0)).toBeNull();
  });
});
