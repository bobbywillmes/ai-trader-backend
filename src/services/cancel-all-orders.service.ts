import { cancelAllAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';

export async function cancelAllOpenOrders() {
  const results = await cancelAllAlpacaOrders();

  return {
    ok: true,
    requested: results.length,
    results: results.map((result) => ({
      orderId: result.id,
      brokerStatus: result.status,
      accepted: result.status >= 200 && result.status < 300,
      body: result.body ?? null
    }))
  };
}