import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  shouldDefer: vi.fn(),
  getBackoffUntil: vi.fn(),
  beginRequest: vi.fn(),
  completeRequest: vi.fn(),
  resolveAlpacaConfigForTradingAccount: vi.fn(),
  authorizeLiveBrokerWrite: vi.fn(),
}));

vi.mock('../../services/alpaca-config-resolver.service.js', () => ({
  resolveAlpacaConfigForTradingAccount:
    mocks.resolveAlpacaConfigForTradingAccount,
}));

vi.mock('../../services/alpaca-api-usage.service.js', () => ({
  alpacaApiUsageRegistry: {
    shouldDefer: mocks.shouldDefer,
    getBackoffUntil: mocks.getBackoffUntil,
    beginRequest: mocks.beginRequest,
    completeRequest: mocks.completeRequest,
  },
}));

vi.mock('../../services/live-write-approval.service.js', () => ({
  authorizeLiveBrokerWrite: mocks.authorizeLiveBrokerWrite,
}));

import { AlpacaApiError } from '../../errors/alpaca-api-error.js';
import { alpacaRequestForAccount } from './client.js';
import type { AlpacaRequestMetadata } from './request-metadata.js';

const accountReadMetadata: AlpacaRequestMetadata = {
  operation: 'account_read',
  endpoint: 'GET /v2/account',
  method: 'GET',
  requestClass: 'informational_read',
  operationClass: 'LIFECYCLE_READ',
  deferDuringRateLimit: false,
};

