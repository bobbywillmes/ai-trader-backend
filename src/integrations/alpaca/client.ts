import { env } from '../../config/env.js';
import { AlpacaApiError } from '../../errors/alpaca-api-error.js';
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
};

export async function alpacaRequest<T>(
  path: string,
  options: RequestOptions
): Promise<T> {
  assertKnownAlpacaOperation(options.metadata.operation);
  assertKnownAlpacaEndpoint(options.metadata.endpoint);

  const url = `${env.ALPACA_BASE_URL}${path}`;
  const method = options.method ?? 'GET';

  const requestInit: RequestInit = {
    method,
    headers: {
      'APCA-API-KEY-ID': env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET,
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

  const response = await fetch(url, requestInit);

  if (response.status === 404 && options.returnNullOn404) {
    return null as T;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new AlpacaApiError(response.status, text);
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }

  return (await response.text()) as T;
}
