import type { AlpacaResolvedConfig } from './alpaca-config-resolver.service.js';
import { env } from '../config/env.js';

export type PaperBrokerWriteAuthorityStatus = {
  deploymentRole: 'OBSERVATION_ONLY' | 'PAPER_EXECUTOR';
  configuredIdentityCount: number;
  ready: boolean;
  message: string;
};

export function getPaperBrokerWriteAuthorityStatus(): PaperBrokerWriteAuthorityStatus {
  const configuredIdentityCount = env.PAPER_BROKER_WRITE_AUTHORIZATIONS.length;
  const ready = env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE === 'OBSERVATION_ONLY'
    ? configuredIdentityCount === 0
    : configuredIdentityCount > 0;
  return {
    deploymentRole: env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE,
    configuredIdentityCount,
    ready,
    message: env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE === 'OBSERVATION_ONLY'
      ? 'PAPER broker writes are denied on this deployment.'
      : `${configuredIdentityCount} exact PAPER brokerage identity authorization(s) configured.`,
  };
}

export function authorizePaperBrokerWrite(config: AlpacaResolvedConfig): void {
  if (env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE !== 'PAPER_EXECUTOR') {
    throw new Error('PAPER broker writes are blocked because this deployment is OBSERVATION_ONLY.');
  }
  if (!config.brokerAccountId || !config.keyFingerprint) {
    throw new Error('PAPER broker write blocked because verified brokerage identity evidence is incomplete.');
  }
  const authorized = env.PAPER_BROKER_WRITE_AUTHORIZATIONS.some(item =>
    item.brokerAccountId === config.brokerAccountId &&
    item.keyFingerprint === config.keyFingerprint,
  );
  if (!authorized) {
    throw new Error('PAPER broker write blocked because the brokerage account and credential identity are not authorized for this deployment.');
  }
}
