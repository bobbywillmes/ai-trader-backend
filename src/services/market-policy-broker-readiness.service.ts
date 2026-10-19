import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { deriveMarketPolicyEnforcementDisposition, type MarketPolicyEnforcementDisposition } from './assignment-market-policy-enforcement-authorization.service.js';
import { BROKER_ACTIVE_ENTRY_STATUSES } from './entry-lifecycle-status.service.js';
import { getMarketPolicyEnforcementRuntimeStatus } from './market-policy-enforcement-rollout.service.js';

// Phase 3C.3 read-only pre-activation inventory. It never mutates state, calls a broker, or grants
// authority. Operators run it before activating PAPER enforcement (and before granting enforcement
// to an assignment with queued entries) to see which queued BUY intents the broker-time guard will
// quarantine, which carry frozen obligations, and which are already in the delivery/recovery path.

const NOT_DISPATCHED_STATUSES = new Set(['received', 'pending']);
const ENFORCEMENT_REQUIRED = new Set<MarketPolicyEnforcementDisposition>(['ENFORCED', 'AUTHORIZATION_INEFFECTIVE', 'LAPSED']);

export type BrokerDeliveryClassification = 'NOT_DISPATCHED' | 'DISPATCH_IN_PROGRESS_OR_UNCERTAIN' | 'DELIVERY_UNCERTAIN' | 'BROKER_ORDER_DELIVERED';
export type BrokerTimeTreatment =
  | 'FROZEN_OBLIGATION_REVALIDATED_BEFORE_POST'
  | 'QUARANTINED_AT_BROKER_TIME_WHILE_ROLLOUT_ACTIVE'
  | 'EXISTING_ENTRY_BEHAVIOR'
  | 'EXISTING_RECOVERY_PATHWAY';

type Db = PrismaClient;

function classifyDelivery(intent: { status: string; blockReason: string | null; brokerOrders: number; claimStatus: string | null; dispatchStarted: boolean }): BrokerDeliveryClassification {
  if (intent.brokerOrders > 0 || !['received', 'pending', 'submitting', 'failed'].includes(intent.status)) return 'BROKER_ORDER_DELIVERED';
  if (intent.blockReason?.includes('DELIVERY_UNCERTAIN') || intent.claimStatus === 'UNRESOLVED') return 'DELIVERY_UNCERTAIN';
  if (intent.status === 'submitting' || intent.dispatchStarted) return 'DISPATCH_IN_PROGRESS_OR_UNCERTAIN';
  return 'NOT_DISPATCHED';
}

