import {
  TradingAccountEnvironment,
  TradingBroker,
  type TradingAccount,
} from '@prisma/client';
import { env } from '../config/env.js';
import {
  getTradingAccountById,
  resolveDefaultTradingAccountId,
} from './trading-account.service.js';
import { loadActiveTradingAccountApiKeyCredential } from './trading-account-credential.service.js';

const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const ALPACA_LIVE_BASE_URL = 'https://api.alpaca.markets';

export type AlpacaCredentialSource = 'trading_account_credential' | 'legacy_env';

export type AlpacaResolvedConfig = {
  tradingAccountId: number;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  source: AlpacaCredentialSource;
  credentialId: number | null;
  keyFingerprint: string | null;
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
    `Trading account ${tradingAccountId} does not have active Alpaca credentials. Add an ACTIVE TradingAccountCredential before using this non-default trading account.`
  );
}

function legacyEnvCredentialConfig(account: TradingAccount): AlpacaResolvedConfig {
  return {
    tradingAccountId: account.id,
    baseUrl: env.ALPACA_BASE_URL,
    apiKey: env.ALPACA_API_KEY,
    apiSecret: env.ALPACA_API_SECRET,
    source: 'legacy_env',
    credentialId: null,
    keyFingerprint: null,
  };
}

function baseUrlForAccountEnvironment(environment: TradingAccountEnvironment) {
  return environment === TradingAccountEnvironment.LIVE
    ? ALPACA_LIVE_BASE_URL
    : ALPACA_PAPER_BASE_URL;
}

export async function resolveAlpacaConfigForTradingAccount(
  tradingAccountId: number
): Promise<AlpacaResolvedConfig> {
  const account = await getTradingAccountById(tradingAccountId);

  if (!account) {
    throw missingTradingAccountError(tradingAccountId);
  }

  if (account.broker !== TradingBroker.ALPACA) {
    throw unsupportedBrokerError(account);
  }

  const credential =
    await loadActiveTradingAccountApiKeyCredential(tradingAccountId);

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

  const defaultTradingAccountId = await resolveDefaultTradingAccountId();

  if (tradingAccountId === defaultTradingAccountId) {
    return legacyEnvCredentialConfig(account);
  }

  throw missingAccountCredentialsError(tradingAccountId);
}
