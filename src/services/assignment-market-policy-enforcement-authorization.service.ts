import { createHash } from 'node:crypto';
import { PlatformRole, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { assignmentEnrollmentConfigurationFingerprint } from './assignment-market-policy-enrollment.service.js';
import { getMarketPolicyEnforcementRuntimeStatus, redactMarketPolicyEnforcementRuntimeStatus } from './market-policy-enforcement-rollout.service.js';
import { strategyMarketPolicyConfigurationFingerprint, validateMarketPolicyRules } from './strategy-market-policy.service.js';
import { createSystemEvent } from './system-event.service.js';

// Phase 3C.2 grants bind the exact tradable Subscription and canonical Security. Historical V1 grants
// never bound Security; they were invalidated by migration and never gain inferred authority.
export const MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION = 'PAPER_MARKET_POLICY_ENFORCEMENT_V2' as const;
export const LEGACY_MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION = 'PAPER_MARKET_POLICY_ENFORCEMENT_V1' as const;
export const MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_SCOPE = 'PAPER_ONLY' as const;
export const MARKET_POLICY_LAPSE_RESOLUTION = 'RESTORE_NON_ENFORCED' as const;

type Db = typeof prisma | Prisma.TransactionClient;

export type EnforcementAuthorizationBlockingCode =
  | 'ACCOUNT_NOT_PAPER'
  | 'ENROLLMENT_GENERATION_REQUIRED'
  | 'ENROLLMENT_NOT_ACTIVE'
  | 'ASSIGNMENT_IDENTITY_MISMATCH'
  | 'SECURITY_IDENTITY_INCONSISTENT'
  | 'ACCOUNT_OWNERSHIP_CHANGED'
  | 'ACTIVE_POLICY_REQUIRED'
  | 'POLICY_REVISION_SUPERSEDED'
  | 'POLICY_CONFIGURATION_INVALID'
  | 'CONFIGURATION_FINGERPRINT_MISMATCH'
  | 'AUTHORIZATION_ALREADY_EFFECTIVE';

const BLOCKING_MESSAGES: Record<EnforcementAuthorizationBlockingCode, string> = {
  ACCOUNT_NOT_PAPER: 'Market-policy enforcement authorization is PAPER-only.',
  ENROLLMENT_GENERATION_REQUIRED: 'The assignment has no enrollment generation to authorize.',
  ENROLLMENT_NOT_ACTIVE: 'Only an ACTIVE enrollment generation can be authorized.',
  ASSIGNMENT_IDENTITY_MISMATCH: 'The enrollment generation no longer matches the exact account, assignment, and Strategy.',
  SECURITY_IDENTITY_INCONSISTENT: 'The assignment Subscription symbol, routing Security, and canonical Security do not agree.',
  ACCOUNT_OWNERSHIP_CHANGED: 'The account holder changed after the enrollment generation was prepared.',
  ACTIVE_POLICY_REQUIRED: 'The assignment Strategy has no ACTIVE market-policy revision.',
  POLICY_REVISION_SUPERSEDED: 'The bound policy revision is no longer the Strategy\'s ACTIVE revision.',
  POLICY_CONFIGURATION_INVALID: 'The bound policy revision does not validly describe all five market dimensions.',
  CONFIGURATION_FINGERPRINT_MISMATCH: 'The enrollment configuration fingerprint no longer matches the bound identity.',
  AUTHORIZATION_ALREADY_EFFECTIVE: 'An effective enforcement authorization already exists for this assignment.',
};

type DimensionRule = { dimension: string; algorithmVersion: string; requirement: string; allowedStates: Array<{ state: string }> };

export type EnforcementSecurityIdentity = {
  subscriptionId: number; subscriptionSymbol: string; subscriptionSecurityId: number; subscriptionStrategyId: number;
  routingSecurityId: number; securityId: number; securitySymbol: string;
};

export type EnforcementAuthorizationContext = {
  account: { id: number; environment: string; accountHolderUserId: number };
  assignment: { id: number; tradingAccountId: number; routingStrategyId: number };
  // Optional so pure eligibility callers that predate Security binding still type-check; every
  // service-loaded context carries it.
  security?: EnforcementSecurityIdentity;
  activePolicyRevisionId: number | null;
  generation: null | {
    id: number; enrollmentId: number; generation: number; status: string; tradingAccountId: number; accountSubscriptionId: number;
    strategyId: number; policyRevisionId: number; accountHolderUserId: number; configurationFingerprint: string;
  };
  boundRevision: null | { id: number; status: string; strategyId: number; dimensionRules: DimensionRule[] };
  effectiveAuthorizationId: number | null;
};

export function securityIdentityConsistent(security: EnforcementSecurityIdentity, routingStrategyId: number) {
  return security.routingSecurityId === security.subscriptionSecurityId && security.securityId === security.routingSecurityId
    && security.subscriptionStrategyId === routingStrategyId
    && security.subscriptionSymbol.trim().toUpperCase() === security.securitySymbol;
}

// Pure configuration-integrity evaluation. Current market outcome and operational posture are
// deliberately absent: BLOCKED or INSUFFICIENT_EVIDENCE markets do not prevent authorization.
export function evaluateEnforcementAuthorizationEligibility(context: EnforcementAuthorizationContext) {
  const codes: EnforcementAuthorizationBlockingCode[] = [];
  const { account, assignment, generation, boundRevision } = context;
  if (account.environment !== 'PAPER') codes.push('ACCOUNT_NOT_PAPER');
  if (!context.activePolicyRevisionId) codes.push('ACTIVE_POLICY_REQUIRED');
  if (context.security && !securityIdentityConsistent(context.security, assignment.routingStrategyId)) codes.push('SECURITY_IDENTITY_INCONSISTENT');
  const configurationValidation = boundRevision ? validateMarketPolicyRules(boundRevision.dimensionRules) : null;
  let expectedConfigurationFingerprint: string | null = null;
  if (!generation) {
    codes.push('ENROLLMENT_GENERATION_REQUIRED');
  } else {
    if (generation.status !== 'ACTIVE') codes.push('ENROLLMENT_NOT_ACTIVE');
    const identityMatches = generation.tradingAccountId === account.id && generation.accountSubscriptionId === assignment.id
      && generation.tradingAccountId === assignment.tradingAccountId && generation.strategyId === assignment.routingStrategyId
      && (!boundRevision || boundRevision.strategyId === generation.strategyId);
    if (!identityMatches) codes.push('ASSIGNMENT_IDENTITY_MISMATCH');
    const ownershipValid = generation.accountHolderUserId === account.accountHolderUserId;
    if (!ownershipValid) codes.push('ACCOUNT_OWNERSHIP_CHANGED');
    const revisionCurrent = context.activePolicyRevisionId === generation.policyRevisionId && boundRevision?.status === 'ACTIVE';
    if (context.activePolicyRevisionId && !revisionCurrent) codes.push('POLICY_REVISION_SUPERSEDED');
    if (configurationValidation && !configurationValidation.valid) codes.push('POLICY_CONFIGURATION_INVALID');
    if (boundRevision) {
      expectedConfigurationFingerprint = assignmentEnrollmentConfigurationFingerprint({
        accountId: generation.tradingAccountId, assignmentId: generation.accountSubscriptionId, strategyId: generation.strategyId,
        policyRevisionId: boundRevision.id, policyConfigurationFingerprint: strategyMarketPolicyConfigurationFingerprint(boundRevision.dimensionRules),
        accountHolderUserId: account.accountHolderUserId, environment: account.environment, generation: generation.generation,
      });
      // Report a fingerprint mismatch only when no more specific identity reason explains it.
      if (identityMatches && ownershipValid && account.environment === 'PAPER' && expectedConfigurationFingerprint !== generation.configurationFingerprint) codes.push('CONFIGURATION_FINGERPRINT_MISMATCH');
    }
  }
  if (context.effectiveAuthorizationId !== null) codes.push('AUTHORIZATION_ALREADY_EFFECTIVE');
  return {
    eligible: codes.length === 0,
    blockingReasons: codes.map(code => ({ code, message: BLOCKING_MESSAGES[code] })),
    configurationValidity: configurationValidation
      ? { valid: configurationValidation.valid, errors: configurationValidation.errors }
      : { valid: false, errors: [{ code: 'BOUND_POLICY_REVISION_REQUIRED', message: 'No enrollment generation binds a policy revision.' }] },
    expectedConfigurationFingerprint,
  };
}

// Key order is part of the persisted fingerprint contract and must stay byte-identical to the
// PostgreSQL function "enforcement_authorization_fingerprint_v2"; do not reorder.
export function enforcementAuthorizationFingerprint(input: {
  accountId: number; assignmentId: number; subscriptionId: number; securityId: number; securitySymbol: string; strategyId: number;
  policyRevisionId: number; enrollmentId: number; enrollmentGenerationId: number; generation: number; configurationFingerprint: string;
  accountHolderUserId: number; authorizationSequence: number;
}) {
  const { accountId, assignmentId, subscriptionId, securityId, securitySymbol, strategyId, policyRevisionId, enrollmentId, enrollmentGenerationId, generation, configurationFingerprint, accountHolderUserId, authorizationSequence } = input;
  return createHash('sha256').update(JSON.stringify({
    authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION, environment: 'PAPER', accountId, assignmentId, subscriptionId, securityId, securitySymbol,
    strategyId, policyRevisionId, enrollmentId, enrollmentGenerationId, generation, configurationFingerprint, accountHolderUserId, authorizationSequence,
  })).digest('hex');
}

const userSelect = { select: { id: true, email: true, name: true } } as const;
const authorizationInclude = {
  authorizedBy: userSelect, revokedBy: userSelect, invalidatedBy: userSelect,
  lapseResolution: { include: { resolvedBy: userSelect } },
} satisfies Prisma.AssignmentMarketPolicyEnforcementAuthorizationInclude;
type AuthorizationRow = Prisma.AssignmentMarketPolicyEnforcementAuthorizationGetPayload<{ include: typeof authorizationInclude }>;

function summarizeEnforcementAuthorization(row: AuthorizationRow) {
  return {
    id: row.id, enrollmentGenerationId: row.enrollmentGenerationId, authorizationSequence: row.authorizationSequence,
    authorityVersion: row.authorityVersion, status: row.status, environment: row.environment, policyRevisionId: row.policyRevisionId,
    securityId: row.securityId, securitySymbol: row.securitySymbol,
    authorizedAt: row.authorizedAt, revokedAt: row.revokedAt, invalidatedAt: row.invalidatedAt, invalidationReasonCode: row.invalidationReasonCode,
    invalidationSource: row.invalidationSource,
    lapseResolution: row.lapseResolution ? { resolution: row.lapseResolution.resolution, resolvedAt: row.lapseResolution.resolvedAt } : null,
  };
}

export function presentEnforcementAuthorization(row: AuthorizationRow, viewerRole: PlatformRole) {
  return viewerRole === PlatformRole.SYSTEM_OWNER ? presentOwnerEnforcementAuthorization(row) : summarizeEnforcementAuthorization(row);
}

function presentOwnerEnforcementAuthorization(row: AuthorizationRow) {
  return {
    ...summarizeEnforcementAuthorization(row),
    enrollmentId: row.enrollmentId, tradingAccountId: row.tradingAccountId, accountSubscriptionId: row.accountSubscriptionId, strategyId: row.strategyId,
    subscriptionId: row.subscriptionId, accountHolderUserId: row.accountHolderUserId, configurationFingerprint: row.configurationFingerprint, authorizationFingerprint: row.authorizationFingerprint,
    grantReason: row.grantReason, revocationReason: row.revocationReason, invalidationEvidence: row.invalidationEvidenceJson,
    authorizedBy: row.authorizedBy, revokedBy: row.revokedBy, invalidatedBy: row.invalidatedBy,
    lapseResolution: row.lapseResolution ? {
      id: row.lapseResolution.id, resolution: row.lapseResolution.resolution, resolvedAt: row.lapseResolution.resolvedAt,
      reason: row.lapseResolution.reason, resolvedBy: row.lapseResolution.resolvedBy,
    } : null,
  };
}

const assignmentSelect = {
  id: true, tradingAccountId: true, routingStrategyId: true, routingSecurityId: true, subscriptionId: true, enabled: true, entriesEnabled: true,
  tradingAccount: { select: { id: true, displayName: true, environment: true, status: true, tradingEnabled: true, killSwitchEnabled: true, accountHolderUserId: true } },
  subscription: { select: { id: true, key: true, name: true, symbol: true, securityId: true, strategyId: true, security: { select: { id: true, symbol: true } }, strategy: { select: { id: true, key: true, name: true, enabled: true, marketPolicy: { select: { revisions: { where: { status: 'ACTIVE' as const }, select: { id: true, revision: true }, take: 1 } } } } } } },
} satisfies Prisma.TradingAccountSubscriptionSelect;

const generationSelect = {
  id: true, enrollmentId: true, generation: true, status: true, tradingAccountId: true, accountSubscriptionId: true, strategyId: true,
  policyRevisionId: true, accountHolderUserId: true, configurationFingerprint: true,
} satisfies Prisma.AssignmentMarketPolicyEnrollmentGenerationSelect;

async function loadContext(accountId: number, assignmentId: number, generationId: number | null, db: Db) {
  const assignment = await db.tradingAccountSubscription.findFirst({ where: { id: assignmentId, tradingAccountId: accountId }, select: assignmentSelect });
  if (!assignment) return null;
  const generation = generationId !== null
    ? await db.assignmentMarketPolicyEnrollmentGeneration.findFirst({ where: { id: generationId, accountSubscriptionId: assignmentId }, select: generationSelect })
    : await db.assignmentMarketPolicyEnrollmentGeneration.findFirst({ where: { accountSubscriptionId: assignmentId, status: { in: ['ACTIVE', 'PREPARED'] } }, orderBy: { generation: 'desc' }, select: generationSelect })
      ?? await db.assignmentMarketPolicyEnrollmentGeneration.findFirst({ where: { accountSubscriptionId: assignmentId }, orderBy: { generation: 'desc' }, select: generationSelect });
  const boundRevision = generation ? await db.strategyMarketPolicyRevision.findUnique({
    where: { id: generation.policyRevisionId },
    select: { id: true, revision: true, status: true, policy: { select: { strategyId: true } }, dimensionRules: { select: { dimension: true, algorithmVersion: true, requirement: true, allowedStates: { select: { state: true } } } } },
  }) : null;
  const effective = await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { accountSubscriptionId: assignmentId, status: 'AUTHORIZED' }, include: authorizationInclude });
  const latest = await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { accountSubscriptionId: assignmentId }, orderBy: { id: 'desc' }, include: authorizationInclude });
  const activeRevision = assignment.subscription.strategy.marketPolicy?.revisions[0] ?? null;
  const context: EnforcementAuthorizationContext = {
    account: { id: assignment.tradingAccount.id, environment: assignment.tradingAccount.environment, accountHolderUserId: assignment.tradingAccount.accountHolderUserId },
    assignment: { id: assignment.id, tradingAccountId: assignment.tradingAccountId, routingStrategyId: assignment.routingStrategyId },
    security: {
      subscriptionId: assignment.subscriptionId, subscriptionSymbol: assignment.subscription.symbol, subscriptionSecurityId: assignment.subscription.securityId,
      subscriptionStrategyId: assignment.subscription.strategyId, routingSecurityId: assignment.routingSecurityId,
      securityId: assignment.subscription.security.id, securitySymbol: assignment.subscription.security.symbol,
    },
    activePolicyRevisionId: activeRevision?.id ?? null,
    generation,
    boundRevision: boundRevision ? { id: boundRevision.id, status: boundRevision.status, strategyId: boundRevision.policy.strategyId, dimensionRules: boundRevision.dimensionRules } : null,
    effectiveAuthorizationId: effective?.id ?? null,
  };
  return { assignment, generation, boundRevision, activeRevision, effective, latest, context };
}

