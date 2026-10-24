import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { getAlpacaAccount } from '../integrations/alpaca/account.adapter.js';
import { resolveAlpacaConfigForTradingAccount } from './alpaca-config-resolver.service.js';
import { fingerprintSecret } from './trading-credential-crypto.service.js';

export const LIFECYCLE_AUTHORITY_OPERATIONS = [
  'OBSERVE', 'POSITION_CREATE', 'POSITION_MARKET_REFRESH',
  'POSITION_LIFECYCLE_TRANSITION', 'LOCAL_ORDER_ADOPT', 'SUBSCRIPTION_ATTRIBUTION',
  'EXIT_STATE_MUTATION', 'ENTRY_CLAIM_MUTATION', 'RECONCILIATION_REPAIR', 'BROKER_EXIT_WRITE',
] as const;
export type LifecycleAuthorityOperation = typeof LIFECYCLE_AUTHORITY_OPERATIONS[number];
export type LifecycleAuthorityOutcome = 'EXECUTOR' | 'OBSERVER' | 'UNKNOWN' | 'DENIED';
export type LifecycleAuthorityReasonCode =
  | 'VERIFIED_EXECUTOR' | 'VERIFIED_OBSERVER' | 'LIVE_POLICY_INDEPENDENT'
  | 'ACCOUNT_NOT_FOUND' | 'UNSUPPORTED_BROKER' | 'OWNERSHIP_UNDECLARED'
  | 'OWNERSHIP_DECLARATION_DUPLICATE' | 'OWNERSHIP_IDENTITY_CONTRADICTORY'
  | 'DEPLOYMENT_ROLE_CONTRADICTORY' | 'STORED_BROKER_IDENTITY_MISSING'
  | 'STORED_BROKER_IDENTITY_MISMATCH' | 'LOCAL_BROKER_IDENTITY_DUPLICATE'
  | 'CREDENTIAL_INACTIVE' | 'CREDENTIAL_UNVERIFIED' | 'CREDENTIAL_FINGERPRINT_MISSING'
  | 'CREDENTIAL_FINGERPRINT_MISMATCH' | 'EXECUTOR_FINGERPRINT_UNAUTHORIZED'
  | 'BROKER_IDENTITY_UNAVAILABLE' | 'BROKER_IDENTITY_MISMATCH';

const OBSERVER_OPERATIONS = new Set<LifecycleAuthorityOperation>(['OBSERVE', 'POSITION_CREATE', 'POSITION_MARKET_REFRESH']);
const EXECUTOR_OPERATIONS = new Set<LifecycleAuthorityOperation>(LIFECYCLE_AUTHORITY_OPERATIONS);
const MAX_GRANT_TTL_MS = 5 * 60_000;

export type LifecycleAuthorityAssessment = Readonly<{
  tradingAccountId: number; environment: 'PAPER' | 'LIVE' | null; outcome: LifecycleAuthorityOutcome;
  reasonCode: LifecycleAuthorityReasonCode; reason: string; expectedBrokerAccountId: string | null;
  storedBrokerAccountId: string | null; observedBrokerAccountId: string | null;
  credentialFingerprint: string | null; configurationRevision: string | null;
  verifiedAt: string | null; expiresAt: string | null;
  allowedOperations: readonly LifecycleAuthorityOperation[];
  deniedOperations: readonly Readonly<{ operation: LifecycleAuthorityOperation; reasonCode: string }>[];
  provenanceRequiredForStrategyOperations: readonly string[];
  policyDelegation: 'PAPER_LIFECYCLE_AUTHORITY' | 'LIVE_INDEPENDENT';
}>;
type OwnershipRole = 'OBSERVER' | 'EXECUTOR';
type InternalVerdict = Readonly<{
  assessment: LifecycleAuthorityAssessment; role: OwnershipRole | null; brokerAccountId: string | null;
  credentialFingerprint: string | null; configurationRevision: string | null;
  verifiedAtMs: number | null; expiresAtMs: number | null; accountGeneration: number; globalGeneration: number;
}>;
declare const lifecycleGrantBrand: unique symbol;
export type LifecycleAuthorityGrant = { readonly [lifecycleGrantBrand]: true };
type GrantState = {
  id: string; tradingAccountId: number; operation: LifecycleAuthorityOperation; role: OwnershipRole;
  brokerAccountId: string; credentialFingerprint: string; configurationRevision: string;
  issuedAtMs: number; expiresAtMs: number; accountGeneration: number; globalGeneration: number; permanentlyExpired: boolean;
};

