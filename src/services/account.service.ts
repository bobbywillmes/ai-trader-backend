import type { BrokerCredentialStatus } from '@prisma/client';
import { getAlpacaAccount } from '../integrations/alpaca/account.adapter.js';
import { normalizeAccount } from '../integrations/alpaca/normalizers.js';
import type { AlpacaApiOperation } from '../integrations/alpaca/request-metadata.js';
import { prisma } from '../db/prisma.js';

export async function getNormalizedAccount(
  tradingAccountId: number,
  operation: AlpacaApiOperation = 'account_read',
  options: {
    credentialStatuses?: BrokerCredentialStatus[] | undefined;
  } = {}
) {
  const raw = await getAlpacaAccount(tradingAccountId, operation, {
    credentialStatuses: options.credentialStatuses,
  });
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: tradingAccountId },
    select: { environment: true },
  });
  return normalizeAccount(
    raw,
    account.environment === 'PAPER' ? 'paper' : 'live'
  );
}