// Exact authorization row checks shared by informational reads and the locked admission resolver.
function authorizationIneffectiveReasons(authorization: AuthorizationRow, context: EnforcementAuthorizationContext) {
  const generation = context.generation;
  const reasons: string[] = [];
  if (authorization.authorityVersion !== MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION) reasons.push('AUTHORITY_BINDING_REAPPROVAL_REQUIRED');
  if (!generation || generation.id !== authorization.enrollmentGenerationId) reasons.push('AUTHORIZED_GENERATION_NOT_CURRENT');
  else if (generation.configurationFingerprint !== authorization.configurationFingerprint || generation.policyRevisionId !== authorization.policyRevisionId
    || generation.accountHolderUserId !== authorization.accountHolderUserId || generation.strategyId !== authorization.strategyId) reasons.push('AUTHORIZATION_IDENTITY_MISMATCH');
  if (authorization.environment !== 'PAPER') reasons.push('ACCOUNT_NOT_PAPER');
  const security = context.security;
  if (!security || authorization.subscriptionId !== security.subscriptionId || authorization.securityId !== security.securityId
    || authorization.securitySymbol !== security.securitySymbol || authorization.tradingAccountId !== context.assignment.tradingAccountId
    || authorization.strategyId !== context.assignment.routingStrategyId) reasons.push('AUTHORIZATION_SECURITY_MISMATCH');
  if (generation && authorization.authorityVersion === MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION && authorization.subscriptionId !== null && authorization.securityId !== null && authorization.securitySymbol !== null) {
    const recomputed = enforcementAuthorizationFingerprint({
      accountId: authorization.tradingAccountId, assignmentId: authorization.accountSubscriptionId, subscriptionId: authorization.subscriptionId,
      securityId: authorization.securityId, securitySymbol: authorization.securitySymbol, strategyId: authorization.strategyId,
      policyRevisionId: authorization.policyRevisionId, enrollmentId: authorization.enrollmentId, enrollmentGenerationId: authorization.enrollmentGenerationId,
      generation: generation.generation, configurationFingerprint: authorization.configurationFingerprint,
      accountHolderUserId: authorization.accountHolderUserId, authorizationSequence: authorization.authorizationSequence,
    });
    if (recomputed !== authorization.authorizationFingerprint) reasons.push('AUTHORIZATION_FINGERPRINT_MISMATCH');
  }
  const evaluation = evaluateEnforcementAuthorizationEligibility({ ...context, effectiveAuthorizationId: null });
  for (const reason of evaluation.blockingReasons) if (!reasons.includes(reason.code)) reasons.push(reason.code);
  return reasons;
}

