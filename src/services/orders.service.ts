import { getOpenAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';
import { normalizeOpenOrder } from '../integrations/alpaca/normalizers.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';

export async function getNormalizedOpenOrders(
  operation: AlpacaApiOperation = 'open_orders_sync'
) {
  const raw = await getOpenAlpacaOrders(operation);
  return raw.map(normalizeOpenOrder);
}
