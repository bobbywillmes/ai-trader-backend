import { OperationalAttentionResolutionPolicy, SystemEventSeverity, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { ADAPTER_INVOCATION_STARTED_EVENT, DISPATCH_OUTCOME_EVENT_TYPES } from './entry-delivery-evidence.service.js';
import { OPERATIONAL_ATTENTION_CODES, OPERATIONAL_ATTENTION_SOURCES, openOrObserveOperationalAttention } from './operational-attention.service.js';

// A TradingView-marked claim with possible-delivery or broker evidence keeps its exposure ownership
// until authoritative evidence settles the outcome (Phase 4A.2C3C). C3A only keeps that episode
// visible: one active OperationalAttention per intent, refreshed at most once per retry interval and
// re-evidenced only when the facts change. The absence of a local BrokerOrder or adapter marker never
// resolves it, and no release, broker read or dispatch happens here.

/** Matches ENTRY_DISPATCH_RECOVERY_RETRY_MS, the bound on every other per-claim recovery attempt. */
const ATTENTION_REFRESH_MS = 60_000;
const POSSIBLE_DELIVERY_EVENT_TYPES = [ADAPTER_INVOCATION_STARTED_EVENT, ...DISPATCH_OUTCOME_EVENT_TYPES];

export type TradingViewDeliveryUncertainty = {
  claimId: number; orderIntentId: number; tradingAccountId: number; claimStatus: string; intentStatus: string;
  activeKey: string; materialFingerprint: string; details: Record<string, unknown>;
};

export function tradingViewDeliveryAttentionKey(orderIntentId: number) {
  return `TRADINGVIEW_C2_WORKER_RECOVERY:${orderIntentId}`;
}

/** Unreleased marked claims whose durable evidence means delivery may have started. */
export async function loadTradingViewDeliveryUncertainty(args: { db?: PrismaClient; tradingAccountIds?: number[]; orderIntentId?: number } = {}): Promise<TradingViewDeliveryUncertainty[]> {
  const db = args.db ?? prisma;
  const claims = await db.entryExposureClaim.findMany({
    where: {
      releasedAt: null,
      ...(args.tradingAccountIds ? { tradingAccountId: { in: args.tradingAccountIds } } : {}),
      ...(args.orderIntentId != null ? { orderIntentId: args.orderIntentId } : {}),
      orderIntent: { is: { externalSignalAccountCycleId: { not: null } } },
      OR: [
        { trackedPositionId: { not: null } },
        { events: { some: { eventType: { in: POSSIBLE_DELIVERY_EVENT_TYPES } } } },
        { orderIntent: { is: { OR: [{ externalSignalBrokerDispatchConsumption: { isNot: null } }, { brokerOrders: { some: {} } }, { brokerActivities: { some: {} } }] } } },
      ],
    },
    select: {
      id: true, status: true, tradingAccountId: true, trackedPositionId: true,
      events: { where: { eventType: { in: POSSIBLE_DELIVERY_EVENT_TYPES } }, select: { id: true, eventType: true }, orderBy: { id: 'asc' } },
      orderIntent: { select: {
        id: true, status: true, externalSignalBrokerDispatchConsumption: { select: { id: true } },
        _count: { select: { brokerOrders: true, brokerActivities: true } },
      } },
    },
    orderBy: { id: 'asc' },
  });
  return claims.map((claim) => {
    const intent = claim.orderIntent!;
    const facts = {
      deliveryEventIds: claim.events.map((event) => event.id),
      deliveryEventTypes: [...new Set(claim.events.map((event) => event.eventType))].sort(),
      pairedConsumption: Boolean(intent.externalSignalBrokerDispatchConsumption),
      brokerOrders: intent._count.brokerOrders, brokerActivities: intent._count.brokerActivities,
      trackedPositionAttached: claim.trackedPositionId !== null,
    };
    return {
      claimId: claim.id, orderIntentId: intent.id, tradingAccountId: claim.tradingAccountId, claimStatus: claim.status, intentStatus: intent.status,
      activeKey: tradingViewDeliveryAttentionKey(intent.id), materialFingerprint: JSON.stringify(facts),
      details: { orderIntentId: intent.id, claimId: claim.id, ...facts, exposureRetained: true, definitelyNotSent: false, resolution: 'AUTHORITATIVE_EVIDENCE_REQUIRED' },
    };
  });
}

function dueAt(attention: { lastObservedAt: Date; materialFingerprint: string | null } | undefined, row: TradingViewDeliveryUncertainty, now: Date) {
  return !attention || attention.materialFingerprint !== row.materialFingerprint || attention.lastObservedAt.getTime() <= now.getTime() - ATTENTION_REFRESH_MS;
}

async function loadDue(rows: TradingViewDeliveryUncertainty[], now: Date, db: PrismaClient) {
  if (!rows.length) return [];
  const active = await db.operationalAttention.findMany({
    where: { activeKey: { in: rows.map((row) => row.activeKey) } },
    select: { activeKey: true, materialFingerprint: true, lastObservedAt: true },
  });
  const byKey = new Map(active.map((attention) => [attention.activeKey, attention]));
  return rows.filter((row) => dueAt(byKey.get(row.activeKey), row, now)).map((row) => ({ row, attention: byKey.get(row.activeKey) }));
}

/** Schedules an account only while its episode needs a first report, a change or a refresh. */
export async function summarizeTradingViewDeliveryAttentionDueByAccount(args: { db?: PrismaClient; now?: Date } = {}) {
  const db = args.db ?? prisma;
  const due = await loadDue(await loadTradingViewDeliveryUncertainty({ db }), args.now ?? new Date(), db);
  const byAccount = new Map<number, number>();
  for (const { row } of due) byAccount.set(row.tradingAccountId, (byAccount.get(row.tradingAccountId) ?? 0) + 1);
  return byAccount;
}

async function observeDue(rows: TradingViewDeliveryUncertainty[], now: Date, db: PrismaClient) {
  let observed = 0;
  for (const { row, attention } of await loadDue(rows, now, db)) {
    if (attention && attention.materialFingerprint === row.materialFingerprint) {
      await db.operationalAttention.updateMany({
        where: { activeKey: row.activeKey, materialFingerprint: row.materialFingerprint },
        data: { lastObservedAt: now, occurrenceCount: { increment: 1 } },
      });
    } else {
      await openOrObserveOperationalAttention({
        tradingAccountId: row.tradingAccountId, orderIntentId: row.orderIntentId,
        code: OPERATIONAL_ATTENTION_CODES.TRADINGVIEW_C2_WORKER_RECOVERY_REQUIRED, source: OPERATIONAL_ATTENTION_SOURCES.WORKER,
        severity: SystemEventSeverity.ERROR, title: 'TradingView delivery needs reconciliation',
        message: 'A TradingView entry has possible-delivery or broker evidence. Its exposure is retained and it is not classified as definitely not sent; only authoritative evidence can resolve it.',
        details: row.details, fingerprint: row.activeKey, materialFingerprint: row.materialFingerprint,
        resolutionPolicy: OperationalAttentionResolutionPolicy.AUTHORITATIVE_ONLY, observedAt: now,
      });
    }
    observed += 1;
  }
  return observed;
}

export async function observeTradingViewDeliveryUncertaintyForAccount(tradingAccountId: number, now = new Date()) {
  const rows = await loadTradingViewDeliveryUncertainty({ tradingAccountIds: [tradingAccountId] });
  return { held: rows.length, observed: await observeDue(rows, now, prisma) };
}

/** Whether the intent has uncertainty; reports it when it does. */
export async function observeTradingViewDeliveryUncertaintyForIntent(orderIntentId: number, args: { db?: PrismaClient; now?: Date } = {}) {
  const db = args.db ?? prisma;
  const rows = await loadTradingViewDeliveryUncertainty({ db, orderIntentId });
  await observeDue(rows, args.now ?? new Date(), db);
  return rows.length > 0;
}
