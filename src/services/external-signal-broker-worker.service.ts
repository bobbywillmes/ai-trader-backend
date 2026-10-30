import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';
import { evaluateOrderRisk, logRiskGateBlockedOrder } from './risk-gate.service.js';
import { getSizingEstimatedNotional } from './trading-account-entry-risk-usage.service.js';
import { recordOrderIntentRiskEvaluation } from './order-audit.service.js';
import { resolveSubscriptionOrderInput } from './subscription.service.js';
import { appendNotSentEvidence, ADAPTER_MARKER_PROTOCOL } from './entry-delivery-evidence.service.js';
import { releaseUnsubmittedOrRouteToRecovery } from './entry-dispatch-recovery.service.js';

type Db = PrismaClient;
const C2_REFUSAL = 'TRADINGVIEW_C2_BROKER_DISPATCH_UNAVAILABLE';
export type TradingViewC2WorkerResult = { outcome: 'NOT_CLAIMED' } | { outcome: 'RISK_DENIED'; reason: string } | { outcome: 'C2_DISPATCH_REFUSED' };

/** Explicit C2-only path. No scheduler calls it and every allowed candidate is refused before dispatch. */
export async function processTradingViewOrderIntentForC2(orderIntentId: number, options: { db?: Db } = {}): Promise<TradingViewC2WorkerResult> {
  const db = options.db ?? prisma;
  const candidate = await db.orderIntent.findUnique({ where: { id: orderIntentId }, include: { externalSignalOriginAccountCycle: { include: { entryExecutionObligation: true } } } });
  if (!candidate || candidate.status !== 'pending' || candidate.externalSignalAccountCycleId == null) return { outcome: 'NOT_CLAIMED' };
  const obligation = candidate.externalSignalOriginAccountCycle?.entryExecutionObligation;
  if (!obligation || !candidate.clientOrderId) return { outcome: 'NOT_CLAIMED' };
  const claimed = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`;
    const dispatch = await tx.externalSignalBrokerDispatchState.findUnique({ where: { id: 1 } });
    if (!dispatch?.activeRolloutGenerationId || dispatch.activatedAt == null) return null;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${candidate.tradingAccountId}:${candidate.externalSignalOriginAccountCycle!.securityId}`}, 0))::text`;
    const workerClaim = await tx.externalSignalBrokerWorkerClaim.create({ data: { orderIntentId: candidate.id, executionObligationId: obligation.id, accountCycleId: candidate.externalSignalAccountCycleId!, rolloutGenerationId: obligation.rolloutGenerationId, dispatchStateVersion: dispatch.version, clientOrderId: candidate.clientOrderId!, claimFingerprint: '0'.repeat(64) } });
    const exposure = await tx.entryExposureClaim.updateMany({ where: { orderIntentId: candidate.id, status: 'ENTRY_PENDING', releasedAt: null }, data: { status: 'ENTRY_SUBMITTING' } });
    if (exposure.count !== 1) throw new Error('TRADINGVIEW_EXPOSURE_CLAIM_LOST');
    const claim = await tx.entryExposureClaim.findUniqueOrThrow({ where: { orderIntentId: candidate.id } });
    await tx.entryExposureClaimEvent.create({ data: { claimId: claim.id, eventType: 'WORKER_CLAIMED_FOR_SUBMISSION', evidenceJson: { markerProtocol: ADAPTER_MARKER_PROTOCOL, workerClaimId: workerClaim.id, executionMode: 'TRADINGVIEW_C2_NON_EXECUTABLE' } } });
    const intent = await tx.orderIntent.updateMany({ where: { id: candidate.id, status: 'pending' }, data: { status: 'submitting' } });
    if (intent.count !== 1) throw new Error('TRADINGVIEW_WORKER_CLAIM_LOST');
    return { claim };
  }, { isolationLevel: 'Serializable' }).catch(error => {
    if (error instanceof Error && /unique constraint|Unique constraint|P2002/.test(error.message)) return null;
    throw error;
  });
  if (!claimed) return { outcome: 'NOT_CLAIMED' };
  const rawInput = placeOrderSchema.parse(candidate.rawRequestJson);
  const assignment = await resolveSubscriptionOrderInput(rawInput);
  if (candidate.tradingAccountId == null || candidate.tradingAccountSubscriptionId == null || assignment.tradingAccountId !== candidate.tradingAccountId || assignment.tradingAccountSubscriptionId !== candidate.tradingAccountSubscriptionId || candidate.side.toLowerCase() !== 'buy' || rawInput.signalType === 'exit') return refuseAndRelease(db, candidate.id, claimed.claim.id, 'TRADINGVIEW_FROZEN_ASSIGNMENT_CONFLICT');
  const resolved = { ...rawInput, symbol: candidate.symbol, side: 'buy' as const, orderType: candidate.orderType as 'market' | 'limit', timeInForce: candidate.timeInForce as 'day' | 'gtc', tradingAccountId: candidate.tradingAccountId, tradingAccountSubscriptionId: candidate.tradingAccountSubscriptionId, clientOrderId: candidate.clientOrderId, ...(candidate.subscriptionId != null ? { subscriptionId: candidate.subscriptionId } : {}) };
  const requestedNotionalOverride = getSizingEstimatedNotional(candidate.rawRequestJson);
  const risk = await evaluateOrderRisk(resolved, { tradingAccountId: candidate.tradingAccountId, excludeOrderIntentId: candidate.id, ...(requestedNotionalOverride !== null ? { requestedNotionalOverride } : {}) });
  await recordOrderIntentRiskEvaluation({ orderIntentId: candidate.id, allowed: risk.allowed, reason: risk.allowed ? null : risk.reason, details: risk.details });
  if (!risk.allowed) {
    await logRiskGateBlockedOrder({ orderIntentId: candidate.id, tradingAccountId: candidate.tradingAccountId, input: resolved, result: risk });
    await refuseAndRelease(db, candidate.id, claimed.claim.id, risk.reason);
    return { outcome: 'RISK_DENIED', reason: risk.reason };
  }
  await refuseAndRelease(db, candidate.id, claimed.claim.id, C2_REFUSAL);
  return { outcome: 'C2_DISPATCH_REFUSED' };
}

async function refuseAndRelease(db: Db, orderIntentId: number, claimId: number, reason: string): Promise<{ outcome: 'C2_DISPATCH_REFUSED' }> {
  await db.$transaction(async tx => {
    await appendNotSentEvidence(tx, { claimId, orderIntentId, classification: 'NOT_SENT_PRE_DISPATCH', producer: 'WORKER_RISK_RECHECK', source: 'WORKER', reason, message: reason });
    const changed = await tx.orderIntent.updateMany({ where: { id: orderIntentId, status: 'submitting' }, data: { status: 'blocked', blockReason: reason } });
    if (changed.count !== 1) throw new Error('TRADINGVIEW_C2_REFUSAL_LOST');
  });
  await releaseUnsubmittedOrRouteToRecovery({ orderIntentId, reason, source: 'WORKER', dispatchAttempted: false });
  return { outcome: 'C2_DISPATCH_REFUSED' };
}
