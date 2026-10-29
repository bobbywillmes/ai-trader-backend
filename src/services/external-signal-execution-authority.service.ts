import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { createSystemEvent } from './system-event.service.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (code: string, message: string) => new HttpError(409, message, { code });
const isConcurrencyError = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
  || error instanceof Error && /serializ|deadlock|40001|40P01/i.test(error.message);

async function requireOwner(actorUserId: number, db: Prisma.TransactionClient) {
  const actor = await db.user.findUnique({ where: { id: actorUserId }, select: { enabled: true, platformRole: true } });
  if (!actor?.enabled || actor.platformRole !== 'SYSTEM_OWNER') throw new HttpError(403, 'SYSTEM_OWNER access required.');
}

export async function listExternalSignalExecutionRollouts(actorUserId?: number) {
  return prisma.$transaction(async db => {
    if (actorUserId !== undefined) await requireOwner(actorUserId, db);
    const [generations, events, state] = await Promise.all([
      db.externalSignalExecutionRolloutGeneration.findMany({ orderBy: [{ direction: 'asc' }, { generation: 'desc' }] }),
      db.externalSignalExecutionRolloutActivation.findMany({ orderBy: { id: 'desc' }, take: 100 }),
      db.externalSignalExecutionRolloutState.findUniqueOrThrow({ where: { id: 1 } }),
    ]);
    return { activeExecutionGenerationId: state.activeRolloutGenerationId, executionEpochAt: state.activatedAt, rolloutStateVersion: state.version, generations, activationEvents: events };
  });
}

export async function createExternalSignalExecuteGeneration(input: { configuration: Prisma.InputJsonValue; reason: string }, actorUserId: number) {
  return prisma.$transaction(async db => {
    await requireOwner(actorUserId, db);
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`;
    const prior = await db.externalSignalExecutionRolloutGeneration.findFirst({ where: { direction: 'ENTRY' }, orderBy: [{ generation: 'desc' }, { id: 'desc' }] });
    const generation = (prior?.generation ?? 0) + 1;
    const configurationJson = { ...input.configuration as object, schemaVersion: 1, authority: 'PAPER_ENTRY' } as Prisma.InputJsonValue;
    const configurationFingerprint = fingerprint(configurationJson);
    const row = await db.externalSignalExecutionRolloutGeneration.create({ data: {
      direction: 'ENTRY', generation, enabled: true, authorityMode: 'EXECUTE', supersedesGenerationId: prior?.id ?? null,
      configurationJson, configurationFingerprint, effectiveAt: new Date(), createdByUserId: actorUserId,
    } });
    await createSystemEvent({ type: 'EXTERNAL_SIGNAL_EXECUTION_GENERATION_CREATED', entityType: 'ExternalSignalExecutionRolloutGeneration', entityId: row.id, actorUserId, message: 'A disabled-by-default PAPER ENTRY execution generation was created.', payloadJson: { generation, configurationFingerprint, active: false, reason: input.reason, tradingEffect: 'NONE' } }, db);
    return row;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function changeExternalSignalExecutionRollout(rolloutGenerationId: number, action: 'ACTIVATE'|'DEACTIVATE', reason: string, actorUserId: number) {
  try {
    return await prisma.$transaction(async db => {
      await requireOwner(actorUserId, db);
      const event = await db.externalSignalExecutionRolloutActivation.create({ data: { rolloutGenerationId, action, reason, actorUserId } });
      await createSystemEvent({ type: `EXTERNAL_SIGNAL_EXECUTION_ROLLOUT_${action}D`, entityType: 'ExternalSignalExecutionRolloutGeneration', entityId: rolloutGenerationId, actorUserId, severity: action === 'ACTIVATE' ? 'WARNING' : 'INFO', message: action === 'ACTIVATE' ? 'PAPER ENTRY execution authority epoch activated; no admission or dispatch integration exists in Phase 4A.2A.' : 'PAPER ENTRY execution authority epoch deactivated.', payloadJson: { activationEventId: event.id, action, tradingEffect: 'NONE_IN_4A_2A' } }, db);
      return event;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isConcurrencyError(error)) throw conflict('CONCURRENT_ROLLOUT_CHANGE', 'Execution rollout changed concurrently; reload before retrying.');
    throw conflict('ROLLOUT_TRANSITION_REJECTED', 'Execution rollout transition was rejected by the database safety protocol.');
  }
}

export async function listExternalSignalEntryExecutionAuthorizations(accountId: number, assignmentId: number, actorUserId: number) {
  return prisma.$transaction(async db => {
    await requireOwner(actorUserId, db);
    return db.externalSignalEntryExecutionAuthorization.findMany({ where: { tradingAccountId: accountId, tradingAccountSubscriptionId: assignmentId }, orderBy: { id: 'desc' } });
  });
}

export async function grantExternalSignalEntryExecutionAuthorization(accountId: number, assignmentId: number, input: { rolloutGenerationId: number; strategySignalBindingId: number; expectedStrategySignalRevisionId: number; expectedSecurityId: number; reason: string }, actorUserId: number) {
  try {
    return await prisma.$transaction(async db => {
      await requireOwner(actorUserId, db);
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`;
      await db.$executeRaw`UPDATE "ExternalSignalExecutionRolloutState" SET version=version WHERE id=1`;
      await db.$queryRaw`SELECT id FROM "ExternalSignalSource" WHERE id=(SELECT "signalSourceId" FROM "StrategySignalBinding" WHERE id=${input.strategySignalBindingId}) FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM "StrategySignalBinding" WHERE id=${input.strategySignalBindingId} FOR UPDATE`;
      const binding = await db.strategySignalBinding.findUnique({ where: { id: input.strategySignalBindingId }, include: { signalSource: true, revisions: { where: { status: 'ACTIVE' }, take: 1 } } });
      if (!binding || !binding.revisions[0]) throw new HttpError(404, 'Active source binding revision not found.');
      const revision = binding.revisions[0];
      if (revision.id !== input.expectedStrategySignalRevisionId) throw conflict('STALE_STRATEGY_REVISION', 'The active strategy signal revision changed after it was loaded.');
      await db.$queryRaw`SELECT id FROM "ExternalSignalExecutionRolloutGeneration" WHERE id=${input.rolloutGenerationId} FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM "TradingAccount" WHERE id=${accountId} FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM "TradingAccountSubscription" WHERE id=${assignmentId} FOR UPDATE`;
      const assignment = await db.tradingAccountSubscription.findFirst({ where: { id: assignmentId, tradingAccountId: accountId }, include: { tradingAccount: true, subscription: true } });
      if (!assignment) throw new HttpError(404, 'Account assignment not found.');
      if (assignment.routingSecurityId !== input.expectedSecurityId) throw conflict('STALE_SECURITY_IDENTITY', 'The assignment Security changed after it was loaded.');
      await db.$queryRaw`SELECT id FROM "Subscription" WHERE id=${assignment.subscriptionId} FOR UPDATE`;
      await db.$queryRaw`SELECT id FROM "Security" WHERE id=${assignment.routingSecurityId} FOR UPDATE`;
      const latest = await db.externalSignalEntryExecutionAuthorization.findFirst({ where: { rolloutGenerationId: input.rolloutGenerationId, tradingAccountSubscriptionId: assignmentId, strategySignalBindingId: input.strategySignalBindingId }, orderBy: { authorizationSequence: 'desc' } });
      const row = await db.externalSignalEntryExecutionAuthorization.create({ data: {
        rolloutGenerationId: input.rolloutGenerationId, authorizationSequence: (latest?.authorizationSequence ?? 0) + 1, status: 'AUTHORIZED',
        tradingAccountId: accountId, tradingAccountSubscriptionId: assignmentId, subscriptionId: assignment.subscriptionId, securityId: assignment.routingSecurityId,
        signalSourceId: binding.signalSourceId, strategySignalBindingId: binding.id, strategySignalRevisionId: revision.id, strategyRevision: revision.revision,
        accountHolderUserId: assignment.tradingAccount.accountHolderUserId, assignmentFingerprint: '0'.repeat(64), sourceFingerprint: '0'.repeat(64), authorizationFingerprint: '0'.repeat(64),
        authorizedByUserId: actorUserId, grantReason: input.reason,
      } });
      await createSystemEvent({ type: 'EXTERNAL_SIGNAL_ENTRY_EXECUTION_AUTHORIZED', entityType: 'ExternalSignalEntryExecutionAuthorization', entityId: row.id, tradingAccountId: accountId, actorUserId, severity: 'WARNING', message: 'Exact TradingView PAPER ENTRY assignment execution authority granted; no admission integration exists in Phase 4A.2A.', payloadJson: { assignmentId, bindingId: binding.id, rolloutGenerationId: input.rolloutGenerationId, authorizationFingerprint: row.authorizationFingerprint, tradingEffect: 'NONE_IN_4A_2A' } }, db);
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isConcurrencyError(error)) throw conflict('CONCURRENT_AUTHORITY_CHANGE', 'Execution authority changed concurrently; reload before retrying.');
    throw conflict('AUTHORIZATION_REJECTED', 'Execution authorization was rejected by the exact-identity database checks.');
  }
}

