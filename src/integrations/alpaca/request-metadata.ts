export const alpacaApiOperations = [
  'account_read',
  'account_snapshot',
  'bootstrap_snapshot',
  'broker_activity_sync',
  'market_calendar',
  'market_clock',
  'manual_admin_action',
  'open_orders_sync',
  'order_cancel',
  'order_cancel_all',
  'pending_order_idempotency_check',
  'pending_order_submission',
  'position_close',
  'positions_read',
  'protective_order_idempotency_check',
  'protective_order_submission',
  'protective_order_sync',
  'reconciliation_check',
  'risk_gate_account_check',
  'submitted_order_sync',
  'tracked_position_sync',
] as const;

export type AlpacaApiOperation = (typeof alpacaApiOperations)[number];

export const alpacaApiEndpoints = [
  'GET /v2/account',
  'GET /v2/account/activities',
  'GET /v2/account/activities/:activityType',
  'GET /v2/calendar',
  'GET /v2/clock',
  'GET /v2/orders',
  'GET /v2/orders/:orderId',
  'GET /v2/orders:by_client_order_id',
  'GET /v2/positions',
  'DELETE /v2/orders',
  'DELETE /v2/orders/:orderId',
  'DELETE /v2/positions/:symbol',
  'POST /v2/orders',
] as const;

export type AlpacaApiEndpoint = (typeof alpacaApiEndpoints)[number];

export const alpacaApiRequestClasses = [
  'critical_write',
  'informational_read',
  'synchronization_read',
] as const;

export type AlpacaApiRequestClass =
  (typeof alpacaApiRequestClasses)[number];

export type AlpacaRequestMetadata = {
  operation: AlpacaApiOperation;
  endpoint: AlpacaApiEndpoint;
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  requestClass: AlpacaApiRequestClass;
  deferDuringRateLimit: boolean;
};

export function assertKnownAlpacaOperation(
  operation: string
): asserts operation is AlpacaApiOperation {
  if (!alpacaApiOperations.includes(operation as AlpacaApiOperation)) {
    throw new Error(`Unknown Alpaca API operation: ${operation}`);
  }
}

export function assertKnownAlpacaEndpoint(
  endpoint: string
): asserts endpoint is AlpacaApiEndpoint {
  if (!alpacaApiEndpoints.includes(endpoint as AlpacaApiEndpoint)) {
    throw new Error(`Unknown Alpaca API endpoint: ${endpoint}`);
  }
}
