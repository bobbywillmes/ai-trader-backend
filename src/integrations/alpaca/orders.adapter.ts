import { alpacaRequest } from './client.js';
import type { AlpacaOrder } from './alpaca.types.js';

export async function getOpenAlpacaOrders(): Promise<AlpacaOrder[]> {
  return alpacaRequest<AlpacaOrder[]>('/v2/orders?status=open&direction=desc');
}