// ---------------------------------------------------------------------------------------------
// Enforcement disposition (Hermes M3 lapse semantics)
// ---------------------------------------------------------------------------------------------

export type MarketPolicyEnforcementDisposition =
  | 'NEVER_AUTHORIZED'
  | 'ENFORCED'
  | 'AUTHORIZATION_INEFFECTIVE'
  | 'LAPSED'
  | 'OWNER_REVOKED'
  | 'OWNER_OPTED_OUT'
  | 'NOT_APPLICABLE_LIVE';

export type MarketPolicyEntryBehavior = 'EXISTING_ENTRY_BEHAVIOR' | 'MARKET_POLICY_ENFORCED' | 'FAIL_CLOSED' | 'EXPLICITLY_NON_ENFORCED';

const DISPOSITION_BEHAVIOR: Record<MarketPolicyEnforcementDisposition, MarketPolicyEntryBehavior> = {
  NEVER_AUTHORIZED: 'EXISTING_ENTRY_BEHAVIOR',
  NOT_APPLICABLE_LIVE: 'EXISTING_ENTRY_BEHAVIOR',
  ENFORCED: 'MARKET_POLICY_ENFORCED',
  AUTHORIZATION_INEFFECTIVE: 'FAIL_CLOSED',
  LAPSED: 'FAIL_CLOSED',
  OWNER_REVOKED: 'EXPLICITLY_NON_ENFORCED',
  OWNER_OPTED_OUT: 'EXPLICITLY_NON_ENFORCED',
};