export async function revokeExternalSignalEntryExecutionAuthorization(accountId: number, assignmentId: number, authorizationId: number, reason: string, actorUserId: number) {
  return prisma.$transaction(async db => {
    await requireOwner(actorUserId, db);
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`;
    await db.$executeRaw`UPDATE "ExternalSignalExecutionRolloutState" SET version=version WHERE id=1`;
    const existing = await db.externalSignalEntryExecutionAuthorization.findFirst({ where: { id: authorizationId, tradingAccountId: accountId, tradingAccountSubscriptionId: assignmentId } });
    if (!existing) throw new HttpError(404, 'Execution authorization not found.');
    await db.$queryRaw`SELECT id FROM "ExternalSignalSource" WHERE id=${existing.signalSourceId} FOR UPDATE`;
    await db.$queryRaw`SELECT id FROM "StrategySignalBinding" WHERE id=${existing.strategySignalBindingId} FOR UPDATE`;
    await db.$queryRaw`SELECT id FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=${authorizationId} FOR UPDATE`;
    if (existing.status !== 'AUTHORIZED') throw conflict('AUTHORIZATION_NOT_EFFECTIVE', 'Only an effective authorization may be revoked.');
    const row = await db.externalSignalEntryExecutionAuthorization.update({ where: { id: authorizationId }, data: { status: 'REVOKED', revokedByUserId: actorUserId, revocationReason: reason } });
    await createSystemEvent({ type: 'EXTERNAL_SIGNAL_ENTRY_EXECUTION_REVOKED', entityType: 'ExternalSignalEntryExecutionAuthorization', entityId: row.id, tradingAccountId: accountId, actorUserId, message: 'TradingView PAPER ENTRY assignment execution authority revoked.', payloadJson: { assignmentId, authorizationId, futureAdmission: 'BLOCKED', uncommittedDispatch: 'BLOCKED' } }, db);
    return row;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(error => {
    if (error instanceof HttpError) throw error;
    if (isConcurrencyError(error)) throw conflict('CONCURRENT_AUTHORITY_CHANGE', 'Execution authority changed concurrently; reload before retrying.');
    throw error;
  });
}
