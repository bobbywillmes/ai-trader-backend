import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  shouldDefer: vi.fn(),
  getBackoffUntil: vi.fn(),
  beginRequest: vi.fn(),
  completeRequest: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({
  env: {
    ALPACA_API_KEY: 'test-key',
    ALPACA_API_SECRET: 'test-secret',
    ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
  },
}));

vi.mock('../../services/alpaca-api-usage.service.js', () => ({
  alpacaApiUsageRegistry: {
    shouldDefer: mocks.shouldDefer,
    getBackoffUntil: mocks.getBackoffUntil,
    beginRequest: mocks.beginRequest,
    completeRequest: mocks.completeRequest,
  },
}));

import { AlpacaApiError } from '../../errors/alpaca-api-error.js';
import { alpacaRequest } from './client.js';
import type { AlpacaRequestMetadata } from './request-metadata.js';

const accountReadMetadata: AlpacaRequestMetadata = {
  operation: 'account_read',
  endpoint: 'GET /v2/account',
  method: 'GET',
  requestClass: 'informational_read',
  deferDuringRateLimit: false,
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  });
}

describe('alpacaRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.shouldDefer.mockReturnValue(false);
    mocks.getBackoffUntil.mockReturnValue(null);
    mocks.beginRequest.mockReturnValue({
      metadata: accountReadMetadata,
      startedAt: new Date('2026-06-20T00:00:00.000Z'),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves successful JSON return values while sending Alpaca credentials', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ id: 'account-1' }));

    await expect(
      alpacaRequest('/v2/account', {
        metadata: accountReadMetadata,
      })
    ).resolves.toEqual({ id: 'account-1' });

    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://paper-api.alpaca.markets/v2/account',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'APCA-API-KEY-ID': 'test-key',
          'APCA-API-SECRET-KEY': 'test-secret',
        }),
      })
    );
    expect(mocks.completeRequest).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        statusCode: 200,
        outcome: 'success',
      })
    );
  });

  it('preserves AlpacaApiError for HTTP failures', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response('rejected', {
        status: 422,
      })
    );

    await expect(
      alpacaRequest('/v2/account', {
        metadata: accountReadMetadata,
      })
    ).rejects.toMatchObject({
      name: 'AlpacaApiError',
      statusCode: 422,
      responseBody: 'rejected',
    } satisfies Partial<AlpacaApiError>);
    expect(mocks.completeRequest).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        statusCode: 422,
        outcome: 'client_error',
      })
    );
  });

  it('preserves 404-as-null behavior when requested', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    await expect(
      alpacaRequest('/v2/orders/order-123', {
        returnNullOn404: true,
        metadata: {
          operation: 'protective_order_sync',
          endpoint: 'GET /v2/orders/:orderId',
          method: 'GET',
          requestClass: 'synchronization_read',
          deferDuringRateLimit: true,
        },
      })
    ).resolves.toBeNull();
  });

  it('rejects unknown operation and endpoint keys before fetch', async () => {
    await expect(
      alpacaRequest('/v2/account', {
        metadata: {
          ...accountReadMetadata,
          operation: 'GET /v2/account' as never,
        },
      })
    ).rejects.toThrow('Unknown Alpaca API operation');

    await expect(
      alpacaRequest('/v2/account', {
        metadata: {
          ...accountReadMetadata,
          endpoint: 'GET /v2/account/abc123' as never,
        },
      })
    ).rejects.toThrow('Unknown Alpaca API endpoint');

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.beginRequest).not.toHaveBeenCalled();
  });

  it('rejects mismatched declared request methods before fetch', async () => {
    await expect(
      alpacaRequest('/v2/orders', {
        method: 'POST',
        metadata: {
          operation: 'pending_order_submission',
          endpoint: 'POST /v2/orders',
          method: 'GET',
          requestClass: 'critical_write',
          deferDuringRateLimit: false,
        },
      })
    ).rejects.toThrow('metadata method GET does not match request method POST');

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.beginRequest).not.toHaveBeenCalled();
  });

  it('measures 429 responses separately', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response('rate limited', {
        status: 429,
        headers: {
          'retry-after': '30',
        },
      })
    );

    await expect(
      alpacaRequest('/v2/account', {
        metadata: accountReadMetadata,
      })
    ).rejects.toMatchObject({
      statusCode: 429,
    });

    expect(mocks.completeRequest).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        statusCode: 429,
        outcome: 'rate_limited',
        responseFailedBeforeHeaders: false,
      })
    );
  });

  it('measures network and timeout failures before preserving the original error', async () => {
    const networkError = new Error('socket closed');
    mocks.fetch.mockRejectedValueOnce(networkError);

    await expect(
      alpacaRequest('/v2/account', {
        metadata: accountReadMetadata,
      })
    ).rejects.toBe(networkError);

    expect(mocks.completeRequest).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        statusCode: null,
        outcome: 'network_error',
        responseFailedBeforeHeaders: true,
      })
    );

    const timeoutError = new DOMException('aborted', 'AbortError');
    mocks.fetch.mockRejectedValueOnce(timeoutError);

    await expect(
      alpacaRequest('/v2/account', {
        metadata: accountReadMetadata,
      })
    ).rejects.toBe(timeoutError);

    expect(mocks.completeRequest).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        statusCode: null,
        outcome: 'timeout',
      })
    );
  });

  it('defers safe reads during active rate-limit backoff without sending fetch', async () => {
    mocks.shouldDefer.mockReturnValue(true);
    mocks.getBackoffUntil.mockReturnValue(new Date('2026-06-20T00:01:00.000Z'));

    await expect(
      alpacaRequest('/v2/account', {
        metadata: {
          ...accountReadMetadata,
          deferDuringRateLimit: true,
        },
      })
    ).rejects.toMatchObject({
      name: 'AlpacaRateLimitDeferredError',
      backoffUntil: new Date('2026-06-20T00:01:00.000Z'),
    });

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.beginRequest).not.toHaveBeenCalled();
  });
});
