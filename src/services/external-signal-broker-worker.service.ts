import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';
import { evaluateOrderRisk, logRiskGateBlockedOrder } from './risk-gate.service.js';
import { getSizingEstimatedNotional } from './trading-account-entry-risk-usage.service.js';
import { recordOrderIntentRiskEvaluation } from './order-audit.service.js';
import { appendNotSentEvidence, ADAPTER_MARKER_PROTOCOL, type NotSentProducer } from './entry-delivery-evidence.service.js';
import { releaseUnsubmittedOrRouteToRecovery } from './entry-dispatch-recovery.service.js';

type Db = PrismaClient;
const C2_REFUSAL = 'TRADINGVIEW_C2_BROKER_DISPATCH_UNAVAILABLE';
const C2_MAX_SIGNAL_AGE_MS = 120_000;
const SERIALIZATION_RETRIES = 2;
export type TradingViewC2WorkerResult = { outcome: 'NOT_CLAIMED' } | { outcome: 'RISK_DENIED'; reason: string } | { outcome: 'C2_DISPATCH_REFUSED' };
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Explicit C2-only path. No scheduler calls it and every allowed candidate is refused before dispatch. */
export async function processTradingViewOrderIntentForC2(orderIntentId: number, options: { db?: Db } = {}): Promise<TradingViewC2WorkerResult> {
  const db = options.db ?? prisma;
  const candidate = await db.orderIntent.findUnique({ where: { id: orderIntentId }, include: {
    externalSignalOriginAccountCycle: { include: {
      entryExecutionObligation: { include: { entrySignal: { select: { createdAt: true } } } },
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
    await terminalizeUnclaimedRefusal(db, candidate.id, 'TRADINGVIEW_C2_PRECLAIM_READINESS_REFUSED');
    return { outcome: 'C2_DISPATCH_REFUSED' };
  }
  if (Date.now() - obligation.entrySignal.createdAt.getTime() > C2_MAX_SIGNAL_AGE_MS) {
    await terminalizeUnclaimedRefusal(db, candidate.id, 'TRADINGVIEW_ENTRY_SIGNAL_EXPIRED');
    return { outcome: 'C2_DISPATCH_REFUSED' };
  }

  let claimed: { claim: { id: number } } | null = null;
  for (let attempt = 0; attempt <= SERIALIZATION_RETRIES; attempt += 1) {
    try {
      claimed = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`;
        const dispatch = await tx.externalSignalBrokerDispatchState.findUnique({ where: { id: 1 } });
        if (!dispatch?.activeRolloutGenerationId || dispatch.activatedAt == null) return null;
        const workerClaim = await tx.externalSignalBrokerWorkerClaim.create({ data: {
          orderIntentId: candidate.id, executionObligationId: obligation.id, accountCycleId: candidate.externalSignalAccountCycleId!,
          rolloutGenerationId: obligation.rolloutGenerationId, dispatchStateVersion: dispatch.version,
          clientOrderId: candidate.clientOrderId!, claimFingerprint: '0'.repeat(64),
        } });
        // The claim trigger locks mutable identities first. This shared advisory lock therefore
        // follows ordinary Market Intelligence admission's identity-before-exposure order.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${candidate.tradingAccountId}:${cycle.securityId}`}, 0))`;
        const exposure = await tx.entryExposureClaim.updateMany({ where: { orderIntentId: candidate.id, status: 'ENTRY_PENDING', releasedAt: null }, data: { status: 'ENTRY_SUBMITTING' } });
        if (exposure.count !== 1) throw new Error('TRADINGVIEW_EXPOSURE_CLAIM_LOST');
        const claim = await tx.entryExposureClaim.findUniqueOrThrow({ where: { orderIntentId: candidate.id } });
        await tx.entryExposureClaimEvent.create({ data: { claimId: claim.id, eventType: 'WORKER_CLAIMED_FOR_SUBMISSION', evidenceJson: { markerProtocol: ADAPTER_MARKER_PROTOCOL, workerClaimId: workerClaim.id, executionMode: 'TRADINGVIEW_C2_NON_EXECUTABLE' } } });
        const intent = await tx.orderIntent.updateMany({ where: { id: candidate.id, status: 'pending' }, data: { status: 'submitting' } });
        if (intent.count !== 1) throw new Error('TRADINGVIEW_WORKER_CLAIM_LOST');
        return { claim: { id: claim.id } };
      }, { isolationLevel: 'Serializable' });
      break;
    } catch (error) {
      if (errorCode(error) === 'P2002') return { outcome: 'NOT_CLAIMED' };
      if (errorCode(error) === 'P2034' && attempt < SERIALIZATION_RETRIES) continue;
      if (errorCode(error) === 'P2034') {
        const winner = await db.externalSignalBrokerWorkerClaim.findUnique({ where: { orderIntentId } });
        if (winner) return { outcome: 'NOT_CLAIMED' };
      }
      if (await db.externalSignalBrokerWorkerClaim.findUnique({ where: { orderIntentId } }).catch(() => null)) return { outcome: 'NOT_CLAIMED' };
      if (/TradingView worker claim lacks current post-activation authority/.test(errorMessage(error))) {
        await terminalizeUnclaimedRefusal(db, candidate.id, 'TRADINGVIEW_C2_CLAIM_AUTHORITY_REFUSED');
        return { outcome: 'C2_DISPATCH_REFUSED' };
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
      await refuseAndRelease(db, candidate.id, claimed.claim.id, risk.reason, 'TRADINGVIEW_C2_RISK_REFUSAL');
      return { outcome: 'RISK_DENIED', reason: risk.reason };
    }
    await refuseAndRelease(db, candidate.id, claimed.claim.id, C2_REFUSAL, 'TRADINGVIEW_C2_DISPATCH_UNAVAILABLE');
    return { outcome: 'C2_DISPATCH_REFUSED' };
  } catch (error) {
    await refuseAndRelease(db, candidate.id, claimed.claim.id, 'TRADINGVIEW_C2_POST_CLAIM_FAILURE', 'WORKER_PRE_BOUNDARY_FAILURE', errorMessage(error));
    return { outcome: 'C2_DISPATCH_REFUSED' };
  }
}

async function terminalizeUnclaimedRefusal(db: Db, orderIntentId: number, reason: string) {
  const claim = await db.entryExposureClaim.findUnique({ where: { orderIntentId }, select: { id: true } });
  if (!claim) return;
  await db.$transaction(async tx => {
    await appendNotSentEvidence(tx, { claimId: claim.id, orderIntentId, classification: 'NOT_SENT_PRE_DISPATCH', producer: 'TRADINGVIEW_C2_PRECLAIM_REFUSAL', source: 'WORKER', reason, message: reason });
    await tx.orderIntent.updateMany({ where: { id: orderIntentId, status: 'pending', externalSignalBrokerWorkerClaim: null }, data: { status: 'blocked', blockReason: reason } });
  });
  await releaseUnsubmittedOrRouteToRecovery({ orderIntentId, reason, source: 'WORKER', dispatchAttempted: false });
}

async function refuseAndRelease(db: Db, orderIntentId: number, claimId: number, reason: string, producer: NotSentProducer, message = reason) {
  await db.$transaction(async tx => {
    const existing = await tx.entryExposureClaimEvent.findFirst({ where: { claimId, eventType: 'NOT_SENT_EVIDENCE_RECORDED' }, select: { id: true } });
    if (!existing) await appendNotSentEvidence(tx, { claimId, orderIntentId, classification: 'NOT_SENT_PRE_DISPATCH', producer, source: 'WORKER', reason, message });
    const changed = await tx.orderIntent.updateMany({ where: { id: orderIntentId, status: 'submitting' }, data: { status: 'blocked', blockReason: reason } });
    if (changed.count !== 1) {
      const current = await tx.orderIntent.findUnique({ where: { id: orderIntentId }, select: { status: true } });
      if (!current || !['blocked', 'failed'].includes(current.status)) throw new Error('TRADINGVIEW_C2_REFUSAL_LOST');
    }
  });
  await releaseUnsubmittedOrRouteToRecovery({ orderIntentId, reason, source: 'WORKER', dispatchAttempted: false });
}

/** Scheduler-facing recovery for a C2 claim that crashed after ownership and before refusal. */
export async function recoverTradingViewC2Claim(orderIntentId: number, options: { db?: Db } = {}) {
  const db = options.db ?? prisma;
  const row = await db.orderIntent.findUnique({ where: { id: orderIntentId }, include: {
    externalSignalBrokerWorkerClaim: true, externalSignalBrokerDispatchConsumption: true,
    entryExposureClaim: { include: { events: true } }, brokerOrders: true, brokerActivities: true,
  } });
  if (!row?.externalSignalBrokerWorkerClaim || row.status !== 'submitting' || !row.entryExposureClaim || row.tradingAccountId == null) return { outcome: 'NOT_APPLICABLE' as const };
  const events = row.entryExposureClaim.events;
  const adapter = events.some(event => event.eventType === 'ADAPTER_INVOCATION_STARTED');
  const dispatchOutcome = events.some(event => event.eventType === 'DISPATCH_OUTCOME_RECORDED');
  const contradictory = Boolean(row.externalSignalBrokerDispatchConsumption || adapter || dispatchOutcome || row.brokerOrders.length || row.brokerActivities.length || row.trackedPositionId);
  if (contradictory) {
    const activeKey = `TRADINGVIEW_C2_WORKER_RECOVERY:${orderIntentId}`;
    await db.operationalAttention.upsert({ where: { activeKey }, create: {
      tradingAccountId: row.tradingAccountId, orderIntentId, code: 'TRADINGVIEW_C2_WORKER_RECOVERY_REQUIRED', source: 'WORKER', status: 'OPEN', severity: 'ERROR',
      title: 'TradingView C2 worker claim needs recovery', message: 'Worker ownership has dispatch or broker evidence that C2 cannot safely classify.',
      detailsJson: { orderIntentId, pairedConsumption: Boolean(row.externalSignalBrokerDispatchConsumption), adapter, dispatchOutcome, brokerOrders: row.brokerOrders.length, brokerActivities: row.brokerActivities.length },
      fingerprint: activeKey, activeKey, materialFingerprint: [adapter, dispatchOutcome, row.brokerOrders.length, row.brokerActivities.length].join('|'), resolutionPolicy: 'AUTHORITATIVE_ONLY',
    }, update: { lastObservedAt: new Date() } });
    return { outcome: 'OPERATIONAL_ATTENTION' as const };
  }
  await refuseAndRelease(db, orderIntentId, row.entryExposureClaim.id, 'TRADINGVIEW_C2_STALE_PRE_DISPATCH_CLAIM', 'TRADINGVIEW_C2_PRE_DISPATCH_RECOVERY');
  return { outcome: 'DEFINITE_NOT_SENT' as const };
}
