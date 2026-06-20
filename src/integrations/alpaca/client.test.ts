import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({
  env: {
    ALPACA_API_KEY: 'test-key',
    ALPACA_API_SECRET: 'test-secret',
    ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
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
  });
});
