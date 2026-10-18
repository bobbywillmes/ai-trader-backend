import { createHash } from 'node:crypto';
import { PlatformRole, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { assignmentEnrollmentConfigurationFingerprint } from './assignment-market-policy-enrollment.service.js';
import { strategyMarketPolicyConfigurationFingerprint, validateMarketPolicyRules } from './strategy-market-policy.service.js';
import { createSystemEvent } from './system-event.service.js';

// Phase 3C.1 records explicit PAPER authority only. No order, risk, worker or broker path consumes
// these records yet; Phase 3C.2 will read them through resolveAssignmentMarketPolicyEnforcementAuthority.
export const MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION = 'PAPER_MARKET_POLICY_ENFORCEMENT_V1' as const;
export const MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_SCOPE = 'PAPER_ONLY' as const;
export const MARKET_POLICY_RUNTIME_ENFORCEMENT = { active: false, status: 'NOT_ACTIVATED', tradingEffect: 'NONE' } as const;

type Db = typeof prisma | Prisma.TransactionClient;

export type EnforcementAuthorizationBlockingCode =
  | 'ACCOUNT_NOT_PAPER'
  | 'ENROLLMENT_GENERATION_REQUIRED'
  | 'ENROLLMENT_NOT_ACTIVE'
  | 'ASSIGNMENT_IDENTITY_MISMATCH'
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
  ACCOUNT_OWNERSHIP_CHANGED: 'The account holder changed after the enrollment generation was prepared.',
  ACTIVE_POLICY_REQUIRED: 'The assignment Strategy has no ACTIVE market-policy revision.',
  POLICY_REVISION_SUPERSEDED: 'The bound policy revision is no longer the Strategy\'s ACTIVE revision.',
  POLICY_CONFIGURATION_INVALID: 'The bound policy revision does not validly describe all five market dimensions.',
  CONFIGURATION_FINGERPRINT_MISMATCH: 'The enrollment configuration fingerprint no longer matches the bound identity.',
  AUTHORIZATION_ALREADY_EFFECTIVE: 'An effective enforcement authorization already exists for this assignment.',
};

type DimensionRule = { dimension: string; algorithmVersion: string; requirement: string; allowedStates: Array<{ state: string }> };

export type EnforcementAuthorizationContext = {
  account: { id: number; environment: string; accountHolderUserId: number };
  assignment: { id: number; tradingAccountId: number; routingStrategyId: number };
  activePolicyRevisionId: number | null;
  generation: null | {
    id: number; enrollmentId: number; generation: number; status: string; tradingAccountId: number; accountSubscriptionId: number;
    strategyId: number; policyRevisionId: number; accountHolderUserId: number; configurationFingerprint: string;
  };
  boundRevision: null | { id: number; status: string; strategyId: number; dimensionRules: DimensionRule[] };
  effectiveAuthorizationId: number | null;
};

