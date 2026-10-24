import { createHash, randomUUID } from 'node:crypto';
import { getAlpacaAccount } from '../integrations/alpaca/account.adapter.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { resolveAlpacaConfigForTradingAccount } from './alpaca-config-resolver.service.js';
import { fingerprintSecret } from './trading-credential-crypto.service.js';

export const LIFECYCLE_AUTHORITY_OPERATIONS = [
  'OBSERVE',
  'POSITION_CREATE',
  'POSITION_MARKET_REFRESH',
  'POSITION_LIFECYCLE_TRANSITION',
  'LOCAL_ORDER_ADOPT',
  'SUBSCRIPTION_ATTRIBUTION',
  'EXIT_STATE_MUTATION',
  'ENTRY_CLAIM_MUTATION',
  'RECONCILIATION_REPAIR',
  'BROKER_EXIT_WRITE',
] as const;

export type LifecycleAuthorityOperation = typeof LIFECYCLE_AUTHORITY_OPERATIONS[number];
export type LifecycleAuthorityOutcome = 'EXECUTOR' | 'OBSERVER' | 'UNKNOWN' | 'DENIED';
export type LifecycleAuthorityReasonCode =
  | 'VERIFIED_EXECUTOR'
  | 'VERIFIED_OBSERVER'
  | 'LIVE_POLICY_INDEPENDENT'
  | 'ACCOUNT_NOT_FOUND'
  | 'UNSUPPORTED_BROKER'
  | 'OWNERSHIP_UNDECLARED'
  | 'OWNERSHIP_DECLARATION_DUPLICATE'
  | 'OWNERSHIP_IDENTITY_CONTRADICTORY'
  | 'DEPLOYMENT_ROLE_CONTRADICTORY'
  | 'STORED_BROKER_IDENTITY_MISSING'
  | 'STORED_BROKER_IDENTITY_MISMATCH'
  | 'LOCAL_BROKER_IDENTITY_DUPLICATE'
  | 'CREDENTIAL_INACTIVE'
  | 'CREDENTIAL_UNVERIFIED'
  | 'CREDENTIAL_FINGERPRINT_MISSING'
  | 'CREDENTIAL_FINGERPRINT_MISMATCH'
  | 'EXECUTOR_FINGERPRINT_UNAUTHORIZED'
  | 'BROKER_IDENTITY_UNAVAILABLE'
  | 'BROKER_IDENTITY_MISMATCH';

const OBSERVER_OPERATIONS = new Set<LifecycleAuthorityOperation>([
  'OBSERVE', 'POSITION_CREATE', 'POSITION_MARKET_REFRESH',
]);
const EXECUTOR_OPERATIONS = new Set<LifecycleAuthorityOperation>(LIFECYCLE_AUTHORITY_OPERATIONS);
const MAX_GRANT_TTL_MS = 5 * 60_000;

export type LifecycleAuthorityAssessment = {
  tradingAccountId: number;
  environment: 'PAPER' | 'LIVE' | null;
  outcome: LifecycleAuthorityOutcome;
  reasonCode: LifecycleAuthorityReasonCode;
  reason: string;
  expectedBrokerAccountId: string | null;
  storedBrokerAccountId: string | null;
  observedBrokerAccountId: string | null;
  credentialFingerprint: string | null;
  configurationRevision: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  allowedOperations: LifecycleAuthorityOperation[];
  deniedOperations: Array<{ operation: LifecycleAuthorityOperation; reasonCode: string }>;
  provenanceRequiredForStrategyOperations: readonly string[];
  policyDelegation: 'PAPER_LIFECYCLE_AUTHORITY' | 'LIVE_INDEPENDENT';
};

declare const lifecycleGrantBrand: unique symbol;
export type LifecycleAuthorityGrant = { readonly [lifecycleGrantBrand]: true };
type GrantState = {
  id: string; tradingAccountId: number; operation: LifecycleAuthorityOperation;
  brokerAccountId: string; credentialFingerprint: string; configurationRevision: string;
  expiresAtMs: number;
};

const grants = new WeakMap<object, GrantState>();
const assessmentCache = new Map<number, { assessment: LifecycleAuthorityAssessment; expiresAtMs: number }>();

const accountSelect = {
  id: true, broker: true, environment: true, brokerAccountId: true,
  credential: { select: { id: true, status: true, verifiedAt: true, revokedAt: true, keyFingerprint: true, updatedAt: true } },
} as const;

