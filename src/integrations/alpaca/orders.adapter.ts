import { alpacaRequestForAccount } from './client.js';
import type { AlpacaOrder } from './alpaca.types.js';
import type { AlpacaApiOperation, AlpacaBrokerOperationClass } from './request-metadata.js';
import type { NewPositionEntryAuthorizationContext } from '../../services/live-entry-arming.service.js';

type AlpacaCreateOrderRequest = {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
  time_in_force: 'day' | 'gtc';
  qty?: string;
  notional?: string;
  limit_price?: string;
  trail_price?: string;
  trail_percent?: string;
  extended_hours?: boolean;
  client_order_id: string;
};

export async function getOpenAlpacaOrders(
  tradingAccountId: number,
  operation: AlpacaApiOperation = 'open_orders_sync'
): Promise<AlpacaOrder[]> {
  return alpacaRequestForAccount(tradingAccountId, '/v2/orders?status=open&direction=desc', {
    metadata: {
      operation,
      endpoint: 'GET /v2/orders',
      method: 'GET',
      requestClass:
        operation === 'manual_admin_action' ||
        operation === 'bootstrap_snapshot'
          ? 'informational_read'
          : 'synchronization_read',
      operationClass: 'LIFECYCLE_READ',
      deferDuringRateLimit:
        operation !== 'manual_admin_action' &&
        operation !== 'bootstrap_snapshot',
    },
  });
}

export async function getAlpacaOrderById(
  tradingAccountId: number,
  orderId: string,
  operation: AlpacaApiOperation = 'protective_order_sync'
): Promise<AlpacaOrder | null> {
  return alpacaRequestForAccount(tradingAccountId, `/v2/orders/${orderId}`, {
    returnNullOn404: true,
    metadata: {
      operation,
      endpoint: 'GET /v2/orders/:orderId',
      method: 'GET',
      requestClass: 'synchronization_read',
      operationClass: 'LIFECYCLE_READ',
      deferDuringRateLimit: true,
    },
  });
}

export async function getAlpacaOrderByClientOrderId(
  tradingAccountId: number,
  clientOrderId: string,
  operation: AlpacaApiOperation = 'pending_order_idempotency_check'
): Promise<AlpacaOrder | null> {
  return alpacaRequestForAccount(
    tradingAccountId,
    `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(
      clientOrderId
    )}`,
    {
      returnNullOn404: true,
      metadata: {
        operation,
        endpoint: 'GET /v2/orders:by_client_order_id',
        method: 'GET',
        requestClass: 'synchronization_read',
        operationClass: 'LIFECYCLE_READ',
        deferDuringRateLimit: false,
      },
    }
  );
}

export async function placeAlpacaOrder(
  tradingAccountId: number,
  payload: AlpacaCreateOrderRequest,
  operation: AlpacaApiOperation = 'pending_order_submission',
  newPositionEntryContext?: NewPositionEntryAuthorizationContext,
): Promise<AlpacaOrder> {
  return alpacaRequestForAccount(tradingAccountId, '/v2/orders', {
    method: 'POST',
    body: payload,
    metadata: {
      operation,
      endpoint: 'POST /v2/orders',
      method: 'POST',
      requestClass: 'critical_write',
      operationClass:
        operation === 'pending_order_submission'
          ? 'ENTRY_WRITE'
          : 'RISK_REDUCING_WRITE',
      deferDuringRateLimit: false,
      ...(newPositionEntryContext ? { newPositionEntryContext } : {}),
    },
  });
}

export async function cancelAlpacaOrder(
  tradingAccountId: number,
  orderId: string,
  operation: AlpacaApiOperation = 'order_cancel',
  operationClass: AlpacaBrokerOperationClass = 'ENTRY_WRITE'
): Promise<void> {
  await alpacaRequestForAccount(tradingAccountId, `/v2/orders/${orderId}`, {
    method: 'DELETE',
    metadata: {
      operation,
      endpoint: 'DELETE /v2/orders/:orderId',
      method: 'DELETE',
      requestClass: 'critical_write',
      operationClass,
      deferDuringRateLimit: false,
    },
  });
}

export type AlpacaCancelAllOrderResult = {
  id: string;
  status: number;
  body?: unknown;
};

export async function cancelAllAlpacaOrders(
  tradingAccountId: number,
  operation: AlpacaApiOperation = 'order_cancel_all'
): Promise<
  AlpacaCancelAllOrderResult[]
> {
  return alpacaRequestForAccount(tradingAccountId, '/v2/orders', {
    method: 'DELETE',
    metadata: {
      operation,
      endpoint: 'DELETE /v2/orders',
      method: 'DELETE',
      requestClass: 'critical_write',
      operationClass: 'ENTRY_WRITE',
      deferDuringRateLimit: false,
    },
  });
}
