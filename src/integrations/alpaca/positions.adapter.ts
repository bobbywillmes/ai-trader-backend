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
export async function getAlpacaPositionBySymbol(
  tradingAccountId: number,
  symbol: string,
  operation: AlpacaApiOperation = 'tracked_position_sync'
): Promise<AlpacaPosition | null> {
  return alpacaRequestForAccount<AlpacaPosition>(
    tradingAccountId,
    `/v2/positions/${encodeURIComponent(symbol.toUpperCase())}`,
    {
      returnNullOn404: true,
      metadata: {
        operation,
        endpoint: 'GET /v2/positions/:symbol',
        method: 'GET',
        requestClass: 'synchronization_read',
        operationClass: 'LIFECYCLE_READ',
        deferDuringRateLimit: false,
      },
    }
  );
}