type AccountEvidence = Awaited<ReturnType<typeof readAccountEvidence>>;

function configurationRevision(input: {
  account: NonNullable<AccountEvidence['account']>;
  declaration: { role: 'OBSERVER' | 'EXECUTOR'; expectedBrokerAccountId?: string | undefined };
}) {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    deploymentRole: env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE,
    declaration: input.declaration,
    brokerAccountId: input.account.brokerAccountId,
    credential: input.account.credential ? {
      id: input.account.credential.id,
      status: input.account.credential.status,
      verifiedAt: input.account.credential.verifiedAt?.toISOString() ?? null,
      revokedAt: input.account.credential.revokedAt?.toISOString() ?? null,
      keyFingerprint: input.account.credential.keyFingerprint,
      updatedAt: input.account.credential.updatedAt.toISOString(),
    } : null,
    authorizations: env.PAPER_BROKER_WRITE_AUTHORIZATIONS,
  })).digest('hex')}`;
}

function operationProjection(outcome: LifecycleAuthorityOutcome, reasonCode: LifecycleAuthorityReasonCode) {
  const allowed = outcome === 'EXECUTOR' ? EXECUTOR_OPERATIONS : outcome === 'OBSERVER' ? OBSERVER_OPERATIONS : new Set<LifecycleAuthorityOperation>();
  return {
    allowedOperations: LIFECYCLE_AUTHORITY_OPERATIONS.filter(operation => allowed.has(operation)),
    deniedOperations: LIFECYCLE_AUTHORITY_OPERATIONS.filter(operation => !allowed.has(operation)).map(operation => ({
      operation, reasonCode: outcome === 'OBSERVER' ? 'OBSERVER_STRATEGY_OPERATION_DENIED' : reasonCode,
    })),
  };
}

function result(base: Omit<LifecycleAuthorityAssessment, 'allowedOperations' | 'deniedOperations' | 'provenanceRequiredForStrategyOperations'>): LifecycleAuthorityAssessment {
  return {
    ...base,
    ...operationProjection(base.outcome, base.reasonCode),
    provenanceRequiredForStrategyOperations: [
      'Exact local OrderIntent-to-broker-order/fill linkage',
      'Frozen Subscription and TradingAccountSubscription identity',
      'A reviewed append-only provenance decision with non-contradictory evidence',
    ],
  };
}

async function readAccountEvidence(tradingAccountId: number) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: tradingAccountId }, select: accountSelect });
  const mappings = account?.brokerAccountId ? await prisma.tradingAccount.findMany({
    where: { broker: 'ALPACA', environment: account.environment, brokerAccountId: account.brokerAccountId }, select: { id: true },
  }) : [];
  return { account, mappings };
}

function baseFor(account: NonNullable<AccountEvidence['account']>, overrides: Partial<LifecycleAuthorityAssessment> = {}) {
  return {
    tradingAccountId: account.id, environment: account.environment, expectedBrokerAccountId: null,
    storedBrokerAccountId: account.brokerAccountId, observedBrokerAccountId: null,
    credentialFingerprint: account.credential?.keyFingerprint ?? null, configurationRevision: null,
    verifiedAt: null, expiresAt: null, policyDelegation: 'PAPER_LIFECYCLE_AUTHORITY' as const,
    ...overrides,
  };
}

export async function assessLifecycleAuthority(
  tradingAccountId: number,
  options: { forceRefresh?: boolean; now?: Date; ttlMs?: number } = {},
): Promise<LifecycleAuthorityAssessment> {
  const now = options.now ?? new Date();
  const cached = assessmentCache.get(tradingAccountId);
  if (!options.forceRefresh && cached && cached.expiresAtMs > now.getTime()) return cached.assessment;
  assessmentCache.delete(tradingAccountId);
  const { account, mappings } = await readAccountEvidence(tradingAccountId);
  if (!account) return result({ tradingAccountId, environment: null, outcome: 'UNKNOWN', reasonCode: 'ACCOUNT_NOT_FOUND',
    reason: 'The local TradingAccount does not exist.', expectedBrokerAccountId: null, storedBrokerAccountId: null,
    observedBrokerAccountId: null, credentialFingerprint: null, configurationRevision: null, verifiedAt: null,
    expiresAt: null, policyDelegation: 'PAPER_LIFECYCLE_AUTHORITY' });
  if (account.environment === 'LIVE') return result({ ...baseFor(account), outcome: 'UNKNOWN', reasonCode: 'LIVE_POLICY_INDEPENDENT',
    reason: 'LIVE lifecycle authority remains governed by the independent LIVE safety architecture.', policyDelegation: 'LIVE_INDEPENDENT' });
  if (account.broker !== 'ALPACA') return result({ ...baseFor(account), outcome: 'DENIED', reasonCode: 'UNSUPPORTED_BROKER', reason: 'Lifecycle authority currently supports Alpaca accounts only.' });

  const declarations = env.PAPER_BROKER_WRITE_OWNERSHIP.filter(item => item.tradingAccountId === account.id);
  if (declarations.length === 0) return result({ ...baseFor(account), outcome: 'UNKNOWN', reasonCode: 'OWNERSHIP_UNDECLARED', reason: 'No explicit account-specific PAPER ownership declaration exists.' });
  if (declarations.length !== 1) return result({ ...baseFor(account), outcome: 'DENIED', reasonCode: 'OWNERSHIP_DECLARATION_DUPLICATE', reason: 'More than one PAPER ownership declaration targets this account.' });
  const declaration = declarations[0]!;
  const expected = declaration.expectedBrokerAccountId ?? null;
  const withDeclaration = { ...baseFor(account), expectedBrokerAccountId: expected };
  if (env.PAPER_BROKER_WRITE_OWNERSHIP.some(item => item.tradingAccountId !== account.id && item.expectedBrokerAccountId === expected)) {
    return result({ ...withDeclaration, outcome: 'DENIED', reasonCode: 'OWNERSHIP_IDENTITY_CONTRADICTORY', reason: 'The expected brokerage identity is declared for another local account.' });
  }
  if (declaration.role === 'EXECUTOR' && env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE !== 'PAPER_EXECUTOR'
    || declaration.role === 'OBSERVER' && env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE !== 'OBSERVATION_ONLY') {
    return result({ ...withDeclaration, outcome: 'DENIED', reasonCode: 'DEPLOYMENT_ROLE_CONTRADICTORY', reason: 'The account ownership declaration contradicts the deployment role.' });
  }
  if (!account.brokerAccountId) return result({ ...withDeclaration, outcome: 'UNKNOWN', reasonCode: 'STORED_BROKER_IDENTITY_MISSING', reason: 'The stored verified brokerage account identity is missing.' });
  if (account.brokerAccountId !== expected) return result({ ...withDeclaration, outcome: 'DENIED', reasonCode: 'STORED_BROKER_IDENTITY_MISMATCH', reason: 'The stored brokerage identity does not match the ownership declaration.' });
  if (mappings.length !== 1 || mappings[0]?.id !== account.id) return result({ ...withDeclaration, outcome: 'DENIED', reasonCode: 'LOCAL_BROKER_IDENTITY_DUPLICATE', reason: 'The brokerage identity has duplicate or contradictory local mappings.' });
  if (!account.credential || account.credential.status !== 'ACTIVE' || account.credential.revokedAt) return result({ ...withDeclaration, outcome: 'DENIED', reasonCode: 'CREDENTIAL_INACTIVE', reason: 'The account credential is inactive or revoked.' });
  if (!account.credential.verifiedAt) return result({ ...withDeclaration, outcome: 'UNKNOWN', reasonCode: 'CREDENTIAL_UNVERIFIED', reason: 'The active credential has not been verified.' });
  if (!account.credential.keyFingerprint) return result({ ...withDeclaration, outcome: 'UNKNOWN', reasonCode: 'CREDENTIAL_FINGERPRINT_MISSING', reason: 'The verified credential fingerprint is missing.' });

  let config;
  try { config = await resolveAlpacaConfigForTradingAccount(account.id); }
  catch { return result({ ...withDeclaration, outcome: 'UNKNOWN', reasonCode: 'CREDENTIAL_FINGERPRINT_MISMATCH', reason: 'Credential material could not be resolved and verified.' }); }
  if (config.keyFingerprint !== account.credential.keyFingerprint || fingerprintSecret(config.apiKey) !== account.credential.keyFingerprint) {
    return result({ ...withDeclaration, outcome: 'DENIED', reasonCode: 'CREDENTIAL_FINGERPRINT_MISMATCH', reason: 'Decrypted credential material does not match the stored fingerprint.' });
  }
  if (declaration.role === 'EXECUTOR' && !env.PAPER_BROKER_WRITE_AUTHORIZATIONS.some(item => item.brokerAccountId === expected && item.keyFingerprint === account.credential!.keyFingerprint)) {
    return result({ ...withDeclaration, outcome: 'DENIED', reasonCode: 'EXECUTOR_FINGERPRINT_UNAUTHORIZED', reason: 'Executor lifecycle authority lacks the existing exact fingerprint authorization.' });
  }
  let observedBrokerAccountId: string;
  try { observedBrokerAccountId = (await getAlpacaAccount(account.id, 'account_read')).account_number; }
  catch { return result({ ...withDeclaration, outcome: 'UNKNOWN', reasonCode: 'BROKER_IDENTITY_UNAVAILABLE', reason: 'Fresh broker identity verification failed.' }); }
  if (observedBrokerAccountId !== expected || observedBrokerAccountId !== account.brokerAccountId) {
    return result({ ...withDeclaration, observedBrokerAccountId, outcome: 'DENIED', reasonCode: 'BROKER_IDENTITY_MISMATCH', reason: 'Broker-returned identity does not exactly match expected and stored identities.' });
  }
  const ttlMs = Math.min(Math.max(options.ttlMs ?? MAX_GRANT_TTL_MS, 1), MAX_GRANT_TTL_MS);
  const expiresAtMs = now.getTime() + ttlMs;
  const revision = configurationRevision({ account, declaration });
  const assessment = result({ ...withDeclaration, observedBrokerAccountId, credentialFingerprint: account.credential.keyFingerprint,
    configurationRevision: revision, verifiedAt: now.toISOString(), expiresAt: new Date(expiresAtMs).toISOString(),
    outcome: declaration.role, reasonCode: declaration.role === 'EXECUTOR' ? 'VERIFIED_EXECUTOR' : 'VERIFIED_OBSERVER',
    reason: `Exact PAPER identity and credential state are verified for ${declaration.role.toLowerCase()} lifecycle assessment.` });
  assessmentCache.set(account.id, { assessment, expiresAtMs });
  return assessment;
}

export async function issueLifecycleAuthorityGrant(args: {
  tradingAccountId: number; operation: LifecycleAuthorityOperation; ttlMs?: number; now?: Date;
}): Promise<LifecycleAuthorityGrant | null> {
  const assessment = await assessLifecycleAuthority(args.tradingAccountId, {
    ...(args.now ? { now: args.now } : {}), ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs }),
  });
  if (!assessment.allowedOperations.includes(args.operation) || !assessment.observedBrokerAccountId
    || !assessment.credentialFingerprint || !assessment.configurationRevision || !assessment.expiresAt) return null;
  const token = Object.freeze({}) as LifecycleAuthorityGrant;
  grants.set(token, { id: randomUUID(), tradingAccountId: args.tradingAccountId, operation: args.operation,
    brokerAccountId: assessment.observedBrokerAccountId, credentialFingerprint: assessment.credentialFingerprint,
    configurationRevision: assessment.configurationRevision, expiresAtMs: new Date(assessment.expiresAt).getTime() });
  return token;
}

export async function validateLifecycleAuthorityGrant(args: {
  grant: LifecycleAuthorityGrant; tradingAccountId: number; operation: LifecycleAuthorityOperation; now?: Date;
}): Promise<boolean> {
  const state = grants.get(args.grant as object);
  if (!state || state.tradingAccountId !== args.tradingAccountId || state.operation !== args.operation
    || state.expiresAtMs <= (args.now ?? new Date()).getTime()) return false;
  const { account, mappings } = await readAccountEvidence(args.tradingAccountId);
  if (!account || account.environment !== 'PAPER' || account.brokerAccountId !== state.brokerAccountId
    || mappings.length !== 1 || mappings[0]?.id !== account.id) return false;
  const declaration = env.PAPER_BROKER_WRITE_OWNERSHIP.find(item => item.tradingAccountId === account.id);
  if (!declaration || declaration.expectedBrokerAccountId !== state.brokerAccountId || !account.credential
    || account.credential.status !== 'ACTIVE' || account.credential.revokedAt || !account.credential.verifiedAt
    || account.credential.keyFingerprint !== state.credentialFingerprint) return false;
  return configurationRevision({ account, declaration }) === state.configurationRevision;
}

export function invalidateLifecycleAuthorityCache(tradingAccountId?: number) {
  if (tradingAccountId === undefined) assessmentCache.clear(); else assessmentCache.delete(tradingAccountId);
}

export const LIFECYCLE_AUTHORITY_GRANT_MAX_TTL_MS = MAX_GRANT_TTL_MS;
