import { Prisma, type PrismaClient } from '@prisma/client';
import { DriverAdapterError } from '@prisma/driver-adapter-utils';
import pg from 'pg';
import { prisma } from '../db/prisma.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';
import { evaluateOrderRisk, logRiskGateBlockedOrder } from './risk-gate.service.js';
import { getSizingEstimatedNotional } from './trading-account-entry-risk-usage.service.js';
import { recordOrderIntentRiskEvaluation } from './order-audit.service.js';
import { appendNotSentEvidence, ADAPTER_MARKER_PROTOCOL, type NotSentProducer } from './entry-delivery-evidence.service.js';
import { releaseUnsubmittedOrRouteToRecovery } from './entry-dispatch-recovery.service.js';
import { observeTradingViewDeliveryUncertaintyForIntent } from './external-signal-delivery-attention.service.js';
import { lockRowsInOrder } from './external-signal-lock-order.js';
import {
  insertMarketPolicyDispatchConsumption,
  prepareObligatedBrokerDecision,
  type EntryBrokerDispatchRequest,
  type MarketPolicyDispatchDecision,
} from './market-policy-broker-dispatch.service.js';
import type { MarketPolicyEvaluator } from './market-policy-entry-admission.service.js';

type Db = PrismaClient;
const C2_REFUSAL = 'TRADINGVIEW_C2_BROKER_DISPATCH_UNAVAILABLE';
const SERIALIZATION_RETRIES = 2;
const { DatabaseError } = pg;
export type TradingViewC2WorkerResult = { outcome: 'NOT_CLAIMED' | 'LOST_REFUSAL_RACE' } | { outcome: 'RISK_DENIED'; reason: string } | { outcome: 'C2_DISPATCH_REFUSED' };
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const record = (value: unknown): Record<string, unknown> | null => value != null && typeof value === 'object' ? value as Record<string, unknown> : null;
const RETRYABLE_SQLSTATES: readonly string[] = ['40001', '40P01'];
const sqlStateFromPrismaError = (error: Prisma.PrismaClientKnownRequestError) => {
  const meta = record(error.meta);
  const driver = record(meta?.driverAdapterError);
  const cause = record(driver?.cause);
  // Prisma adapters expose the server SQLSTATE through driverAdapterError.cause.originalCode.
  // P2010 from raw queries may instead expose meta.code. Only exact PostgreSQL codes count;
  // free-form messages are deliberately excluded from authority over retries.
  for (const value of [cause?.originalCode, meta?.code]) {
    if (typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value)) return value;
  }
  return null;
};
/**
 * Whether a failed transaction may be retried in a fresh snapshot. Authenticity comes from class identity
 * (`instanceof`), never from an object's shape, `name`, `code` or message: a constructed lookalike with a
 * matching `code` is refused. Recognized: Prisma P2034, Prisma P2010 wrapping 40001/40P01, a top-level
 * DriverAdapterError whose structured SQLSTATE is 40001/40P01, and a node-postgres DatabaseError.
 * Limitation: `instanceof` holds only while one copy of each class is loaded (the lockfile pins a single
 * @prisma/driver-adapter-utils); a duplicate copy fails closed, i.e. is not retried, and the bounded
 * attempt that raised it surfaces the error rather than looping.
 */
export const retryableConcurrencyFailure = (error: unknown) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') return true;
    return error.code === 'P2010' && RETRYABLE_SQLSTATES.includes(sqlStateFromPrismaError(error) ?? '');
  }
  if (error instanceof DriverAdapterError) {
    const originalCode = record(error.cause)?.originalCode;
    return typeof originalCode === 'string' && RETRYABLE_SQLSTATES.includes(originalCode);
  }
  return error instanceof DatabaseError && RETRYABLE_SQLSTATES.includes(error.code ?? '');
};