/**
 * Lapse contract: a never-authorized assignment keeps existing behavior; an effective grant is
 * enforced; an explicit owner revocation or explicit owner opt-out returns to non-enforced behavior;
 * an automatic invalidation, or a grant that no longer validates, fails closed. A previously
 * authorized assignment therefore never silently becomes ungated because its configuration changed.
 */
export function deriveMarketPolicyEnforcementDisposition(input: {
  accountEnvironment: string;
  latest: { status: string; lapseResolution: unknown | null } | null;
  ineffectiveReasons: string[];
}): MarketPolicyEnforcementDisposition {
  if (input.accountEnvironment !== 'PAPER') return 'NOT_APPLICABLE_LIVE';
  if (!input.latest) return 'NEVER_AUTHORIZED';
  if (input.latest.status === 'REVOKED') return 'OWNER_REVOKED';
  if (input.latest.status === 'INVALIDATED') return input.latest.lapseResolution ? 'OWNER_OPTED_OUT' : 'LAPSED';
  return input.ineffectiveReasons.length === 0 ? 'ENFORCED' : 'AUTHORIZATION_INEFFECTIVE';
}

export function marketPolicyEntryBehavior(disposition: MarketPolicyEnforcementDisposition, runtimeActive: boolean): MarketPolicyEntryBehavior {
  // While the PAPER runtime rollout is inactive every assignment keeps its existing entry behavior.
  return runtimeActive ? DISPOSITION_BEHAVIOR[disposition] : 'EXISTING_ENTRY_BEHAVIOR';
}

function presentDisposition(disposition: MarketPolicyEnforcementDisposition, runtime: { active: boolean }) {
  return {
    disposition,
    behaviorWhenRuntimeActive: DISPOSITION_BEHAVIOR[disposition],
    currentEntryBehavior: marketPolicyEntryBehavior(disposition, runtime.active),
    ownerResolutionAvailable: disposition === 'LAPSED',
  };
}

export type LockedMarketPolicyEnforcementResolution = {
  disposition: MarketPolicyEnforcementDisposition;
  reasons: string[];
  authorization: AuthorizationRow | null;
  identity: {
    tradingAccountId: number; accountSubscriptionId: number; environment: string; strategyId: number;
    subscriptionId: number; securityId: number; securitySymbol: string;
  };
  generation: EnforcementAuthorizationContext['generation'];
  boundRevision: { id: number; dimensionRules: DimensionRule[] } | null;
};

/**
 * Phase 3C.2 transactional authority resolver (Hermes M2). Runs inside the entry-admission
 * transaction and returns the exact disposition under row locks that serialize against grant,
 * revoke, lapse resolution, and every automatic invalidation path until the transaction commits.
 *
 * Lock order (shared by every caller; see docs/architecture/market-policy-pre-intent-enforcement.md):
 * TradingAccount KEY SHARE -> TradingAccountSubscription KEY SHARE -> Subscription KEY SHARE ->
 * Security KEY SHARE -> latest authorization FOR SHARE. The caller holds the runtime rollout row
 * FOR SHARE first and takes the entry-exposure advisory lock only afterwards.
 */
