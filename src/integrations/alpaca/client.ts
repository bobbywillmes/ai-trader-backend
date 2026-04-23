import { env } from '../../config/env.js';

type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
};

export async function alpacaRequest<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const url = `${env.ALPACA_BASE_URL}${path}`;

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'APCA-API-KEY-ID': env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET,
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : null
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Alpaca request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}