import type { BrokerCredentialStatus } from '@prisma/client';
import { TradingAccountEnvironment } from '@prisma/client';
import { env } from '../../config/env.js';
import { AlpacaApiError } from '../../errors/alpaca-api-error.js';
import { AlpacaRateLimitDeferredError } from '../../errors/alpaca-rate-limit-deferred-error.js';
import { BrokerWriteDeliveryError } from '../../errors/broker-write-delivery-error.js';
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
  const isWrite = options.metadata.requestClass === 'critical_write';
  try {
    assertKnownAlpacaOperation(options.metadata.operation);
    assertKnownAlpacaEndpoint(options.metadata.endpoint);
    const method = options.method ?? 'GET';
    if (options.metadata.method !== method) {
      throw new Error(
        `Alpaca request metadata method ${options.metadata.method} does not match request method ${method}.`
      );
    }
  } catch (error) {
    if (isWrite) {
      throw new BrokerWriteDeliveryError({
        classification: 'NOT_SENT_BLOCKED',
        message: 'Broker write blocked by local request metadata validation.',
        cause: error,
      });
    }
    throw error;
  }

  if (alpacaApiUsageRegistry.shouldDefer(options.metadata)) {
    const deferred = new AlpacaRateLimitDeferredError({
      metadata: options.metadata,
      backoffUntil: alpacaApiUsageRegistry.getBackoffUntil(),
    });
    if (isWrite) {
      throw new BrokerWriteDeliveryError({
        classification: 'NOT_SENT_RETRYABLE',
        message: 'Broker write deferred locally before request delivery.',
        cause: deferred,
      });
    }
    throw deferred;
  }

  let config;
  try {
    config = await resolveAlpacaConfigForTradingAccount(tradingAccountId, {
      credentialStatuses: options.credentialStatuses,
    });
  } catch (error) {
    if (isWrite) {
      throw new BrokerWriteDeliveryError({
        classification: 'NOT_SENT_BLOCKED',
        message: `Broker write blocked because TradingAccount ${tradingAccountId} credentials are unavailable.`,
        cause: error,
      });
    }
    throw error;
  }
  if (options.metadata.requestClass === 'critical_write' &&
      config.environment === TradingAccountEnvironment.LIVE) {
    const operationClass = options.metadata.operationClass ?? 'ENTRY_WRITE';
    const allowed = operationClass === 'RISK_REDUCING_WRITE'
      ? env.ALLOW_LIVE_RISK_REDUCING_WRITES
      : operationClass === 'ENTRY_WRITE'
        ? env.ALLOW_LIVE_TRADING && env.ALLOW_LIVE_RISK_REDUCING_WRITES
        : false;
    if (!allowed) {
      const required = operationClass === 'RISK_REDUCING_WRITE'
        ? 'ALLOW_LIVE_RISK_REDUCING_WRITES'
        : 'ALLOW_LIVE_TRADING and ALLOW_LIVE_RISK_REDUCING_WRITES';
    throw new BrokerWriteDeliveryError({
      classification: 'NOT_SENT_BLOCKED',
        message: `LIVE ${operationClass} blocked for TradingAccount ${tradingAccountId}: ${required} must be true.`,
    });
    }
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

  let requestStart;
  try {
    if (options.body !== undefined) {
      requestInit.body = JSON.stringify(options.body);
    }
    requestStart = alpacaApiUsageRegistry.beginRequest(
      tradingAccountId,
      options.metadata
    );
  } catch (error) {
    if (isWrite) {
      throw new BrokerWriteDeliveryError({
        classification: 'NOT_SENT_BLOCKED',
        message: 'Broker write blocked by local request preparation.',
        cause: error,
      });
    }
    throw error;
  }
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
      if (isWrite) {
        throw new BrokerWriteDeliveryError({
          classification:
            error.statusCode >= 500
              ? 'DELIVERY_UNCERTAIN'
              : 'BROKER_REJECTED',
          message:
            error.statusCode >= 500
              ? `Broker write delivery is uncertain after Alpaca returned ${error.statusCode}.`
              : `Alpaca explicitly rejected broker write with status ${error.statusCode}.`,
          statusCode: error.statusCode,
          cause: error,
        });
      }
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

    if (isWrite) {
      throw new BrokerWriteDeliveryError({
        classification: 'DELIVERY_UNCERTAIN',
        message: 'Broker write delivery is uncertain after a network or response failure.',
        cause: error,
      });
    }
    throw error;
  }
}
