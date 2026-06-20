import { cancelAllAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';

export async function cancelAllOpenOrders() {
  const results = await cancelAllAlpacaOrders('order_cancel_all');

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