const orderWriteMetadata: AlpacaRequestMetadata = {
  operation: 'pending_order_submission',
  endpoint: 'POST /v2/orders',
  method: 'POST',
  requestClass: 'critical_write',
  operationClass: 'ENTRY_WRITE',
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

describe('alpacaRequestForAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.shouldDefer.mockReturnValue(false);
    mocks.authorizeLiveBrokerWrite.mockResolvedValue(undefined);
    mocks.getBackoffUntil.mockReturnValue(null);
    mocks.beginRequest.mockReturnValue({
      metadata: accountReadMetadata,
      startedAt: new Date('2026-06-20T00:00:00.000Z'),
    });
    mocks.resolveAlpacaConfigForTradingAccount.mockResolvedValue({
      tradingAccountId: 1,
      environment: 'PAPER',
      baseUrl: 'https://paper-api.alpaca.markets',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      source: 'legacy_env',
      credentialId: null,
      keyFingerprint: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves successful JSON return values while sending Alpaca credentials', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ id: 'account-1' }));

    await expect(
      alpacaRequestForAccount(1, '/v2/account', {
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
    expect(mocks.resolveAlpacaConfigForTradingAccount).toHaveBeenCalledWith(
      1,
      {}
    );
  });

  it('uses an explicit trading account id when one is provided', async () => {
    mocks.resolveAlpacaConfigForTradingAccount.mockResolvedValueOnce({
      tradingAccountId: 42,
      environment: 'LIVE',
      baseUrl: 'https://api.alpaca.markets',
      apiKey: 'account-key',
      apiSecret: 'account-secret',
      source: 'trading_account_credential',
      credentialId: 7,
      keyFingerprint: 'fingerprint-1',
    });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ id: 'account-42' }));

    await expect(
      alpacaRequestForAccount(42, '/v2/account', {
        metadata: accountReadMetadata,
      })
    ).resolves.toEqual({ id: 'account-42' });

    expect(mocks.resolveAlpacaConfigForTradingAccount).toHaveBeenCalledWith(
      42,
      {}
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://api.alpaca.markets/v2/account',
      expect.objectContaining({
        headers: expect.objectContaining({
          'APCA-API-KEY-ID': 'account-key',
          'APCA-API-SECRET-KEY': 'account-secret',
        }),
      })
    );
  });

  it('blocks LIVE broker writes while preserving account-scoped LIVE reads', async () => {
    mocks.resolveAlpacaConfigForTradingAccount.mockResolvedValue({
      tradingAccountId: 42,
      environment: 'LIVE',
      baseUrl: 'https://api.alpaca.markets',
      apiKey: 'account-key',
      apiSecret: 'account-secret',
      source: 'trading_account_credential',
      credentialId: 7,
      keyFingerprint: 'fingerprint-1',
    });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ id: 'account-42' }));

    await expect(
      alpacaRequestForAccount(42, '/v2/account', {
        metadata: accountReadMetadata,
      })
    ).resolves.toEqual({ id: 'account-42' });

    await expect(
      alpacaRequestForAccount(42, '/v2/orders', {
        method: 'POST',
        body: { symbol: 'SPY' },
        metadata: orderWriteMetadata,
      })
    ).rejects.toThrow('ALLOW_LIVE_TRADING and ALLOW_LIVE_RISK_REDUCING_WRITES must be true');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('classifies but does not silently permit LIVE risk-reducing writes', async () => {
    mocks.resolveAlpacaConfigForTradingAccount.mockResolvedValue({
      tradingAccountId: 42,
      environment: 'LIVE',
      baseUrl: 'https://api.alpaca.markets',
      apiKey: 'account-key',
      apiSecret: 'account-secret',
      source: 'trading_account_credential',
      credentialId: 7,
      keyFingerprint: 'fingerprint-1',
    });

    await expect(
      alpacaRequestForAccount(42, '/v2/orders', {
        method: 'POST',
        body: { symbol: 'SPY' },
        metadata: {
          ...orderWriteMetadata,
          operation: 'position_close',
          operationClass: 'RISK_REDUCING_WRITE',
        },
      })
    ).rejects.toThrow(
      'LIVE RISK_REDUCING_WRITE blocked for TradingAccount 42: ALLOW_LIVE_RISK_REDUCING_WRITES must be true.'
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('propagates missing account credentials before sending an Alpaca request', async () => {
    mocks.resolveAlpacaConfigForTradingAccount.mockRejectedValueOnce(
      new Error(
        'Trading account 42 does not have active Alpaca credentials. Add an ACTIVE TradingAccountCredential before using this non-default trading account.'
      )
    );

    await expect(
      alpacaRequestForAccount(42, '/v2/account', {
        metadata: accountReadMetadata,
      })
    ).rejects.toThrow('Trading account 42 does not have active Alpaca credentials');

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.beginRequest).not.toHaveBeenCalled();
    expect(mocks.completeRequest).not.toHaveBeenCalled();
  });

  it('preserves AlpacaApiError for HTTP failures', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response('rejected', {
        status: 422,
      })
    );

    await expect(
      alpacaRequestForAccount(1, '/v2/account', {
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
      alpacaRequestForAccount(1, '/v2/orders/order-123', {
        returnNullOn404: true,
        metadata: {
          operation: 'protective_order_sync',
          endpoint: 'GET /v2/orders/:orderId',
          method: 'GET',
          requestClass: 'synchronization_read',
          operationClass: 'LIFECYCLE_READ',
          deferDuringRateLimit: true,
        },
      })
    ).resolves.toBeNull();
  });

  it('rejects unknown operation and endpoint keys before fetch', async () => {
    await expect(
      alpacaRequestForAccount(1, '/v2/account', {
        metadata: {
          ...accountReadMetadata,
          operation: 'GET /v2/account' as never,
        },
      })
    ).rejects.toThrow('Unknown Alpaca API operation');

    await expect(
      alpacaRequestForAccount(1, '/v2/account', {
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
      alpacaRequestForAccount(1, '/v2/orders', {
        method: 'POST',
        metadata: {
          operation: 'pending_order_submission',
          endpoint: 'POST /v2/orders',
          method: 'GET',
          requestClass: 'critical_write',
          operationClass: 'ENTRY_WRITE',
          deferDuringRateLimit: false,
        },
      })
    ).rejects.toMatchObject({
      name: 'BrokerWriteDeliveryError',
      classification: 'NOT_SENT_BLOCKED',
    });

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
      alpacaRequestForAccount(1, '/v2/account', {
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
      alpacaRequestForAccount(1, '/v2/account', {
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
      alpacaRequestForAccount(1, '/v2/account', {
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
      alpacaRequestForAccount(1, '/v2/account', {
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

  it('classifies missing credentials for a write as definitely not sent', async () => {
    mocks.resolveAlpacaConfigForTradingAccount.mockRejectedValueOnce(
      new Error('credentials unavailable secret=[redacted]')
    );

    await expect(
      alpacaRequestForAccount(42, '/v2/orders', {
        method: 'POST',
        body: { symbol: 'SPY' },
        metadata: orderWriteMetadata,
      })
    ).rejects.toMatchObject({
      classification: 'NOT_SENT_BLOCKED',
      message: expect.not.stringContaining('secret'),
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('classifies locally deferred writes as definitely not sent and retryable', async () => {
    mocks.shouldDefer.mockReturnValue(true);

    await expect(
      alpacaRequestForAccount(1, '/v2/orders', {
        method: 'POST',
        body: { symbol: 'SPY' },
        metadata: orderWriteMetadata,
      })
    ).rejects.toMatchObject({
      name: 'BrokerWriteDeliveryError',
      classification: 'NOT_SENT_RETRYABLE',
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('classifies explicit broker rejection separately from uncertain 5xx delivery', async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response('invalid order', { status: 422 }))
      .mockResolvedValueOnce(new Response('server unavailable', { status: 503 }));

    await expect(
      alpacaRequestForAccount(1, '/v2/orders', {
        method: 'POST',
        body: { symbol: 'SPY' },
        metadata: orderWriteMetadata,
      })
    ).rejects.toMatchObject({ classification: 'BROKER_REJECTED' });

    await expect(
      alpacaRequestForAccount(1, '/v2/orders', {
        method: 'POST',
        body: { symbol: 'SPY' },
        metadata: orderWriteMetadata,
      })
    ).rejects.toMatchObject({ classification: 'DELIVERY_UNCERTAIN' });
  });

  it('classifies write timeout and network interruption as delivery uncertain', async () => {
    mocks.fetch
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
      .mockRejectedValueOnce(new Error('connection reset'));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        alpacaRequestForAccount(1, '/v2/orders', {
          method: 'POST',
          body: { symbol: 'SPY' },
          metadata: orderWriteMetadata,
        })
      ).rejects.toMatchObject({
        classification: 'DELIVERY_UNCERTAIN',
      });
    }
  });
});
