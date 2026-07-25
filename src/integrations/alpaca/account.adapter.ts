import type { BrokerCredentialStatus } from '@prisma/client';
import { alpacaRequestForAccount } from './client.js';
import type { AlpacaAccount } from './alpaca.types.js';
import type { AlpacaApiOperation } from './request-metadata.js';

export async function getAlpacaAccount(
  tradingAccountId: number,
  operation: AlpacaApiOperation = 'account_read',
  options: {
    credentialStatuses?: BrokerCredentialStatus[] | undefined;
  } = {}
): Promise<AlpacaAccount> {
  return alpacaRequestForAccount<AlpacaAccount>(tradingAccountId, '/v2/account', {
    credentialStatuses: options.credentialStatuses,
    metadata: {
      operation,
      endpoint: 'GET /v2/account',
      method: 'GET',
      requestClass: 'informational_read',
      deferDuringRateLimit: operation === 'account_snapshot',
    },
  });
}
