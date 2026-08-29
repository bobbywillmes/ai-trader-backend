import {
  OperationalAttentionResolutionPolicy,
  SystemEventSeverity,
  type OperationalAttention,
} from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { ReconciliationFinding, ReconciliationFindingCode } from './reconciliation.service.js';
import {
  OPERATIONAL_ATTENTION_CODES,
  OPERATIONAL_ATTENTION_SOURCES,
  openOrObserveOperationalAttention,
  resolveOperationalAttentionAuthoritatively,
} from './operational-attention.service.js';

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
};

export function reconciliationAttentionFingerprint(tradingAccountId: number, finding: ReconciliationFinding) {
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
    await openOrObserveOperationalAttention({
      tradingAccountId: args.tradingAccountId,
      code: rule.code,
      source: OPERATIONAL_ATTENTION_SOURCES.RECONCILIATION,
      severity: severityFor(args.environment, finding),
      title: rule.title(finding),
      message: finding.message,
      details: { runIdentifier: args.runIdentifier, findingCode: finding.code, symbol: finding.symbol, ...(finding.details ?? {}) },
      fingerprint,
      resolutionPolicy: OperationalAttentionResolutionPolicy.AUTHORITATIVE_ONLY,
      ...(finding.entityType === 'trackedPosition' ? { trackedPositionId: Number(finding.entityId) } : {}),
      ...(finding.entityType === 'orderIntent' ? { orderIntentId: Number(finding.entityId) } : {}),
      observedSystemEventId: args.eventIds.get(`${finding.entityType}:${finding.entityId}:${finding.code}`) ?? null,
    });
    updated += 1;
  }
  const active = await prisma.operationalAttention.findMany({
    where: { tradingAccountId: args.tradingAccountId, source: OPERATIONAL_ATTENTION_SOURCES.RECONCILIATION, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
  });
  let resolved = 0;
  for (const attention of active) {
    if (observedFingerprints.has(attention.fingerprint)) continue;
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

export const RECONCILIATION_ATTENTION_ELIGIBILITY = RULES;
