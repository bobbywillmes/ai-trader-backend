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
  parseIndexChartRange,
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

  it('rejects timestamp zero instead of normalizing it to 1970', () => {
    const normalized = normalizeMassiveSnapshotTicker(
      'SPY',
      {
        lastTrade: {
          p: 100,
          t: 0,
        },
        updated: 0,
      },
      'closed'
    );

    expect(normalized.updatedTime).toBeNull();
  });

  it('does not treat cleared zero-valued weekend snapshot prices as market prices', () => {
    const normalized = normalizeMassiveSnapshotTicker(
      'SPY',
      {
        lastTrade: {
          p: 0,
          t: 0,
        },
        min: {
          c: 0,
          t: 0,
        },
        day: {
          c: 0,
          h: 0,
          l: 0,
          t: 0,
        },
        prevDay: {
          c: 540,
          t: Date.UTC(2026, 5, 12, 20),
        },
        todaysChange: 0,
        todaysChangePerc: 0,
        updated: 0,
      },
      'closed'
    );

    expect(normalized).toMatchObject({
      lastPrice: null,
      todayChange: null,
      todayChangePercent: null,
      dayHigh: null,
      dayLow: null,
      previousClose: 540,
      updatedTime: '2026-06-12T20:00:00.000Z',
    });
  });

  it('uses prevDay.t as a valid latest market timestamp when current prices are cleared', () => {
    const normalized = normalizeMassiveSnapshotTicker(
      'QQQ',
      {
        day: {
          c: 0,
          h: 0,
          l: 0,
          t: 0,
        },
        prevDay: {
          c: 470.25,
          t: Date.UTC(2026, 5, 12, 20),
        },
        updated: 0,
      },
      'closed'
    );

    expect(normalized.updatedTime).toBe('2026-06-12T20:00:00.000Z');
    expect(normalized.previousClose).toBe(470.25);
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
              message: 'too many requests',
              status: 'ERROR',
              request_id: 'req_123',
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
      details: {
        upstreamStatus: 429,
        upstream: {
          error: 'rate limit',
          message: 'too many requests',
          status: 'ERROR',
          requestId: 'req_123',
        },
      },
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
                h: 101,
                l: 99,
                o: 99.5,
                t: 1781357400000,
              },
              {
                c: 101.25,
                h: 102,
                l: 100,
                o: 100.5,
                t: 1781357700000,
              },
              {
                c: null,
                h: 103,
                l: 98,
                o: 101,
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

    expect(result.range).toBe('1d');
    expect(result.rangeLabel).toBe('1D');
    expect(result.interval).toEqual({
      multiplier: 5,
      timespan: 'minute',
    });
    expect(result.symbols).toHaveLength(4);
    expect(result.symbols[0]).toEqual({
      symbol: 'SPY',
      from: '2026-06-13',
      to: '2026-06-13',
      summary: {
        open: 99.5,
        close: 101.25,
        change: 1.75,
        changePercent: 1.7587939698492463,
        high: 102,
        low: 99,
      },
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

  it('scales the aggregate interval and date range for longer chart ranges', async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      const parsed = new URL(url);

      if (parsed.pathname.includes('/v1/marketstatus/now')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            market: 'closed',
          }),
        };
      }

      if (parsed.pathname.includes('/v2/snapshot/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ticker: {
              lastTrade: {
                p: 100,
                t: 1781368200000000000,
              },
            },
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              c: 100,
              h: 101,
              l: 99,
              o: 99.5,
              t: 1781357400000,
            },
          ],
        }),
      };
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getIndexIntraday('30d');

    expect(result.range).toBe('30d');
    expect(result.rangeLabel).toBe('30D');
    expect(result.interval).toEqual({
      multiplier: 4,
      timespan: 'hour',
    });
    expect(result.symbols[0]).toMatchObject({
      from: '2026-05-15',
      to: '2026-06-13',
    });

    const aggregateUrl = fetchMock.mock.calls
      .map(([url]) => new URL(url))
      .find((url) => url.pathname.includes('/v2/aggs/'));

    expect(aggregateUrl?.pathname).toContain(
      '/v2/aggs/ticker/SPY/range/4/hour/2026-05-15/2026-06-13'
    );
  });

  it('uses prevDay timestamps from cleared weekend snapshots and never requests 1969 or 1970 aggregates', async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      const parsed = new URL(url);

      if (parsed.pathname.includes('/v1/marketstatus/now')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            market: 'closed',
            serverTime: '2026-06-14T16:00:00Z',
          }),
        };
      }

      if (parsed.pathname.includes('/v2/snapshot/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ticker: {
              lastTrade: {
                p: 0,
                t: 0,
              },
              min: {
                c: 0,
                t: 0,
              },
              day: {
                c: 0,
                h: 0,
                l: 0,
                t: 0,
              },
              prevDay: {
                c: 540,
                t: Date.UTC(2026, 5, 12, 20),
              },
              todaysChange: 0,
              todaysChangePerc: 0,
              updated: 0,
            },
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              c: 541,
              h: 542,
              l: 539,
              o: 540,
              t: Date.UTC(2026, 5, 12, 13, 30),
            },
            {
              c: 543,
              h: 544,
              l: 540,
              o: 541,
              t: Date.UTC(2026, 5, 12, 20),
            },
          ],
        }),
      };
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getIndexIntraday('1d');

    expect(result.symbols[0]).toMatchObject({
      from: '2026-06-12',
      to: '2026-06-12',
      summary: {
        open: 540,
        close: 543,
        change: 3,
      },
    });

    const aggregatePaths = fetchMock.mock.calls
      .map(([url]) => new URL(url).pathname)
      .filter((path) => path.includes('/v2/aggs/'));

    expect(aggregatePaths).toHaveLength(4);
    expect(aggregatePaths.every((path) => path.includes('2026-06-12'))).toBe(
      true
    );
    expect(aggregatePaths.join('\n')).not.toMatch(/1969|1970/);
  });

  it('falls back from a Sunday one-day request to the latest returned trading session', async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      const parsed = new URL(url);
      const path = parsed.pathname;

      if (path.includes('/v1/marketstatus/now')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ market: 'closed' }),
        };
      }

      if (path.includes('/v2/snapshot/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ticker: {
              lastTrade: {
                p: 100,
                t: Date.UTC(2026, 5, 14, 16),
              },
            },
          }),
        };
      }

      if (path.includes('/range/5/minute/2026-06-14/2026-06-14')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [] }),
        };
      }

      if (path.includes('/range/1/day/2026-06-04/2026-06-14')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                c: 101,
                h: 102,
                l: 99,
                o: 100,
                t: Date.UTC(2026, 5, 12, 20),
              },
            ],
          }),
        };
      }

      if (path.includes('/range/5/minute/2026-06-12/2026-06-12')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              {
                c: 100.5,
                h: 101,
                l: 99.5,
                o: 100,
                t: Date.UTC(2026, 5, 12, 13, 30),
              },
              {
                c: 101,
                h: 101.5,
                l: 100,
                o: 100.5,
                t: Date.UTC(2026, 5, 12, 20),
              },
            ],
          }),
        };
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getIndexIntraday('1d');

    expect(result.symbols[0]).toMatchObject({
      from: '2026-06-12',
      to: '2026-06-12',
      points: [
        {
          close: 100.5,
          time: '2026-06-12T13:30:00.000Z',
        },
        {
          close: 101,
          time: '2026-06-12T20:00:00.000Z',
        },
      ],
    });

    const aggregatePaths = fetchMock.mock.calls
      .map(([url]) => new URL(url).pathname)
      .filter((path) => path.includes('/v2/aggs/'));

    expect(aggregatePaths).toContain(
      '/v2/aggs/ticker/SPY/range/5/minute/2026-06-14/2026-06-14'
    );
    expect(aggregatePaths).toContain(
      '/v2/aggs/ticker/SPY/range/1/day/2026-06-04/2026-06-14'
    );
    expect(aggregatePaths).toContain(
      '/v2/aggs/ticker/SPY/range/5/minute/2026-06-12/2026-06-12'
    );
  });

  it('returns an empty one-day chart without throwing when holiday lookback has no sessions', async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      const parsed = new URL(url);

      if (parsed.pathname.includes('/v1/marketstatus/now')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ market: 'closed' }),
        };
      }

      if (parsed.pathname.includes('/v2/snapshot/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ticker: {
              lastTrade: {
                p: 100,
                t: Date.UTC(2026, 6, 3, 16),
              },
            },
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      };
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getIndexIntraday('1d');

    expect(result.symbols[0]).toEqual({
      symbol: 'SPY',
      from: '2026-07-03',
      to: '2026-07-03',
      summary: {
        open: null,
        close: null,
        change: null,
        changePercent: null,
        high: null,
        low: null,
      },
      points: [],
    });
  });

  it('keeps normal weekday one-day behavior when the requested session has bars', async () => {
    const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => {
      const parsed = new URL(url);

      if (parsed.pathname.includes('/v1/marketstatus/now')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ market: 'open' }),
        };
      }

      if (parsed.pathname.includes('/v2/snapshot/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ticker: {
              lastTrade: {
                p: 101,
                t: Date.UTC(2026, 5, 12, 16),
              },
            },
          }),
        };
      }

      if (parsed.pathname.includes('/range/1/day/')) {
        throw new Error(`Unexpected daily fallback ${url}`);
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              c: 100.5,
              h: 101,
              l: 99.5,
              o: 100,
              t: Date.UTC(2026, 5, 12, 13, 30),
            },
          ],
        }),
      };
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getIndexIntraday('1d');

    expect(result.symbols[0]).toMatchObject({
      from: '2026-06-12',
      to: '2026-06-12',
    });

    const aggregatePaths = fetchMock.mock.calls
      .map(([url]) => new URL(url).pathname)
      .filter((path) => path.includes('/v2/aggs/'));

    expect(aggregatePaths).toHaveLength(4);
    expect(aggregatePaths[0]).toContain(
      '/v2/aggs/ticker/SPY/range/5/minute/2026-06-12/2026-06-12'
    );
  });
});

describe('parseIndexChartRange', () => {
  it('defaults invalid values to the one-day range', () => {
    expect(parseIndexChartRange(undefined)).toBe('1d');
    expect(parseIndexChartRange('bad')).toBe('1d');
  });

  it('accepts supported chart ranges', () => {
    expect(parseIndexChartRange('7d')).toBe('7d');
    expect(parseIndexChartRange('14d')).toBe('14d');
    expect(parseIndexChartRange('30d')).toBe('30d');
    expect(parseIndexChartRange('6m')).toBe('6m');
    expect(parseIndexChartRange('1y')).toBe('1y');
  });
});
