import type { BrokerCredentialStatus } from '@prisma/client';
import { TradingAccountEnvironment } from '@prisma/client';
import { env } from '../../config/env.js';
import { AlpacaApiError } from '../../errors/alpaca-api-error.js';
import { AlpacaRateLimitDeferredError } from '../../errors/alpaca-rate-limit-deferred-error.js';
import { alpacaApiUsageRegistry } from '../../services/alpaca-api-usage.service.js';
import { resolveAlpacaConfigForTradingAccount } from '../../services/alpaca-config-resolver.service.js';
import {
  assertKnownAlpacaEndpoint,
  assertKnownAlpacaOperation,
  type AlpacaRequestMetadata,
} from './request-metadata.js';

export type AccountRequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
  returnNullOn404?: boolean;
  metadata: AlpacaRequestMetadata;
  credentialStatuses?: BrokerCredentialStatus[] | undefined;
};

export async function alpacaRequestForAccount<T>(
  tradingAccountId: number,
  path: string,
  options: AccountRequestOptions
): Promise<T> {
  assertKnownAlpacaOperation(options.metadata.operation);
  assertKnownAlpacaEndpoint(options.metadata.endpoint);

  if (alpacaApiUsageRegistry.shouldDefer(options.metadata)) {
    throw new AlpacaRateLimitDeferredError({
      metadata: options.metadata,
      backoffUntil: alpacaApiUsageRegistry.getBackoffUntil(),
    });
  }

  const config = await resolveAlpacaConfigForTradingAccount(tradingAccountId, {
    credentialStatuses: options.credentialStatuses,
  });
  if (
    options.metadata.requestClass === 'critical_write' &&
    config.environment === TradingAccountEnvironment.LIVE &&
    !env.ALLOW_LIVE_TRADING
  ) {
    throw new Error(
      `LIVE broker write blocked for TradingAccount ${tradingAccountId}: ALLOW_LIVE_TRADING is false.`
    );
  }
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

  const requestStart = alpacaApiUsageRegistry.beginRequest(
    tradingAccountId,
    options.metadata
  );
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
