import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../errors/http-error.js';

vi.mock('../config/env.js', () => ({
  env: {
    MASSIVE_API_KEY: 'test-massive-key',
    MASSIVE_BASE_URL: 'https://api.massive.test',
  },
}));

import { fetchMassiveNews } from './massive-news.service.js';

describe('fetchMassiveNews', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('requests Massive reference news with ticker, ascending publish time, limit, and since timestamp', async () => {
    const payload = {
      results: [
        {
          id: 'article-1',
          title: 'AAPL expands AI partnerships',
        },
      ],
    };
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }));

    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchMassiveNews({
        ticker: ' aapl ',
        sincePublishedAt: new Date('2026-07-04T12:30:00Z'),
        limit: 25,
      })
    ).resolves.toBe(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const parsed = new URL(String(url));

    expect(parsed.origin).toBe('https://api.massive.test');
    expect(parsed.pathname).toBe('/v2/reference/news');
    expect(parsed.searchParams.get('ticker')).toBe('AAPL');
    expect(parsed.searchParams.get('sort')).toBe('published_utc');
    expect(parsed.searchParams.get('order')).toBe('asc');
    expect(parsed.searchParams.get('limit')).toBe('25');
    expect(parsed.searchParams.get('published_utc.gt')).toBe(
      '2026-07-04T12:30:00.000Z'
    );
    expect(String(url)).not.toContain('test-massive-key');
    expect(options).toMatchObject({
      headers: {
        Authorization: 'Bearer test-massive-key',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
  });

  it('uses a safe default limit when no limit is provided', async () => {
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    }));

    vi.stubGlobal('fetch', fetchMock);

    await fetchMassiveNews({
      ticker: 'MSFT',
    });

    const [url] = fetchMock.mock.calls[0] ?? [];

    expect(new URL(String(url)).searchParams.get('limit')).toBe('50');
  });

  it('fails clearly when Massive returns an error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({
          error: 'rate limit',
          message: 'too many requests',
          status: 'ERROR',
          request_id: 'req_news_123',
        }),
      }))
    );

    await expect(
      fetchMassiveNews({
        ticker: 'NVDA',
      })
    ).rejects.toMatchObject({
      statusCode: 502,
      message: 'rate limit',
      details: {
        upstreamStatus: 429,
        ticker: 'NVDA',
        upstream: {
          error: 'rate limit',
          message: 'too many requests',
          status: 'ERROR',
          requestId: 'req_news_123',
        },
      },
    } satisfies Partial<HttpError>);
  });
});