export async function resolveLockedAssignmentMarketPolicyEnforcement(tx: Prisma.TransactionClient, accountSubscriptionId: number): Promise<LockedMarketPolicyEnforcementResolution> {
  const [probe] = await tx.$queryRaw<Array<{ tradingAccountId: number }>>`SELECT "tradingAccountId" FROM "TradingAccountSubscription" WHERE id = ${accountSubscriptionId}`;
  if (!probe) throw new HttpError(404, `TradingAccountSubscription ${accountSubscriptionId} was not found.`);
  const [account] = await tx.$queryRaw<Array<{ id: number; environment: string }>>`SELECT id, environment::text AS environment FROM "TradingAccount" WHERE id = ${probe.tradingAccountId} FOR KEY SHARE`;
  const [tas] = await tx.$queryRaw<Array<{ tradingAccountId: number; subscriptionId: number; routingStrategyId: number }>>`
    SELECT "tradingAccountId", "subscriptionId", "routingStrategyId" FROM "TradingAccountSubscription" WHERE id = ${accountSubscriptionId} FOR KEY SHARE`;
  if (!account || !tas || tas.tradingAccountId !== account.id) throw new Error('ASSIGNMENT_ACCOUNT_CHANGED_DURING_ADMISSION');
  const [subscription] = await tx.$queryRaw<Array<{ securityId: number }>>`SELECT "securityId" FROM "Subscription" WHERE id = ${tas.subscriptionId} FOR KEY SHARE`;
  const [security] = await tx.$queryRaw<Array<{ id: number; symbol: string }>>`SELECT id, symbol FROM "Security" WHERE id = ${subscription?.securityId ?? -1} FOR KEY SHARE`;
  if (!subscription || !security) throw new Error('ASSIGNMENT_SECURITY_IDENTITY_MISSING');
  const identity = {
    tradingAccountId: account.id, accountSubscriptionId, environment: account.environment, strategyId: tas.routingStrategyId,
    subscriptionId: tas.subscriptionId, securityId: security.id, securitySymbol: security.symbol,
  };
  if (account.environment !== 'PAPER') return { disposition: 'NOT_APPLICABLE_LIVE', reasons: [], authorization: null, identity, generation: null, boundRevision: null };

  const [locked] = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId" = ${accountSubscriptionId} ORDER BY id DESC LIMIT 1 FOR SHARE`;
  if (!locked) return { disposition: 'NEVER_AUTHORIZED', reasons: [], authorization: null, identity, generation: null, boundRevision: null };
  const authorization = await tx.assignmentMarketPolicyEnforcementAuthorization.findUniqueOrThrow({ where: { id: locked.id }, include: authorizationInclude });
  if (authorization.status !== 'AUTHORIZED') {
    const disposition = deriveMarketPolicyEnforcementDisposition({ accountEnvironment: account.environment, latest: authorization, ineffectiveReasons: [] });
    return { disposition, reasons: disposition === 'LAPSED' ? [authorization.invalidationReasonCode ?? 'INVALIDATED'] : [], authorization, identity, generation: null, boundRevision: null };
  }
  const loaded = await loadContext(account.id, accountSubscriptionId, authorization.enrollmentGenerationId, tx);
  const reasons = loaded ? authorizationIneffectiveReasons(authorization, loaded.context) : ['ASSIGNMENT_IDENTITY_MISMATCH'];
  if (loaded?.context.security && loaded.context.security.securityId !== identity.securityId) reasons.push('ASSIGNMENT_SECURITY_CHANGED_DURING_ADMISSION');
  const disposition = deriveMarketPolicyEnforcementDisposition({ accountEnvironment: account.environment, latest: authorization, ineffectiveReasons: reasons });
  return {
    disposition, reasons, authorization, identity,
    generation: loaded?.generation ?? null,
    boundRevision: loaded?.boundRevision ? { id: loaded.boundRevision.id, dimensionRules: loaded.boundRevision.dimensionRules } : null,
  };
}

/**
 * Informational, unlocked read of whether this exact assignment is explicitly and currently
 * authorized. It never evaluates markets, creates decisions, or grants trading authority; the
 * entry admission path uses resolveLockedAssignmentMarketPolicyEnforcement instead.
 */
export async function resolveAssignmentMarketPolicyEnforcementAuthority(accountSubscriptionId: number, db: Db = prisma) {
  const authorization = await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { accountSubscriptionId, status: 'AUTHORIZED' }, include: authorizationInclude });
  if (!authorization) return { authorized: false as const, reasons: ['NOT_AUTHORIZED'], authorization: null };
  const loaded = await loadContext(authorization.tradingAccountId, accountSubscriptionId, authorization.enrollmentGenerationId, db);
  const reasons = loaded ? authorizationIneffectiveReasons(authorization, loaded.context) : ['ASSIGNMENT_IDENTITY_MISMATCH'];
  return {
    authorized: reasons.length === 0,
    reasons,
    authorization: {
      id: authorization.id, authorityVersion: authorization.authorityVersion, authorizationFingerprint: authorization.authorizationFingerprint,
      enrollmentGenerationId: authorization.enrollmentGenerationId, policyRevisionId: authorization.policyRevisionId,
      configurationFingerprint: authorization.configurationFingerprint, tradingAccountId: authorization.tradingAccountId,
      accountSubscriptionId: authorization.accountSubscriptionId, strategyId: authorization.strategyId,
      subscriptionId: authorization.subscriptionId, securityId: authorization.securityId, securitySymbol: authorization.securitySymbol,
    },
  };
}

async function stateFor(loaded: NonNullable<Awaited<ReturnType<typeof loadContext>>>, viewerRole: PlatformRole, db: Db) {
  const { generation, effective, latest: latestForAssignment, context } = loaded;
  const latestForGeneration = generation
    ? await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { enrollmentGenerationId: generation.id }, orderBy: { authorizationSequence: 'desc' }, include: authorizationInclude })
    : null;
  // AUTHORIZED rows always belong to the ACTIVE generation; prefer the effective row, then the
  // current generation's latest row, then the assignment's latest row (for example, after re-enrollment).
  const authorization = effective ?? latestForGeneration ?? latestForAssignment;
  const state = authorization?.status ?? 'NOT_AUTHORIZED';
  const ineffectiveReasons = authorization?.status === 'AUTHORIZED' ? authorizationIneffectiveReasons(authorization, context) : [];
  const runtimeStatus = await getMarketPolicyEnforcementRuntimeStatus(db);
  const runtimeEnforcement = viewerRole === PlatformRole.SYSTEM_OWNER ? runtimeStatus : redactMarketPolicyEnforcementRuntimeStatus(runtimeStatus);
  const disposition = deriveMarketPolicyEnforcementDisposition({
    accountEnvironment: context.account.environment, latest: latestForAssignment,
    ineffectiveReasons: latestForAssignment?.status === 'AUTHORIZED' ? authorizationIneffectiveReasons(latestForAssignment, context) : [],
  });
  return {
    authorizationScope: MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_SCOPE,
    authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION,
    runtimeEnforcement,
    enrollmentGeneration: generation ? { id: generation.id, generation: generation.generation, status: generation.status } : null,
    state,
    effective: state === 'AUTHORIZED' && ineffectiveReasons.length === 0,
    ineffectiveReasons,
    enforcement: {
      ...presentDisposition(disposition, runtimeEnforcement),
      latestAuthorizationId: latestForAssignment?.id ?? null,
    },
    authorization: authorization ? presentEnforcementAuthorization(authorization, viewerRole) : null,
  };
}

