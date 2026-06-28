import { alpacaRequest } from './client.js';
import type { AlpacaPosition } from './alpaca.types.js';
import type { AlpacaApiOperation } from './request-metadata.js';

export async function getAlpacaPositions(
  operation: AlpacaApiOperation = 'tracked_position_sync',
  options: { tradingAccountId?: number } = {}
): Promise<AlpacaPosition[]> {
  return alpacaRequest<AlpacaPosition[]>('/v2/positions', {
    tradingAccountId: options.tradingAccountId,
    metadata: {
      operation,
      endpoint: 'GET /v2/positions',
      method: 'GET',
      requestClass:
        operation === 'manual_admin_action' ||
        operation === 'bootstrap_snapshot'
          ? 'informational_read'
          : 'synchronization_read',
      deferDuringRateLimit:
        operation !== 'manual_admin_action' &&
        operation !== 'bootstrap_snapshot',
    },
  });
}

export async function closeAlpacaPosition(
  symbol: string,
  operation: AlpacaApiOperation = 'position_close',
  options: { tradingAccountId?: number } = {}
) {
  return alpacaRequest(`/v2/positions/${symbol}`, {
    tradingAccountId: options.tradingAccountId,
    method: 'DELETE',
    metadata: {
      operation,
      endpoint: 'DELETE /v2/positions/:symbol',
      method: 'DELETE',
      requestClass: 'critical_write',
      deferDuringRateLimit: false,
    },
  });
}
