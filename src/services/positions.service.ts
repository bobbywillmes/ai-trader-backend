import { getAlpacaPositions } from '../integrations/alpaca/positions.adapter.js';
import { normalizePosition } from '../integrations/alpaca/normalizers.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';

export async function getNormalizedPositions(
  tradingAccountId: number,
  operation: AlpacaApiOperation = 'tracked_position_sync'
) {
  const raw = await getAlpacaPositions(tradingAccountId, operation);
  return raw.map(normalizePosition);
}
