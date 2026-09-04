import { createHash } from 'node:crypto';
import {
  OperationalAttentionResolutionPolicy,
  SystemEventSeverity,
  type OperationalAttention,
} from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { ReconciliationFinding, ReconciliationFindingCode } from './reconciliation.service.js';
import type {
  ReconciliationBrokerOrder,
  ReconciliationBrokerPosition,
  ReconciliationTrackedPosition,
} from './reconciliation.service.js';
import { isNonterminalBrokerOrderStatus } from './broker-order-lifecycle-status.service.js';
import { parseExactPositiveDecimal } from './verified-exit-submission.service.js';
import {
  OPERATIONAL_ATTENTION_CODES,
  OPERATIONAL_ATTENTION_SOURCES,
  openOrObserveOperationalAttention,
  resolveOperationalAttentionAuthoritatively,
} from './operational-attention.service.js';
import { verifyAppliedHistoricalLifecycleActions } from './historical-entry-lifecycle-workbench.service.js';

type Rule = {
  code: typeof OPERATIONAL_ATTENTION_CODES[keyof typeof OPERATIONAL_ATTENTION_CODES];
  title: (finding: ReconciliationFinding) => string;
};

const RULES: Partial<Record<ReconciliationFindingCode, Rule>> = {
  position_attribution_missing: { code: OPERATIONAL_ATTENTION_CODES.LIFECYCLE_REVIEW_REQUIRED, title: (finding) => `${finding.symbol} lifecycle attribution is incomplete` },
  trail_order_missing_after_unlock: { code: OPERATIONAL_ATTENTION_CODES.PROTECTIVE_EXIT_UNAVAILABLE, title: (finding) => `${finding.symbol} protective exit is unavailable` },
  trail_order_problem_status: { code: OPERATIONAL_ATTENTION_CODES.PROTECTIVE_EXIT_UNAVAILABLE, title: (finding) => `${finding.symbol} protective exit requires review` },
  position_quantity_mismatch: { code: OPERATIONAL_ATTENTION_CODES.EXIT_QUANTITY_MISMATCH, title: (finding) => `${finding.symbol} broker exposure differs from tracked quantity` },
  position_side_mismatch: { code: OPERATIONAL_ATTENTION_CODES.BROKER_EXCESS_EXPOSURE, title: (finding) => `${finding.symbol} broker exposure side differs` },
  tracked_position_missing_at_broker: { code: OPERATIONAL_ATTENTION_CODES.BROKER_EXPOSURE_UNVERIFIABLE, title: (finding) => `${finding.symbol} tracked exposure is missing at broker` },
  unexpected_short_position: { code: OPERATIONAL_ATTENTION_CODES.UNEXPECTED_SHORT_POSITION, title: (finding) => `Unexpected short exposure: ${finding.symbol}` },
  local_order_status_stale_terminal_broker_order: { code: OPERATIONAL_ATTENTION_CODES.HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE, title: (finding) => `${finding.symbol} historical entry lifecycle is incomplete` },
  historical_filled_entry_position_link_missing: { code: OPERATIONAL_ATTENTION_CODES.HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE, title: (finding) => `${finding.symbol} historical entry lifecycle is incomplete` },
};

