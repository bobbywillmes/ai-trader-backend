import { describe, expect, it, vi } from 'vitest';
import { fetchBars, months } from './intraday-stress-data.js';
import { etInstant } from '../services/market-calendar.js';
const row = { t: etInstant('2026-09-17', 570).getTime(), o: 100, h: 101, l: 99, c: 100, v: 10 };
const page = { status: 'OK', ticker: 'SPY', adjusted: false, results: [row] };
describe('bounded research provider boundary', () => {
  it('requests unadjusted 15-minute evidence and retains the endpoint identity', async () => {
    const transport = vi.fn(async () => page);
    const bars = await fetchBars('SPY', 'MINUTE_15', '2026-09-17', '2026-09-17', transport);
    expect(transport).toHaveBeenCalledWith('/v2/aggs/ticker/SPY/range/15/minute/2026-09-17/2026-09-17?adjusted=false&sort=asc&limit=50000');
    expect(bars[0]).toMatchObject({ symbol: 'SPY', timeframe: 'MINUTE_15', low: 99 });
  });
  it.each([{ adjusted: true }, { ticker: 'RSP' }, { status: 'ERROR' }, { results: [{ ...row, t: row.t - 86400000 }] }, { results: [row, row] }, { next_url: 'https://attacker.invalid/path' }])('fails closed on identity, pagination and interval corruption: %j', async patch => {
    await expect(fetchBars('SPY', 'MINUTE_15', '2026-09-17', '2026-09-17', async () => ({ ...page, ...patch }))).rejects.toThrow();
  });
  it('accepts explicit empty responses as absent evidence', async () => {
    expect(await fetchBars('SPY', 'DAY_1', '2026-09-17', '2026-09-17', async () => ({ status: 'OK', ticker: 'SPY', adjusted: false, resultsCount: 0 }))).toEqual([]);
  });
  it('chunks full leap months and the partial final month without overlaps', () => {
    expect(months('2024-02-01', '2024-03-12')).toEqual([['2024-02-01', '2024-02-29'], ['2024-03-01', '2024-03-12']]);
  });
});
