import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { strategyMarketPolicyConfigurationFingerprint, validateMarketPolicyRules } from './strategy-market-policy.service.js';

export const ASSIGNMENT_MARKET_POLICY_ENROLLMENT_AUTHORITY = 'CONFIGURATION_ONLY' as const;
export const ASSIGNMENT_MARKET_POLICY_ENFORCEMENT_ENABLED = false as const;
export function marketOutcomePermitsConfigurationActivation(_outcome: 'ALLOWED' | 'BLOCKED' | 'INSUFFICIENT_EVIDENCE' | null) { return true; }

const generationInclude = {
  policyRevision: { include: { policy: { select: { id: true, strategyId: true } }, dimensionRules: { include: { allowedStates: true } } } },
  transitions: { orderBy: { sequence: 'asc' as const }, include: { actor: { select: { id: true, email: true, name: true } } } },
  preparedBy: { select: { id: true, email: true, name: true } },
  activatedBy: { select: { id: true, email: true, name: true } },
  disabledBy: { select: { id: true, email: true, name: true } },
} satisfies Prisma.AssignmentMarketPolicyEnrollmentGenerationInclude;

const assignmentSelect = {
  id: true, tradingAccountId: true, routingStrategyId: true, enabled: true, entriesEnabled: true,
  tradingAccount: { select: { id: true, displayName: true, environment: true, status: true, tradingEnabled: true, killSwitchEnabled: true, accountHolderUserId: true } },
  subscription: { select: { id: true, strategy: { select: { id: true, key: true, name: true, enabled: true, marketPolicy: { select: { id: true, revisions: { where: { status: 'ACTIVE' as const }, include: { dimensionRules: { include: { allowedStates: true } } }, take: 1 } } } } }, security: { select: { id: true, symbol: true } } } },
} satisfies Prisma.TradingAccountSubscriptionSelect;

function fingerprint(input: object) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }

async function assertOwner(actorUserId: number, db: Prisma.TransactionClient) {
  const actor = await db.user.findUnique({ where: { id: actorUserId }, select: { platformRole: true, enabled: true } });
  if (!actor || !actor.enabled || actor.platformRole !== 'SYSTEM_OWNER') throw new HttpError(403, 'SYSTEM_OWNER authorization is required.');
}

async function findAssignment(accountId: number, assignmentId: number, db: typeof prisma | Prisma.TransactionClient) {
  return db.tradingAccountSubscription.findFirst({ where: { id: assignmentId, tradingAccountId: accountId }, select: assignmentSelect });
}

function publicGeneration<T extends { enforcementAuthorityVersion: string | null; enforcementAuthorizedAt: Date | null }>(generation: T) {
  return { ...generation, authority: ASSIGNMENT_MARKET_POLICY_ENROLLMENT_AUTHORITY, enforcementEnabled: generation.enforcementAuthorityVersion !== null && generation.enforcementAuthorizedAt !== null };
}

export async function getAssignmentMarketPolicyEnrollment(accountId: number, assignmentId: number) {
  const assignment = await findAssignment(accountId, assignmentId, prisma);
  if (!assignment) return null;
  const enrollment = await prisma.assignmentMarketPolicyEnrollment.findUnique({
    where: { accountSubscriptionId: assignmentId },
    include: { generations: { include: generationInclude, orderBy: { generation: 'desc' } } },
  });
  return { authority: ASSIGNMENT_MARKET_POLICY_ENROLLMENT_AUTHORITY, enforcementEnabled: false, assignment, enrollment: enrollment ? { ...enrollment, generations: enrollment.generations.map(publicGeneration) } : null };
}

