import { describe, expect, it, vi } from 'vitest';
import { normalizeTiingoDaily, normalizeTiingoIntraday, normalizeTiingoLatest, TiingoRestClient } from './rest.client.js';

const daily = { date: '2026-09-24T00:00:00.000Z', open: 100, high: 102, low: 99, close: 101, volume: 1000, splitFactor: 1 };
const minute = { date: '2026-09-24T14:30:00.000Z', open: 100, high: 102, low: 99, close: 101, volume: 1000 };

describe('Tiingo REST normalization', () => {
  it('preserves raw daily OHLCV and provider split factor', () => {
    expect(normalizeTiingoDaily([daily])).toEqual([{ barStartAt: new Date(daily.date), open: 100, high: 102, low: 99, close: 101, volume: 1000, splitFactor: 1 }]);
  });
  it.each([{ ...daily, splitFactor: 0 }, { ...daily, splitFactor: '1' }, { ...daily, high: 98 }, { ...daily, volume: -1 }])('rejects invalid daily evidence', row => {
    expect(() => normalizeTiingoDaily([row])).toThrow();
  });
  it('rejects duplicates and does not fabricate intraday split factors', () => {
    expect(() => normalizeTiingoIntraday([minute, minute])).toThrow('duplicate');
    expect(normalizeTiingoIntraday([minute])[0]).not.toHaveProperty('splitFactor');
    expect(normalizeTiingoLatest([minute], 'spy')).toEqual({ symbol: 'SPY', price: 101, observedAt: new Date(minute.date) });
  });
  it('bounds requests and excludes token and upstream body from errors', async () => {
    const fetcher = vi.fn(async () => new Response('secret-token upstream details', { status: 429 }));
    const client = new TiingoRestClient({ token: 'secret-token', fetcher, maxConcurrency: 1 });
    await expect(client.daily('SPY', '2026-09-24', '2026-09-24')).rejects.toThrow('Tiingo HTTP 429');
    expect(fetcher.mock.calls).toHaveLength(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).not.toContain('secret-token');
    expect(options.headers).toMatchObject({ Authorization: 'Token secret-token' });
    expect(options.signal).toBeDefined();
  });
});
