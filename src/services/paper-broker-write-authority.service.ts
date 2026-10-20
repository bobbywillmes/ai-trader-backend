import type { AlpacaResolvedConfig } from './alpaca-config-resolver.service.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { resolveAlpacaConfigForTradingAccount } from './alpaca-config-resolver.service.js';
import { fingerprintSecret } from './trading-credential-crypto.service.js';

export type PaperBrokerWriteAuthorityStatus = {
  deploymentRole: 'OBSERVATION_ONLY' | 'PAPER_EXECUTOR'; configuredIdentityCount: number;
  expectedExecutorCount: number; explicitObserverCount: number; configurationValid: boolean; message: string;
};

export function getPaperBrokerWriteAuthorityStatus(): PaperBrokerWriteAuthorityStatus {
  const configuredIdentityCount = env.PAPER_BROKER_WRITE_AUTHORIZATIONS.length;
  const expectedExecutorCount = env.PAPER_BROKER_WRITE_OWNERSHIP.filter(item => item.role === 'EXECUTOR').length;
  const explicitObserverCount = env.PAPER_BROKER_WRITE_OWNERSHIP.filter(item => item.role === 'OBSERVER').length;
  const configurationValid = env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE === 'OBSERVATION_ONLY'
    ? configuredIdentityCount === 0 && expectedExecutorCount === 0 : configuredIdentityCount > 0 && expectedExecutorCount > 0;
  return { deploymentRole: env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE, configuredIdentityCount, expectedExecutorCount,
    explicitObserverCount, configurationValid, message: env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE === 'OBSERVATION_ONLY'
      ? `${explicitObserverCount} PAPER account(s) are explicitly observation-only on this deployment.`
      : `${expectedExecutorCount} expected executor(s) and ${configuredIdentityCount} exact authorization(s) configured.` };
}

export function authorizePaperBrokerWrite(config: AlpacaResolvedConfig): void {
  if (env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE !== 'PAPER_EXECUTOR') throw new Error('PAPER broker writes are blocked because this deployment is OBSERVATION_ONLY.');
  if (!config.brokerAccountId || !config.keyFingerprint) throw new Error('PAPER broker write blocked because verified brokerage identity evidence is incomplete.');
  if (fingerprintSecret(config.apiKey) !== config.keyFingerprint) throw new Error('PAPER broker write blocked because the decrypted credential does not match its stored fingerprint.');
  if (!env.PAPER_BROKER_WRITE_AUTHORIZATIONS.some(item => item.brokerAccountId === config.brokerAccountId && item.keyFingerprint === config.keyFingerprint)) {
    throw new Error('PAPER broker write blocked because the brokerage account and credential identity are not authorized for this deployment.');
  }
}

export type PaperAccountAuthorityAssessment = {
  tradingAccountId: number; displayName: string; ownershipRole: 'OBSERVER' | 'EXECUTOR' | 'UNDECLARED' | 'UNKNOWN';
  expectedBrokerAccountId: string | null; openLifecycleExposure: boolean | null;
  exposure: { activePositions: number; nonterminalBrokerOrders: number; activeOrderIntents: number; activeEntryClaims: number } | null;
  credentialUsable: boolean | null; brokerAccountIdVerified: boolean | null; credentialFingerprintConsistent: boolean | null;
  intendedExecutor: boolean | null; outcome: 'AUTHORIZED' | 'INTENTIONAL_OBSERVATION_ONLY' | 'DENIED' | 'UNKNOWN'; ready: boolean; reason: string;
};

