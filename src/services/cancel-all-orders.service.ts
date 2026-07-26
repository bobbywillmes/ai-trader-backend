import { cancelAllAlpacaOrders } from '../integrations/alpaca/orders.adapter.js';
import { adaptivePollingCoordinator } from './adaptive-polling.service.js';
export async function cancelAllOpenOrders(tradingAccountId: number) {
  const results = await cancelAllAlpacaOrders(
    tradingAccountId,
    'order_cancel_all'
  );
  const accepted = results.some(
    (result) => result.status >= 200 && result.status < 300
  );

  if (accepted) {
    adaptivePollingCoordinator.forceAfterBrokerOrderCancellation(
      tradingAccountId,
      'broker_order_cancel_all_requested'
    );
  }

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
