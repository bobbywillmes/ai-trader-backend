import {
  BrokerCredentialStatus,
  TradingAccountEnvironment,
  TradingBroker,
  type TradingAccount,
} from '@prisma/client';
import {
  getTradingAccountById,
} from './trading-account.service.js';
import { loadTradingAccountApiKeyCredential } from './trading-account-credential.service.js';

const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const ALPACA_LIVE_BASE_URL = 'https://api.alpaca.markets';

export type AlpacaCredentialSource = 'trading_account_credential';

export type AlpacaResolvedConfig = {
  tradingAccountId: number;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  source: AlpacaCredentialSource;
  credentialId: number | null;
  keyFingerprint: string | null;
};

export type AlpacaConfigResolverOptions = {
  credentialStatuses?: BrokerCredentialStatus[] | undefined;
};

function missingTradingAccountError(tradingAccountId: number) {
  return new Error(`Trading account ${tradingAccountId} could not be found.`);
}

function unsupportedBrokerError(account: TradingAccount) {
  return new Error(
    `Trading account ${account.id} uses unsupported broker ${account.broker}.`
  );
}

function missingAccountCredentialsError(tradingAccountId: number) {
  return new Error(
    `Trading account ${tradingAccountId} does not have active Alpaca credentials. Add and verify an ACTIVE TradingAccountCredential before broker access.`
  );
}

function baseUrlForAccountEnvironment(environment: TradingAccountEnvironment) {
  return environment === TradingAccountEnvironment.LIVE
    ? ALPACA_LIVE_BASE_URL
    : ALPACA_PAPER_BASE_URL;
}

export async function resolveAlpacaConfigForTradingAccount(
  tradingAccountId: number,
  options: AlpacaConfigResolverOptions = {}
): Promise<AlpacaResolvedConfig> {
  const account = await getTradingAccountById(tradingAccountId);

  if (!account) {
    throw missingTradingAccountError(tradingAccountId);
  }

  if (account.broker !== TradingBroker.ALPACA) {
    throw unsupportedBrokerError(account);
  }

  const credential = await loadTradingAccountApiKeyCredential(
    tradingAccountId,
    options.credentialStatuses ?? [BrokerCredentialStatus.ACTIVE]
  );

  if (credential) {
    return {
      tradingAccountId,
      baseUrl: baseUrlForAccountEnvironment(account.environment),
      apiKey: credential.apiKey,
      apiSecret: credential.apiSecret,
      source: 'trading_account_credential',
      credentialId: credential.credentialId,
      keyFingerprint: credential.keyFingerprint,
    };
  }

  throw missingAccountCredentialsError(tradingAccountId);
}
