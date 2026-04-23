import { getAlpacaPositions } from '../integrations/alpaca/positions.adapter.js';
import { normalizePosition } from '../integrations/alpaca/normalizers.js';

export async function getNormalizedPositions() {
  const raw = await getAlpacaPositions();
  return raw.map(normalizePosition);
}