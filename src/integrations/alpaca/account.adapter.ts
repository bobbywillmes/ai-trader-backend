import { alpacaRequest } from './client.js';
import type { AlpacaAccount } from './alpaca.types.js';
import type { AlpacaApiOperation } from './request-metadata.js';

export async function getAlpacaAccount(
  operation: AlpacaApiOperation = 'account_read',
  options: { tradingAccountId?: number | undefined } = {}
): Promise<AlpacaAccount> {
  return alpacaRequest<AlpacaAccount>('/v2/account', {
    tradingAccountId: options.tradingAccountId,
    metadata: {
      operation,
      endpoint: 'GET /v2/account',
      method: 'GET',
      requestClass: 'informational_read',
      deferDuringRateLimit: operation === 'account_snapshot',
    },
  });
}