const grants = new WeakMap<object, GrantState>();
const assessmentCache = new Map<number, InternalVerdict>();
const accountGenerations = new Map<number, number>();
let globalGeneration = 0;
const accountSelect = { id: true, broker: true, environment: true, brokerAccountId: true,
  credential: { select: { id: true, status: true, verifiedAt: true, revokedAt: true, keyFingerprint: true, updatedAt: true } } } as const;
type AccountEvidence = Awaited<ReturnType<typeof readAccountEvidence>>;
type Declaration = { tradingAccountId: number; role: OwnershipRole; expectedBrokerAccountId?: string | undefined };

function trustedNowMs() { return Date.now(); }
function generationFor(accountId: number) { return accountGenerations.get(accountId) ?? 0; }
function policyAllows(role: OwnershipRole, operation: LifecycleAuthorityOperation) {
  return role === 'EXECUTOR' ? EXECUTOR_OPERATIONS.has(operation) : OBSERVER_OPERATIONS.has(operation);
}
function deploymentAllows(role: OwnershipRole) {
  return role === 'OBSERVER' || env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE === 'PAPER_EXECUTOR';
}
function executorFingerprintAuthorized(declaration: Declaration, fingerprint: string) {
  return declaration.role !== 'EXECUTOR' || env.PAPER_BROKER_WRITE_AUTHORIZATIONS.some(item =>
    item.brokerAccountId === declaration.expectedBrokerAccountId && item.keyFingerprint === fingerprint);
}
function configurationRevision(account: NonNullable<AccountEvidence['account']>, declaration: Declaration) {
  return `sha256:${createHash('sha256').update(JSON.stringify({ broker: account.broker, environment: account.environment,
    deploymentRole: env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE, declaration, brokerAccountId: account.brokerAccountId,
    credential: account.credential ? { id: account.credential.id, status: account.credential.status,
      verifiedAt: account.credential.verifiedAt?.toISOString() ?? null, revokedAt: account.credential.revokedAt?.toISOString() ?? null,
      keyFingerprint: account.credential.keyFingerprint, updatedAt: account.credential.updatedAt.toISOString() } : null,
    authorizations: env.PAPER_BROKER_WRITE_AUTHORIZATIONS })).digest('hex')}`;
}
function operationProjection(outcome: LifecycleAuthorityOutcome, reasonCode: LifecycleAuthorityReasonCode) {
  const role = outcome === 'EXECUTOR' || outcome === 'OBSERVER' ? outcome : null;
  return {
    allowedOperations: Object.freeze(LIFECYCLE_AUTHORITY_OPERATIONS.filter(operation => role && policyAllows(role, operation))),
    deniedOperations: Object.freeze(LIFECYCLE_AUTHORITY_OPERATIONS.filter(operation => !role || !policyAllows(role, operation)).map(operation =>
      Object.freeze({ operation, reasonCode: role === 'OBSERVER' ? 'OBSERVER_STRATEGY_OPERATION_DENIED' : reasonCode }))),
  };
}
function immutableAssessment(base: Omit<LifecycleAuthorityAssessment, 'allowedOperations' | 'deniedOperations' | 'provenanceRequiredForStrategyOperations'>) {
  return Object.freeze({ ...base, ...operationProjection(base.outcome, base.reasonCode),
    provenanceRequiredForStrategyOperations: Object.freeze(['Exact local OrderIntent-to-broker-order/fill linkage',
      'Frozen Subscription and TradingAccountSubscription identity',
      'A reviewed append-only provenance decision with non-contradictory evidence']) });
}
function detachedAssessment(assessment: LifecycleAuthorityAssessment): LifecycleAuthorityAssessment {
  return Object.freeze({ ...assessment, allowedOperations: Object.freeze([...assessment.allowedOperations]),
    deniedOperations: Object.freeze(assessment.deniedOperations.map(item => Object.freeze({ ...item }))),
    provenanceRequiredForStrategyOperations: Object.freeze([...assessment.provenanceRequiredForStrategyOperations]) });
}
function verdict(assessment: LifecycleAuthorityAssessment, generation: { account: number; global: number }, role: OwnershipRole | null = null): InternalVerdict {
  return Object.freeze({ assessment, role, brokerAccountId: assessment.observedBrokerAccountId,
    credentialFingerprint: assessment.credentialFingerprint, configurationRevision: assessment.configurationRevision,
    verifiedAtMs: assessment.verifiedAt ? Date.parse(assessment.verifiedAt) : null,
    expiresAtMs: assessment.expiresAt ? Date.parse(assessment.expiresAt) : null,
    accountGeneration: generation.account, globalGeneration: generation.global });
}
async function readAccountEvidence(tradingAccountId: number) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: tradingAccountId }, select: accountSelect });
  const mappings = account?.brokerAccountId ? await prisma.tradingAccount.findMany({ where: {
    broker: account.broker, environment: account.environment, brokerAccountId: account.brokerAccountId }, select: { id: true } }) : [];
  return { account, mappings };
}
function baseFor(account: NonNullable<AccountEvidence['account']>) {
  return { tradingAccountId: account.id, environment: account.environment, expectedBrokerAccountId: null,
    storedBrokerAccountId: account.brokerAccountId, observedBrokerAccountId: null,
    credentialFingerprint: account.credential?.keyFingerprint ?? null, configurationRevision: null,
    verifiedAt: null, expiresAt: null, policyDelegation: 'PAPER_LIFECYCLE_AUTHORITY' as const };
}
function invalidateAccount(accountId: number) {
  accountGenerations.set(accountId, generationFor(accountId) + 1);
  assessmentCache.delete(accountId);
}
function negativeVerdict(accountId: number, assessment: LifecycleAuthorityAssessment, forceRefresh: boolean) {
  if (forceRefresh || assessmentCache.get(accountId)?.role !== null) invalidateAccount(accountId);
  return verdict(assessment, { account: generationFor(accountId), global: globalGeneration });
}