export async function previewAssignmentMarketPolicyEnrollment(accountId: number, assignmentId: number) {
  const state = await getAssignmentMarketPolicyEnrollment(accountId, assignmentId);
  if (!state) return null;
  const { assignment, enrollment } = state;
  const current = enrollment?.generations.find(item => item.status !== 'DISABLED') ?? enrollment?.generations[0] ?? null;
  const activePolicy = assignment.subscription.strategy.marketPolicy?.revisions[0] ?? null;
  const ownershipValid = !current || current.accountHolderUserId === assignment.tradingAccount.accountHolderUserId;
  const policyRevisionMatches = !current || (activePolicy?.id === current.policyRevisionId);
  const paperEligible = assignment.tradingAccount.environment === 'PAPER';
  const configurationValidation = activePolicy ? validateMarketPolicyRules(activePolicy.dimensionRules) : { valid: false, errors: [{ code: 'ACTIVE_POLICY_REQUIRED', message: 'The assignment strategy has no active market policy revision.' }] };
  const configurationValid = paperEligible && ownershipValid && policyRevisionMatches && configurationValidation.valid;
  const latestDecision = activePolicy ? await prisma.strategyMarketEligibilityDecision.findFirst({ where: { strategyId: assignment.routingStrategyId, policyRevisionId: activePolicy.id }, orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }], select: { id: true, outcome: true, reasonCode: true, evaluatedAt: true, validUntil: true } }) : null;
  const evaluatorTechnicalStatus = latestDecision ? 'AVAILABLE' : 'NOT_EVALUATED';
  const marketOutcome = latestDecision?.outcome ?? null;
  const readyToActivate = Boolean(current?.status === 'PREPARED' && configurationValid);
  const notReadyReasons = [
    ...(!paperEligible ? ['ACCOUNT_NOT_PAPER'] : []),
    ...(!ownershipValid ? ['ACCOUNT_OWNERSHIP_CHANGED'] : []),
    ...(!activePolicy ? ['ACTIVE_POLICY_REQUIRED'] : []),
    ...(!policyRevisionMatches ? ['POLICY_REVISION_MISMATCH'] : []),
    ...(!configurationValidation.valid ? ['POLICY_CONFIGURATION_INVALID'] : []),
  ];
  return {
    authority: ASSIGNMENT_MARKET_POLICY_ENROLLMENT_AUTHORITY, enforcementEnabled: false,
    assignmentIdentity: { accountId, assignmentId, strategyId: assignment.routingStrategyId, policyRevisionId: activePolicy?.id ?? null },
    paperEligible, ownershipValid, policyRevisionMatches, configurationValid, configurationErrors: configurationValidation.errors,
    enrollmentGeneration: current ? publicGeneration(current) : null,
    readyToActivate, notReadyReasons,
    currentMarketEligibility: { outcome: marketOutcome, reasonCode: latestDecision?.reasonCode ?? 'NO_PERSISTED_SHADOW_DECISION', evaluatorTechnicalStatus, decisionId: latestDecision?.id ?? null, evaluatedAt: latestDecision?.evaluatedAt ?? null, validUntil: latestDecision?.validUntil ?? null, requiredForActivation: false },
    operationalPosture: { strategyEnabled: assignment.subscription.strategy.enabled, assignmentEnabled: assignment.enabled, entriesEnabled: assignment.entriesEnabled, accountStatus: assignment.tradingAccount.status, accountTradingEnabled: assignment.tradingAccount.tradingEnabled, killSwitchEnabled: assignment.tradingAccount.killSwitchEnabled, affectsEnrollmentValidity: false },
  };
}