export async function getAssignmentMarketPolicyEnforcementAuthorization(accountId: number, assignmentId: number, viewerRole: PlatformRole) {
  const loaded = await loadContext(accountId, assignmentId, null, prisma);
  if (!loaded) return null;
  return stateFor(loaded, viewerRole, prisma);
}

export async function previewAssignmentMarketPolicyEnforcementAuthorization(accountId: number, assignmentId: number, generationId: number | null, viewerRole: PlatformRole) {
  const loaded = await loadContext(accountId, assignmentId, generationId, prisma);
  if (!loaded) return null;
  if (generationId !== null && !loaded.generation) throw new HttpError(404, 'Enrollment generation not found.');
  const { assignment, generation, boundRevision, activeRevision, context } = loaded;
  const evaluation = evaluateEnforcementAuthorizationEligibility(context);
  const owner = viewerRole === PlatformRole.SYSTEM_OWNER;
  // Read-only: the latest persisted shadow decision is informational and never required.
  const latestDecision = boundRevision ? await prisma.strategyMarketEligibilityDecision.findFirst({ where: { strategyId: assignment.routingStrategyId, policyRevisionId: boundRevision.id }, orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }], select: { id: true, outcome: true, reasonCode: true, evaluatedAt: true, validUntil: true } }) : null;
  const currentAuthorization = await stateFor(loaded, viewerRole, prisma);
  return {
    authorizationScope: MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_SCOPE,
    authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION,
    runtimeEnforcement: currentAuthorization.runtimeEnforcement,
    identity: {
      tradingAccount: { id: assignment.tradingAccount.id, displayName: assignment.tradingAccount.displayName, environment: assignment.tradingAccount.environment },
      assignment: { id: assignment.id },
      subscription: { id: assignment.subscription.id, key: assignment.subscription.key, name: assignment.subscription.name, symbol: assignment.subscription.symbol },
      security: assignment.subscription.security,
      strategy: { id: assignment.subscription.strategy.id, key: assignment.subscription.strategy.key, name: assignment.subscription.strategy.name },
      enrollmentGeneration: generation ? { id: generation.id, enrollmentId: generation.enrollmentId, generation: generation.generation, status: generation.status } : null,
      boundPolicyRevision: boundRevision ? { id: boundRevision.id, revision: boundRevision.revision, status: boundRevision.status } : null,
      activePolicyRevision: activeRevision,
      ...(owner ? {
        accountHolderUserId: assignment.tradingAccount.accountHolderUserId,
        boundAccountHolderUserId: generation?.accountHolderUserId ?? null,
        configurationFingerprint: generation?.configurationFingerprint ?? null,
        expectedConfigurationFingerprint: evaluation.expectedConfigurationFingerprint,
      } : {}),
    },
    configurationValidity: evaluation.configurationValidity,
    eligibleToAuthorize: evaluation.eligible,
    blockingReasons: evaluation.blockingReasons,
    viewerCanAuthorize: owner,
    currentAuthorization,
    currentMarketEligibility: {
      outcome: latestDecision?.outcome ?? null, reasonCode: latestDecision?.reasonCode ?? 'NO_PERSISTED_SHADOW_DECISION',
      evaluatorTechnicalStatus: latestDecision ? 'AVAILABLE' : 'NOT_EVALUATED', decisionId: latestDecision?.id ?? null,
      evaluatedAt: latestDecision?.evaluatedAt ?? null, validUntil: latestDecision?.validUntil ?? null, requiredForAuthorization: false,
    },
    operationalPosture: {
      strategyEnabled: assignment.subscription.strategy.enabled, assignmentEnabled: assignment.enabled, entriesEnabled: assignment.entriesEnabled,
      accountStatus: assignment.tradingAccount.status, accountTradingEnabled: assignment.tradingAccount.tradingEnabled,
      killSwitchEnabled: assignment.tradingAccount.killSwitchEnabled, affectsAuthorizationValidity: false,
    },
  };
}

export async function listAssignmentMarketPolicyEnforcementAuthorizationHistory(accountId: number, assignmentId: number) {
  const assignment = await prisma.tradingAccountSubscription.findFirst({ where: { id: assignmentId, tradingAccountId: accountId }, select: { id: true } });
  if (!assignment) return null;
  const authorizations = await prisma.assignmentMarketPolicyEnforcementAuthorization.findMany({
    where: { accountSubscriptionId: assignmentId },
    orderBy: { id: 'desc' },
    take: 200,
    include: { ...authorizationInclude, enrollmentGeneration: { select: { generation: true } }, policyRevision: { select: { revision: true } }, events: { orderBy: { sequence: 'asc' }, include: { actor: userSelect } } },
  });
  return {
    authorizationScope: MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_SCOPE,
    runtimeEnforcement: await getMarketPolicyEnforcementRuntimeStatus(prisma),
    authorizations: authorizations.map(row => ({
      ...presentOwnerEnforcementAuthorization(row),
      generation: row.enrollmentGeneration.generation,
      policyRevision: row.policyRevision.revision,
      events: row.events.map(event => ({ id: event.id, sequence: event.sequence, action: event.action, fromStatus: event.fromStatus, toStatus: event.toStatus, reason: event.reason, actor: event.actor, occurredAt: event.occurredAt, authorizationFingerprint: event.authorizationFingerprint, configurationFingerprint: event.configurationFingerprint, provenance: event.provenanceJson })),
    })),
  };
}

// FOR SHARE serializes the owner check against a concurrent disable or demotion of the actor.
// A grant committed before such a change remains historically valid.
async function assertEnabledOwner(actorUserId: number, db: Prisma.TransactionClient) {
  const actor = await db.user.findUnique({ where: { id: actorUserId }, select: { platformRole: true, enabled: true } });
  if (!actor || !actor.enabled || actor.platformRole !== PlatformRole.SYSTEM_OWNER) throw new HttpError(403, 'SYSTEM_OWNER authorization is required.', { code: 'SYSTEM_OWNER_REQUIRED' });
  const [locked] = await db.$queryRaw<Array<{ platformRole: string; enabled: boolean }>>`SELECT "platformRole"::text AS "platformRole", enabled FROM "User" WHERE id = ${actorUserId} FOR SHARE`;
  if (!locked || !locked.enabled || locked.platformRole !== PlatformRole.SYSTEM_OWNER) throw new HttpError(403, 'SYSTEM_OWNER authorization is required.', { code: 'SYSTEM_OWNER_REQUIRED' });
}

