import { AlpacaApiError } from '../errors/alpaca-api-error.js';
import { HttpError } from '../errors/http-error.js';
import { cancelAlpacaOrder } from '../integrations/alpaca/orders.adapter.js';
import { prisma } from '../db/prisma.js';
import { adaptivePollingCoordinator } from './adaptive-polling.service.js';
export async function cancelOrderById(tradingAccountId: number, orderId: string) {
  const localOrder = await prisma.brokerOrder.findFirst({
    where: {
      tradingAccountId,
      broker: 'alpaca',
      brokerOrderId: orderId,
    },
    select: { id: true },
  });

  if (!localOrder) {
    throw new HttpError(
      404,
      `Alpaca order ${orderId} was not found in TradingAccount ${tradingAccountId}.`
    );
  }


  try {
    await cancelAlpacaOrder(tradingAccountId, orderId, 'order_cancel');
    adaptivePollingCoordinator.forceAfterBrokerOrderCancellation(
      'broker_order_cancel_requested'
    );

    return {
      ok: true,
      orderId,
      status: 'cancel_requested'
    };
  } catch (error) {
    if (error instanceof AlpacaApiError) {
      if (error.statusCode === 404) {
        throw new HttpError(404, `Order ${orderId} was not found.`);
      }

      if (error.statusCode === 422) {
        throw new HttpError(
          422,
          `Order ${orderId} is no longer cancelable.`
        );
      }
    }

    throw error;
  }
}
