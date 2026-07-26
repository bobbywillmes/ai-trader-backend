import { alpacaRequestForAccount } from './client.js';
import type { AlpacaPosition } from './alpaca.types.js';
import type { AlpacaApiOperation } from './request-metadata.js';

export async function getAlpacaPositions(
  tradingAccountId: number,
  operation: AlpacaApiOperation = 'tracked_position_sync'
): Promise<AlpacaPosition[]> {
  return alpacaRequestForAccount<AlpacaPosition[]>(tradingAccountId, '/v2/positions', {
    metadata: {
      operation,
      endpoint: 'GET /v2/positions',
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

export async function closeAlpacaPosition(
  tradingAccountId: number,
  symbol: string,
  operation: AlpacaApiOperation = 'position_close'
) {
  return alpacaRequestForAccount(tradingAccountId, `/v2/positions/${symbol}`, {
    method: 'DELETE',
    metadata: {
      operation,
      endpoint: 'DELETE /v2/positions/:symbol',
      method: 'DELETE',
      requestClass: 'critical_write',
      operationClass: 'RISK_REDUCING_WRITE',
      deferDuringRateLimit: false,
    },
  });
}
