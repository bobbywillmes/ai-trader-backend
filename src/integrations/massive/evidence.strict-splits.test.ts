import { describe, expect, it, vi } from 'vitest';
import { fetchDailyEvidence, fetchSplitEvidence, fetchStrictSplitEvidence } from './evidence.client.js';
const split = { id: 'one', ticker: 'QQQ', execution_date: '2026-09-14', split_from: 1, split_to: 2 };
const page = (results: unknown[] = [split]) => ({ status: 'OK', results });
describe('strict production split evidence', () => {
  it('retains complete normalized identity and distinguishes empty success from request failure', async () => {
    expect(await fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => page())).toEqual([{ id: 'one', symbol: 'QQQ', executionDate: '2026-09-14', splitFrom: 1, splitTo: 2, priceFactor: 0.5 }]);
    expect(await fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => page([]))).toEqual([]);
    await expect(fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => { throw new Error('secret provider response'); })).rejects.toThrow('Massive evidence: split request failed');
  });
  it.each([[split, split], [split, { ...split, id: 'two' }], [split, { ...split, split_to: 3 }], [split, { ...split, execution_date: '2026-09-15' }]])('rejects duplicates before dedupe %j', async (...rows) => {
    await expect(fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => page(rows))).rejects.toThrow('duplicate');
  });
  it('rejects identical duplicates across pages but preserves legacy deduplication', async () => {
    const get = vi.fn().mockResolvedValueOnce({ ...page(), next_url: '/stocks/v1/splits?cursor=two' }).mockResolvedValueOnce(page());
    await expect(fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', get)).rejects.toThrow('duplicate');
    expect(await fetchSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => page([split, split]))).toHaveLength(1);
  });
  it.each([{ ticker: 'SPY' }, { execution_date: '2026-09-16' }, { execution_date: '2026-02-30' }, { id: '' }, { split_from: 0 }, { split_to: -1 }, { split_to: Infinity }, { split_from: 'NaN' }])('rejects malformed identity/ratio %j', async override => {
    await expect(fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => page([{ ...split, ...override }]))).rejects.toThrow('Massive evidence');
  });
  it.each(['https://foreign.example/stocks/v1/splits?apiKey=secret', '/other', '', '/stocks/v1/splits?cursor=loop'])('rejects unsafe or looping pagination %s', async next_url => {
    await expect(fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => ({ ...page([]), next_url }))).rejects.toThrow(/pagination/);
  });
  it.each([{ status: 'ERROR', results: [] }, { status: 'OK' }])('rejects incomplete responses %j', async response => {
    await expect(fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => response)).rejects.toThrow();
  });
  it('follows safe complete pages, strips credentials, and enforces the page bound', async () => {
    const get = vi.fn().mockResolvedValueOnce({ ...page(), next_url: '/stocks/v1/splits?cursor=two&apiKey=secret' }).mockResolvedValueOnce(page([{ ...split, id: 'two', execution_date: '2026-09-15' }]));
    expect(await fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', get)).toHaveLength(2);
    expect(get.mock.calls[1]![0]).not.toContain('secret');
    let count = 0;
    await expect(fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => ({ ...page([]), next_url: `/stocks/v1/splits?cursor=${++count}` }))).rejects.toThrow('limit');
    expect(count).toBe(20);
    await expect(fetchStrictSplitEvidence('QQQ', '2026-09-01', '2026-09-15', async () => ({ ...page([]), next_url: 'https://[invalid?apiKey=secret' }))).rejects.toThrow('invalid pagination link');
  });
  it.each(['QQQ', 'DIA', 'IWM'] as const)('accepts daily evidence for %s without weakening validation', async ticker => {
    const response = { status: 'OK', ticker, adjusted: false, results: [{ t: Date.parse('2026-09-14T04:00Z'), o: 1, h: 2, l: 1, c: 2, v: 0 }] };
    expect(await fetchDailyEvidence(ticker, '2026-09-14', '2026-09-14', async () => response)).toHaveLength(1);
    await expect(fetchDailyEvidence(ticker, '2026-09-14', '2026-09-14', async () => ({ ...response, ticker: 'SPY' }))).rejects.toThrow('ticker');
  });
});
