import { alpacaRequest } from './client.js';
import type { AlpacaPosition } from './alpaca.types.js';

export async function getAlpacaPositions(): Promise<AlpacaPosition[]> {
  return alpacaRequest<AlpacaPosition[]>('/v2/positions');
}

export async function closeAlpacaPosition(symbol: string) {
  return alpacaRequest(`/v2/positions/${symbol}`, {
    method: 'DELETE',
  });
}