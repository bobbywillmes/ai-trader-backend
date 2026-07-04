import { env } from '../config/env.js';
import { HttpError } from '../errors/http-error.js';

export type MassiveNewsPayload = {
  results?: unknown;
  [key: string]: unknown;
};

export type FetchMassiveNewsRequest = {
  ticker: string;
  sincePublishedAt?: Date;
  limit?: number;
};

const DEFAULT_NEWS_LIMIT = 50;
const MAX_NEWS_LIMIT = 1000;

function normalizeTicker(ticker: string) {
  const normalized = ticker.trim().toUpperCase();

  if (normalized === '') {
    throw new HttpError(400, 'Massive news ticker is required.');
  }

  return normalized;
}

function normalizeLimit(limit: number | undefined) {
  if (!Number.isInteger(limit) || limit === undefined || limit <= 0) {
    return DEFAULT_NEWS_LIMIT;
  }

  return Math.min(limit, MAX_NEWS_LIMIT);
}

function buildMassiveNewsUrl(request: FetchMassiveNewsRequest) {
  const url = new URL('/v2/reference/news', env.MASSIVE_BASE_URL);

  url.searchParams.set('ticker', normalizeTicker(request.ticker));
  url.searchParams.set('sort', 'published_utc');
  url.searchParams.set('order', 'asc');
  url.searchParams.set('limit', String(normalizeLimit(request.limit)));

  if (request.sincePublishedAt) {
    url.searchParams.set(
      'published_utc.gt',
      request.sincePublishedAt.toISOString()
    );
  }

  return url.toString();
}

async function massiveNewsGet(
  request: FetchMassiveNewsRequest
): Promise<MassiveNewsPayload> {
  const url = buildMassiveNewsUrl(request);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${env.MASSIVE_API_KEY}`,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const upstreamError =
      data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : null;
    const upstreamMessage =
      data && typeof data === 'object' && 'message' in data
        ? String(data.message)
        : null;
    const message =
      upstreamError ??
      upstreamMessage ??
      `Massive news request failed with status ${response.status}`;

    throw new HttpError(502, message, {
      upstreamStatus: response.status,
      ticker: normalizeTicker(request.ticker),
      upstream:
        data && typeof data === 'object'
          ? {
              error: upstreamError,
              message: upstreamMessage,
              status: 'status' in data ? String(data.status) : null,
              requestId: 'request_id' in data ? String(data.request_id) : null,
            }
          : null,
    });
  }

  return data && typeof data === 'object' ? (data as MassiveNewsPayload) : {};
}

export async function fetchMassiveNews(
  request: FetchMassiveNewsRequest
): Promise<MassiveNewsPayload> {
  return massiveNewsGet(request);
}
