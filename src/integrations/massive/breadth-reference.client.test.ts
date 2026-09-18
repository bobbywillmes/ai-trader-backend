import { describe, expect, it, vi } from 'vitest';
import { fetchCommonStockUniverse, fetchGroupedDailyBars } from './breadth-reference.client.js';

const groupedRow = (ticker: string, c = 100) => ({ T: ticker, v: 1000, vw: c, o: c, c, h: c, l: c, t: Date.parse('2026-09-14T04:00Z'), n: 5 });
const groupedResponse = (rows: unknown[]) => ({ status: 'OK', resultsCount: rows.length, results: rows });

describe('grouped daily bars', () => {
  it('returns a ticker -> close map from a single unpaginated response', async () => {
    const get = vi.fn().mockResolvedValue(groupedResponse([groupedRow('AAPL', 101.5), groupedRow('MSFT', 202)]));
    const bars = await fetchGroupedDailyBars('2026-09-14', get);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0]).toBe('/v2/aggs/grouped/locale/us/market/stocks/2026-09-14?adjusted=true');
    expect([...bars.entries()]).toEqual([['AAPL', 101.5], ['MSFT', 202]]);
  });
  it('accepts an explicitly empty result set', async () => {
    expect((await fetchGroupedDailyBars('2026-09-14', async () => ({ status: 'OK', resultsCount: 0 }))).size).toBe(0);
  });
  it.each([
    { row: { T: '' } }, { row: { c: null } }, { row: { c: -1 } }, { row: { c: 'NaN' } },
  ])('rejects malformed rows %j', async ({ row }) => {
    await expect(fetchGroupedDailyBars('2026-09-14', async () => groupedResponse([{ ...groupedRow('AAPL'), ...row }]))).rejects.toThrow('Massive breadth reference');
  });
  it('rejects a duplicate ticker within one response instead of silently overwriting it', async () => {
    await expect(fetchGroupedDailyBars('2026-09-14', async () => groupedResponse([groupedRow('AAPL', 100), groupedRow('AAPL', 101)]))).rejects.toThrow('duplicate ticker');
  });
  it('rejects a non-success status and a missing results array', async () => {
    await expect(fetchGroupedDailyBars('2026-09-14', async () => ({ status: 'ERROR' }))).rejects.toThrow('status');
    await expect(fetchGroupedDailyBars('2026-09-14', async () => ({ status: 'OK' }))).rejects.toThrow('results');
  });
});

const universeRow = (ticker: string) => ({ ticker, type: 'CS', active: true });

describe('point-in-time common-stock universe', () => {
  it('requests locale=us/market=stocks/type=CS/active=true for the exact date', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'OK', results: [universeRow('A')] });
    await fetchCommonStockUniverse('2022-01-10', get);
    expect(get.mock.calls[0]?.[0]).toBe('/v3/reference/tickers?locale=us&market=stocks&type=CS&active=true&date=2022-01-10&sort=ticker&limit=1000');
  });
  it('follows same-origin cursor pagination deterministically and stops without a next_url', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 'OK', results: [universeRow('A'), universeRow('AA')], next_url: 'https://api.massive.com/v3/reference/tickers?cursor=abc' })
      .mockResolvedValueOnce({ status: 'OK', results: [universeRow('MSFT')] });
    const universe = await fetchCommonStockUniverse('2024-06-10', get);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]?.[0]).toBe('/v3/reference/tickers?cursor=abc');
    expect(universe).toEqual(['A', 'AA', 'MSFT']);
  });
  it('rejects duplicate tickers across pages instead of double-counting the universe', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 'OK', results: [universeRow('A')], next_url: 'https://api.massive.com/v3/reference/tickers?cursor=abc' })
      .mockResolvedValueOnce({ status: 'OK', results: [universeRow('A')] });
    await expect(fetchCommonStockUniverse('2024-06-10', get)).rejects.toThrow('duplicate ticker');
  });
  it('rejects a non-CS or inactive row rather than filtering it locally', async () => {
    await expect(fetchCommonStockUniverse('2024-06-10', async () => ({ status: 'OK', results: [{ ticker: 'SPY', type: 'ETF', active: true }] }))).rejects.toThrow('non-CS');
    await expect(fetchCommonStockUniverse('2024-06-10', async () => ({ status: 'OK', results: [{ ticker: 'X', type: 'CS', active: false }] }))).rejects.toThrow('non-CS');
  });
  it('rejects a foreign or malformed pagination destination', async () => {
    await expect(fetchCommonStockUniverse('2024-06-10', async () => ({ status: 'OK', results: [universeRow('A')], next_url: 'https://other.example/steal' }))).rejects.toThrow('pagination');
  });
  it('fails closed on a provider fetch failure rather than returning a partial universe', async () => {
    await expect(fetchCommonStockUniverse('2024-06-10', async () => { throw new Error('network down'); })).rejects.toThrow();
  });
  it('bounds pagination so a runaway provider loop cannot hang the runner', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'OK', results: [], next_url: 'https://api.massive.com/v3/reference/tickers?cursor=loop' });
    await expect(fetchCommonStockUniverse('2024-06-10', get)).rejects.toThrow('pagination loop or limit');
  });
});
