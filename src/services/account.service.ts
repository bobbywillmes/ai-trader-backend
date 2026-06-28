import { getAlpacaAccount } from '../integrations/alpaca/account.adapter.js';
import { normalizeAccount } from '../integrations/alpaca/normalizers.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';

export async function getNormalizedAccount(
  operation: AlpacaApiOperation = 'account_read',
  options: { tradingAccountId?: number | undefined } = {}
) {
  const raw = await getAlpacaAccount(operation, {
    tradingAccountId: options.tradingAccountId,
  });
  return normalizeAccount(raw);
}
