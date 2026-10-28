import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { routeSignalInTransaction } from './signal-routing.service.js';
import { evaluateNewSignalRoute } from './signal-evaluation.service.js';

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;
type Db = typeof prisma;

function reservationKey(cycleId: number, accountId: number, routeId: number) {
  return `external-shadow:${createHash('sha256').update(`${cycleId}:${accountId}:${routeId}`).digest('hex')}`;
}

async function claimWork(db: Db, workerId: string) {
  const rows = await db.$queryRaw<Array<{ id: number; signalId: number; attemptCount: number }>>`
    WITH candidate AS (
      SELECT id FROM "ExternalSignalCorrelationWork"
      WHERE ((status IN ('PENDING','RETRY_WAIT') AND "nextAttemptAt" <= statement_timestamp())
        OR (status = 'CLAIMED' AND "leaseExpiresAt" <= statement_timestamp()))
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "ExternalSignalCorrelationWork" w SET status='CLAIMED',
      "attemptCount"=w."attemptCount"+1, "leaseOwner"=${workerId},
      "leaseExpiresAt"=statement_timestamp()+interval '60 seconds', "updatedAt"=statement_timestamp()
    FROM candidate WHERE w.id=candidate.id
    RETURNING w.id, w."signalId", w."attemptCount"`;
  return rows[0] ?? null;
}

async function insertDecision(tx: Prisma.TransactionClient, data: Prisma.ExternalSignalCorrelationDecisionCreateManyInput) {
  await tx.externalSignalCorrelationDecision.createMany({ data: [data], skipDuplicates: true });
}