export async function assessMarketPolicyBrokerEnforcementReadiness(options: { db?: Db; tradingAccountIds?: number[] } = {}) {
  const db = options.db ?? prisma;
  const runtime = await getMarketPolicyEnforcementRuntimeStatus(db);
  const accountFilter = options.tradingAccountIds?.length ? { id: { in: options.tradingAccountIds } } : {};
  const intents = await db.orderIntent.findMany({
    where: {
      side: { equals: 'buy', mode: 'insensitive' },
      trackedPositionId: null,
      tradingAccountSubscriptionId: { not: null },
      tradingAccount: { environment: 'PAPER', ...accountFilter },
      OR: [
        { status: { in: [...BROKER_ACTIVE_ENTRY_STATUSES] } },
        { status: 'failed', blockReason: { contains: 'DELIVERY_UNCERTAIN' } },
        { status: 'failed', entryExposureClaim: { status: 'UNRESOLVED', releasedAt: null } },
      ],
    },
    orderBy: { id: 'asc' },
    select: {
      id: true, tradingAccountId: true, tradingAccountSubscriptionId: true, clientOrderId: true, symbol: true, status: true, blockReason: true, createdAt: true,
      marketPolicyEnforcementObligation: { select: { id: true, authorizationId: true, policyRevisionId: true } },
      marketPolicyBrokerDispatchConsumption: { select: { id: true } },
      entryExposureClaim: { select: { id: true, status: true, releasedAt: true } },
      _count: { select: { brokerOrders: true } },
    },
  });

  const assignmentIds = [...new Set(intents.map(intent => intent.tradingAccountSubscriptionId!))];
  const authorizations = await db.assignmentMarketPolicyEnforcementAuthorization.findMany({
    where: { tradingAccount: { environment: 'PAPER', ...accountFilter } },
    orderBy: { id: 'desc' },
    select: {
      id: true, tradingAccountId: true, accountSubscriptionId: true, status: true, authorityVersion: true, invalidationReasonCode: true,
      invalidationSource: true, invalidatedAt: true, authorizedAt: true, policyRevisionId: true, enrollmentGenerationId: true,
      lapseResolution: { select: { id: true } },
    },
  });
  const latestByAssignment = new Map<number, (typeof authorizations)[number]>();
  for (const authorization of authorizations) if (!latestByAssignment.has(authorization.accountSubscriptionId)) latestByAssignment.set(authorization.accountSubscriptionId, authorization);
  const dispositionFor = (assignmentId: number) => deriveMarketPolicyEnforcementDisposition({
    accountEnvironment: 'PAPER',
    latest: latestByAssignment.get(assignmentId) ? { status: latestByAssignment.get(assignmentId)!.status, lapseResolution: latestByAssignment.get(assignmentId)!.lapseResolution } : null,
    // Authorization effectiveness is resolved under locks at broker time; for inventory purposes an
    // AUTHORIZED latest row means enforcement is required either way (ENFORCED or fail-closed).
    ineffectiveReasons: [],
  });

  const inventory = intents.map(intent => {
    const disposition = dispositionFor(intent.tradingAccountSubscriptionId!);
    const delivery = classifyDelivery({
      status: intent.status, blockReason: intent.blockReason, brokerOrders: intent._count.brokerOrders,
      claimStatus: intent.entryExposureClaim?.releasedAt ? null : intent.entryExposureClaim?.status ?? null,
      dispatchStarted: Boolean(intent.marketPolicyBrokerDispatchConsumption),
    });
    const obligationPresent = Boolean(intent.marketPolicyEnforcementObligation);
    const treatment: BrokerTimeTreatment = delivery !== 'NOT_DISPATCHED'
      ? 'EXISTING_RECOVERY_PATHWAY'
      : obligationPresent
        ? 'FROZEN_OBLIGATION_REVALIDATED_BEFORE_POST'
        : ENFORCEMENT_REQUIRED.has(disposition)
          ? 'QUARANTINED_AT_BROKER_TIME_WHILE_ROLLOUT_ACTIVE'
          : 'EXISTING_ENTRY_BEHAVIOR';
    return {
      orderIntentId: intent.id, tradingAccountId: intent.tradingAccountId, accountSubscriptionId: intent.tradingAccountSubscriptionId,
      clientOrderId: intent.clientOrderId, symbol: intent.symbol, status: intent.status, createdAt: intent.createdAt,
      obligationPresent, obligationId: intent.marketPolicyEnforcementObligation?.id ?? null,
      assignmentDisposition: disposition, brokerDeliveryClassification: delivery, brokerTimeTreatment: treatment,
      claimStatus: intent.entryExposureClaim ? (intent.entryExposureClaim.releasedAt ? 'RELEASED' : intent.entryExposureClaim.status) : null,
      notDispatchedQueued: NOT_DISPATCHED_STATUSES.has(intent.status) && delivery === 'NOT_DISPATCHED',
    };
  });

  // Hermes L5: owner-visible unresolved lapses, including V1 grants invalidated for Security-binding reapproval.
  const unresolvedLapses = [...latestByAssignment.values()]
    .filter(authorization => authorization.status === 'INVALIDATED' && !authorization.lapseResolution)
    .map(authorization => ({
      authorizationId: authorization.id, tradingAccountId: authorization.tradingAccountId, accountSubscriptionId: authorization.accountSubscriptionId,
      authorityVersion: authorization.authorityVersion, invalidationReasonCode: authorization.invalidationReasonCode, invalidationSource: authorization.invalidationSource,
      invalidatedAt: authorization.invalidatedAt, policyRevisionId: authorization.policyRevisionId, enrollmentGenerationId: authorization.enrollmentGenerationId,
      securityBindingReapprovalRequired: authorization.invalidationReasonCode === 'AUTHORITY_BINDING_REAPPROVAL_REQUIRED',
      entryBehaviorWhileRolloutActive: 'FAIL_CLOSED' as const,
      resolution: 'REAUTHORIZE_OR_OWNER_RESOLVE_LAPSE' as const,
    }));

  const atRisk = inventory.filter(item => item.brokerTimeTreatment === 'QUARANTINED_AT_BROKER_TIME_WHILE_ROLLOUT_ACTIVE');
  const recovering = inventory.filter(item => item.brokerTimeTreatment === 'EXISTING_RECOVERY_PATHWAY' && item.brokerDeliveryClassification !== 'BROKER_ORDER_DELIVERED');
  return {
    mode: 'READ_ONLY' as const,
    runtimeEnforcement: { active: runtime.active, status: runtime.status, version: runtime.version },
    assignmentsWithQueuedEntries: assignmentIds.length,
    summary: {
      inventoried: inventory.length,
      queuedWithoutObligationRequiringEnforcement: atRisk.length,
      queuedWithFrozenObligation: inventory.filter(item => item.brokerTimeTreatment === 'FROZEN_OBLIGATION_REVALIDATED_BEFORE_POST').length,
      queuedExistingBehavior: inventory.filter(item => item.brokerTimeTreatment === 'EXISTING_ENTRY_BEHAVIOR').length,
      deliveryUncertainOrInProgress: recovering.length,
      brokerOrderDelivered: inventory.filter(item => item.brokerDeliveryClassification === 'BROKER_ORDER_DELIVERED').length,
      unresolvedLapses: unresolvedLapses.length,
    },
    // Operator guard: activation is safe for queued entries either way (they are quarantined), but
    // the owner should review and resolve these before activating so nothing is silently discarded.
    activationGuard: {
      reviewRequired: atRisk.length > 0 || recovering.length > 0 || unresolvedLapses.length > 0,
      reasons: [
        ...(atRisk.length ? ['QUEUED_UNOBLIGATED_ENTRIES_WILL_BE_QUARANTINED'] : []),
        ...(recovering.length ? ['DELIVERY_UNCERTAIN_ENTRIES_IN_RECOVERY'] : []),
        ...(unresolvedLapses.length ? ['UNRESOLVED_AUTHORIZATION_LAPSES_FAIL_CLOSED'] : []),
      ],
      liquidationRequired: false,
    },
    inventory,
    unresolvedLapses,
  };
}