async function assessInternal(tradingAccountId: number, forceRefresh = false): Promise<InternalVerdict> {
  const nowMs = trustedNowMs();
  const cached = assessmentCache.get(tradingAccountId);
  if (!forceRefresh && cached && cached.expiresAtMs !== null && cached.expiresAtMs > nowMs
    && cached.accountGeneration === generationFor(tradingAccountId) && cached.globalGeneration === globalGeneration) return cached;
  const started = { account: generationFor(tradingAccountId), global: globalGeneration };
  const { account, mappings } = await readAccountEvidence(tradingAccountId);
  const fail = (assessment: LifecycleAuthorityAssessment) => negativeVerdict(tradingAccountId, assessment, forceRefresh);
  if (!account) return fail(immutableAssessment({ tradingAccountId, environment: null, outcome: 'UNKNOWN', reasonCode: 'ACCOUNT_NOT_FOUND',
    reason: 'The local TradingAccount does not exist.', expectedBrokerAccountId: null, storedBrokerAccountId: null,
    observedBrokerAccountId: null, credentialFingerprint: null, configurationRevision: null, verifiedAt: null,
    expiresAt: null, policyDelegation: 'PAPER_LIFECYCLE_AUTHORITY' }));
  if (account.environment === 'LIVE') return fail(immutableAssessment({ ...baseFor(account), outcome: 'UNKNOWN', reasonCode: 'LIVE_POLICY_INDEPENDENT',
    reason: 'LIVE lifecycle authority remains governed by the independent LIVE safety architecture.', policyDelegation: 'LIVE_INDEPENDENT' }));
  if (account.broker !== 'ALPACA') return fail(immutableAssessment({ ...baseFor(account), outcome: 'DENIED', reasonCode: 'UNSUPPORTED_BROKER', reason: 'Lifecycle authority currently supports Alpaca accounts only.' }));
  const declarations = env.PAPER_BROKER_WRITE_OWNERSHIP.filter(item => item.tradingAccountId === account.id);
  if (declarations.length === 0) return fail(immutableAssessment({ ...baseFor(account), outcome: 'UNKNOWN', reasonCode: 'OWNERSHIP_UNDECLARED', reason: 'No explicit account-specific PAPER ownership declaration exists.' }));
  if (declarations.length !== 1) return fail(immutableAssessment({ ...baseFor(account), outcome: 'DENIED', reasonCode: 'OWNERSHIP_DECLARATION_DUPLICATE', reason: 'More than one PAPER ownership declaration targets this account.' }));
  const declaration = declarations[0]!;
  const expected = declaration.expectedBrokerAccountId ?? null;
  const declaredBase = { ...baseFor(account), expectedBrokerAccountId: expected };
  if (env.PAPER_BROKER_WRITE_OWNERSHIP.some(item => item.tradingAccountId !== account.id && item.expectedBrokerAccountId === expected))
    return fail(immutableAssessment({ ...declaredBase, outcome: 'DENIED', reasonCode: 'OWNERSHIP_IDENTITY_CONTRADICTORY', reason: 'The expected brokerage identity is declared for another local account.' }));
  if (!deploymentAllows(declaration.role)) return fail(immutableAssessment({ ...declaredBase, outcome: 'DENIED', reasonCode: 'DEPLOYMENT_ROLE_CONTRADICTORY', reason: 'The account ownership declaration contradicts the deployment role.' }));
  if (!account.brokerAccountId) return fail(immutableAssessment({ ...declaredBase, outcome: 'UNKNOWN', reasonCode: 'STORED_BROKER_IDENTITY_MISSING', reason: 'The stored verified brokerage account identity is missing.' }));
  if (account.brokerAccountId !== expected) return fail(immutableAssessment({ ...declaredBase, outcome: 'DENIED', reasonCode: 'STORED_BROKER_IDENTITY_MISMATCH', reason: 'The stored brokerage identity does not match the ownership declaration.' }));
  if (mappings.length !== 1 || mappings[0]?.id !== account.id) return fail(immutableAssessment({ ...declaredBase, outcome: 'DENIED', reasonCode: 'LOCAL_BROKER_IDENTITY_DUPLICATE', reason: 'The brokerage identity has duplicate or contradictory local mappings.' }));
  if (!account.credential || account.credential.status !== 'ACTIVE' || account.credential.revokedAt) return fail(immutableAssessment({ ...declaredBase, outcome: 'DENIED', reasonCode: 'CREDENTIAL_INACTIVE', reason: 'The account credential is inactive or revoked.' }));
  if (!account.credential.verifiedAt) return fail(immutableAssessment({ ...declaredBase, outcome: 'UNKNOWN', reasonCode: 'CREDENTIAL_UNVERIFIED', reason: 'The active credential has not been verified.' }));
  if (!account.credential.keyFingerprint) return fail(immutableAssessment({ ...declaredBase, outcome: 'UNKNOWN', reasonCode: 'CREDENTIAL_FINGERPRINT_MISSING', reason: 'The verified credential fingerprint is missing.' }));
  let config;
  try { config = await resolveAlpacaConfigForTradingAccount(account.id); }
  catch { return fail(immutableAssessment({ ...declaredBase, outcome: 'UNKNOWN', reasonCode: 'CREDENTIAL_FINGERPRINT_MISMATCH', reason: 'Credential material could not be resolved and verified.' })); }
  if (config.keyFingerprint !== account.credential.keyFingerprint || fingerprintSecret(config.apiKey) !== account.credential.keyFingerprint)
    return fail(immutableAssessment({ ...declaredBase, outcome: 'DENIED', reasonCode: 'CREDENTIAL_FINGERPRINT_MISMATCH', reason: 'Decrypted credential material does not match the stored fingerprint.' }));
  if (!executorFingerprintAuthorized(declaration, account.credential.keyFingerprint))
    return fail(immutableAssessment({ ...declaredBase, outcome: 'DENIED', reasonCode: 'EXECUTOR_FINGERPRINT_UNAUTHORIZED', reason: 'Executor lifecycle authority lacks the existing exact fingerprint authorization.' }));
  let observedBrokerAccountId: string;
  try { observedBrokerAccountId = (await getAlpacaAccount(account.id, 'account_read')).account_number; }
  catch { return fail(immutableAssessment({ ...declaredBase, outcome: 'UNKNOWN', reasonCode: 'BROKER_IDENTITY_UNAVAILABLE', reason: 'Fresh broker identity verification failed.' })); }
  if (observedBrokerAccountId !== expected || observedBrokerAccountId !== account.brokerAccountId)
    return fail(immutableAssessment({ ...declaredBase, observedBrokerAccountId, outcome: 'DENIED', reasonCode: 'BROKER_IDENTITY_MISMATCH', reason: 'Broker-returned identity does not exactly match expected and stored identities.' }));
  const verifiedAtMs = trustedNowMs();
  const expiresAtMs = verifiedAtMs + MAX_GRANT_TTL_MS;
  const revision = configurationRevision(account, declaration);
  const assessment = immutableAssessment({ ...declaredBase, observedBrokerAccountId, credentialFingerprint: account.credential.keyFingerprint,
    configurationRevision: revision, verifiedAt: new Date(verifiedAtMs).toISOString(), expiresAt: new Date(expiresAtMs).toISOString(),
    outcome: declaration.role, reasonCode: declaration.role === 'EXECUTOR' ? 'VERIFIED_EXECUTOR' : 'VERIFIED_OBSERVER',
    reason: `Exact PAPER identity and credential state are verified for ${declaration.role.toLowerCase()} lifecycle assessment.` });
  const internal = verdict(assessment, started, declaration.role);
  if (generationFor(account.id) === started.account && globalGeneration === started.global) assessmentCache.set(account.id, internal);
  return internal;
}

