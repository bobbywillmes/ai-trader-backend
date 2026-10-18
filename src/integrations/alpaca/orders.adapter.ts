import { alpacaRequestForAccount } from './client.js';
import type { AlpacaOrder } from './alpaca.types.js';
import type { AlpacaApiOperation, AlpacaBrokerOperationClass } from './request-metadata.js';
import type { NewPositionEntryAuthorizationContext } from '../../services/live-entry-arming.service.js';

type AlpacaCreateOrderBase = {
  symbol: string;
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

export type AlpacaEntryOrderRequest = AlpacaCreateOrderBase & {
  side: 'buy';
  position_intent?: 'buy_to_open';
};

export type VerifiedAlpacaExitOrderRequest = AlpacaCreateOrderBase & {
  side: 'sell';
  position_intent: 'sell_to_close';
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

const COMPLETE_OPEN_ORDER_PAGE_SIZE = 500;
const COMPLETE_OPEN_ORDER_MAX_PAGES = 20;

/**
 * Returns a complete, bounded snapshot of open BUY orders for one canonical
 * symbol. The extra empty page when a page is full is intentional: without it,
 * a caller cannot distinguish an exact page boundary from truncation.
 */
export async function getCompleteOpenAlpacaBuyOrdersForSymbol(
  tradingAccountId: number,
  symbol: string,
  operation: AlpacaApiOperation = 'reconciliation_check',
): Promise<AlpacaOrder[]> {
  const canonicalSymbol = symbol.trim().toUpperCase();
  if (!canonicalSymbol) throw new Error('A canonical symbol is required for complete open-order evidence.');

  const orders: AlpacaOrder[] = [];
  const seenIds = new Set<string>();
  let beforeOrderId: string | null = null;

  for (let pageNumber = 0; pageNumber < COMPLETE_OPEN_ORDER_MAX_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({
      status: 'open',
      direction: 'desc',
      limit: String(COMPLETE_OPEN_ORDER_PAGE_SIZE),
      symbols: canonicalSymbol,
      side: 'buy',
    });
    if (beforeOrderId) query.set('before_order_id', beforeOrderId);
    const page = await alpacaRequestForAccount<AlpacaOrder[]>(
      tradingAccountId,
      `/v2/orders?${query.toString()}`,
      {
        metadata: {
          operation,
          endpoint: 'GET /v2/orders',
          method: 'GET',
          requestClass: operation === 'manual_admin_action' ? 'informational_read' : 'synchronization_read',
          operationClass: 'LIFECYCLE_READ',
          deferDuringRateLimit: operation !== 'manual_admin_action',
        },
      },
    );
    if (!Array.isArray(page)) throw new Error('Alpaca returned malformed open-order evidence.');
    for (const order of page) {
      if (!order?.id || !order.symbol || !order.side || !order.status) {
        throw new Error('Alpaca returned an incomplete open-order record.');
      }
      if (seenIds.has(order.id)) throw new Error('Alpaca open-order pagination repeated an order identity.');
      if (order.symbol.trim().toUpperCase() !== canonicalSymbol || order.side.toLowerCase() !== 'buy') {
        throw new Error('Alpaca open-order filtering returned a conflicting order identity.');
      }
      seenIds.add(order.id);
      orders.push(order);
    }
    if (page.length < COMPLETE_OPEN_ORDER_PAGE_SIZE) return orders;
    const nextCursor = page.at(-1)?.id;
    if (!nextCursor || nextCursor === beforeOrderId) throw new Error('Alpaca open-order pagination did not advance.');
    beforeOrderId = nextCursor;
  }
  throw new Error('Alpaca open-order evidence exceeded the bounded pagination limit.');
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

async function placeAlpacaOrder(
  tradingAccountId: number,
  payload: AlpacaEntryOrderRequest | VerifiedAlpacaExitOrderRequest,
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

export function submitAlpacaEntryOrder(
  tradingAccountId: number,
  payload: AlpacaEntryOrderRequest,
  newPositionEntryContext?: NewPositionEntryAuthorizationContext,
) {
  return placeAlpacaOrder(
    tradingAccountId,
    payload,
    'pending_order_submission',
    newPositionEntryContext,
  );
}

/**
 * Final adapter used only by VerifiedExitSubmissionService after it owns fresh
 * broker verification and final authorization. Production callers must not
 * expose or re-export this function through a generic order API.
 */
export function submitVerifiedAlpacaExitOrder(
  tradingAccountId: number,
  payload: VerifiedAlpacaExitOrderRequest,
  operation: 'position_close' | 'protective_order_submission',
) {
  return placeAlpacaOrder(tradingAccountId, payload, operation);
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
