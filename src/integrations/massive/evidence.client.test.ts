import { describe, expect, it, vi } from 'vitest';
import { fetchDailyEvidence, fetchMinuteEvidence, fetchSplitEvidence } from './evidence.client.js';
const row = { t: Date.parse('2026-09-14T04:00Z'), o: 100, h: 102, l: 99, c: 101, v: 1000.25 };
const response = (results: unknown[] = [row]) => ({ status: 'OK', adjusted: false, ticker: 'SPY', results });
// 2026-09-14 is EDT (UTC-4); 13:30Z = 09:30 ET, the first regular-session 15-minute interval.
const minuteRow = { t: Date.parse('2026-09-14T13:30Z'), o: 100, h: 102, l: 99, c: 101, v: 500 };
describe('strict Massive evidence', () => {
  it('explicitly requests unadjusted data and follows safe pages', async () => {
    const get = vi.fn().mockResolvedValueOnce({ ...response(), next_url: 'https://api.massive.com/v2/aggs/ticker/SPY/range/1/day/2026-09-14/2026-09-15?cursor=next' }).mockResolvedValueOnce(response([{ ...row, t: Date.parse('2026-09-15T04:00Z') }]));
    const bars = await fetchDailyEvidence('SPY', '2026-09-14', '2026-09-15', get);
    expect(bars).toHaveLength(2); expect(bars[0]?.volume).toBe('1000.25');
    expect(get.mock.calls.every(call => call[0].includes('adjusted=false'))).toBe(true);
  });
  it.each([{ c: null }, { v: undefined }, { t: 1 }, { o: -1 }, { l: 105 }, { h: 90 }, { v: -1 }, { c: 'NaN' }, { t: Date.parse('2026-09-14T14:00Z') }])('rejects malformed evidence instead of filtering %j', async invalid => {
    await expect(fetchDailyEvidence('SPY', '2026-09-14', '2026-09-14', async () => response([{ ...row, ...invalid }]))).rejects.toThrow('Massive evidence');
  });
  it('rejects adjusted, incomplete and foreign pagination responses', async () => {
    await expect(fetchDailyEvidence('SPY', '2026-09-14', '2026-09-14', async () => ({ ...response(), adjusted: true }))).rejects.toThrow('adjustment');
    await expect(fetchDailyEvidence('SPY', '2026-09-14', '2026-09-14', async () => ({ status: 'OK', ticker: 'SPY', adjusted: false }))).rejects.toThrow('results');
    await expect(fetchDailyEvidence('SPY', '2026-09-14', '2026-09-14', async () => ({ ...response(), next_url: 'https://other.example/steal' }))).rejects.toThrow('pagination');
  });
  it('accepts an explicitly empty aggregate result', async () => {
    expect(await fetchDailyEvidence('SPY', '2026-09-14', '2026-09-14', async () => ({ status: 'OK', adjusted: false, ticker: 'SPY', resultsCount: 0 }))).toEqual([]);
  });
  it('returns bounded split dates and factors without using cumulative future factors', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'OK', results: [{ id: 'split', ticker: 'SPY', execution_date: '2026-09-14', split_from: 1, split_to: 2, historical_adjustment_factor: 0.1 }] });
    expect(await fetchSplitEvidence('SPY', '2026-01-01', '2026-09-15', get)).toEqual([{ id: 'split', symbol: 'SPY', executionDate: '2026-09-14', splitFrom: 1, splitTo: 2, priceFactor: 0.5 }]);
    expect(get.mock.calls[0]?.[0]).toContain('execution_date.lte=2026-09-15');
  });
  it('accepts a bar aligned to a regular-session 15-minute interval', async () => {
    const bars = await fetchMinuteEvidence('SPY', '2026-09-14', '2026-09-14', async () => ({ status: 'OK', adjusted: false, ticker: 'SPY', results: [minuteRow] }));
    expect(bars).toHaveLength(1); expect(bars[0]?.volume).toBe('500');
  });
  it('rejects a bar not aligned to the 09:30 ET 15-minute grid', async () => {
    await expect(fetchMinuteEvidence('SPY', '2026-09-14', '2026-09-14', async () => ({ status: 'OK', adjusted: false, ticker: 'SPY', results: [{ ...minuteRow, t: Date.parse('2026-09-14T13:35Z') }] }))).rejects.toThrow('not aligned');
  });
  it('rejects a bar outside the 09:30-16:00 ET regular session window', async () => {
    await expect(fetchMinuteEvidence('SPY', '2026-09-14', '2026-09-14', async () => ({ status: 'OK', adjusted: false, ticker: 'SPY', results: [{ ...minuteRow, t: Date.parse('2026-09-14T13:00Z') }] }))).rejects.toThrow('not aligned');
  });
});
