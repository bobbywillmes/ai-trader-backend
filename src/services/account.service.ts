import type { BrokerCredentialStatus } from '@prisma/client';
import { getAlpacaAccount } from '../integrations/alpaca/account.adapter.js';
import { normalizeAccount } from '../integrations/alpaca/normalizers.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';

export async function getNormalizedAccount(
  operation: AlpacaApiOperation = 'account_read',
  options: {
    tradingAccountId?: number | undefined;
    credentialStatuses?: BrokerCredentialStatus[] | undefined;
  } = {}
) {
  const raw = await getAlpacaAccount(operation, {
    tradingAccountId: options.tradingAccountId,
    credentialStatuses: options.credentialStatuses,
  });
  return normalizeAccount(raw);
}