/** Explicit C2-only path. No scheduler calls it and every allowed candidate is refused before dispatch. */
export async function processTradingViewOrderIntentForC2(orderIntentId: number, options: { db?: Db; beforeUnclaimedRefusal?: (reason: string) => Promise<void> } = {}): Promise<TradingViewC2WorkerResult> {
  const db = options.db ?? prisma;
  const candidate = await db.orderIntent.findUnique({ where: { id: orderIntentId }, include: {
    externalSignalOriginAccountCycle: { include: {
      entryExecutionObligation: { include: { entrySignal: { select: { id: true } } } },
      accountSubscription: { include: { allocation: true, tradingAccount: { include: { credential: true } }, subscription: { include: { security: true, strategy: true, exitProfile: true } } } },
    } },
  } });
  if (!candidate || candidate.status !== 'pending' || candidate.externalSignalAccountCycleId == null) return { outcome: 'NOT_CLAIMED' };
  const cycle = candidate.externalSignalOriginAccountCycle;
  const obligation = cycle?.entryExecutionObligation;
  if (!cycle || !obligation || !candidate.clientOrderId || candidate.tradingAccountId == null || candidate.tradingAccountSubscriptionId == null) return { outcome: 'NOT_CLAIMED' };

  const rawInput = placeOrderSchema.parse(candidate.rawRequestJson);
  const assignment = cycle.accountSubscription;
  const prevalidationFailure = assignment.id !== candidate.tradingAccountSubscriptionId || assignment.tradingAccountId !== candidate.tradingAccountId ||
    assignment.subscriptionId !== candidate.subscriptionId || !assignment.enabled || !assignment.entriesEnabled || !assignment.allocation?.enabled ||
    assignment.allocation.tradingAccountId !== assignment.tradingAccountId || assignment.tradingAccount.status !== 'ACTIVE' ||
    !assignment.tradingAccount.tradingEnabled || assignment.tradingAccount.killSwitchEnabled || assignment.tradingAccount.tradingBlocked ||
    assignment.tradingAccount.credential?.status !== 'ACTIVE' || !assignment.subscription.enabled || !assignment.subscription.security.enabled ||
    !assignment.subscription.strategy.enabled || !assignment.subscription.exitProfile.enabled || candidate.side.toLowerCase() !== 'buy' || rawInput.signalType === 'exit';
  if (prevalidationFailure) {
    await options.beforeUnclaimedRefusal?.('TRADINGVIEW_C2_PRECLAIM_READINESS_REFUSED');
    const refused = await terminalizeUnclaimedRefusal(db, candidate.id, 'TRADINGVIEW_C2_PRECLAIM_READINESS_REFUSED');
    return { outcome: refused ? 'C2_DISPATCH_REFUSED' : 'LOST_REFUSAL_RACE' };
  }
  // The 120-second rule is the database receipt clock (Signal.receivedAt against clock_timestamp()); the claim guard enforces the same rule at
  // insert. This early read only gives the legible refusal. A signal without a receipt (historical) is never fresh.
  const [receipt] = await db.$queryRaw<Array<{ open: boolean }>>`SELECT external_signal_signal_receipt_open(${obligation.entrySignal.id}) AS open`;
  if (receipt?.open !== true) {
    await options.beforeUnclaimedRefusal?.('TRADINGVIEW_ENTRY_SIGNAL_EXPIRED');
    const refused = await terminalizeUnclaimedRefusal(db, candidate.id, 'TRADINGVIEW_ENTRY_SIGNAL_EXPIRED');
    return { outcome: refused ? 'C2_DISPATCH_REFUSED' : 'LOST_REFUSAL_RACE' };
  }

  let claimed: { claim: { id: number }; workerClaimId: number } | null = null;
  for (let attempt = 0; attempt <= SERIALIZATION_RETRIES; attempt += 1) {
    try {
      claimed = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`;
        // Canonical order (design section 6.5): one single-table statement per row, each in the mode the claim
        // guard will request, so the guard's own multi-table statement finds every row already held.
        // Rows 2-3: rollout and dispatch state; the dispatch version is read only after its row is locked.
        await lockRowsInOrder(tx, [['rolloutState', 1, 'UPDATE'], ['dispatchState', 1, 'UPDATE']]);
        const dispatch = await tx.externalSignalBrokerDispatchState.findUnique({ where: { id: 1 } });
        if (!dispatch?.activeRolloutGenerationId || dispatch.activatedAt == null) return null;
        // Rows 4-9: source, binding, revision, generation, then the source cycle before its account cycle (H3).
        // Rows 10-15: identity rows FOR SHARE. A pause, kill switch or disablement is a non-key UPDATE and still
        // blocks; Market Intelligence's FOR SHARE requests on the same rows no longer conflict (H1). Row 17: authorization.
        // The ids come from immutable evidence. A row that is missing or stale is refused by the claim guard.
        const [authority] = await tx.$queryRaw<Array<{ source: number; binding: number; revision: number }>>`
          SELECT "signalSourceId" AS source, "strategySignalBindingId" AS binding, "strategySignalRevisionId" AS revision
          FROM "ExternalSignalEntryExecutionAuthorization" WHERE id = ${obligation.authorizationId}`;
        if (authority) {
          await lockRowsInOrder(tx, [
            ['source', authority.source, 'UPDATE'], ['binding', authority.binding, 'UPDATE'], ['revision', authority.revision, 'UPDATE'],
            ['generation', obligation.rolloutGenerationId, 'UPDATE'], ['cycle', obligation.sourceCycleId, 'UPDATE'],
            ['accountCycle', candidate.externalSignalAccountCycleId!, 'UPDATE'],
            ['account', candidate.tradingAccountId!, 'SHARE'], ['assignment', candidate.tradingAccountSubscriptionId!, 'SHARE'],
            ['subscription', cycle.subscriptionId, 'SHARE'], ['security', cycle.securityId, 'SHARE'],
            ['authorization', obligation.authorizationId, 'UPDATE'],
          ]);
        }
        // Row 21: the exposure advisory lock follows every identity row (admission's order) and precedes the intent,
        // matching stale recovery, which takes it before `FOR UPDATE OF i`. Rows 22-23: intent, then its claim.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${candidate.tradingAccountId}:${cycle.securityId}`}, 0))`;
        await lockRowsInOrder(tx, [['intent', candidate.id, 'UPDATE']]);
        await tx.$queryRaw`SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId" = ${candidate.id} FOR UPDATE`;
        const workerClaim = await tx.externalSignalBrokerWorkerClaim.create({ data: {
          orderIntentId: candidate.id, executionObligationId: obligation.id, accountCycleId: candidate.externalSignalAccountCycleId!,
          rolloutGenerationId: obligation.rolloutGenerationId, dispatchStateVersion: dispatch.version,
          clientOrderId: candidate.clientOrderId!, claimFingerprint: '0'.repeat(64),
        } });
        const exposure = await tx.entryExposureClaim.updateMany({ where: { orderIntentId: candidate.id, status: 'ENTRY_PENDING', releasedAt: null }, data: { status: 'ENTRY_SUBMITTING' } });
        if (exposure.count !== 1) throw new Error('TRADINGVIEW_EXPOSURE_CLAIM_LOST');
        const claim = await tx.entryExposureClaim.findUniqueOrThrow({ where: { orderIntentId: candidate.id } });
        await tx.entryExposureClaimEvent.create({ data: { claimId: claim.id, eventType: 'WORKER_CLAIMED_FOR_SUBMISSION', evidenceJson: { markerProtocol: ADAPTER_MARKER_PROTOCOL, workerClaimId: workerClaim.id, executionMode: 'TRADINGVIEW_C2_NON_EXECUTABLE' } } });
        const intent = await tx.orderIntent.updateMany({ where: { id: candidate.id, status: 'pending' }, data: { status: 'submitting' } });
        if (intent.count !== 1) throw new Error('TRADINGVIEW_WORKER_CLAIM_LOST');
        return { claim: { id: claim.id }, workerClaimId: workerClaim.id };
      }, { isolationLevel: 'Serializable' });
      break;
    } catch (error) {
      if (errorCode(error) === 'P2002') return { outcome: 'NOT_CLAIMED' };
      if (retryableConcurrencyFailure(error) && attempt < SERIALIZATION_RETRIES) continue;
      if (retryableConcurrencyFailure(error)) {
        const winner = await db.externalSignalBrokerWorkerClaim.findUnique({ where: { orderIntentId } });
        if (winner) return { outcome: 'NOT_CLAIMED' };
      }
      if (await db.externalSignalBrokerWorkerClaim.findUnique({ where: { orderIntentId } }).catch(() => null)) return { outcome: 'NOT_CLAIMED' };
      if (/TradingView worker claim lacks current post-activation authority/.test(errorMessage(error))) {
        await options.beforeUnclaimedRefusal?.('TRADINGVIEW_C2_CLAIM_AUTHORITY_REFUSED');
        const refused = await terminalizeUnclaimedRefusal(db, candidate.id, 'TRADINGVIEW_C2_CLAIM_AUTHORITY_REFUSED');
        return { outcome: refused ? 'C2_DISPATCH_REFUSED' : 'LOST_REFUSAL_RACE' };
      }
      throw error;
    }
  }
  if (!claimed) return { outcome: 'NOT_CLAIMED' };

  try {
    const resolved = { ...rawInput, symbol: candidate.symbol, side: 'buy' as const, orderType: candidate.orderType as 'market' | 'limit', timeInForce: candidate.timeInForce as 'day' | 'gtc', tradingAccountId: candidate.tradingAccountId, tradingAccountSubscriptionId: candidate.tradingAccountSubscriptionId, clientOrderId: candidate.clientOrderId, ...(candidate.subscriptionId != null ? { subscriptionId: candidate.subscriptionId } : {}) };
    const requestedNotionalOverride = getSizingEstimatedNotional(candidate.rawRequestJson);
    const risk = await evaluateOrderRisk(resolved, { tradingAccountId: candidate.tradingAccountId, excludeOrderIntentId: candidate.id, ...(requestedNotionalOverride !== null ? { requestedNotionalOverride } : {}) });
    await recordOrderIntentRiskEvaluation({ orderIntentId: candidate.id, allowed: risk.allowed, reason: risk.allowed ? null : risk.reason, details: risk.details });
    if (!risk.allowed) {
      await logRiskGateBlockedOrder({ orderIntentId: candidate.id, tradingAccountId: candidate.tradingAccountId, input: resolved, result: risk });
      await refuseAndRelease(db, candidate.id, claimed.claim.id, claimed.workerClaimId, risk.reason, 'TRADINGVIEW_C2_RISK_REFUSAL');
      return { outcome: 'RISK_DENIED', reason: risk.reason };
    }
    await refuseAndRelease(db, candidate.id, claimed.claim.id, claimed.workerClaimId, C2_REFUSAL, 'TRADINGVIEW_C2_DISPATCH_UNAVAILABLE');
    return { outcome: 'C2_DISPATCH_REFUSED' };
  } catch (error) {
    await refuseAndRelease(db, candidate.id, claimed.claim.id, claimed.workerClaimId, 'TRADINGVIEW_C2_POST_CLAIM_FAILURE', 'WORKER_PRE_BOUNDARY_FAILURE', errorMessage(error));
    return { outcome: 'C2_DISPATCH_REFUSED' };
  }
}