function stableMaterial(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableMaterial).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => !['runIdentifier', 'occurrenceCount', 'lastObservedAt', 'revision'].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableMaterial(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function reconciliationAttentionMaterialFingerprint(finding: ReconciliationFinding) {
  return createHash('sha256').update(stableMaterial({ code: finding.code, severity: finding.severity, entityType: finding.entityType, entityId: finding.entityId, details: finding.details ?? {} })).digest('hex');
}

export function reconciliationAttentionFingerprint(tradingAccountId: number, finding: ReconciliationFinding) {
  if (finding.attentionCode === OPERATIONAL_ATTENTION_CODES.HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE) {
    const brokerOrderRecordId = finding.details?.brokerOrderRecordId ?? finding.entityId;
    return `account:${tradingAccountId}|historical-entry-lifecycle:brokerOrder:${brokerOrderRecordId}`;
  }
  return `account:${tradingAccountId}|reconciliation:${finding.code}|${finding.entityType}:${finding.entityId}`;
}

export function isAuthoritativeReconciliationEnvironment(environment: string) {
  return environment !== 'LIVE' || (env.NODE_ENV === 'production' && env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR');
}

function severityFor(environment: string, finding: ReconciliationFinding) {
  if (environment === 'LIVE') return SystemEventSeverity.CRITICAL;
  return finding.severity === 'critical' ? SystemEventSeverity.ERROR : SystemEventSeverity.WARNING;
}

export async function projectReconciliationOperationalAttention(args: {
  tradingAccountId: number;
  environment: string;
  findings: ReconciliationFinding[];
  eventIds: Map<string, number>;
  runIdentifier: string;
}) {
  if (!isAuthoritativeReconciliationEnvironment(args.environment)) return { updated: 0, resolved: 0 };
  let updated = 0;
  const observedFingerprints = new Set<string>();
  for (const finding of args.findings) {
    const rule = RULES[finding.code];
    if (!rule) continue;
    const fingerprint = reconciliationAttentionFingerprint(args.tradingAccountId, finding);
    observedFingerprints.add(fingerprint);
    const observed = await openOrObserveOperationalAttention({
      tradingAccountId: args.tradingAccountId,
      code: rule.code,
      source: OPERATIONAL_ATTENTION_SOURCES.RECONCILIATION,
      severity: severityFor(args.environment, finding),
      title: rule.title(finding),
      message: finding.message,
      details: { runIdentifier: args.runIdentifier, findingCode: finding.code, symbol: finding.symbol, ...(finding.details ?? {}) },
      fingerprint,
      materialFingerprint: reconciliationAttentionMaterialFingerprint(finding),
      resolutionPolicy: OperationalAttentionResolutionPolicy.AUTHORITATIVE_ONLY,
      ...(finding.entityType === 'trackedPosition' ? { trackedPositionId: Number(finding.entityId) } : {}),
      ...(finding.entityType === 'orderIntent' ? { orderIntentId: Number(finding.entityId) } : {}),
      ...(finding.entityType === 'brokerOrder' ? { brokerOrderId: Number(finding.details?.brokerOrderRecordId ?? finding.entityId) } : {}),
      ...(typeof finding.details?.orderIntentId === 'number' ? { orderIntentId: finding.details.orderIntentId, orderIntentIsObservationContext: true } : {}),
      observedSystemEventId: args.eventIds.get(`${finding.entityType}:${finding.entityId}:${finding.code}`) ?? null,
    });
    if (rule.code === OPERATIONAL_ATTENTION_CODES.HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE) {
      const unresolved = Array.isArray(finding.details?.unresolvedComponents) ? finding.details.unresolvedComponents.filter((value): value is string => typeof value === 'string') : [];
      await verifyAppliedHistoricalLifecycleActions({ attentionId: observed.attention.id, unresolvedComponents: unresolved, runIdentifier: args.runIdentifier });
    }
    updated += 1;
  }
  const active = await prisma.operationalAttention.findMany({
    where: { tradingAccountId: args.tradingAccountId, source: OPERATIONAL_ATTENTION_SOURCES.RECONCILIATION, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
  });
  let resolved = 0;
  for (const attention of active) {
    if (observedFingerprints.has(attention.fingerprint)) continue;
    if (attention.code === OPERATIONAL_ATTENTION_CODES.HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE) {
      await verifyAppliedHistoricalLifecycleActions({ attentionId: attention.id, unresolvedComponents: [], runIdentifier: args.runIdentifier });
    }
    await resolveOperationalAttentionAuthoritatively({
      id: attention.id,
      expectedRevision: attention.revision,
      reason: 'A complete authoritative reconciliation run no longer observed this condition.',
      evidence: { runIdentifier: args.runIdentifier, conditionAbsent: true },
    });
    resolved += 1;
  }
  return { updated, resolved };
}

export async function resolveClearedExitReservationAttention(args: {
  tradingAccountId: number;
  environment: string;
  trackedPositions: ReconciliationTrackedPosition[];
  brokerPositions: ReconciliationBrokerPosition[];
  brokerOrders: ReconciliationBrokerOrder[];
  runIdentifier: string;
}) {
  if (!isAuthoritativeReconciliationEnvironment(args.environment)) return 0;
  const active = await prisma.operationalAttention.findMany({
    where: {
      tradingAccountId: args.tradingAccountId,
      code: OPERATIONAL_ATTENTION_CODES.CONFLICTING_EXIT_RESERVATION,
      source: OPERATIONAL_ATTENTION_SOURCES.EXIT_VERIFICATION,
      status: { in: ['OPEN', 'ACKNOWLEDGED'] },
    },
  });
  let resolved = 0;
  for (const attention of active) {
    if (!attention.trackedPositionId) continue;
    const local = args.trackedPositions.filter(
      (position) => position.id === attention.trackedPositionId,
    );
    if (local.length !== 1 || local[0]!.status !== 'open' || local[0]!.side?.toLowerCase() !== 'long') continue;
    const localQty = parseExactPositiveDecimal(local[0]!.qty);
    if (!localQty) continue;
    const symbol = local[0]!.symbol.trim().toUpperCase();
    const broker = args.brokerPositions.filter(
      (position) => position.symbol.trim().toUpperCase() === symbol,
    );
    if (broker.length !== 1 || broker[0]!.side?.trim().toLowerCase() !== 'long') continue;
    const brokerQty = parseExactPositiveDecimal(broker[0]!.qty);
    if (!brokerQty || brokerQty.canonical !== localQty.canonical) continue;
    const activeSellReservations = args.brokerOrders.filter(
      (order) =>
        order.symbol.trim().toUpperCase() === symbol &&
        order.side?.trim().toLowerCase() === 'sell' &&
        isNonterminalBrokerOrderStatus(order.status ?? ''),
    );
    if (activeSellReservations.length > 0) continue;
    const unresolvedIntent = await prisma.orderIntent.findFirst({
      where: {
        tradingAccountId: args.tradingAccountId,
        trackedPositionId: attention.trackedPositionId,
        source: 'close-position',
        status: { in: ['pending', 'submitting', 'submitted'] },
      },
      select: { id: true },
    });
    if (unresolvedIntent) continue;
    await resolveOperationalAttentionAuthoritatively({
      id: attention.id,
      expectedRevision: attention.revision,
      reason: 'Authoritative reconciliation confirmed that no active sell reservation remains.',
      evidence: {
        runIdentifier: args.runIdentifier,
        tradingAccountId: args.tradingAccountId,
        trackedPositionId: attention.trackedPositionId,
        symbol,
        brokerPositionSide: broker[0]!.side,
        brokerHeldQty: brokerQty.canonical,
        localTrackedQty: localQty.canonical,
        activeSellReservationCount: 0,
        brokerOpenOrdersReadSucceeded: true,
        resolvedAt: new Date().toISOString(),
        resolutionBasis: 'CONFLICTING_EXIT_RESERVATION_ABSENT',
      },
    });
    resolved += 1;
  }
  return resolved;
}

export const RECONCILIATION_ATTENTION_ELIGIBILITY = RULES;
