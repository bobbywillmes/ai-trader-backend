import type { AlpacaResolvedConfig } from './alpaca-config-resolver.service.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { resolveAlpacaConfigForTradingAccount } from './alpaca-config-resolver.service.js';
import { fingerprintSecret } from './trading-credential-crypto.service.js';

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
  const actualFingerprint = fingerprintSecret(config.apiKey);
  if (actualFingerprint !== config.keyFingerprint) {
    throw new Error('PAPER broker write blocked because the decrypted credential does not match its stored fingerprint.');
  }
  const authorized = env.PAPER_BROKER_WRITE_AUTHORIZATIONS.some(item =>
    item.brokerAccountId === config.brokerAccountId &&
    item.keyFingerprint === config.keyFingerprint,
  );
  if (!authorized) {
    throw new Error('PAPER broker write blocked because the brokerage account and credential identity are not authorized for this deployment.');
  }
}

export type PaperAccountAuthorityAssessment = {
  tradingAccountId: number;
  displayName: string;
  openLifecycleExposure: boolean;
  credentialUsable: boolean;
  brokerAccountIdVerified: boolean;
  credentialFingerprintConsistent: boolean;
  intendedExecutor: boolean;
  outcome: 'AUTHORIZED' | 'INTENTIONAL_OBSERVATION_ONLY' | 'DENIED' | 'UNKNOWN';
  ready: boolean;
  reason: string;
};

export async function assessPaperBrokerWriteAuthorityForAccount(
  tradingAccountId: number,
): Promise<PaperAccountAuthorityAssessment> {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { id: true, displayName: true, environment: true, brokerAccountId: true,
      credential: { select: { status: true, verifiedAt: true, keyFingerprint: true } },
      trackedPositions: { where: { status: { in: ['open', 'closing'] } }, select: { id: true }, take: 1 } },
  });
  if (!account || account.environment !== 'PAPER') throw new Error('PAPER trading account was not found.');
  const intended = account.brokerAccountId !== null && env.PAPER_BROKER_WRITE_AUTHORIZATIONS.some(
    item => item.brokerAccountId === account.brokerAccountId,
  );
  const base = { tradingAccountId: account.id, displayName: account.displayName,
    openLifecycleExposure: account.trackedPositions.length > 0, intendedExecutor: intended };
  if (env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE === 'OBSERVATION_ONLY' || !intended) {
    return { ...base, credentialUsable: false, brokerAccountIdVerified: account.brokerAccountId !== null,
      credentialFingerprintConsistent: false, outcome: 'INTENTIONAL_OBSERVATION_ONLY', ready: true,
      reason: 'This brokerage identity is not assigned to this deployment for PAPER execution.' };
  }
  try {
    const config = await resolveAlpacaConfigForTradingAccount(account.id);
    const credentialUsable = account.credential?.status === 'ACTIVE' && account.credential.verifiedAt !== null;
    const fingerprintConsistent = config.keyFingerprint !== null && account.credential?.keyFingerprint === config.keyFingerprint && fingerprintSecret(config.apiKey) === config.keyFingerprint;
    const authorized = credentialUsable && fingerprintConsistent && config.brokerAccountId !== null && env.PAPER_BROKER_WRITE_AUTHORIZATIONS.some(
      item => item.brokerAccountId === config.brokerAccountId && item.keyFingerprint === config.keyFingerprint,
    );
    return { ...base, credentialUsable, brokerAccountIdVerified: config.brokerAccountId !== null,
      credentialFingerprintConsistent: fingerprintConsistent, outcome: authorized ? 'AUTHORIZED' : 'DENIED',
      ready: authorized, reason: authorized ? 'Exact account_number and credential fingerprint are authorized.'
        : 'Required PAPER executor identity evidence is missing, stale, or inconsistent.' };
  } catch {
    return { ...base, credentialUsable: false, brokerAccountIdVerified: account.brokerAccountId !== null,
      credentialFingerprintConsistent: false, outcome: 'UNKNOWN', ready: false,
      reason: 'Required PAPER executor credential identity could not be read.' };
  }
}

export async function assessPaperBrokerWriteAuthority(): Promise<{ configuration: PaperBrokerWriteAuthorityStatus; ready: boolean; accounts: PaperAccountAuthorityAssessment[] }> {
  const accounts = await prisma.tradingAccount.findMany({ where: { environment: 'PAPER' }, select: { id: true }, orderBy: { id: 'asc' } });
  const results: PaperAccountAuthorityAssessment[] = [];
  for (const account of accounts) {
    try { results.push(await assessPaperBrokerWriteAuthorityForAccount(account.id)); }
    catch { results.push({ tradingAccountId: account.id, displayName: 'Unavailable', openLifecycleExposure: false,
      credentialUsable: false, brokerAccountIdVerified: false, credentialFingerprintConsistent: false,
      intendedExecutor: false, outcome: 'UNKNOWN', ready: false, reason: 'Account identity evidence could not be read.' }); }
  }
  const configuration = getPaperBrokerWriteAuthorityStatus();
  const required = results.filter(item => item.intendedExecutor || (env.NODE_ENV === 'production' && item.openLifecycleExposure));
  return { configuration, ready: configuration.ready && required.every(item => item.outcome === 'AUTHORIZED'), accounts: results };
}
