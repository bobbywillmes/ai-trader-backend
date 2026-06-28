import type { BrokerCredentialStatus } from '@prisma/client';
import { AlpacaApiError } from '../../errors/alpaca-api-error.js';
import { AlpacaRateLimitDeferredError } from '../../errors/alpaca-rate-limit-deferred-error.js';
import { alpacaApiUsageRegistry } from '../../services/alpaca-api-usage.service.js';
import { resolveAlpacaConfigForTradingAccount } from '../../services/alpaca-config-resolver.service.js';
import { resolveDefaultTradingAccountId } from '../../services/trading-account.service.js';
import {
  assertKnownAlpacaEndpoint,
  assertKnownAlpacaOperation,
  type AlpacaRequestMetadata,
} from './request-metadata.js';

type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
  returnNullOn404?: boolean;
  metadata: AlpacaRequestMetadata;
  tradingAccountId?: number | undefined;
  credentialStatuses?: BrokerCredentialStatus[] | undefined;
};

export async function alpacaRequest<T>(
  path: string,
  options: RequestOptions
): Promise<T> {
  assertKnownAlpacaOperation(options.metadata.operation);
  assertKnownAlpacaEndpoint(options.metadata.endpoint);

  if (alpacaApiUsageRegistry.shouldDefer(options.metadata)) {
    throw new AlpacaRateLimitDeferredError({
      metadata: options.metadata,
      backoffUntil: alpacaApiUsageRegistry.getBackoffUntil(),
    });
  }

  const tradingAccountId =
    options.tradingAccountId ?? (await resolveDefaultTradingAccountId());
  const config = await resolveAlpacaConfigForTradingAccount(tradingAccountId, {
    credentialStatuses: options.credentialStatuses,
  });
  const url = `${config.baseUrl}${path}`;
  const method = options.method ?? 'GET';

  const requestInit: RequestInit = {
    method,
    headers: {
      'APCA-API-KEY-ID': config.apiKey,
      'APCA-API-SECRET-KEY': config.apiSecret,
      'Content-Type': 'application/json'
    }
  };

  if (options.metadata.method !== method) {
    throw new Error(
      `Alpaca request metadata method ${options.metadata.method} does not match request method ${method}.`
    );
  }

  if (options.body !== undefined) {
    requestInit.body = JSON.stringify(options.body);
  }

  const requestStart = alpacaApiUsageRegistry.beginRequest(options.metadata);
  let measured = false;

  try {
    const response = await fetch(url, requestInit);

    if (response.status === 404 && options.returnNullOn404) {
      alpacaApiUsageRegistry.completeRequest(requestStart, {
        statusCode: response.status,
        outcome: 'success',
        responseFailedBeforeHeaders: false,
        headers: response.headers,
      });
      measured = true;

      return null as T;
    }

    if (response.status === 204) {
      alpacaApiUsageRegistry.completeRequest(requestStart, {
        statusCode: response.status,
        outcome: 'success',
        responseFailedBeforeHeaders: false,
        headers: response.headers,
      });
      measured = true;

      return undefined as T;
    }

    if (!response.ok) {
      const text = await response.text();
      alpacaApiUsageRegistry.completeRequest(requestStart, {
        statusCode: response.status,
        outcome:
          response.status === 429
            ? 'rate_limited'
            : response.status >= 500
              ? 'server_error'
              : 'client_error',
        responseFailedBeforeHeaders: false,
        headers: response.headers,
      });
      measured = true;
      throw new AlpacaApiError(response.status, text);
    }

    alpacaApiUsageRegistry.completeRequest(requestStart, {
      statusCode: response.status,
      outcome: 'success',
      responseFailedBeforeHeaders: false,
      headers: response.headers,
    });
    measured = true;

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      return response.json() as Promise<T>;
    }

    return (await response.text()) as T;
  } catch (error) {
    if (error instanceof AlpacaApiError) {
      throw error;
    }

    if (!measured) {
      alpacaApiUsageRegistry.completeRequest(requestStart, {
        statusCode: null,
        outcome:
          error instanceof Error && error.name === 'AbortError'
            ? 'timeout'
            : 'network_error',
        responseFailedBeforeHeaders: true,
      });
    }

    throw error;
  }
}