// Pure configuration-integrity evaluation. Current market outcome and operational posture are
// deliberately absent: BLOCKED or INSUFFICIENT_EVIDENCE markets do not prevent authorization.
export function evaluateEnforcementAuthorizationEligibility(context: EnforcementAuthorizationContext) {
  const codes: EnforcementAuthorizationBlockingCode[] = [];
  const { account, assignment, generation, boundRevision } = context;
  if (account.environment !== 'PAPER') codes.push('ACCOUNT_NOT_PAPER');
  if (!context.activePolicyRevisionId) codes.push('ACTIVE_POLICY_REQUIRED');
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

export function enforcementAuthorizationFingerprint(input: {
  accountId: number; assignmentId: number; strategyId: number; policyRevisionId: number; enrollmentId: number; enrollmentGenerationId: number;
  generation: number; configurationFingerprint: string; accountHolderUserId: number; authorizationSequence: number;
}) {
  const { accountId, assignmentId, strategyId, policyRevisionId, enrollmentId, enrollmentGenerationId, generation, configurationFingerprint, accountHolderUserId, authorizationSequence } = input;
  return createHash('sha256').update(JSON.stringify({ authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION, environment: 'PAPER', accountId, assignmentId, strategyId, policyRevisionId, enrollmentId, enrollmentGenerationId, generation, configurationFingerprint, accountHolderUserId, authorizationSequence })).digest('hex');
}

const userSelect = { select: { id: true, email: true, name: true } } as const;
const authorizationInclude = { authorizedBy: userSelect, revokedBy: userSelect, invalidatedBy: userSelect } satisfies Prisma.AssignmentMarketPolicyEnforcementAuthorizationInclude;
type AuthorizationRow = Prisma.AssignmentMarketPolicyEnforcementAuthorizationGetPayload<{ include: typeof authorizationInclude }>;

function summarizeEnforcementAuthorization(row: AuthorizationRow) {
  return {
    id: row.id, enrollmentGenerationId: row.enrollmentGenerationId, authorizationSequence: row.authorizationSequence,
    authorityVersion: row.authorityVersion, status: row.status, environment: row.environment, policyRevisionId: row.policyRevisionId,
    authorizedAt: row.authorizedAt, revokedAt: row.revokedAt, invalidatedAt: row.invalidatedAt, invalidationReasonCode: row.invalidationReasonCode,
  };
}

export function presentEnforcementAuthorization(row: AuthorizationRow, viewerRole: PlatformRole) {
  return viewerRole === PlatformRole.SYSTEM_OWNER ? presentOwnerEnforcementAuthorization(row) : summarizeEnforcementAuthorization(row);
}

function presentOwnerEnforcementAuthorization(row: AuthorizationRow) {
  return {
    ...summarizeEnforcementAuthorization(row),
    enrollmentId: row.enrollmentId, tradingAccountId: row.tradingAccountId, accountSubscriptionId: row.accountSubscriptionId, strategyId: row.strategyId,
    accountHolderUserId: row.accountHolderUserId, configurationFingerprint: row.configurationFingerprint, authorizationFingerprint: row.authorizationFingerprint,
    grantReason: row.grantReason, revocationReason: row.revocationReason,
    authorizedBy: row.authorizedBy, revokedBy: row.revokedBy, invalidatedBy: row.invalidatedBy,
  };
}

const assignmentSelect = {
  id: true, tradingAccountId: true, routingStrategyId: true, enabled: true, entriesEnabled: true,
  tradingAccount: { select: { id: true, displayName: true, environment: true, status: true, tradingEnabled: true, killSwitchEnabled: true, accountHolderUserId: true } },
  subscription: { select: { id: true, key: true, name: true, security: { select: { id: true, symbol: true } }, strategy: { select: { id: true, key: true, name: true, enabled: true, marketPolicy: { select: { revisions: { where: { status: 'ACTIVE' as const }, select: { id: true, revision: true }, take: 1 } } } } } } },
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
  const activeRevision = assignment.subscription.strategy.marketPolicy?.revisions[0] ?? null;
  const context: EnforcementAuthorizationContext = {
    account: { id: assignment.tradingAccount.id, environment: assignment.tradingAccount.environment, accountHolderUserId: assignment.tradingAccount.accountHolderUserId },
    assignment: { id: assignment.id, tradingAccountId: assignment.tradingAccountId, routingStrategyId: assignment.routingStrategyId },
    activePolicyRevisionId: activeRevision?.id ?? null,
    generation,
    boundRevision: boundRevision ? { id: boundRevision.id, status: boundRevision.status, strategyId: boundRevision.policy.strategyId, dimensionRules: boundRevision.dimensionRules } : null,
    effectiveAuthorizationId: effective?.id ?? null,
  };
  return { assignment, generation, boundRevision, activeRevision, effective, context };
}

// Exact authorization row checks shared by state reads and the future Phase 3C.2 consumer.
function authorizationIneffectiveReasons(authorization: AuthorizationRow, context: EnforcementAuthorizationContext) {
  const generation = context.generation;
  const reasons: string[] = [];
  if (!generation || generation.id !== authorization.enrollmentGenerationId) reasons.push('AUTHORIZED_GENERATION_NOT_CURRENT');
  else if (generation.configurationFingerprint !== authorization.configurationFingerprint || generation.policyRevisionId !== authorization.policyRevisionId
    || generation.accountHolderUserId !== authorization.accountHolderUserId || generation.strategyId !== authorization.strategyId) reasons.push('AUTHORIZATION_IDENTITY_MISMATCH');
  if (authorization.environment !== 'PAPER') reasons.push('ACCOUNT_NOT_PAPER');
  const evaluation = evaluateEnforcementAuthorizationEligibility({ ...context, effectiveAuthorizationId: null });
  for (const reason of evaluation.blockingReasons) if (!reasons.includes(reason.code)) reasons.push(reason.code);
  return reasons;
}

/**
 * Phase 3C.2 read boundary: is this exact assignment explicitly and currently authorized for
 * PAPER market-policy enforcement? Read-only; it never evaluates markets or creates decisions.
 * Phase 3C.1 has no caller in any trading path.
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
    },
  };
}

async function stateFor(loaded: NonNullable<Awaited<ReturnType<typeof loadContext>>>, viewerRole: PlatformRole, db: Db) {
  const { generation, effective, context } = loaded;
  const latest = generation
    ? await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { enrollmentGenerationId: generation.id }, orderBy: { authorizationSequence: 'desc' }, include: authorizationInclude })
    : null;
  // AUTHORIZED rows always belong to the ACTIVE generation; prefer the effective row if one exists.
  const authorization = effective ?? latest;
  const state = authorization?.status ?? 'NOT_AUTHORIZED';
  const ineffectiveReasons = authorization?.status === 'AUTHORIZED' ? authorizationIneffectiveReasons(authorization, context) : [];
  return {
    authorizationScope: MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_SCOPE,
    authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION,
    runtimeEnforcement: MARKET_POLICY_RUNTIME_ENFORCEMENT,
    enrollmentGeneration: generation ? { id: generation.id, generation: generation.generation, status: generation.status } : null,
    state,
    effective: state === 'AUTHORIZED' && ineffectiveReasons.length === 0,
    ineffectiveReasons,
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
  return {
    authorizationScope: MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_SCOPE,
    authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION,
    runtimeEnforcement: MARKET_POLICY_RUNTIME_ENFORCEMENT,
    identity: {
      tradingAccount: { id: assignment.tradingAccount.id, displayName: assignment.tradingAccount.displayName, environment: assignment.tradingAccount.environment },
      assignment: { id: assignment.id },
      subscription: { id: assignment.subscription.id, key: assignment.subscription.key, name: assignment.subscription.name },
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
    currentAuthorization: await stateFor(loaded, viewerRole, prisma),
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
    runtimeEnforcement: MARKET_POLICY_RUNTIME_ENFORCEMENT,
    authorizations: authorizations.map(row => ({
      ...presentOwnerEnforcementAuthorization(row),
      generation: row.enrollmentGeneration.generation,
      policyRevision: row.policyRevision.revision,
      events: row.events.map(event => ({ id: event.id, sequence: event.sequence, action: event.action, fromStatus: event.fromStatus, toStatus: event.toStatus, reason: event.reason, actor: event.actor, occurredAt: event.occurredAt, authorizationFingerprint: event.authorizationFingerprint, configurationFingerprint: event.configurationFingerprint })),
    })),
  };
}

async function assertEnabledOwner(actorUserId: number, db: Prisma.TransactionClient) {
  const actor = await db.user.findUnique({ where: { id: actorUserId }, select: { platformRole: true, enabled: true } });
  if (!actor || !actor.enabled || actor.platformRole !== PlatformRole.SYSTEM_OWNER) throw new HttpError(403, 'SYSTEM_OWNER authorization is required.', { code: 'SYSTEM_OWNER_REQUIRED' });
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
  if (error instanceof Error && /Enforcement (authorization|revocation)/.test(error.message)) throw conflict('AUTHORIZATION_INTEGRITY_REJECTED', 'PostgreSQL rejected the enforcement authorization change.', { reason: error.message });
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
      const latest = await db.assignmentMarketPolicyEnforcementAuthorization.findFirst({ where: { enrollmentGenerationId: generation.id }, orderBy: { authorizationSequence: 'desc' }, select: { authorizationSequence: true } });
      const authorizationSequence = (latest?.authorizationSequence ?? 0) + 1;
      const authorizationFingerprint = enforcementAuthorizationFingerprint({
        accountId, assignmentId, strategyId: generation.strategyId, policyRevisionId: generation.policyRevisionId, enrollmentId: generation.enrollmentId,
        enrollmentGenerationId: generation.id, generation: generation.generation, configurationFingerprint: generation.configurationFingerprint,
        accountHolderUserId: generation.accountHolderUserId, authorizationSequence,
      });
      const row = await db.assignmentMarketPolicyEnforcementAuthorization.create({
        data: {
          enrollmentId: generation.enrollmentId, enrollmentGenerationId: generation.id, authorizationSequence, authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION,
          status: 'AUTHORIZED', environment: 'PAPER', tradingAccountId: accountId, accountSubscriptionId: assignmentId, strategyId: generation.strategyId,
          policyRevisionId: generation.policyRevisionId, accountHolderUserId: generation.accountHolderUserId, configurationFingerprint: generation.configurationFingerprint,
          authorizationFingerprint, authorizedByUserId: actorUserId, authorizedAt: new Date(), grantReason: input.reason,
        },
        include: authorizationInclude,
      });
      await createSystemEvent({
        type: 'MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_GRANTED', entityType: 'AssignmentMarketPolicyEnforcementAuthorization', entityId: row.id,
        tradingAccountId: accountId, actorUserId, message: 'PAPER market-policy enforcement authorization granted; runtime enforcement is not active.',
        payloadJson: { authorizationId: row.id, accountSubscriptionId: assignmentId, enrollmentGenerationId: generation.id, policyRevisionId: generation.policyRevisionId, authorityVersion: row.authorityVersion, authorizationSequence, runtimeEnforcementActive: false, tradingEffect: 'NONE' },
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
      const now = new Date();
      const revokedAt = now < row.authorizedAt ? row.authorizedAt : now;
      const updated = await db.assignmentMarketPolicyEnforcementAuthorization.update({ where: { id: row.id }, data: { status: 'REVOKED', revokedByUserId: actorUserId, revokedAt, revocationReason: input.reason }, include: authorizationInclude });
      await createSystemEvent({
        type: 'MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_REVOKED', entityType: 'AssignmentMarketPolicyEnforcementAuthorization', entityId: row.id,
        tradingAccountId: accountId, actorUserId, message: 'PAPER market-policy enforcement authorization revoked.',
        payloadJson: { authorizationId: row.id, accountSubscriptionId: assignmentId, enrollmentGenerationId: row.enrollmentGenerationId, policyRevisionId: row.policyRevisionId, authorityVersion: row.authorityVersion, runtimeEnforcementActive: false, tradingEffect: 'NONE' },
      }, db);
      return presentOwnerEnforcementAuthorization(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { mapPersistenceError(error); }
}
