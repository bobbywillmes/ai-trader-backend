import { getOpenAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';
import { normalizeOpenOrder } from '../integrations/alpaca/normalizers.js';

export async function getNormalizedOpenOrders() {
  const raw = await getOpenAlpacaOrders();
  return raw.map(normalizeOpenOrder);
}