async function terminalizeUnclaimedRefusal(db: Db, orderIntentId: number, reason: string) {
  for (let attempt = 0; attempt <= SERIALIZATION_RETRIES; attempt += 1) {
    try {
      const terminalized = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`;
        const rows = await tx.$queryRaw<Array<{ claim_id: number }>>`
          SELECT ec.id AS claim_id FROM "OrderIntent" i
          JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=i.id
          WHERE i.id=${orderIntentId} AND i.status='pending'
            AND NOT EXISTS (SELECT 1 FROM "ExternalSignalBrokerWorkerClaim" wc WHERE wc."orderIntentId"=i.id)
            AND ec.status='ENTRY_PENDING' AND ec."releasedAt" IS NULL
          FOR UPDATE OF i,ec`;
        if (rows.length !== 1) return false;
        const changed = await tx.orderIntent.updateMany({
          where: { id: orderIntentId, status: 'pending', externalSignalBrokerWorkerClaim: null },
          data: { status: 'blocked', blockReason: reason },
        });
        if (changed.count !== 1) throw new Error('TRADINGVIEW_C2_REFUSAL_FENCE_LOST');
        await appendNotSentEvidence(tx, { claimId: rows[0]!.claim_id, orderIntentId, classification: 'NOT_SENT_PRE_DISPATCH', producer: 'TRADINGVIEW_C2_PRECLAIM_REFUSAL', source: 'WORKER', reason, message: reason });
        return true;
      }, { isolationLevel: 'Serializable' });
      if (!terminalized) return false;
      await releaseUnsubmittedOrRouteToRecovery({ orderIntentId, reason, source: 'WORKER', dispatchAttempted: false });
      return true;
    } catch (error) {
      if (retryableConcurrencyFailure(error) && attempt < SERIALIZATION_RETRIES) continue;
      throw error;
    }
  }
  return false;
}

async function refuseAndRelease(db: Db, orderIntentId: number, claimId: number, workerClaimId: number, reason: string, producer: NotSentProducer, message = reason) {
  for (let attempt = 0; attempt <= SERIALIZATION_RETRIES; attempt += 1) {
    try {
      await db.$transaction(async tx => {
        // Intent before claim: the worker-claim guard's order, which the evidence fence would otherwise invert.
        await tx.$queryRaw`SELECT id FROM "OrderIntent" WHERE id=${orderIntentId} FOR UPDATE`;
        const existing = await tx.entryExposureClaimEvent.findFirst({ where: { claimId, eventType: 'NOT_SENT_EVIDENCE_RECORDED', evidenceJson: { path: ['workerClaimId'], equals: workerClaimId } }, select: { id: true } });
        if (!existing) await appendNotSentEvidence(tx, { claimId, orderIntentId, classification: 'NOT_SENT_PRE_DISPATCH', producer, source: 'WORKER', reason, message, workerClaimId });
        const changed = await tx.orderIntent.updateMany({ where: { id: orderIntentId, status: 'submitting' }, data: { status: 'blocked', blockReason: reason } });
        if (changed.count !== 1) {
          const current = await tx.orderIntent.findUnique({ where: { id: orderIntentId }, select: { status: true } });
          if (!current || !['blocked', 'failed'].includes(current.status)) throw new Error('TRADINGVIEW_C2_REFUSAL_LOST');
        }
      });
      break;
    } catch (error) {
      if (retryableConcurrencyFailure(error) && attempt < SERIALIZATION_RETRIES) continue;
      throw error;
    }
  }
  await releaseUnsubmittedOrRouteToRecovery({ orderIntentId, reason, source: 'WORKER', dispatchAttempted: false });
}

/** Scheduler-facing recovery for a C2 claim that crashed after ownership and before refusal. */
export async function recoverTradingViewC2Claim(orderIntentId: number, options: { db?: Db } = {}) {
  const db = options.db ?? prisma;
  const row = await db.orderIntent.findUnique({ where: { id: orderIntentId }, include: { externalSignalBrokerWorkerClaim: true, entryExposureClaim: { select: { id: true } } } });
  if (!row?.externalSignalBrokerWorkerClaim || row.status !== 'submitting' || !row.entryExposureClaim || row.tradingAccountId == null) return { outcome: 'NOT_APPLICABLE' as const };
  if (await observeTradingViewDeliveryUncertaintyForIntent(orderIntentId, { db })) return { outcome: 'OPERATIONAL_ATTENTION' as const };
  try {
    await refuseAndRelease(db, orderIntentId, row.entryExposureClaim.id, row.externalSignalBrokerWorkerClaim.id, 'TRADINGVIEW_C2_STALE_PRE_DISPATCH_CLAIM', 'TRADINGVIEW_C2_PRE_DISPATCH_RECOVERY');
  } catch (error) {
    // Evidence that committed after the read above makes the database refuse. That is the same
    // episode, reported once, rather than a failure repeated on every scheduler tick.
    if (await observeTradingViewDeliveryUncertaintyForIntent(orderIntentId, { db })) return { outcome: 'OPERATIONAL_ATTENTION' as const };
    throw error;
  }
  return { outcome: 'DEFINITE_NOT_SENT' as const };
}

export type TradingViewFinalAuthorization = {
  outcome: 'AUTHORIZED' | 'ALREADY_AUTHORIZED';
  orderIntentId: number;
  marketPolicyConsumptionId: number;
  tradingViewConsumptionId: number;
  authorizedAt: Date;
  authorizationDeadlineAt: Date;
  fenceVersion: bigint;
};

/**
 * Attempt-scoped result of one finalizer invocation. It deliberately carries no broker `deliveryClassification`:
 * a failed attempt says nothing about the intent, because another finalizer that completed decision phase D may
 * still commit its pair later. Neither error is release evidence; only C2 not-sent and C3C terminalization
 * (independent database authority) can release exposure.
 */
export type TradingViewFinalizerAttemptOutcome = 'NOT_AUTHORIZED_BY_THIS_ATTEMPT' | 'AMBIGUOUS';

export class TradingViewFinalizationRefusedError extends Error {
  readonly code = 'TRADINGVIEW_FINALIZATION_REFUSED' as const;
  readonly attemptOutcome = 'NOT_AUTHORIZED_BY_THIS_ATTEMPT' as const;
  readonly intentLevelNotSentProof = false as const;
  constructor(readonly reasonCode: string, diagnostic?: string, options?: { cause?: unknown }) {
    super(`${reasonCode}${diagnostic ? `: ${diagnostic}` : ''}`, options);
    this.name = 'TradingViewFinalizationRefusedError';
  }
}

export class TradingViewFinalizationAmbiguousError extends Error {
  readonly code = 'TRADINGVIEW_FINALIZATION_OUTCOME_AMBIGUOUS' as const;
  readonly attemptOutcome = 'AMBIGUOUS' as const;
  readonly intentLevelNotSentProof = false as const;
  constructor(readonly underlying: unknown) {
    super('The paired-finalization outcome is ambiguous until committed consumption can be re-read. Exposure must remain owned.');
    this.name = 'TradingViewFinalizationAmbiguousError';
  }
}

type FinalizerPrecheck = {
  orderIntentId: number;
  tradingAccountId: number;
  symbol: string;
  clientOrderId: string;
  executionObligationId: number;
  marketPolicyObligationId: number;
  workerClaimId: number;
  accountCycleId: number;
  executionAuthorizationId: number;
  rolloutGenerationId: number;
  dispatchStateVersion: number;
  fenceVersion: bigint;
};

async function loadFinalizerPrecheck(db: Db, orderIntentId: number): Promise<FinalizerPrecheck> {
  const rows = await db.$queryRaw<FinalizerPrecheck[]>`
    SELECT i.id AS "orderIntentId", i."tradingAccountId", i.symbol, i."clientOrderId",
      eo.id AS "executionObligationId", mo.id AS "marketPolicyObligationId", wc.id AS "workerClaimId",
      eo."accountCycleId", eo."authorizationId" AS "executionAuthorizationId", eo."rolloutGenerationId",
      wc."dispatchStateVersion", f.version AS "fenceVersion"
    FROM "OrderIntent" i
    JOIN "ExternalSignalEntryExecutionObligation" eo ON eo."orderIntentId"=i.id
    JOIN "OrderIntentMarketPolicyEnforcementObligation" mo ON mo."orderIntentId"=i.id
    JOIN "ExternalSignalBrokerWorkerClaim" wc ON wc."orderIntentId"=i.id
    JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=i.id
    JOIN "ExternalSignalTradeCycleAccount" ac ON ac.id=eo."accountCycleId"
    JOIN "Signal" s ON s.id=eo."entrySignalId"
    JOIN "ExternalSignalDispatchFence" f ON f."orderIntentId"=i.id
    WHERE i.id=${orderIntentId} AND i.status='submitting' AND i.side='buy' AND i.source='tradingview'
      AND ec.status='ENTRY_SUBMITTING' AND ec."releasedAt" IS NULL AND ec."trackedPositionId" IS NULL
      AND ac."pendingExitAcceptedAt" IS NULL AND ac."terminalAt" IS NULL
      AND external_signal_signal_receipt_open(s.id, interval '5 seconds')`;
  const row = rows[0];
  if (!row) throw new TradingViewFinalizationRefusedError('TRADINGVIEW_FINALIZATION_PRECHECK_FAILED');
  return row;
}

async function readCommittedPair(db: Db, orderIntentId: number): Promise<TradingViewFinalAuthorization | null> {
  return db.$transaction(async tx => {
    // This is F's first lock. Taking the same boundary before reading means an F that has
    // started but has not reached the fence cannot later commit behind an authoritative
    // missing-pair conclusion. A timeout/connection failure escapes and is AMBIGUOUS.
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
    await tx.$executeRawUnsafe(`SET LOCAL idle_in_transaction_session_timeout = '10s'`);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`;
    const rows = await tx.$queryRaw<Array<TradingViewFinalAuthorization & { decisionId: number }>>`
      SELECT t.id AS "tradingViewConsumptionId", m.id AS "marketPolicyConsumptionId", m."decisionId",
        t."orderIntentId", t."authorizedAt", t."authorizationDeadlineAt", t."fenceVersion"
      FROM "ExternalSignalBrokerDispatchConsumption" t
      JOIN "MarketPolicyBrokerDispatchConsumption" m ON m.id=t."marketPolicyDispatchConsumptionId"
      WHERE t."orderIntentId"=${orderIntentId}`;
    const pair = rows[0];
    if (!pair) return null;
    await tx.$executeRaw`SELECT external_signal_lock_dispatch_graph(${orderIntentId}, ${pair.decisionId})`;
    const [verified] = await tx.$queryRaw<Array<{ tv: number; mi: number; deadline: Date }>>`
      SELECT t.id AS tv, m.id AS mi, t."authorizationDeadlineAt" AS deadline
      FROM "ExternalSignalBrokerDispatchConsumption" t
      JOIN "MarketPolicyBrokerDispatchConsumption" m ON m.id=t."marketPolicyDispatchConsumptionId"
      WHERE t."orderIntentId"=${orderIntentId} FOR SHARE OF t,m`;
    if (!verified || verified.tv !== pair.tradingViewConsumptionId || verified.mi !== pair.marketPolicyConsumptionId || verified.deadline.getTime() !== pair.authorizationDeadlineAt.getTime()) {
      throw new Error('TRADINGVIEW_COMMITTED_PAIR_CHANGED');
    }
    return { ...pair, outcome: 'ALREADY_AUTHORIZED' as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 7_500, timeout: 12_500 });
}

function finalizationRefusal(error: unknown) {
  let diagnostic = errorMessage(error);
  try { diagnostic += JSON.stringify(error); } catch { /* diagnostic only */ }
  const structured = record(error) && typeof record(error)?.reasonCode === 'string' ? String(record(error)?.reasonCode) : null;
  const state = structuredSqlState(error);
  const stateReason = state === '55P03' ? 'TRADINGVIEW_FINALIZATION_LOCK_TIMEOUT'
    : state === '40001' || state === '40P01' || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') ? 'TRADINGVIEW_FINALIZATION_CONCURRENCY_EXHAUSTED' : null;
  const reason = diagnostic.match(/TRADINGVIEW_[A-Z0-9_]+|BROKER_DISPATCH_[A-Z0-9_]+/)?.[0] ?? structured ?? stateReason ?? 'TRADINGVIEW_FINALIZATION_FAILED';
  return new TradingViewFinalizationRefusedError(reason, diagnostic.slice(0, 300), { cause: error });
}

/** Trusted structured SQLSTATE only (class identity plus adapter/driver fields); never parsed from message text. */
function structuredSqlState(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return sqlStateFromPrismaError(error);
  if (error instanceof DriverAdapterError) {
    const state = record(error.cause)?.originalCode;
    return typeof state === 'string' ? state : null;
  }
  if (error instanceof DatabaseError) return error.code ?? null;
  return null;
}

/**
 * Every exit of the finalizer funnels through here so callers see exactly two failure shapes. Unresolved
 * connection/database uncertainty is AMBIGUOUS; everything else is an attempt-scoped refusal. Neither is
 * intent-level evidence, because this invocation cannot see whether another attempt will still commit.
 */
function normalizeFinalizerFailure(error: unknown) {
  if (error instanceof TradingViewFinalizationRefusedError || error instanceof TradingViewFinalizationAmbiguousError) return error;
  if (potentiallyLostTransactionAcknowledgement(error)) return new TradingViewFinalizationAmbiguousError(error);
  return finalizationRefusal(error);
}

function potentiallyLostTransactionAcknowledgement(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (['P1001', 'P1002', 'P1017'].includes(error.code)) return true;
    const state = sqlStateFromPrismaError(error);
    return state?.startsWith('08') === true || state?.startsWith('57P0') === true;
  }
  if (error instanceof DriverAdapterError) {
    const state = record(error.cause)?.originalCode;
    return typeof state !== 'string' || state.startsWith('08') || state.startsWith('57P0');
  }
  if (error instanceof DatabaseError && (error.code?.startsWith('08') || error.code?.startsWith('57P0'))) return true;
  return /connection (?:terminated|closed|lost)|socket|ECONNRESET|EPIPE/i.test(errorMessage(error));
}

