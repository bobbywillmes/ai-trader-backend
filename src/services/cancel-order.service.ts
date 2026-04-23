import { AlpacaApiError } from '../errors/alpaca-api-error.js';
import { HttpError } from '../errors/http-error.js';
import { cancelAlpacaOrder } from '../integrations/alpaca/orders.adapter.js';

export async function cancelOrderById(orderId: string) {
  try {
    await cancelAlpacaOrder(orderId);

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