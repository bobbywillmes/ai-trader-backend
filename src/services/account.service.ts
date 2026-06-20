import { getAlpacaAccount } from '../integrations/alpaca/account.adapter.js';
import { normalizeAccount } from '../integrations/alpaca/normalizers.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';

export async function getNormalizedAccount(
  operation: AlpacaApiOperation = 'account_read'
) {
  const raw = await getAlpacaAccount(operation);
  return normalizeAccount(raw);
}