export type TradingViewFinalizerOptions = {
  db?: Db;
  evaluator?: MarketPolicyEvaluator;
  brokerPostOpportunityId?: number | null;
  /** Test seams only. They never perform broker I/O. */
  afterDecision?: (decision: MarketPolicyDispatchDecision) => Promise<void>;
  beforeCommit?: () => Promise<void>;
  afterCommit?: (authorization: TradingViewFinalAuthorization) => Promise<void>;
};

/**
 * Test-only C3B.2 paired final authorization. No scheduler, route, webhook or ordinary worker calls it.
 * A committed result is permission to attempt a future dispatch, never evidence of a broker request.
 */
export async function finalizeTradingViewDispatch(orderIntentId: number, options: TradingViewFinalizerOptions = {}): Promise<TradingViewFinalAuthorization> {
  const db = options.db ?? prisma;
  const brokerPostOpportunityId = options.brokerPostOpportunityId ?? null;
  // A failed idempotency reread cannot establish whether a pair is committed or in flight: AMBIGUOUS.
  const existing = await readCommittedPair(db, orderIntentId).catch(readError => { throw new TradingViewFinalizationAmbiguousError({ initialReadError: readError }); });
  if (existing) return existing;
  const precheck = await loadFinalizerPrecheck(db, orderIntentId).catch(error => { throw normalizeFinalizerFailure(error); });
  const request: EntryBrokerDispatchRequest = {
    orderIntentId, tradingAccountId: precheck.tradingAccountId, symbol: precheck.symbol, clientOrderId: precheck.clientOrderId,
  };

  let decision: MarketPolicyDispatchDecision;
  try {
    decision = await prepareObligatedBrokerDecision(db, request, precheck.marketPolicyObligationId, options.evaluator);
  } catch (error) {
    const durable = await readCommittedPair(db, orderIntentId).catch(readError => { throw new TradingViewFinalizationAmbiguousError({ decisionError: error, readError }); });
    if (durable) return durable;
    // D failing is this attempt's failure only; a pending sibling may still commit. Not intent-level proof.
    throw normalizeFinalizerFailure(error);
  }
  await options.afterDecision?.(decision);
  let lastError: unknown;
  for (let attempt = 0; attempt <= SERIALIZATION_RETRIES; attempt += 1) {
    try {
      const authorization = await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
        await tx.$executeRawUnsafe(`SET LOCAL idle_in_transaction_session_timeout = '15s'`);
        await tx.$executeRaw`SELECT external_signal_lock_dispatch_graph(${orderIntentId}, ${decision.decisionId})`;
        const [fence] = await tx.$queryRaw<Array<{ version: bigint }>>`SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=${orderIntentId} FOR UPDATE`;
        if (!fence) throw new Error('TRADINGVIEW_DISPATCH_FENCE_MISSING');
        const mi = await insertMarketPolicyDispatchConsumption(
          tx,
          decision,
          request,
          brokerPostOpportunityId,
          'PAIRED_TRADINGVIEW_AUTHORIZATION_ONLY; NO_BROKER_REQUEST; C3C_SEND_PERMIT_REQUIRED',
        );
        const inserted = await tx.$queryRaw<Array<Omit<TradingViewFinalAuthorization, 'outcome' | 'marketPolicyConsumptionId' | 'orderIntentId'>>>(Prisma.sql`
          INSERT INTO "ExternalSignalBrokerDispatchConsumption"
            ("orderIntentId","executionObligationId","workerClaimId","marketPolicyDispatchConsumptionId",
             "rolloutGenerationId","executionAuthorizationId","dispatchStateVersion","clientOrderId",
             "brokerPostOpportunityId","fenceVersion","evidenceJson")
          VALUES (${orderIntentId},${precheck.executionObligationId},${precheck.workerClaimId},${mi.id},
             ${precheck.rolloutGenerationId},${precheck.executionAuthorizationId},${precheck.dispatchStateVersion},${precheck.clientOrderId},
             ${brokerPostOpportunityId},${fence.version},${JSON.stringify({ semantics: 'PAIRED_PERMISSION_TO_ATTEMPT_ONLY; NO_BROKER_REQUEST' })}::jsonb)
          RETURNING id AS "tradingViewConsumptionId","authorizedAt","authorizationDeadlineAt","fenceVersion"`);
        const tv = inserted[0];
        if (!tv) throw new Error('TRADINGVIEW_CONSUMPTION_INSERT_MISSING');
        const [pair] = await tx.$queryRaw<Array<{ fence: bigint; mi: number; deadline: Date }>>`
          SELECT f.version AS fence, t."marketPolicyDispatchConsumptionId" AS mi, t."authorizationDeadlineAt" AS deadline
          FROM "ExternalSignalBrokerDispatchConsumption" t
          JOIN "ExternalSignalDispatchFence" f ON f."orderIntentId"=t."orderIntentId"
          WHERE t.id=${tv.tradingViewConsumptionId}`;
        if (!pair || pair.mi !== mi.id || pair.fence !== fence.version + 1n || pair.deadline.getTime() !== tv.authorizationDeadlineAt.getTime()) {
          throw new Error('TRADINGVIEW_PAIRED_AUTHORIZATION_VERIFICATION_FAILED');
        }
        const [deadline] = await tx.$queryRaw<Array<{ open: boolean }>>`
          SELECT "authorizationDeadlineAt" - clock_timestamp() >= interval '2 seconds' AS open
          FROM "ExternalSignalBrokerDispatchConsumption" WHERE id=${tv.tradingViewConsumptionId}`;
        if (deadline?.open !== true) throw new Error('TRADINGVIEW_AUTHORIZATION_DEADLINE_CLOSED');
        await options.beforeCommit?.();
        return { outcome: 'AUTHORIZED' as const, orderIntentId, marketPolicyConsumptionId: mi.id, ...tv };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 20_000 });
      try { await options.afterCommit?.(authorization); } catch (error) {
        const durable = await readCommittedPair(db, orderIntentId);
        if (durable) return durable;
        throw error;
      }
      const durable = await readCommittedPair(db, orderIntentId);
      if (!durable) throw new TradingViewFinalizationAmbiguousError(new Error('TRADINGVIEW_COMMIT_ACKNOWLEDGED_WITHOUT_DURABLE_PAIR'));
      return { ...durable, outcome: 'AUTHORIZED' };
    } catch (error) {
      lastError = error;
      let durable: TradingViewFinalAuthorization | null;
      try { durable = await readCommittedPair(db, orderIntentId); }
      catch (readError) { throw new TradingViewFinalizationAmbiguousError({ transactionError: error, readError }); }
      if (durable) return durable;
      if (!retryableConcurrencyFailure(error) || attempt >= SERIALIZATION_RETRIES) break;
      // A failed SERIALIZABLE transaction is never reused. A new decision keeps D and F freshness bounded.
      const fresh = await loadFinalizerPrecheck(db, orderIntentId).catch(precheckError => { throw normalizeFinalizerFailure(precheckError); });
      try {
        decision = await prepareObligatedBrokerDecision(db, request, fresh.marketPolicyObligationId, options.evaluator);
      } catch (decisionError) {
        let committed: TradingViewFinalAuthorization | null;
        try { committed = await readCommittedPair(db, orderIntentId); }
        catch (readError) { throw new TradingViewFinalizationAmbiguousError({ decisionError, readError }); }
        if (committed) return committed;
        throw normalizeFinalizerFailure(decisionError);
      }
    }
  }
  throw normalizeFinalizerFailure(lastError);
}
