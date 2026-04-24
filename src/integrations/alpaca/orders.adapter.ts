import { alpacaRequest } from './client.js';
import type { AlpacaOrder } from './alpaca.types.js';

type AlpacaCreateOrderRequest = {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  time_in_force: 'day' | 'gtc';
  qty?: string;
  notional?: string;
  limit_price?: string;
  extended_hours?: boolean;
  client_order_id: string;
};

export async function getOpenAlpacaOrders(): Promise<AlpacaOrder[]> {
  return alpacaRequest<AlpacaOrder[]>('/v2/orders?status=open&direction=desc');
}

export async function getAlpacaOrderByClientOrderId(
  clientOrderId: string
): Promise<AlpacaOrder | null> {
  return alpacaRequest<AlpacaOrder | null>(
    `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
    { returnNullOn404: true }
  );
}

export async function placeAlpacaOrder(
  payload: AlpacaCreateOrderRequest
): Promise<AlpacaOrder> {
  return alpacaRequest<AlpacaOrder>('/v2/orders', {
    method: 'POST',
    body: payload
  });
}

export async function cancelAlpacaOrder(orderId: string): Promise<void> {
  await alpacaRequest<void>(`/v2/orders/${orderId}`, {
    method: 'DELETE'
  });
}

export type AlpacaCancelAllOrderResult = {
  id: string;
  status: number;
  body?: unknown;
};

export async function cancelAllAlpacaOrders(): Promise<AlpacaCancelAllOrderResult[]> {
  return alpacaRequest<AlpacaCancelAllOrderResult[]>('/v2/orders', {
    method: 'DELETE'
  });
}