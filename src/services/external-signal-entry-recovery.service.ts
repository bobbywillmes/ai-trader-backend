import { type Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { DELIVERY_EVIDENCE_EVENT_TYPES, summarizeDeliveryEvidence } from './entry-delivery-evidence.service.js';

type Db = PrismaClient;
const PROOF = 'INTENT_DEFINITELY_NOT_SENT_AND_CLAIM_RELEASED' as const;
const TERMINAL_REASON = 'INTENT_DEFINITELY_NOT_SENT_AND_CLAIM_RELEASED';

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function observeConflict(db: Db, row: { id: number; tradingAccountId: number; entryOrderIntentId: number | null }, blockers: string[]) {
  const activeKey = `TRADINGVIEW_ENTRY_ADMISSION_RECOVERY:${row.id}`;
  await db.operationalAttention.upsert({
    where: { activeKey },
    create: {
      tradingAccountId: row.tradingAccountId, orderIntentId: row.entryOrderIntentId,
      code: 'TRADINGVIEW_ENTRY_ADMISSION_RECOVERY_REQUIRED', source: 'WORKER', status: 'OPEN', severity: 'WARNING',
      title: 'TradingView entry admission needs recovery',
      message: 'A TradingView account cycle cannot be terminalized from the available claim and delivery evidence.',
      detailsJson: json({ accountCycleId: row.id, orderIntentId: row.entryOrderIntentId, blockers, quarantinedFromBrokerDispatch: true }),
      fingerprint: activeKey, activeKey, materialFingerprint: blockers.sort().join('|'), resolutionPolicy: 'AUTHORITATIVE_ONLY',
    },
    update: {
      occurrenceCount: { increment: 1 }, lastObservedAt: new Date(),
      detailsJson: json({ accountCycleId: row.id, orderIntentId: row.entryOrderIntentId, blockers, quarantinedFromBrokerDispatch: true }),
      materialFingerprint: blockers.sort().join('|'),
    },
  });
}

/**
 * Finishes the TradingView lifecycle only after the shared claim-release path has durably proved a
 * definite non-send. It is deliberately separate from claim release so a crash between the two is
 * harmless: the next account recovery tick replays this idempotent reconciliation.
 */
export async function reconcileReleasedTradingViewAdmissionCyclesForAccount(
  tradingAccountId: number,
  options: { db?: Db; limit?: number } = {},
) {
  const db = options.db ?? prisma;
  const candidates = await db.externalSignalTradeCycleAccount.findMany({
    where: { tradingAccountId, status: 'ENTRY_INTENT_CREATED', entryOrderIntent: { is: { status: { in: ['blocked', 'failed'] } } } },
    select: { id: true, externalSignalTradeCycleId: true, tradingAccountId: true, entryOrderIntentId: true },
    orderBy: { id: 'asc' }, take: Math.min(Math.max(options.limit ?? 10, 1), 50),
  });
  let terminalized = 0, retained = 0;
  const conflicted: Array<{ accountCycleId: number; blockers: string[] }> = [];

  for (const candidate of candidates) {
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycle" WHERE id=${candidate.externalSignalTradeCycleId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "ExternalSignalTradeCycleAccount" WHERE id=${candidate.id} FOR UPDATE`;
      const account = await tx.externalSignalTradeCycleAccount.findUnique({
        where: { id: candidate.id },
        include: {
          entryExecutionObligation: true,
          entryOrderIntent: { include: { entryExposureClaim: { include: { events: { orderBy: { id: 'asc' } } } } } },
        },
      });
      if (!account || account.status !== 'ENTRY_INTENT_CREATED') return { kind: 'GONE' as const };
      const intent = account.entryOrderIntent;
      const obligation = account.entryExecutionObligation;
      const claim = intent?.entryExposureClaim;
      const events = claim?.events ?? [];
      const delivery = summarizeDeliveryEvidence(events.filter(event =>
        (DELIVERY_EVIDENCE_EVENT_TYPES as readonly string[]).includes(event.eventType)));
      const releaseEvent = events.find(event => event.eventType === 'RELEASED_NO_BROKER_EXPOSURE');
      const releaseEvidence = releaseEvent?.evidenceJson && typeof releaseEvent.evidenceJson === 'object' && !Array.isArray(releaseEvent.evidenceJson)
        ? releaseEvent.evidenceJson as Record<string, unknown> : null;
      const notSent = events.some(event => event.eventType === 'NOT_SENT_EVIDENCE_RECORDED')
        || ['CLAIM_NEVER_REACHED_BROKER_BOUNDARY', 'RECORDED_NOT_SENT_EVIDENCE'].includes(String(releaseEvidence?.notSentBasis ?? ''));
      const released = Boolean(releaseEvent);
      const [dispatchConsumptions, unenforcedDispatches, dispatchEvents, liveArmingConsumptions, brokerOrders, brokerActivities] = intent ? await Promise.all([
        tx.marketPolicyBrokerDispatchConsumption.count({ where: { orderIntentId: intent.id } }),
        tx.marketPolicyBrokerUnenforcedDispatch.count({ where: { orderIntentId: intent.id } }),
        tx.orderIntentBrokerOpportunityEvent.count({ where: { orderIntentId: intent.id, eventType: { in: ['ADAPTER_DISPATCH_REACHED', 'BROKER_RESPONSE_CONFIRMED', 'BROKER_REJECTED', 'DELIVERY_UNCERTAIN'] } } }),
        tx.liveEntryArmingTermination.count({ where: { orderIntentId: intent.id, type: 'CONSUMED' } }),
        tx.brokerOrder.count({ where: { orderIntentId: intent.id } }),
        tx.brokerActivity.count({ where: { orderIntentId: intent.id } }),
      ]) : [0, 0, 0, 0, 0, 0];
      const blockers = [
        ...(!intent ? ['INTENT_MISSING'] : []),
        ...(intent && !['blocked', 'failed'].includes(intent.status) ? ['INTENT_NOT_TERMINAL_PRE_DISPATCH'] : []),
        ...(intent && intent.externalSignalAccountCycleId !== account.id ? ['INTENT_ORIGIN_MISMATCH'] : []),
        ...(!obligation ? ['EXECUTION_OBLIGATION_MISSING'] : []),
        ...(obligation && intent && (obligation.orderIntentId !== intent.id || obligation.accountCycleId !== account.id || obligation.sourceCycleId !== account.externalSignalTradeCycleId || obligation.entrySignalRouteId !== account.entrySignalRouteId) ? ['EXECUTION_OBLIGATION_IDENTITY_MISMATCH'] : []),
        ...(!claim ? ['CLAIM_MISSING'] : []),
        ...(claim && (claim.orderIntentId !== intent?.id || claim.tradingAccountId !== account.tradingAccountId || claim.securityId !== account.securityId) ? ['CLAIM_IDENTITY_MISMATCH'] : []),
        ...(claim && (claim.status !== 'RELEASED' || !claim.releasedAt) ? ['CLAIM_NOT_RELEASED'] : []),
        ...(claim?.trackedPositionId != null ? ['POSITION_ATTACHED'] : []),
        ...(!notSent ? ['DEFINITE_NOT_SENT_EVIDENCE_MISSING'] : []),
        ...(!released ? ['CLAIM_RELEASE_EVIDENCE_MISSING'] : []),
        ...(delivery.adapterMarkers > 0 ? ['ADAPTER_INVOCATION_EVIDENCE_PRESENT'] : []),
        ...(delivery.dispatchOutcomes.length > 0 || delivery.ambiguous.length > 0 ? ['DISPATCH_OUTCOME_EVIDENCE_PRESENT'] : []),
        ...(dispatchConsumptions + unenforcedDispatches + dispatchEvents + liveArmingConsumptions > 0 ? ['DISPATCH_RECORD_PRESENT'] : []),
        ...(brokerOrders > 0 ? ['BROKER_ORDER_PRESENT'] : []),
        ...(brokerActivities > 0 ? ['BROKER_ACTIVITY_PRESENT'] : []),
      ];
      if (blockers.length) return { kind: 'CONFLICT' as const, blockers };

      await tx.externalSignalTradeCycleAccount.update({ where: { id: account.id }, data: {
        status: 'TERMINAL_NO_EXPOSURE', terminalAt: new Date(), terminalReasonCode: TERMINAL_REASON, noExposureProof: PROOF,
      } });
      const remaining = await tx.externalSignalTradeCycleAccount.count({
        where: { externalSignalTradeCycleId: account.externalSignalTradeCycleId, status: { not: 'TERMINAL_NO_EXPOSURE' } },
      });
      if (remaining === 0) await tx.externalSignalTradeCycle.updateMany({
        where: { id: account.externalSignalTradeCycleId, status: { in: ['ENTRY_RECEIVED', 'ROUTED', 'ACTIVE'] } },
        data: { status: 'TERMINAL_NO_EXPOSURE', terminalAt: new Date(), terminalReasonCode: 'ALL_ACCOUNT_ENTRIES_DEFINITELY_NOT_SENT' },
      });
      return { kind: 'TERMINALIZED' as const };
    });
    if (result.kind === 'TERMINALIZED') terminalized += 1;
    else if (result.kind === 'CONFLICT') {
      retained += 1;
      conflicted.push({ accountCycleId: candidate.id, blockers: result.blockers });
      await observeConflict(db, candidate, result.blockers);
    }
  }
  return { examined: candidates.length, terminalized, retained, conflicted };
}