async function correlateClaim(tx: Prisma.TransactionClient, signalId: number) {
  const signal = await tx.signal.findUnique({ where: { id: signalId }, include: { strategySignalRevision: true } });
  if (!signal || signal.schemaVersion !== 2 || !signal.externalSignalTradeCycleId) throw new Error('INVALID_CORRELATION_SIGNAL');

  // Global lock order: source -> binding -> source-cycle -> account-cycle.
  await tx.$queryRaw`SELECT id FROM "ExternalSignalSource" WHERE id=${signal.signalSourceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "StrategySignalBinding" WHERE id=${signal.strategySignalBindingId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycle" WHERE id=${signal.externalSignalTradeCycleId} FOR UPDATE`;
  const cycle = await tx.externalSignalTradeCycle.findUniqueOrThrow({ where: { id: signal.externalSignalTradeCycleId } });
  const terminal = ['TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED', 'CONFLICT'].includes(cycle.status);
  if (terminal) return;

  if (signal.event === 'EXIT_LONG') {
    const accountCycles = await tx.externalSignalTradeCycleAccount.findMany({
      where: { externalSignalTradeCycleId: cycle.id }, orderBy: { id: 'asc' },
    });
    if (accountCycles.length === 0) {
      await insertDecision(tx, { externalSignalTradeCycleId: cycle.id, signalId, decisionType: 'EXIT_PENDING',
        authorityMode: 'SHADOW', reasonCode: 'EXIT_ACCEPTED_AWAITING_ENTRY', evidenceJson: { schemaVersion: 1, accountRoutesDeferred: true } });
      return;
    }
    for (const account of accountCycles) {
      await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycleAccount" WHERE id=${account.id} FOR UPDATE`;
      if (['TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED'].includes(account.status)) continue;
      if (account.status !== 'EXIT_PENDING') {
        await tx.externalSignalTradeCycleAccount.update({ where: { id: account.id }, data: {
          status: 'EXIT_PENDING', pendingExitAcceptedAt: signal.createdAt,
        } });
      }
      await insertDecision(tx, { externalSignalTradeCycleId: cycle.id, accountCycleId: account.id, signalId,
        decisionType: 'EXIT_PENDING', authorityMode: 'SHADOW', reservationKey: account.entryReservationKey,
        reasonCode: account.entryReservationKey ? 'EXIT_HELD_BEHIND_ADMISSION_RESERVATION' : 'EXIT_ACCEPTED_SHADOW_ONLY',
        evidenceJson: { schemaVersion: 1, orderIntentAbsenceIsNotProof: true } });
    }
    return;
  }

  const routing = await routeSignalInTransaction(signal.id, tx);
  for (const route of routing.routes) await evaluateNewSignalRoute(route.id, tx);
  const pendingExit = await tx.signal.findFirst({ where: { externalSignalTradeCycleId: cycle.id, event: 'EXIT_LONG' }, orderBy: { id: 'asc' } });
  const rollout = await tx.externalSignalExecutionRolloutGeneration.findFirst({ where: {
    direction: 'ENTRY', enabled: true, authorityMode: 'SHADOW', effectiveAt: { lte: new Date() },
  }, orderBy: [{ generation: 'desc' }, { id: 'desc' }] });

  for (const route of routing.routes) {
    const key = reservationKey(cycle.id, route.tradingAccountId, route.id);
    const status = pendingExit ? 'TERMINAL_NO_EXPOSURE' : rollout ? 'ENTRY_ADMISSION_PENDING' : 'BLOCKED';
    const account = await tx.externalSignalTradeCycleAccount.upsert({
      where: { externalSignalTradeCycleId_tradingAccountId: { externalSignalTradeCycleId: cycle.id, tradingAccountId: route.tradingAccountId } },
      create: {
        externalSignalTradeCycleId: cycle.id, entrySignalRouteId: route.id, tradingAccountId: route.tradingAccountId,
        tradingAccountSubscriptionId: route.tradingAccountSubscriptionId, subscriptionId: route.subscriptionId,
        securityId: signal.securityId, entryRolloutGenerationId: rollout?.id ?? null,
        status, entryReservationKey: key, entryReservationCreatedAt: new Date(),
        ...(pendingExit ? { pendingExitAcceptedAt: pendingExit.createdAt, terminalAt: new Date(),
          terminalReasonCode: 'ENTRY_PREEMPTED_BY_ACCEPTED_EXIT', noExposureProof: 'ENTRY_SUPPRESSED_BEFORE_ADMISSION' as const } : {}),
      },
      update: {},
    });
    await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycleAccount" WHERE id=${account.id} FOR UPDATE`;
    await insertDecision(tx, { externalSignalTradeCycleId: cycle.id, accountCycleId: account.id, signalId,
      decisionType: 'ENTRY_RESERVATION', authorityMode: 'SHADOW', rolloutGenerationId: rollout?.id ?? null,
      reservationKey: key, reasonCode: 'DETERMINISTIC_SHADOW_RESERVATION', evidenceJson: { schemaVersion: 1, callsEntryAdmission: false } });
    await insertDecision(tx, { externalSignalTradeCycleId: cycle.id, accountCycleId: account.id, signalId,
      decisionType: pendingExit ? 'ENTRY_SUPPRESSED' : rollout ? 'ENTRY_SHADOW_AUTHORITY' : 'CYCLE_BLOCKED',
      authorityMode: 'SHADOW', rolloutGenerationId: rollout?.id ?? null, reservationKey: key,
      reasonCode: pendingExit ? 'PENDING_EXIT_PREEMPTED_ENTRY' : rollout ? 'SHADOW_ROLLOUT_ONLY' : 'NO_ENTRY_SHADOW_ROLLOUT',
      evidenceJson: { schemaVersion: 1, executable: false, orderIntentCreated: false } });
  }
  if (pendingExit) {
    await tx.externalSignalTradeCycle.update({ where: { id: cycle.id }, data: { status: 'TERMINAL_NO_EXPOSURE',
      terminalAt: new Date(), terminalReasonCode: 'ENTRY_PREEMPTED_BY_ACCEPTED_EXIT' } });
  } else if (cycle.status === 'ENTRY_RECEIVED') {
    await tx.externalSignalTradeCycle.update({ where: { id: cycle.id }, data: { status: 'ROUTED' } });
  }
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2028'].includes(error.code);
}

export async function processExternalSignalCorrelationWork(options: { limit?: number; workerId?: string; db?: Db } = {}) {
  const db = options.db ?? prisma;
  const workerId = options.workerId ?? randomUUID();
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  let claimed = 0, completed = 0, retrying = 0, failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const claim = await claimWork(db, workerId);
    if (!claim) break;
    claimed += 1;
    try {
      await db.$transaction(async tx => {
        await correlateClaim(tx, claim.signalId);
        await tx.externalSignalCorrelationWork.updateMany({ where: { id: claim.id, status: 'CLAIMED', leaseOwner: workerId }, data: {
          status: 'COMPLETED', leaseOwner: null, leaseExpiresAt: null, completedAt: new Date(), lastErrorCode: null,
        } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      completed += 1;
    } catch (error) {
      const terminal = claim.attemptCount >= MAX_ATTEMPTS && !retryable(error);
      await db.externalSignalCorrelationWork.updateMany({ where: { id: claim.id, status: 'CLAIMED', leaseOwner: workerId }, data: {
        status: terminal ? 'FAILED' : 'RETRY_WAIT', leaseOwner: null, leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + Math.min(claim.attemptCount * 1_000, 30_000)),
        lastErrorCode: error instanceof Error ? error.message.slice(0, 200) : 'UNKNOWN_CORRELATION_ERROR',
      } });
      if (terminal) failed += 1; else retrying += 1;
    }
  }
  return { claimed, completed, retrying, failed };
}
