import { getAlpacaPositions } from '../integrations/alpaca/positions.adapter.js';
import { normalizePosition } from '../integrations/alpaca/normalizers.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';

export async function getNormalizedPositions(
  operation: AlpacaApiOperation = 'tracked_position_sync',
  options: { tradingAccountId?: number | undefined } = {}
) {
  const raw = await getAlpacaPositions(operation, {
    tradingAccountId: options.tradingAccountId,
  });
  return raw.map(normalizePosition);
}