function conflict(code: string, message: string, extra: Record<string, unknown> = {}) {
  return new HttpError(409, message, { code, ...extra });
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw conflict('AUTHORIZATION_ALREADY_EFFECTIVE', BLOCKING_MESSAGES.AUTHORIZATION_ALREADY_EFFECTIVE);
    if (error.code === 'P2034') throw conflict('CONCURRENT_AUTHORIZATION_CHANGE', 'A concurrent authorization change was detected; reload and retry.');
  }
  if (error instanceof Error && /deadlock detected|could not serialize/i.test(error.message)) throw conflict('CONCURRENT_AUTHORIZATION_CHANGE', 'A concurrent authorization change was detected; reload and retry.');
  if (error instanceof Error && /Enforcement (authorization|revocation|lapse)|enabled SYSTEM_OWNER/.test(error.message)) throw conflict('AUTHORIZATION_INTEGRITY_REJECTED', 'PostgreSQL rejected the enforcement authorization change.', { reason: error.message });
  throw error;
}

export type GrantEnforcementAuthorizationInput = { generationId: number; expectedConfigurationFingerprint: string; expectedPolicyRevisionId: number; reason: string };

export async function grantAssignmentMarketPolicyEnforcementAuthorization(accountId: number, assignmentId: number, input: GrantEnforcementAuthorizationInput, actorUserId: number) {
  try {
    return await prisma.$transaction(async db => {
      await assertEnabledOwner(actorUserId, db);
      await db.$queryRaw`SELECT id FROM "TradingAccountSubscription" WHERE id = ${assignmentId} FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id = ${input.generationId} AND "accountSubscriptionId" = ${assignmentId} FOR UPDATE`;
      const loaded = await loadContext(accountId, assignmentId, input.generationId, db);
      if (!loaded) throw new HttpError(404, 'Trading account subscription not found.');
      const { generation, context } = loaded;
      if (!generation) throw new HttpError(404, 'Enrollment generation not found.', { code: 'ENROLLMENT_GENERATION_NOT_FOUND' });
      if (generation.configurationFingerprint !== input.expectedConfigurationFingerprint) throw conflict('STALE_CONFIGURATION', 'Enrollment configuration changed after it was loaded.');
      if (generation.policyRevisionId !== input.expectedPolicyRevisionId) throw conflict('STALE_POLICY_REVISION', 'The enrollment generation binds a different policy revision than expected.');
      if (loaded.effective) throw conflict('AUTHORIZATION_ALREADY_EFFECTIVE', BLOCKING_MESSAGES.AUTHORIZATION_ALREADY_EFFECTIVE, { authorizationId: loaded.effective.id });
      const evaluation = evaluateEnforcementAuthorizationEligibility(context);
      if (!evaluation.eligible) throw conflict(evaluation.blockingReasons[0]!.code, evaluation.blockingReasons[0]!.message, { blockingReasons: evaluation.blockingReasons });
      const security = context.security!;
      const latest = await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { enrollmentGenerationId: generation.id }, orderBy: { authorizationSequence: 'desc' }, select: { authorizationSequence: true } });
      const authorizationSequence = (latest?.authorizationSequence ?? 0) + 1;
      const authorizationFingerprint = enforcementAuthorizationFingerprint({
        accountId, assignmentId, subscriptionId: security.subscriptionId, securityId: security.securityId, securitySymbol: security.securitySymbol,
        strategyId: generation.strategyId, policyRevisionId: generation.policyRevisionId, enrollmentId: generation.enrollmentId,
        enrollmentGenerationId: generation.id, generation: generation.generation, configurationFingerprint: generation.configurationFingerprint,
        accountHolderUserId: generation.accountHolderUserId, authorizationSequence,
      });
      // authorizedAt is omitted: PostgreSQL stamps it, and recomputes and verifies the fingerprint.
      const row = await db.assignmentMarketPolicyEnforcementAuthorization.create({
        data: {
          enrollmentId: generation.enrollmentId, enrollmentGenerationId: generation.id, authorizationSequence, authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION,
          status: 'AUTHORIZED', environment: 'PAPER', tradingAccountId: accountId, accountSubscriptionId: assignmentId, strategyId: generation.strategyId,
          subscriptionId: security.subscriptionId, securityId: security.securityId, securitySymbol: security.securitySymbol,
          policyRevisionId: generation.policyRevisionId, accountHolderUserId: generation.accountHolderUserId, configurationFingerprint: generation.configurationFingerprint,
          authorizationFingerprint, authorizedByUserId: actorUserId, grantReason: input.reason,
        },
        include: authorizationInclude,
      });
      const runtime = await getMarketPolicyEnforcementRuntimeStatus(db);
      await createSystemEvent({
        type: 'MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_GRANTED', entityType: 'AssignmentMarketPolicyEnforcementAuthorization', entityId: row.id,
        tradingAccountId: accountId, actorUserId,
        message: runtime.active
          ? 'PAPER market-policy enforcement authorization granted; new entries for this exact assignment and Security are now market-policy gated.'
          : 'PAPER market-policy enforcement authorization granted; runtime enforcement is not active.',
        payloadJson: { authorizationId: row.id, accountSubscriptionId: assignmentId, enrollmentGenerationId: generation.id, policyRevisionId: generation.policyRevisionId, subscriptionId: security.subscriptionId, securityId: security.securityId, securitySymbol: security.securitySymbol, authorityVersion: row.authorityVersion, authorizationSequence, runtimeEnforcementActive: runtime.active, runtimeRolloutVersion: runtime.version, tradingEffect: runtime.active ? 'PAPER_PRE_INTENT_ENFORCEMENT' : 'NONE' },
      }, db);
      return presentOwnerEnforcementAuthorization(row);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { mapPersistenceError(error); }
}

export type RevokeEnforcementAuthorizationInput = { authorizationId: number; reason: string };

export async function revokeAssignmentMarketPolicyEnforcementAuthorization(accountId: number, assignmentId: number, input: RevokeEnforcementAuthorizationInput, actorUserId: number) {
  try {
    return await prisma.$transaction(async db => {
      await assertEnabledOwner(actorUserId, db);
      await db.$queryRaw`SELECT id FROM "TradingAccountSubscription" WHERE id = ${assignmentId} FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id = ${input.authorizationId} FOR UPDATE`;
      const row = await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { id: input.authorizationId, accountSubscriptionId: assignmentId, tradingAccountId: accountId }, include: authorizationInclude });
      if (!row) throw new HttpError(404, 'Enforcement authorization not found.', { code: 'AUTHORIZATION_NOT_FOUND' });
      if (row.status === 'REVOKED') throw conflict('AUTHORIZATION_ALREADY_REVOKED', 'Enforcement authorization is already REVOKED.');
      if (row.status === 'INVALIDATED') throw conflict('AUTHORIZATION_ALREADY_INVALIDATED', 'Enforcement authorization was already INVALIDATED.', { invalidationReasonCode: row.invalidationReasonCode });
      // revokedAt is stamped by PostgreSQL.
      const updated = await db.assignmentMarketPolicyEnforcementAuthorization.update({ where: { id: row.id }, data: { status: 'REVOKED', revokedByUserId: actorUserId, revocationReason: input.reason }, include: authorizationInclude });
      const runtime = await getMarketPolicyEnforcementRuntimeStatus(db);
      await createSystemEvent({
        type: 'MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_REVOKED', entityType: 'AssignmentMarketPolicyEnforcementAuthorization', entityId: row.id,
        tradingAccountId: accountId, actorUserId,
        message: 'PAPER market-policy enforcement authorization revoked by the owner; this assignment explicitly returns to non-enforced entry behavior. Already-frozen OrderIntent obligations are unchanged.',
        payloadJson: { authorizationId: row.id, accountSubscriptionId: assignmentId, enrollmentGenerationId: row.enrollmentGenerationId, policyRevisionId: row.policyRevisionId, authorityVersion: row.authorityVersion, consequence: 'EXPLICIT_RETURN_TO_NON_ENFORCED_BEHAVIOR', runtimeEnforcementActive: runtime.active, runtimeRolloutVersion: runtime.version, tradingEffect: runtime.active ? 'PAPER_PRE_INTENT_ENFORCEMENT_REMOVED' : 'NONE' },
      }, db);
      return presentOwnerEnforcementAuthorization(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { mapPersistenceError(error); }
}

export type ResolveEnforcementLapseInput = { authorizationId: number; reason: string; confirmNonEnforced: true };

/**
 * Explicit, audited SYSTEM_OWNER decision to restore non-enforced entry behavior after an automatic
 * invalidation. It applies only to the assignment's latest, INVALIDATED authorization; it never
 * restores authority and never changes already-frozen OrderIntent obligations.
 */
export async function resolveAssignmentMarketPolicyEnforcementLapse(accountId: number, assignmentId: number, input: ResolveEnforcementLapseInput, actorUserId: number) {
  try {
    return await prisma.$transaction(async db => {
      await assertEnabledOwner(actorUserId, db);
      await db.$queryRaw`SELECT id FROM "TradingAccountSubscription" WHERE id = ${assignmentId} FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id = ${input.authorizationId} FOR UPDATE`;
      const row = await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { id: input.authorizationId, accountSubscriptionId: assignmentId, tradingAccountId: accountId }, include: authorizationInclude });
      if (!row) throw new HttpError(404, 'Enforcement authorization not found.', { code: 'AUTHORIZATION_NOT_FOUND' });
      if (row.status !== 'INVALIDATED') throw conflict('AUTHORIZATION_NOT_INVALIDATED', 'Only an automatically INVALIDATED authorization has a lapse to resolve.', { status: row.status });
      if (row.lapseResolution) throw conflict('LAPSE_ALREADY_RESOLVED', 'This invalidated authorization was already resolved.', { lapseResolutionId: row.lapseResolution.id });
      const later = await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { accountSubscriptionId: assignmentId, id: { gt: row.id } }, select: { id: true } });
      if (later) throw conflict('AUTHORIZATION_NOT_LATEST', 'A later authorization supersedes this invalidated authorization.', { latestAuthorizationId: later.id });
      const resolution = await db.assignmentMarketPolicyEnforcementLapseResolution.create({
        data: {
          authorizationId: row.id, tradingAccountId: row.tradingAccountId, accountSubscriptionId: row.accountSubscriptionId,
          authorizationFingerprint: row.authorizationFingerprint, invalidationReasonCode: row.invalidationReasonCode!,
          resolution: MARKET_POLICY_LAPSE_RESOLUTION, resolvedByUserId: actorUserId, reason: input.reason,
        },
        include: { resolvedBy: userSelect },
      });
      const runtime = await getMarketPolicyEnforcementRuntimeStatus(db);
      await createSystemEvent({
        type: 'MARKET_POLICY_ENFORCEMENT_LAPSE_RESOLVED', entityType: 'AssignmentMarketPolicyEnforcementAuthorization', entityId: row.id,
        tradingAccountId: accountId, actorUserId, severity: 'WARNING',
        message: 'SYSTEM_OWNER explicitly restored non-enforced entry behavior after an automatic market-policy authorization invalidation.',
        payloadJson: { authorizationId: row.id, lapseResolutionId: resolution.id, accountSubscriptionId: assignmentId, invalidationReasonCode: row.invalidationReasonCode, resolution: MARKET_POLICY_LAPSE_RESOLUTION, consequence: 'EXPLICIT_RETURN_TO_NON_ENFORCED_BEHAVIOR', runtimeEnforcementActive: runtime.active, runtimeRolloutVersion: runtime.version },
      }, db);
      return { id: resolution.id, authorizationId: row.id, resolution: resolution.resolution, resolvedAt: resolution.resolvedAt, reason: resolution.reason, resolvedBy: resolution.resolvedBy, consequence: 'EXPLICIT_RETURN_TO_NON_ENFORCED_BEHAVIOR' as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { mapPersistenceError(error); }
}
