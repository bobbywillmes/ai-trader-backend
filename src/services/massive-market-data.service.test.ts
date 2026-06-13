import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../errors/http-error.js';

vi.mock('../config/env.js', () => ({
  env: {
    MASSIVE_API_KEY: 'test-massive-key',
    MASSIVE_BASE_URL: 'https://api.massive.test',
  },
}));

import {
  getIndexIntraday,
  getIndexPerformance,
  normalizeMassiveSnapshotTicker,
} from './massive-market-data.service.js';

describe('normalizeMassiveSnapshotTicker', () => {
  it('maps Massive snapshot fields into dashboard index performance', () => {
    const normalized = normalizeMassiveSnapshotTicker(
      'SPY',
      {
        lastTrade: {
          p: 543.21,
          t: 1718198100000000000,
        },
        day: {
          h: 545,
          l: 538.5,
        },
        prevDay: {
          c: 540,
        },
        todaysChange: 3.21,
        todaysChangePerc: 0.5944,
        updated: 1718197200000000000,
      },
      'open'
    );

    expect(normalized).toEqual({
      symbol: 'SPY',
      lastPrice: 543.21,
      todayChange: 3.21,
      todayChangePercent: 0.5944,
      dayHigh: 545,
      dayLow: 538.5,
      previousClose: 540,
      marketStatus: 'open',
      updatedTime: '2024-06-12T13:15:00.000Z',
    });
  });

  it('normalizes missing optional fields to null', () => {
    expect(
      normalizeMassiveSnapshotTicker('QQQ', undefined, null)
    ).toEqual({
      symbol: 'QQQ',
      lastPrice: null,
      todayChange: null,
      todayChangePercent: null,
      dayHigh: null,
      dayLow: null,
      previousClose: null,
      marketStatus: null,
      updatedTime: null,
    });
  });
});

describe('getIndexPerformance', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches market status and all four index ETF snapshots without exposing the API key in the URL', async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      if (url.includes('/v1/marketstatus/now')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            market: 'open',
            serverTime: '2026-06-12T16:00:00Z',
          }),
        };
      }

      const symbol = new URL(url).pathname.split('/').at(-1);

      return {
        ok: true,
        status: 200,
        json: async () => ({
          ticker: {
            ticker: symbol,
            lastTrade: {
              p: 100,
              t: 1718198100000000000,
            },
            day: {
              h: 101,
              l: 99,
            },
            prevDay: {
              c: 98,
            },
            todaysChange: 2,
            todaysChangePerc: 2.0408,
            updated: 1718197200000000000,
          },
        }),
      };
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getIndexPerformance();

    expect(result.marketStatus).toBe('open');
    expect(result.serverTime).toBe('2026-06-12T16:00:00Z');
    expect(result.symbols.map((symbol) => symbol.symbol)).toEqual([
      'SPY',
      'QQQ',
      'DIA',
      'IWM',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).not.toContain('test-massive-key');
      expect(options).toMatchObject({
        headers: {
          Authorization: 'Bearer test-massive-key',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      });
      expect(new URL(url).searchParams.has('_')).toBe(true);
    }
  });

  it('fails clearly when a Massive snapshot request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/v1/marketstatus/now')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              market: 'open',
            }),
          };
        }

        if (new URL(url).pathname.endsWith('/QQQ')) {
          return {
            ok: false,
            status: 429,
            json: async () => ({
              error: 'rate limit',
            }),
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            ticker: {},
          }),
        };
      })
    );

    await expect(getIndexPerformance()).rejects.toMatchObject({
      statusCode: 502,
      message: 'rate limit',
    } satisfies Partial<HttpError>);
  });
});

describe('getIndexIntraday', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches 5-minute bars for the latest snapshot trading date', async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      const parsed = new URL(url);

      if (parsed.pathname.includes('/v1/marketstatus/now')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            market: 'closed',
            serverTime: '2026-06-13T14:00:00Z',
          }),
        };
      }

      if (parsed.pathname.includes('/v2/snapshot/')) {
        const symbol = parsed.pathname.split('/').at(-1);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            ticker: {
              ticker: symbol,
              lastTrade: {
                p: 100,
                t: 1781368200000000000,
              },
            },
          }),
        };
      }

      if (parsed.pathname.includes('/v2/aggs/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                c: 100.5,
                t: 1781357400000,
              },
              {
                c: 101.25,
                t: 1781357700000,
              },
              {
                c: null,
                t: 1781358000000,
              },
            ],
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getIndexIntraday();

    expect(result.intervalMinutes).toBe(5);
    expect(result.symbols).toHaveLength(4);
    expect(result.symbols[0]).toEqual({
      symbol: 'SPY',
      date: '2026-06-13',
      points: [
        {
          close: 100.5,
          time: '2026-06-13T13:30:00.000Z',
        },
        {
          close: 101.25,
          time: '2026-06-13T13:35:00.000Z',
        },
      ],
    });

    const aggregateUrls = fetchMock.mock.calls
      .map(([url]) => new URL(url))
      .filter((url) => url.pathname.includes('/v2/aggs/'));

    expect(aggregateUrls).toHaveLength(4);
    expect(aggregateUrls[0]?.pathname).toContain(
      '/v2/aggs/ticker/SPY/range/5/minute/2026-06-13/2026-06-13'
    );
    expect(aggregateUrls[0]?.searchParams.get('adjusted')).toBe('true');
    expect(aggregateUrls[0]?.searchParams.get('sort')).toBe('asc');
  });
});
