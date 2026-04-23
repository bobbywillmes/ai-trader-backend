import { env } from '../../config/env.js';

type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
  returnNullOn404?: boolean;
};

export async function alpacaRequest<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const url = `${env.ALPACA_BASE_URL}${path}`;

  const requestInit: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      'APCA-API-KEY-ID': env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET,
      'Content-Type': 'application/json'
    }
  };

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
    throw new Error(`Alpaca request failed (${response.status}): ${text}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    return response.json() as Promise<T>;
  }

  return (await response.text()) as T;
}