export async function prepareAssignmentMarketPolicyEnrollment(accountId: number, assignmentId: number, actorUserId: number) {
  return prisma.$transaction(async db => {
    await assertOwner(actorUserId, db);
    await db.$queryRaw`SELECT id FROM "TradingAccountSubscription" WHERE id = ${assignmentId} FOR UPDATE`;
    const assignment = await findAssignment(accountId, assignmentId, db);
    if (!assignment) throw new HttpError(404, 'Trading account subscription not found.');
    if (assignment.tradingAccount.environment !== 'PAPER') throw new HttpError(409, 'Market-policy enrollment is PAPER-only.');
    const revision = assignment.subscription.strategy.marketPolicy?.revisions[0];
    if (!revision) throw new HttpError(409, 'The assignment strategy requires an ACTIVE market-policy revision.');
    const validation = validateMarketPolicyRules(revision.dimensionRules);
    if (!validation.valid) throw new HttpError(409, 'The active market-policy revision is invalid.', validation.errors);
    const enrollment = await db.assignmentMarketPolicyEnrollment.upsert({ where: { accountSubscriptionId: assignmentId }, create: { accountSubscriptionId: assignmentId }, update: {} });
    await db.$queryRaw`SELECT id FROM "AssignmentMarketPolicyEnrollment" WHERE id = ${enrollment.id} FOR UPDATE`;
    if (await db.assignmentMarketPolicyEnrollmentGeneration.findFirst({ where: { enrollmentId: enrollment.id, status: { in: ['PREPARED', 'ACTIVE'] } } })) throw new HttpError(409, 'Disable the current enrollment generation before re-enrolling.');
    const latest = await db.assignmentMarketPolicyEnrollmentGeneration.findFirst({ where: { enrollmentId: enrollment.id }, orderBy: { generation: 'desc' }, select: { generation: true } });
    const generation = (latest?.generation ?? 0) + 1;
    const configurationFingerprint = fingerprint({ accountId, assignmentId, strategyId: assignment.routingStrategyId, policyRevisionId: revision.id, policyConfigurationFingerprint: strategyMarketPolicyConfigurationFingerprint(revision.dimensionRules), accountHolderUserId: assignment.tradingAccount.accountHolderUserId, environment: assignment.tradingAccount.environment, generation });
    const row = await db.assignmentMarketPolicyEnrollmentGeneration.create({ data: { enrollmentId: enrollment.id, generation, status: 'PREPARED', tradingAccountId: accountId, accountSubscriptionId: assignmentId, strategyId: assignment.routingStrategyId, policyRevisionId: revision.id, accountHolderUserId: assignment.tradingAccount.accountHolderUserId, configurationFingerprint, preparedByUserId: actorUserId, transitions: { create: { sequence: 1, action: 'PREPARE', fromStatus: null, toStatus: 'PREPARED', actorUserId, accountHolderUserId: assignment.tradingAccount.accountHolderUserId, configurationFingerprint } } }, include: generationInclude });
    return publicGeneration(row);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function activateAssignmentMarketPolicyEnrollment(accountId: number, assignmentId: number, generationId: number, actorUserId: number, expectedConfigurationFingerprint: string) {
  return prisma.$transaction(async db => {
    await assertOwner(actorUserId, db);
    await db.$queryRaw`SELECT id FROM "TradingAccountSubscription" WHERE id = ${assignmentId} FOR UPDATE`;
    const assignment = await findAssignment(accountId, assignmentId, db);
    if (!assignment) throw new HttpError(404, 'Trading account subscription not found.');
    const row = await db.assignmentMarketPolicyEnrollmentGeneration.findFirst({ where: { id: generationId, accountSubscriptionId: assignmentId }, include: generationInclude });
    if (!row) throw new HttpError(404, 'Enrollment generation not found.');
    if (row.status !== 'PREPARED') throw new HttpError(409, 'Only a PREPARED enrollment generation can be activated.');
    if (row.configurationFingerprint !== expectedConfigurationFingerprint) throw new HttpError(409, 'Enrollment configuration changed after it was loaded.');
    if (assignment.tradingAccount.environment !== 'PAPER') throw new HttpError(409, 'Market-policy enrollment is PAPER-only.');
    if (assignment.tradingAccount.accountHolderUserId !== row.accountHolderUserId) throw new HttpError(409, 'Account ownership changed; disable and prepare a new authorization generation.');
    if (assignment.subscription.strategy.marketPolicy?.revisions[0]?.id !== row.policyRevisionId) throw new HttpError(409, 'The bound policy revision is no longer ACTIVE.');
    const now = new Date();
    const updated = await db.assignmentMarketPolicyEnrollmentGeneration.update({ where: { id: row.id }, data: { status: 'ACTIVE', activatedByUserId: actorUserId, activatedAt: now, transitions: { create: { sequence: 2, action: 'ACTIVATE', fromStatus: 'PREPARED', toStatus: 'ACTIVE', actorUserId, accountHolderUserId: row.accountHolderUserId, configurationFingerprint: row.configurationFingerprint } } }, include: generationInclude });
    return publicGeneration(updated);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function disableAssignmentMarketPolicyEnrollment(accountId: number, assignmentId: number, generationId: number, actorUserId: number, reason: string) {
  return prisma.$transaction(async db => {
    await assertOwner(actorUserId, db);
    await db.$queryRaw`SELECT id FROM "TradingAccountSubscription" WHERE id = ${assignmentId} FOR UPDATE`;
    if (!await findAssignment(accountId, assignmentId, db)) throw new HttpError(404, 'Trading account subscription not found.');
    const row = await db.assignmentMarketPolicyEnrollmentGeneration.findFirst({ where: { id: generationId, accountSubscriptionId: assignmentId }, include: generationInclude });
    if (!row) throw new HttpError(404, 'Enrollment generation not found.');
    if (row.status === 'DISABLED') throw new HttpError(409, 'Enrollment generation is already DISABLED.');
    const now = new Date(); const sequence = row.status === 'PREPARED' ? 2 : 3;
    const updated = await db.assignmentMarketPolicyEnrollmentGeneration.update({ where: { id: row.id }, data: { status: 'DISABLED', disabledByUserId: actorUserId, disabledAt: now, disableReason: reason, transitions: { create: { sequence, action: 'DISABLE', fromStatus: row.status, toStatus: 'DISABLED', actorUserId, accountHolderUserId: row.accountHolderUserId, configurationFingerprint: row.configurationFingerprint, reason } } }, include: generationInclude });
    return publicGeneration(updated);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