export async function assessPaperBrokerWriteAuthorityForAccount(tradingAccountId: number): Promise<PaperAccountAuthorityAssessment> {
  const account = await prisma.tradingAccount.findUnique({ where: { id: tradingAccountId }, select: {
    id: true, displayName: true, environment: true, brokerAccountId: true,
    credential: { select: { status: true, verifiedAt: true, keyFingerprint: true } },
    _count: { select: {
      trackedPositions: { where: { status: { in: ['open', 'closing'] } } }, brokerOrders: { where: { status: { notIn: ['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'replaced', 'done_for_day', 'calculated'] } } },
      orderIntents: { where: { status: { in: ['pending', 'submitting', 'submitted'] } } }, entryExposureClaims: { where: { status: 'ACTIVE' } },
    } },
  } });
  if (!account) throw new Error('PAPER trading account was not found.');
  if (account.environment !== 'PAPER') throw new Error('Trading account is not a PAPER account.');
  const declaration = env.PAPER_BROKER_WRITE_OWNERSHIP.find(item => item.tradingAccountId === account.id);
  const exposure = { activePositions: account._count.trackedPositions, nonterminalBrokerOrders: account._count.brokerOrders,
    activeOrderIntents: account._count.orderIntents, activeEntryClaims: account._count.entryExposureClaims };
  const base = { tradingAccountId: account.id, displayName: account.displayName, ownershipRole: declaration?.role ?? 'UNDECLARED' as const,
    expectedBrokerAccountId: declaration?.expectedBrokerAccountId ?? null, openLifecycleExposure: Object.values(exposure).some(count => count > 0),
    exposure, intendedExecutor: declaration ? declaration.role === 'EXECUTOR' : false };
  if (declaration?.role === 'OBSERVER') {
    const productionExposureConflict = env.NODE_ENV === 'production' && base.openLifecycleExposure;
    return { ...base, credentialUsable: null, brokerAccountIdVerified: null, credentialFingerprintConsistent: null,
      outcome: productionExposureConflict ? 'DENIED' : 'INTENTIONAL_OBSERVATION_ONLY', ready: !productionExposureConflict,
      reason: productionExposureConflict
        ? 'A production PAPER account with lifecycle exposure cannot be assigned observation-only ownership.'
        : 'This TradingAccount is explicitly declared observation-only on this deployment.' };
  }
  if (!declaration) return { ...base, credentialUsable: null, brokerAccountIdVerified: account.brokerAccountId !== null,
    credentialFingerprintConsistent: null, outcome: base.openLifecycleExposure ? 'UNKNOWN' : 'DENIED', ready: false,
    reason: 'No explicit PAPER ownership declaration exists for this TradingAccount.' };
  if (env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE !== 'PAPER_EXECUTOR') return { ...base, credentialUsable: null,
    brokerAccountIdVerified: account.brokerAccountId !== null, credentialFingerprintConsistent: null, outcome: 'DENIED', ready: false,
    reason: 'The account is an expected executor but the deployment role is OBSERVATION_ONLY.' };
  if (account.brokerAccountId === null) return { ...base, credentialUsable: account.credential?.status === 'ACTIVE', brokerAccountIdVerified: false,
    credentialFingerprintConsistent: null, outcome: 'UNKNOWN', ready: false, reason: 'The expected executor has no verified Alpaca account_number.' };
  if (account.brokerAccountId !== declaration.expectedBrokerAccountId) return { ...base, credentialUsable: account.credential?.status === 'ACTIVE',
    brokerAccountIdVerified: false, credentialFingerprintConsistent: null, outcome: 'DENIED', ready: false,
    reason: 'The stored Alpaca account_number does not match the expected executor ownership declaration.' };
  try {
    const config = await resolveAlpacaConfigForTradingAccount(account.id);
    const credentialUsable = account.credential?.status === 'ACTIVE' && account.credential.verifiedAt !== null;
    const fingerprintConsistent = config.keyFingerprint !== null && account.credential?.keyFingerprint === config.keyFingerprint && fingerprintSecret(config.apiKey) === config.keyFingerprint;
    const authorized = credentialUsable && fingerprintConsistent && config.brokerAccountId === declaration.expectedBrokerAccountId
      && env.PAPER_BROKER_WRITE_AUTHORIZATIONS.some(item => item.brokerAccountId === config.brokerAccountId && item.keyFingerprint === config.keyFingerprint);
    return { ...base, credentialUsable, brokerAccountIdVerified: config.brokerAccountId === declaration.expectedBrokerAccountId,
      credentialFingerprintConsistent: fingerprintConsistent, outcome: authorized ? 'AUTHORIZED' : 'DENIED', ready: authorized,
      reason: authorized ? 'Expected ownership, exact Alpaca account_number, and credential fingerprint are authorized.'
        : 'Expected executor credential identity is stale, inconsistent, or absent from the authorization allowlist.' };
  } catch {
    return { ...base, credentialUsable: false, brokerAccountIdVerified: true, credentialFingerprintConsistent: null,
      outcome: 'UNKNOWN', ready: false, reason: 'Expected executor credential identity could not be read.' };
  }
}

export type PaperBrokerWriteAuthorityAssessment = { configuration: PaperBrokerWriteAuthorityStatus; ready: boolean; unresolved: string[]; accounts: PaperAccountAuthorityAssessment[] };

export async function assessPaperBrokerWriteAuthority(): Promise<PaperBrokerWriteAuthorityAssessment> {
  let accounts: Array<{ id: number }>;
  try { accounts = await prisma.tradingAccount.findMany({ where: { environment: 'PAPER' }, select: { id: true }, orderBy: { id: 'asc' } }); }
  catch { return { configuration: getPaperBrokerWriteAuthorityStatus(), ready: false, unresolved: ['PAPER account enumeration failed.'], accounts: [] }; }
  const results: PaperAccountAuthorityAssessment[] = []; const unresolved: string[] = [];
  for (const account of accounts) {
    try { results.push(await assessPaperBrokerWriteAuthorityForAccount(account.id)); }
    catch { results.push({ tradingAccountId: account.id, displayName: 'Unavailable', ownershipRole: 'UNKNOWN', expectedBrokerAccountId: null,
      openLifecycleExposure: null, exposure: null, credentialUsable: null, brokerAccountIdVerified: null, credentialFingerprintConsistent: null,
      intendedExecutor: null, outcome: 'UNKNOWN', ready: false, reason: 'Account ownership, identity, and exposure evidence could not be read.' });
      unresolved.push(`TradingAccount ${account.id} could not be inspected.`); }
  }
  const configuration = getPaperBrokerWriteAuthorityStatus();
  for (const authorization of env.PAPER_BROKER_WRITE_AUTHORIZATIONS) {
    const matches = results.filter(item => item.expectedBrokerAccountId === authorization.brokerAccountId && item.ownershipRole === 'EXECUTOR');
    if (matches.length !== 1) unresolved.push(`Authorization for Alpaca account_number ${authorization.brokerAccountId} resolves to ${matches.length} expected executors.`);
  }
  for (const declaration of env.PAPER_BROKER_WRITE_OWNERSHIP.filter(item => item.role === 'EXECUTOR')) {
    const matches = results.filter(item => item.tradingAccountId === declaration.tradingAccountId);
    if (matches.length !== 1 || matches[0]?.outcome !== 'AUTHORIZED') unresolved.push(`Expected executor TradingAccount ${declaration.tradingAccountId} is not AUTHORIZED.`);
  }
  if (env.NODE_ENV === 'production') for (const item of results) {
    if (item.openLifecycleExposure !== false && item.outcome !== 'AUTHORIZED') unresolved.push(`Production PAPER account ${item.tradingAccountId} has unresolved ownership or exposure authority.`);
  }
  if (env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE === 'PAPER_EXECUTOR' && configuration.expectedExecutorCount === 0) unresolved.push('PAPER_EXECUTOR has no explicitly expected executor.');
  return { configuration, ready: configuration.configurationValid && unresolved.length === 0, unresolved: [...new Set(unresolved)], accounts: results };
}