export async function assessLifecycleAuthority(tradingAccountId: number, options: { forceRefresh?: boolean } = {}) {
  return detachedAssessment((await assessInternal(tradingAccountId, options.forceRefresh === true)).assessment);
}
export async function issueLifecycleAuthorityGrant(args: { tradingAccountId: number; operation: LifecycleAuthorityOperation; ttlMs?: number }): Promise<LifecycleAuthorityGrant | null> {
  if (args.ttlMs !== undefined && (!Number.isFinite(args.ttlMs) || args.ttlMs <= 0)) return null;
  const ttlMs = Math.min(args.ttlMs ?? MAX_GRANT_TTL_MS, MAX_GRANT_TTL_MS);
  const internal = await assessInternal(args.tradingAccountId);
  const issuedAtMs = trustedNowMs();
  if (!internal.role || !policyAllows(internal.role, args.operation) || !deploymentAllows(internal.role)
    || internal.accountGeneration !== generationFor(args.tradingAccountId) || internal.globalGeneration !== globalGeneration
    || internal.expiresAtMs === null || internal.expiresAtMs <= issuedAtMs || !internal.brokerAccountId
    || !internal.credentialFingerprint || !internal.configurationRevision) return null;
  const token = Object.freeze({}) as LifecycleAuthorityGrant;
  grants.set(token, { id: randomUUID(), tradingAccountId: args.tradingAccountId, operation: args.operation,
    role: internal.role, brokerAccountId: internal.brokerAccountId, credentialFingerprint: internal.credentialFingerprint,
    configurationRevision: internal.configurationRevision, issuedAtMs, expiresAtMs: issuedAtMs + ttlMs,
    accountGeneration: internal.accountGeneration, globalGeneration: internal.globalGeneration, permanentlyExpired: false });
  return token;
}
export async function validateLifecycleAuthorityGrant(args: { grant: LifecycleAuthorityGrant; tradingAccountId: number; operation: LifecycleAuthorityOperation }): Promise<boolean> {
  const state = grants.get(args.grant as object);
  const nowMs = trustedNowMs();
  if (!state || state.permanentlyExpired || state.tradingAccountId !== args.tradingAccountId || state.operation !== args.operation) return false;
  if (nowMs < state.issuedAtMs || nowMs >= state.expiresAtMs || state.expiresAtMs - state.issuedAtMs > MAX_GRANT_TTL_MS) {
    state.permanentlyExpired = true;
    return false;
  }
  if (state.accountGeneration !== generationFor(args.tradingAccountId) || state.globalGeneration !== globalGeneration) return false;
  const { account, mappings } = await readAccountEvidence(args.tradingAccountId);
  if (!account || account.broker !== 'ALPACA' || account.environment !== 'PAPER' || account.brokerAccountId !== state.brokerAccountId
    || mappings.length !== 1 || mappings[0]?.id !== account.id) return false;
  const declarations = env.PAPER_BROKER_WRITE_OWNERSHIP.filter(item => item.tradingAccountId === account.id);
  if (declarations.length !== 1) return false;
  const declaration = declarations[0]!;
  if (declaration.role !== state.role || !deploymentAllows(declaration.role) || !policyAllows(declaration.role, args.operation)
    || declaration.expectedBrokerAccountId !== state.brokerAccountId || !account.credential
    || account.credential.status !== 'ACTIVE' || account.credential.revokedAt || !account.credential.verifiedAt
    || account.credential.keyFingerprint !== state.credentialFingerprint
    || !executorFingerprintAuthorized(declaration, state.credentialFingerprint)) return false;
  return configurationRevision(account, declaration) === state.configurationRevision;
}
export function invalidateLifecycleAuthorityCache(tradingAccountId?: number) {
  if (tradingAccountId === undefined) { globalGeneration += 1; assessmentCache.clear(); }
  else invalidateAccount(tradingAccountId);
}
export const LIFECYCLE_AUTHORITY_GRANT_MAX_TTL_MS = MAX_GRANT_TTL_MS;
