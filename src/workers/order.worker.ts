import { SystemEventSeverity, type Prisma } from '@prisma/client';
import { logger } from '../config/logger.js';

import { AlpacaRateLimitDeferredError } from '../errors/alpaca-rate-limit-deferred-error.js';
import { prisma } from '../db/prisma.js';
import { getNormalizedOpenOrders } from '../services/orders.service.js';
import { placeOrderSchema } from '../validators/place-order.schema.js';
import type { ResolvedPlaceOrderInput } from '../validators/place-order.schema.js';
import {
  createEntryBrokerSubmissionBoundary,
  submitOrderToBroker,
  type BrokerOrderSubmissionInput,
} from '../services/place-order.service.js';
import { getEntryDispatchRecordedNotSent, getMarketPolicyBrokerDispatchRefusal } from '../services/market-policy-broker-dispatch.service.js';
import {
  attemptReleaseAfterRecordedOutcome,
  emitDispatchOutcomeRecorded,
  entryDispatchOutcomeFor,
  isPreDispatchProofCandidateError,
  loadEntryDispatchRecords,
  proveWorkerPreDispatchNonDelivery,
  recordEntryDispatchOutcome,
  recoverStaleAdmissionClaimsForAccount,
  recoverTerminalEntryClaimsForAccount,
  releaseUnsubmittedOrRouteToRecovery,
  type EntryDispatchOutcomeClassification,
  type EntryDispatchRecords,
} from '../services/entry-dispatch-recovery.service.js';
import {
  appendNotSentEvidence,
  ADAPTER_MARKER_PROTOCOL,
  loadDeliveryEvidenceEvents,
  preserveBlockReason,
  summarizeDeliveryEvidence,
  type NotSentClassification,
  type NotSentProducer,
} from '../services/entry-delivery-evidence.service.js';
import { createSystemEvent } from '../services/system-event.service.js';
import { syncTrailingStopOrderStatus } from '../services/position-exit-state.service.js';
import {
  adaptivePollingCoordinator,
  type AdaptivePollingDecision,
} from '../services/adaptive-polling.service.js';
import { linkEntryDecisionToBrokerOrder } from '../services/entry-decision.service.js';
import {
  enumerateLifecycleAccounts,
  type LifecycleAccountEligibility,
} from '../services/lifecycle-account-eligibility.service.js';
import { resolveDefaultTradingAccountId } from '../services/trading-account.service.js';
import { runTradingAccountWorkflow } from '../services/trading-account-workflow-runner.service.js';
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES, withTradingAccountWorkflowLock } from '../services/trading-account-workflow-lock.service.js';
import {
  evaluateOrderRisk,
  logRiskGateBlockedOrder,
} from '../services/risk-gate.service.js';
import { getSizingEstimatedNotional } from '../services/trading-account-entry-risk-usage.service.js';
import { recordOrderIntentRiskEvaluation } from '../services/order-audit.service.js';
import { resolveSubscriptionOrderInput } from '../services/subscription.service.js';
import { getAlpacaOrderByClientOrderId, getAlpacaOrderById } from '../integrations/alpaca/orders.adapter.js';
import { BrokerWriteDeliveryError, getBrokerWriteDeliveryClassification } from '../errors/broker-write-delivery-error.js';
import { bestEffortAppendBrokerOpportunityEvent, createBrokerObservationBudget } from '../services/order-intent-broker-opportunity.service.js';
import {
  requireEntryExposureClaim,
  recordMissingLocalBrokerOrderDiagnostic,
  releaseConfirmedTerminalEntryClaim,
  transitionEntryExposureClaim,
} from '../services/entry-exposure-claim.service.js';
import { isSellIntent } from '../services/entry-lifecycle-status.service.js';
import { submittedOrderSyncIntentWhere } from '../services/submitted-order-sync-selection.service.js';

export type SubmittedOrderSyncResult = {
  found: number;
  polled: boolean;
  synced: number;
  failed: number;
  failures: Array<{
    orderIntentId: number;
    brokerOrderRecordId: number | null;
    error: string;
  }>;
  skipped: boolean;
  skipReason:
    | 'no_local_submitted_orders'
    | 'adaptive_poll_not_due'
    | 'rate_limited'
    | null;
  deferred: boolean;
  backoffUntil?: string | null;
  mode?: AdaptivePollingDecision['mode'];
  effectiveIntervalMs?: number | null;
  nextDueAt?: string | null;
};

export type LifecycleCoordinatorOutcome =
  | 'PROCESSED'
  | 'SKIPPED'
  | 'LOCK_SKIPPED'
  | 'BACKING_OFF'
  | 'CREDENTIALS_UNAVAILABLE'
  | 'FAILED';

export type SubmittedOrderAccountResult = {
  workflow: 'submitted_orders';
  account: LifecycleAccountEligibility;
  outcome: LifecycleCoordinatorOutcome;
  result?: SubmittedOrderSyncResult;
  error?: string;
};

const SUBMITTED_ORDER_BATCH_LIMIT_PER_ACCOUNT = 10;
export const PENDING_ORDER_BATCH_LIMIT_PER_ACCOUNT = 5;
export const STALE_SUBMITTING_INTENT_THRESHOLD_MS = 5 * 60_000;

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown worker error.';
}

function isExitIntent(intent: { side: string; rawRequestJson: Prisma.JsonValue }) {
  return isSellIntent(intent);
}

function getRecordedDeliveryClassification(blockReason: string | null) {
  const match = blockReason?.match(
    /BROKER_WRITE_DELIVERY:(NOT_SENT_RETRYABLE|NOT_SENT_BLOCKED|BROKER_REJECTED|DELIVERY_UNCERTAIN)/
  );
  return match?.[1] ?? null;
}

export function brokerOrderStatusSeverity(status: string): SystemEventSeverity {
  switch (status) {
    case 'accepted':
    case 'accepted_for_bidding':
    case 'new':
    case 'pending_new':
    case 'partially_filled':
    case 'filled':
    case 'canceled':
    case 'cancelled':
    case 'expired':
    case 'replaced':
    case 'done_for_day':
    case 'calculated':
      return SystemEventSeverity.INFO;
    case 'rejected':
      return SystemEventSeverity.ERROR;
    case 'pending_cancel':
    case 'pending_replace':
    case 'stopped':
    case 'suspended':
      return SystemEventSeverity.WARNING;
    default:
      return SystemEventSeverity.ERROR;
  }
}

export function recoveryDeferredSeverity(environment: 'PAPER' | 'LIVE') {
  return environment === 'LIVE'
    ? SystemEventSeverity.CRITICAL
    : SystemEventSeverity.ERROR;
}

export async function recoverStaleSubmittingIntentsForAccount(
  tradingAccountId: number,
  now = new Date()
) {
  const staleBefore = new Date(
    now.getTime() - STALE_SUBMITTING_INTENT_THRESHOLD_MS
  );
  const intents = await prisma.orderIntent.findMany({
    where: {
      tradingAccountId,
      status: 'submitting',
      NOT: {
        AND: [
          { side: { equals: 'sell', mode: 'insensitive' } },
          {
            blockReason: { not: null },
          },
          {
            blockReason: { contains: 'RECOVERY_DEFERRED_EVENT_RECORDED' },
          },
          { lastSubmittedOrderSyncAt: { not: null } },
          { lastSubmittedOrderSyncAt: { gt: staleBefore } },
        ],
      },
      updatedAt: {
        lte: staleBefore,
      },
    },
    include: {
      brokerOrders: true,
      tradingAccount: { select: { environment: true } },
    },
    orderBy: { updatedAt: 'asc' },
    take: 25,
  });
  let linked = 0;
  let retryable = 0;
  let retained = 0;
  const failures: Array<{ orderIntentId: number; error: string }> = [];

  for (const intent of intents) {
    try {
    if (!intent.clientOrderId) {
      retained += 1;
      continue;
    }
    if (!isExitIntent(intent)) {
      await requireEntryExposureClaim(intent.id, prisma, { allowUnresolved: true });
    }

    const persisted = intent.brokerOrders[0];
    if (persisted) {
      const observationBudget=createBrokerObservationBudget();
      await bestEffortAppendBrokerOpportunityEvent({orderIntentId:intent.id,eventType:'RECOVERY_FOUND',evidence:{source:'local_broker_order',brokerOrderId:persisted.brokerOrderId}},undefined,observationBudget);
      await bestEffortAppendBrokerOpportunityEvent({orderIntentId:intent.id,eventType:'BROKER_ORDER_MATERIALIZED',evidence:{source:'local_broker_order',brokerOrderId:persisted.brokerOrderId}},undefined,observationBudget);
      await prisma.orderIntent.updateMany({
        where: { id: intent.id, status: 'submitting' },
        data: { status: 'submitted', blockReason: null },
      });
      linked += 1;
      if (!isExitIntent(intent)) {
        await transitionEntryExposureClaim({ orderIntentId: intent.id, status: 'BROKER_ORDER_ACTIVE', eventType: 'RECOVERY_LINKED_LOCAL_BROKER_ORDER' });
      }
      continue;
    }

    let brokerOrder;
    try {
      const progress = await prisma.orderIntent.updateMany({
        where: { id: intent.id, status: 'submitting' },
        data: { lastSubmittedOrderSyncAt: now },
      });
      if (progress.count !== 1) {
        retained += 1;
        continue;
      }
      brokerOrder = await getAlpacaOrderByClientOrderId(
        tradingAccountId,
        intent.clientOrderId,
        'pending_order_idempotency_check'
      );
    } catch(error) {
      await bestEffortAppendBrokerOpportunityEvent({orderIntentId:intent.id,eventType:'RECOVERY_INCONCLUSIVE',evidence:{source:'stale_submitting_lookup'}},undefined,createBrokerObservationBudget());
      throw error;
    }

    if (brokerOrder) {
      if (
        brokerOrder.client_order_id !== intent.clientOrderId ||
        brokerOrder.symbol?.trim().toUpperCase() !== intent.symbol.trim().toUpperCase() ||
        brokerOrder.side?.trim().toLowerCase() !== intent.side.trim().toLowerCase()
      ) {
        // Ambiguous attribution stays unresolved; the intent is isolated for operator recovery.
        throw new Error(`Broker order ${brokerOrder.id} found by stable client order ID does not match OrderIntent ${intent.id} identity.`);
      }
      const observationBudget=createBrokerObservationBudget();
      await bestEffortAppendBrokerOpportunityEvent({orderIntentId:intent.id,eventType:'RECOVERY_FOUND',evidence:{source:'broker_lookup',brokerOrderId:brokerOrder.id}},undefined,observationBudget);
      await bestEffortAppendBrokerOpportunityEvent({orderIntentId:intent.id,eventType:'BROKER_ORDER_MATERIALIZED',evidence:{source:'broker_lookup',brokerOrderId:brokerOrder.id,status:brokerOrder.status}},undefined,observationBudget);
      const security = await prisma.security.findUniqueOrThrow({
        where: { symbol: brokerOrder.symbol.toUpperCase() },
        select: { id: true },
      });
      await prisma.$transaction(async (tx) => {
        const existing = await tx.brokerOrder.findFirst({
          where: {
            broker: 'alpaca',
            brokerOrderId: brokerOrder.id,
            tradingAccountId,
          },
        });
        if (!existing) {
          await tx.brokerOrder.create({
            data: {
              orderIntentId: intent.id,
              broker: 'alpaca',
              brokerOrderId: brokerOrder.id,
              clientOrderId: brokerOrder.client_order_id,
              symbol: brokerOrder.symbol,
              side: brokerOrder.side,
              status: brokerOrder.status,
              tradingAccountId,
              trackedPositionId: intent.trackedPositionId,
              securityId: security.id,
              rawBrokerJson: brokerOrder as unknown as Prisma.InputJsonValue,
            },
          });
        }
        await tx.orderIntent.updateMany({
          where: { id: intent.id, status: 'submitting' },
          data: { status: 'submitted', blockReason: null },
        });
      });
      await createSystemEvent({
        type: 'order.submission_recovered',
        entityType: 'orderIntent',
        entityId: intent.id,
        tradingAccountId,
        severity: SystemEventSeverity.INFO,
        payloadJson: {
          previousDeliveryClassification:
            getRecordedDeliveryClassification(intent.blockReason),
          clientOrderId: intent.clientOrderId,
          brokerOrderId: brokerOrder.id,
          recovery: 'broker_order_materialized',
          recoveredAt: new Date().toISOString(),
          reason: 'Stable client-order ID matched an existing broker order.',
        } as Prisma.InputJsonValue,
      });
      if (!isExitIntent(intent)) {
        await transitionEntryExposureClaim({
          orderIntentId: intent.id, status: 'BROKER_ORDER_ACTIVE', eventType: 'RECOVERY_FOUND_BROKER_ORDER',
          evidence: { brokerOrderId: brokerOrder.id, brokerStatus: brokerOrder.status },
        });
      }
      linked += 1;
      continue;
    }

    await bestEffortAppendBrokerOpportunityEvent({orderIntentId:intent.id,eventType:'RECOVERY_ABSENCE_CONFIRMED',evidence:{source:'broker_lookup',clientOrderId:intent.clientOrderId}},undefined,createBrokerObservationBudget());

    if (intent.liveEntryAcceptanceRunId != null) {
      const recorded = getRecordedDeliveryClassification(intent.blockReason);
      await prisma.$transaction(async (tx) => {
        await tx.orderIntent.updateMany({
          where: { id: intent.id, status: 'submitting' },
          data: {
            blockReason:
              intent.blockReason ??
              'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:acceptance broker lookup found no order',
          },
        });
        await tx.liveEntryAcceptanceRun.updateMany({
          where: {
            id: intent.liveEntryAcceptanceRunId!,
            terminalAt: null,
            executionClaimedAt: { not: null },
          },
          data: {
            executionUncertainAt: new Date(),
            executionFailureJson: {
              classification: recorded ?? 'DELIVERY_UNCERTAIN',
              source: 'stale_submitting_recovery',
              orderIntentId: intent.id,
              clientOrderId: intent.clientOrderId,
              brokerLookup: 'NOT_FOUND_OR_UNRESOLVED',
            },
          },
        });
      });
      await createSystemEvent({
        type: 'live_entry_acceptance.execution_action_required',
        entityType: 'LiveEntryAcceptanceRun',
        entityId: intent.liveEntryAcceptanceRunId,
        tradingAccountId,
        severity: SystemEventSeverity.CRITICAL,
        payloadJson: {
          orderIntentId: intent.id,
          clientOrderId: intent.clientOrderId,
          recovery: 'acceptance_entry_not_requeued',
          deliveryClassification: recorded ?? 'DELIVERY_UNCERTAIN',
        } as Prisma.InputJsonValue,
      });
      retained += 1;
      continue;
    }

    if (isExitIntent(intent)) {
      const classification = getRecordedDeliveryClassification(
        intent.blockReason
      );
      if (
        classification === 'NOT_SENT_RETRYABLE' ||
        classification === 'NOT_SENT_BLOCKED' ||
        classification === 'BROKER_REJECTED'
      ) {
        await prisma.$transaction(async (tx) => {
          await tx.orderIntent.updateMany({
            where: { id: intent.id, status: 'submitting' },
            data: {
              status:
                classification === 'NOT_SENT_BLOCKED' ? 'blocked' : 'failed',
            },
          });
          if (intent.trackedPositionId !== null) {
            await tx.trackedPosition.updateMany({
              where: { id: intent.trackedPositionId, status: 'closing' },
              data: { status: 'open', lastSyncedAt: new Date() },
            });
          }
        });
        retryable += 1;
        continue;
      }

      if (!intent.blockReason?.includes('RECOVERY_DEFERRED_EVENT_RECORDED')) {
        await createSystemEvent({
          type: 'order.submission_recovery_deferred',
          entityType: 'orderIntent',
          entityId: intent.id,
          tradingAccountId,
          severity: recoveryDeferredSeverity(
            intent.tradingAccount?.environment === 'LIVE' ? 'LIVE' : 'PAPER'
          ),
          payloadJson: {
            clientOrderId: intent.clientOrderId,
            deliveryClassification:
              classification ?? 'DELIVERY_UNCERTAIN',
            recovery: 'exit_order_not_requeued',
          } as Prisma.InputJsonValue,
        });
        await prisma.orderIntent.updateMany({
          where: { id: intent.id, status: 'submitting' },
          data: {
            blockReason: `${intent.blockReason ?? 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN'}:RECOVERY_DEFERRED_EVENT_RECORDED`,
          },
        });
      }
      retained += 1;
      continue;
    }

    // One stable-ID lookup miss is never release evidence by itself. The release decision below
    // depends only on durable evidence recorded atomically with the intent's terminal state.
    const dispatchRecords = await loadEntryDispatchRecords(intent.id);
    const staleDisposition = await prisma.$transaction(async (tx) => {
      const claim = await tx.entryExposureClaim.findUnique({ where: { orderIntentId: intent.id } });
      const summary = claim ? summarizeDeliveryEvidence(await loadDeliveryEvidenceEvents(claim.id, tx)) : null;
      // Proven never sent: the claim never reached ENTRY_SUBMITTING (the broker boundary requires
      // it), or a marker-protocol worker claimed it and the adapter-invocation marker was never written.
      const provenNotSent = !dispatchRecords.present && claim !== null && !claim.releasedAt && summary !== null && summary.outcomes.length === 0 && (
        ['ENTRY_PENDING', 'ADMISSION_BLOCKED'].includes(claim.status) ||
        (claim.status === 'ENTRY_SUBMITTING' && summary.markerProtocol && summary.adapterMarkers === 0));
      const transitioned = await tx.orderIntent.updateMany({
        where: { id: intent.id, status: 'submitting' },
        data: {
          status: 'failed',
          blockReason: preserveBlockReason(intent.blockReason, provenNotSent
            ? 'Recovery confirmed no broker order and the broker adapter was never invoked; entry requires a new admission decision and was not requeued.'
            : dispatchRecords.present
              ? 'DISPATCH_STARTED_OUTCOME_UNKNOWN: a dispatch record exists and no broker order was found; claim retained for evidence-based recovery and never resent.'
              : 'STALE_SUBMISSION_OUTCOME_UNKNOWN: no durable dispatch record and no proof the request was not issued; claim retained for investigation and never resent.'),
        },
      });
      if (transitioned.count !== 1 || !claim || claim.releasedAt) return { kind: 'NONE' as const };
      if (provenNotSent) {
        if (claim.status === 'ENTRY_SUBMITTING') {
          await appendNotSentEvidence(tx, {
            claimId: claim.id, orderIntentId: intent.id, classification: 'NOT_SENT_PRE_DISPATCH', producer: 'STALE_RECOVERY_ADAPTER_NOT_INVOKED',
            source: 'STALE_RECOVERY', reason: 'RECOVERY_CONFIRMED_NEVER_SUBMITTED', message: intent.blockReason,
          });
        }
        return { kind: 'NOT_SENT' as const };
      }
      // A committed dispatch record (for example, a crash between consumption and the adapter call),
      // an entered boundary, or no evidence either way: an explicit unknown outcome retains the claim.
      const outcome = await recordEntryDispatchOutcome({
        orderIntentId: intent.id, classification: 'DISPATCH_OUTCOME_UNKNOWN', source: 'STALE_RECOVERY', observation: 'INFERRED', records: dispatchRecords, db: tx,
        message: dispatchRecords.present
          ? 'Stale submission with a durable dispatch record; the stable client-order-ID lookup found no broker order.'
          : 'Stale submission without a durable dispatch record or proof of non-dispatch; the stable client-order-ID lookup found no broker order.',
      });
      return { kind: 'OUTCOME' as const, outcome };
    });
    if (staleDisposition.kind === 'OUTCOME') await emitDispatchOutcomeRecorded(staleDisposition.outcome, 'DISPATCH_OUTCOME_UNKNOWN');
    if (staleDisposition.kind === 'NOT_SENT') {
      const release = await releaseUnsubmittedOrRouteToRecovery({
        orderIntentId: intent.id, reason: 'RECOVERY_CONFIRMED_NEVER_SUBMITTED', source: 'STALE_RECOVERY', dispatchAttempted: false,
      });
      if (release.released) retryable += 1; else retained += 1;
      continue;
    }
    retained += 1;
    } catch (error) {
      retained += 1;
      failures.push({ orderIntentId: intent.id, error: sanitizeError(error) });
      await createSystemEvent({
        type: 'order.submission_recovery_action_required',
        entityType: 'orderIntent',
        entityId: intent.id,
        tradingAccountId,
        severity: recoveryDeferredSeverity(
          intent.tradingAccount?.environment === 'LIVE' ? 'LIVE' : 'PAPER'
        ),
        payloadJson: {
          clientOrderId: intent.clientOrderId,
          side: intent.side,
          recovery: 'intent_isolated',
          error: sanitizeError(error),
        } as Prisma.InputJsonValue,
      }).catch(() => undefined);
    }
  }

  // Terminal intents whose claims are still held (including consumed dispatches that a lookup can
  // no longer reach through the 'submitting' selection) get a bounded, evidence-based sweep.
  let dispatchRecovery: Awaited<ReturnType<typeof recoverTerminalEntryClaimsForAccount>> | { error: string } | null = null;
  try {
    dispatchRecovery = await recoverTerminalEntryClaimsForAccount(tradingAccountId, now);
  } catch (error) {
    dispatchRecovery = { error: sanitizeError(error) };
    logger.warn({ tradingAccountId, error }, 'Dispatched entry claim recovery sweep failed; it is retried on the next tick.');
  }
  // Abandoned admissions ('received' intents with ENTRY_PENDING claims) that no other path selects.
  let admissionRecovery: Awaited<ReturnType<typeof recoverStaleAdmissionClaimsForAccount>> | { error: string } | null = null;
  try {
    admissionRecovery = await recoverStaleAdmissionClaimsForAccount(tradingAccountId, now);
  } catch (error) {
    admissionRecovery = { error: sanitizeError(error) };
    logger.warn({ tradingAccountId, error }, 'Stale entry admission recovery failed; it is retried on the next tick.');
  }

  return { found: intents.length, linked, retryable, retained, failures, dispatchRecovery, admissionRecovery };
}

export async function recoverStaleSubmittingIntents() {
  const accounts = await enumerateLifecycleAccounts('submitted_orders');
  const results = [];
  for (const account of accounts) {
    if (!account.eligible) {
      results.push({
        account,
        outcome:
          account.reason === 'credentials_unavailable_with_exposure'
            ? 'CREDENTIALS_UNAVAILABLE' as const
            : 'SKIPPED' as const,
      });
      continue;
    }
    try {
      const run = await runTradingAccountWorkflow({
        tradingAccountId: account.tradingAccountId,
        workerKey: 'pending_order_processing',
        lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.LIFECYCLE_MUTATION,
        execute: () => recoverStaleSubmittingIntentsForAccount(account.tradingAccountId),
      });
      if (run.outcome === 'FAILED') {
        if (run.value !== undefined) {
          results.push({ account, outcome: 'FAILED' as const, result: run.value });
          continue;
        }
        throw run.error;
      }
      results.push({
        account,
        outcome: run.outcome,
        ...(run.outcome === 'PROCESSED' ? { result: run.value } : {}),
      });
    } catch (error) {
      results.push({
        account,
        outcome: 'FAILED' as const,
        error: sanitizeError(error),
      });
    }
  }
  return { workflow: 'stale_submitting_recovery' as const, results };
}

type WorkerFailureEvidencePlan =
  | { kind: 'NOT_SENT'; classification: NotSentClassification; producer: NotSentProducer; releaseReason: string; dispatchAttempted: boolean }
  | { kind: 'OUTCOME'; classification: EntryDispatchOutcomeClassification };

function isEntryOrder(input: BrokerOrderSubmissionInput): boolean {
  return input.side === 'buy' && (input.signalType ?? 'entry') === 'entry';
}

export async function processPendingOrdersForAccount(
  tradingAccountId: number
) {
  const pending = await prisma.orderIntent.findMany({
    where: { status: 'pending', tradingAccountId },
    take: PENDING_ORDER_BATCH_LIMIT_PER_ACCOUNT,
    orderBy: { createdAt: 'asc' },
  });

  if (pending.length > 0) {
    logger.trace({ pendingOrders: pending.length }, 'Order worker found pending orders.');
  }

  let claimed = 0;
  let submitted = 0;
  let blocked = 0;
  let failed = 0;

  for (const intent of pending) {
    logger.trace({ orderIntentId: intent.id }, 'Order worker processing intent.');

    let brokerBoundaryStarted = false;
    const boundary = createEntryBrokerSubmissionBoundary();
    try {
      const entryClaim = await requireEntryExposureClaim(intent.id);
      const claimResult = await prisma.orderIntent.updateMany({
        where: {
          id: intent.id,
          status: 'pending',
        },
        data: {
          status: 'submitting',
        },
      });

      if (claimResult.count !== 1) {
        logger.trace({ orderIntentId: intent.id }, 'Order intent was already claimed.');
        continue;
      }

      claimed += 1;
      // The adapter-marker protocol: submitOrderToBroker appends ADAPTER_INVOCATION_STARTED immediately
      // before invoking the adapter, so a claim held under it without a marker never reached the adapter.
      await transitionEntryExposureClaim({
        orderIntentId: intent.id,
        status: 'ENTRY_SUBMITTING',
        eventType: 'WORKER_CLAIMED_FOR_SUBMISSION',
        evidence: { markerProtocol: ADAPTER_MARKER_PROTOCOL },
      });

      if (!intent.clientOrderId) {
        throw new Error(
          `OrderIntent ${intent.id} is missing clientOrderId. Cannot submit safely.`
        );
      }
      if (
        intent.tradingAccountId === null ||
        intent.tradingAccountSubscriptionId === null
      ) {
        throw new Error(
          `OrderIntent ${intent.id} is missing explicit trading account assignment identity.`
        );
      }

      const rawInput = placeOrderSchema.parse(intent.rawRequestJson);
      const currentAssignmentInput = await resolveSubscriptionOrderInput(rawInput);
      if (
        currentAssignmentInput.tradingAccountId !== intent.tradingAccountId ||
        currentAssignmentInput.tradingAccountSubscriptionId !==
          intent.tradingAccountSubscriptionId
      ) {
        throw new Error(
          `OrderIntent ${intent.id} account assignment no longer matches its recorded routing identity.`
        );
      }

      if (intent.side !== 'buy' || rawInput.signalType === 'exit') {
        await prisma.orderIntent.update({
          where: { id: intent.id },
          data: {
            status: 'blocked',
            blockReason: 'LONG_ONLY_SELL_REQUIRES_VERIFIED_EXIT_BOUNDARY',
          },
        });
        blocked += 1;
        continue;
      }

      const resolvedInput: BrokerOrderSubmissionInput = {
        ...rawInput,
        symbol: intent.symbol,
        side: 'buy',
        orderType: intent.orderType as 'market' | 'limit',
        timeInForce: intent.timeInForce as 'day' | 'gtc',
        tradingAccountId: intent.tradingAccountId,
        tradingAccountSubscriptionId:
          intent.tradingAccountSubscriptionId,
        clientOrderId: intent.clientOrderId,
      };

      if (intent.subscriptionId !== null) {
        resolvedInput.subscriptionId = intent.subscriptionId;
      }

      if (isEntryOrder(resolvedInput)) {
        const requestedNotionalOverride = getSizingEstimatedNotional(
          intent.rawRequestJson
        );
        const riskResult = await evaluateOrderRisk(resolvedInput, {
          tradingAccountId: intent.tradingAccountId,
          excludeOrderIntentId: intent.id,
          ...(requestedNotionalOverride !== null
            ? { requestedNotionalOverride }
            : {}),
        });
        await recordOrderIntentRiskEvaluation({
          orderIntentId: intent.id,
          allowed: riskResult.allowed,
          reason: riskResult.allowed ? null : riskResult.reason,
          details: riskResult.details,
        });

        if (!riskResult.allowed) {
          // The refusal and its structured not-sent evidence commit together, before any release.
          await prisma.$transaction(async (tx) => {
            await tx.orderIntent.update({
              where: { id: intent.id },
              data: {
                status: 'blocked',
                blockReason: riskResult.reason,
              },
            });
            await appendNotSentEvidence(tx, {
              claimId: entryClaim.id, orderIntentId: intent.id, classification: 'NOT_SENT_PRE_DISPATCH', producer: 'WORKER_RISK_RECHECK',
              source: 'WORKER', reason: 'WORKER_RISK_RECHECK_BLOCKED', message: riskResult.reason,
            });
          });

          await logRiskGateBlockedOrder({
            orderIntentId: intent.id,
            tradingAccountId: intent.tradingAccountId,
            input: resolvedInput,
            result: riskResult,
          });
          await releaseUnsubmittedOrRouteToRecovery({
            orderIntentId: intent.id,
            reason: 'WORKER_RISK_RECHECK_BLOCKED',
            source: 'WORKER',
            dispatchAttempted: false,
          });

          logger.trace({ orderIntentId: intent.id, reason: riskResult.reason },
            'Order intent blocked by worker-time risk recheck.');

          blocked += 1;
          continue;
        }
      }

      brokerBoundaryStarted = true;
      const result = await submitOrderToBroker(resolvedInput, {
        tradingAccountId: intent.tradingAccountId,
        orderIntentId: intent.id,
        boundary,
      });
      const brokerOrder = result.order;
      await transitionEntryExposureClaim({
        orderIntentId: intent.id,
        status: 'BROKER_ORDER_ACTIVE',
        eventType: result.duplicate ? 'BROKER_ORDER_RECOVERED' : 'BROKER_ORDER_ACCEPTED',
        evidence: { brokerOrderId: brokerOrder.id, brokerStatus: brokerOrder.status },
      }).catch(() => undefined);

      const existingBrokerOrderRecord = await prisma.brokerOrder.findFirst({
        where: {
          broker: 'alpaca',
          brokerOrderId: brokerOrder.id,
          tradingAccountId: intent.tradingAccountId,
        },
      });

      if (existingBrokerOrderRecord) {
        await linkEntryDecisionToBrokerOrder({
          orderIntentId: intent.id,
          brokerOrderRecordId: existingBrokerOrderRecord.id,
          tradingAccountId: intent.tradingAccountId,
        });

        await prisma.orderIntent.update({
          where: { id: intent.id },
          data: {
            status: 'submitted',
          },
        });
        await releaseConfirmedTerminalEntryClaim({
          orderIntentId: intent.id,
          brokerStatus: brokerOrder.status,
        });

        logger.trace({ orderIntentId: intent.id, brokerOrderId: brokerOrder.id },
          'Order intent already has a broker order.');

        submitted += 1;
        continue;
      }

      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'submitted',
          brokerOrders: {
            create: {
              broker: 'alpaca',
              brokerOrderId: brokerOrder.id,
              clientOrderId: brokerOrder.client_order_id,
              symbol: brokerOrder.symbol,
              side: brokerOrder.side,
              status: brokerOrder.status,
              ...(intent.tradingAccountId !== null
                ? {
                    tradingAccount: {
                      connect: { id: intent.tradingAccountId },
                    },
                  }
                : {}),
              ...(intent.trackedPositionId !== null
                ? {
                    trackedPosition: {
                      connect: { id: intent.trackedPositionId },
                    },
                  }
                : {}),
              security: {
                connect: { symbol: brokerOrder.symbol.toUpperCase() },
              },
              rawBrokerJson: brokerOrder as unknown as Prisma.InputJsonValue,
            },
          },
        },
      });

      const createdBrokerOrderRecord = await prisma.brokerOrder.findFirst({
        where: {
          broker: 'alpaca',
          brokerOrderId: brokerOrder.id,
          tradingAccountId: intent.tradingAccountId,
        },
      });

      if (createdBrokerOrderRecord) {
        await linkEntryDecisionToBrokerOrder({
          orderIntentId: intent.id,
          brokerOrderRecordId: createdBrokerOrderRecord.id,
          tradingAccountId: intent.tradingAccountId,
        });
      }
      await releaseConfirmedTerminalEntryClaim({
        orderIntentId: intent.id,
        brokerStatus: brokerOrder.status,
      });

      logger.trace({ orderIntentId: intent.id }, 'Order intent submitted.');
      submitted += 1;
    } catch (error) {
      // Definitely not dispatched: before the broker boundary, or inside it after the stable-ID lookup
      // confirmed absence and before the dispatch authorization was consumed. Every other failure
      // keeps the existing conservative classification; an unclassified exception is never treated
      // as a definite non-send.
      const definitelyNotDispatched = !brokerBoundaryStarted || boundary.phase === 'NOT_DISPATCHED';
      // Inside the boundary before its stable-ID lookup and local dispatch checks completed (an
      // idempotency GET 429/5xx or network failure, or a database failure verifying the claim or
      // dispatch evidence). The adapter is invoked only after DISPATCH_STARTED, so this attempt sent
      // nothing, but the in-memory phase only nominates the failure: it is proven pre-dispatch solely
      // from durable evidence inspected in the persistence transaction below, and otherwise keeps the
      // conservative delivery-uncertain classification.
      const preDispatchCandidate = brokerBoundaryStarted && boundary.phase === 'UNCLASSIFIED' && isPreDispatchProofCandidateError(error);
      // A dispatch record that committed with a lost acknowledgement: this attempt invoked nothing,
      // yet the record permanently prohibits another POST and the claim needs evidence-based recovery.
      const recordedNotSent = definitelyNotDispatched ? getEntryDispatchRecordedNotSent(error) : null;
      const refusal = definitelyNotDispatched && !recordedNotSent ? getMarketPolicyBrokerDispatchRefusal(error) : null;
      const classification = refusal || recordedNotSent ? null : getBrokerWriteDeliveryClassification(error);
      const statusCode = error instanceof BrokerWriteDeliveryError ? error.statusCode : null;
      const message = error instanceof Error ? error.message : 'Unknown worker error.';
      // A requeued intent's earlier delivery uncertainty is never replaced by weaker later text.
      const blockReason = preserveBlockReason(intent.blockReason, recordedNotSent
        ? recordedNotSent.blockReason
        : refusal
          ? refusal.blockReason
          : classification && !definitelyNotDispatched
            ? `BROKER_WRITE_DELIVERY:${classification}:${message}`
            : !definitelyNotDispatched
              ? `BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:${message}`
              : `LOCAL_PRE_DISPATCH_FAILURE:${message}`);
      const deliveryUncertain = !definitelyNotDispatched && (classification === 'DELIVERY_UNCERTAIN' || classification === null);
      // An authoritative market-policy denial is a durable domain outcome; a technical guard failure
      // stays a failure so account health shows it.
      const policyDenied = refusal !== null && !refusal.technical;

      // 1. Classify delivery. Only a failure before the boundary dispatched (phase NOT_DISPATCHED), or
      //    an adapter guard before fetch with no dispatch record, is proven not sent. Any HTTP response
      //    (every 4xx, including 408 and 409) means the request reached Alpaca: it is never a
      //    never-submitted release and goes to evidence-based recovery.
      const records = !definitelyNotDispatched || recordedNotSent
        ? await loadEntryDispatchRecords(intent.id).catch(() => null)
        : null;
      const conservativePlan: WorkerFailureEvidencePlan = recordedNotSent
        ? { kind: 'OUTCOME', classification: recordedNotSent.deliveryClassification }
        : definitelyNotDispatched
          ? {
              kind: 'NOT_SENT', classification: 'NOT_SENT_PRE_DISPATCH',
              producer: refusal ? 'BROKER_TIME_MARKET_POLICY_REFUSAL' : brokerBoundaryStarted ? 'BROKER_BOUNDARY_NOT_DISPATCHED' : 'WORKER_PRE_BOUNDARY_FAILURE',
              releaseReason: refusal?.claimReleaseReason ?? 'WORKER_PROVEN_PRE_DISPATCH_LOCAL_FAILURE',
              // Only after the boundary confirmed no prior dispatch record can a record be this attempt's.
              dispatchAttempted: brokerBoundaryStarted && boundary.phase === 'NOT_DISPATCHED',
            }
          : (classification === 'NOT_SENT_BLOCKED' || classification === 'NOT_SENT_RETRYABLE') && records && !records.present
            ? {
                kind: 'NOT_SENT', classification: classification === 'NOT_SENT_BLOCKED' ? 'NOT_SENT_LOCAL_BLOCKED' : 'NOT_SENT_LOCAL_RETRYABLE',
                producer: 'ADAPTER_LOCAL_GUARD', releaseReason: classification, dispatchAttempted: false,
              }
            : { kind: 'OUTCOME', classification: entryDispatchOutcomeFor(classification) };

      // 2. Persist the terminal intent state and the delivery classification atomically. If this
      //    fails (including the evidence inspection of a pre-dispatch candidate), nothing is released:
      //    the claim keeps ownership and stale recovery reviews it.
      let plan: WorkerFailureEvidencePlan = conservativePlan;
      let recordedOutcome: Awaited<ReturnType<typeof recordEntryDispatchOutcome>> | null = null;
      try {
        ({ plan, recordedOutcome } = await prisma.$transaction(async (tx) => {
          // Inspected before any write in this transaction, so the classification is chosen against
          // exactly the evidence that commits with it.
          const preDispatch = preDispatchCandidate && intent.tradingAccountId !== null
            ? await proveWorkerPreDispatchNonDelivery(tx, { orderIntentId: intent.id, tradingAccountId: intent.tradingAccountId })
            : null;
          const proven = preDispatch?.proven === true;
          const attemptPlan: WorkerFailureEvidencePlan = proven
            ? {
                kind: 'NOT_SENT', classification: 'NOT_SENT_PRE_DISPATCH', producer: 'WORKER_PRE_BOUNDARY_FAILURE',
                releaseReason: 'WORKER_PROVEN_PRE_DISPATCH_BOUNDARY_FAILURE', dispatchAttempted: false,
              }
            : conservativePlan;
          const attemptBlockReason = proven ? `LOCAL_PRE_DISPATCH_FAILURE:${message}` : blockReason;
          const attemptUncertain = !proven && deliveryUncertain;
          if (intent.liveEntryAcceptanceRunId != null) {
            await tx.orderIntent.update({
              where: { id: intent.id },
              data: {
                status: attemptUncertain ? 'submitting' :
                  classification === 'NOT_SENT_BLOCKED' || policyDenied ? 'blocked' : 'failed',
                blockReason: attemptBlockReason,
              },
            });
            await tx.liveEntryAcceptanceRun.updateMany({
              where: { id: intent.liveEntryAcceptanceRunId!, terminalAt: null },
              data: {
                ...(attemptUncertain
                  ? { executionUncertainAt: new Date() }
                  : {}),
                executionFailureJson: {
                  classification: refusal ? refusal.deliveryClassification : proven ? 'LOCAL_FAILURE' : classification ?? (definitelyNotDispatched ? 'LOCAL_FAILURE' : 'DELIVERY_UNCERTAIN'),
                  source: 'pending_order_submission',
                  orderIntentId: intent.id,
                  clientOrderId: intent.clientOrderId,
                  message,
                },
              },
            });
          } else {
            await tx.orderIntent.update({
              where: { id: intent.id },
              data: { status: policyDenied ? 'blocked' : 'failed', blockReason: attemptBlockReason },
            });
          }
          if (attemptPlan.kind === 'OUTCOME') {
            return {
              plan: attemptPlan,
              recordedOutcome: await recordEntryDispatchOutcome({
                orderIntentId: intent.id, classification: attemptPlan.classification, source: 'WORKER', observation: 'OBSERVED', statusCode,
                // A refused pre-dispatch proof names the evidence that kept the conservative outcome.
                message: preDispatch ? `${message} [pre-dispatch non-delivery not proven: ${preDispatch.blockers.join(',')}]` : message,
                ...(records ? { records } : {}), db: tx,
              }),
            };
          }
          const claim = await tx.entryExposureClaim.findUnique({ where: { orderIntentId: intent.id }, select: { id: true, status: true, releasedAt: true } });
          if (claim && !claim.releasedAt && ['ENTRY_PENDING', 'ENTRY_SUBMITTING', 'ADMISSION_BLOCKED'].includes(claim.status)) {
            await appendNotSentEvidence(tx, {
              claimId: claim.id, orderIntentId: intent.id, classification: attemptPlan.classification, producer: attemptPlan.producer,
              source: 'WORKER', reason: attemptPlan.releaseReason, message,
              ...(proven ? { proof: preDispatch!.proof } : {}),
            });
          }
          return { plan: attemptPlan, recordedOutcome: null };
        }));
      } catch (persistenceError) {
        logger.error({ orderIntentId: intent.id, error: persistenceError, classification: plan.classification },
          'Entry failure classification could not be persisted; claim ownership is retained and nothing is released.');
        await createSystemEvent({
          type: 'entry_exposure.delivery_evidence_unpersisted', entityType: 'orderIntent', entityId: intent.id,
          tradingAccountId: intent.tradingAccountId, severity: SystemEventSeverity.CRITICAL,
          message: 'An entry failure could not record its delivery classification; its exposure claim is retained and stale recovery reviews it.',
          payloadJson: { classification: plan.classification, statusCode, clientOrderId: intent.clientOrderId, preDispatchProofCandidate: preDispatchCandidate } as Prisma.InputJsonValue,
        }).catch(() => undefined);
        failed += 1;
        continue;
      }

      // 3. Only now decide on release, from the durable evidence.
      if (plan.kind === 'NOT_SENT') {
        // The never-submitted checks still decide; a refusal is recorded (UNRESOLVED), not swallowed.
        await releaseUnsubmittedOrRouteToRecovery({
          orderIntentId: intent.id, reason: plan.releaseReason, source: 'WORKER', dispatchAttempted: plan.dispatchAttempted, message,
        });
      } else {
        if (recordedOutcome) await emitDispatchOutcomeRecorded(recordedOutcome, plan.classification);
        // The intent is terminal and never resent. A definite local non-send is verified and
        // released immediately when provable; anything else waits for the recovery sweep.
        await attemptReleaseAfterRecordedOutcome({ orderIntentId: intent.id, classification: plan.classification, source: 'WORKER' })
          .catch((recoveryError) => logger.warn({ orderIntentId: intent.id, error: recoveryError },
            'Entry claim release after a recorded outcome failed; the terminal-claim recovery sweep retries it.'));
      }

      logger.trace({ orderIntentId: intent.id, error },
        'Order intent broker submission failed before account health persistence.');
      if (policyDenied) blocked += 1;
      else failed += 1;
    }
  }

  return {
    found: pending.length,
    claimed,
    submitted,
    blocked,
    failed,
  };
}

export async function processPendingOrders() {
  const accounts = await enumerateLifecycleAccounts('pending_submissions');
  const results = [];

  for (const account of accounts) {
    if (!account.eligible) {
      const outcome =
        account.reason === 'credentials_unavailable_with_exposure'
          ? 'CREDENTIALS_UNAVAILABLE' as const
          : 'SKIPPED' as const;
      results.push({ account, outcome });
      continue;
    }

    try {
      const run = await runTradingAccountWorkflow({
        tradingAccountId: account.tradingAccountId,
        workerKey: 'pending_order_processing',
        lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.LIFECYCLE_MUTATION,
        execute: () => processPendingOrdersForAccount(account.tradingAccountId),
        classify: (result) => result.failed > 0
          ? {
              outcome: 'failure',
              error: new Error(`${result.failed} pending order submission(s) failed.`),
              errorCode: 'PENDING_ORDER_ITEM_FAILURE',
              summary: result,
            }
          : { outcome: 'success', workSucceeded: result.submitted > 0, summary: result },
      });
      if (run.outcome === 'FAILED') {
        if (run.value !== undefined) {
          results.push({ account, outcome: 'FAILED' as const, result: run.value });
          continue;
        }
        throw run.error;
      }
      if (run.outcome !== 'PROCESSED') {
        results.push({ account, outcome: run.outcome });
        continue;
      }
      const result = run.value;
      results.push({
        account,
        outcome: result.failed > 0 ? 'FAILED' as const : 'PROCESSED' as const,
        result,
      });
    } catch (error) {
      const message = sanitizeError(error);
      results.push({
        account,
        outcome: 'FAILED' as const,
        error: message,
      });
      logger.trace({
        workflow: 'pending_submissions',
        tradingAccountId: account.tradingAccountId,
        displayName: account.displayName,
        environment: account.environment,
        outcome: 'FAILED',
        error: message,
      }, 'Pending submission account failure captured for account health.');
    }
  }

  const accountResults = results.flatMap((item) =>
    'result' in item && item.result ? [item.result] : []
  );

  return {
    workflow: 'pending_submissions' as const,
    processedAccounts: results.filter((item) => item.outcome === 'PROCESSED')
      .length,
    failedAccounts: results.filter((item) => item.outcome === 'FAILED').length,
    credentialUnavailableAccounts: results.filter(
      (item) => item.outcome === 'CREDENTIALS_UNAVAILABLE'
    ).length,
    skippedAccounts: results.filter((item) => item.outcome === 'SKIPPED')
      .length,
    intentsFound: accountResults.reduce((sum, item) => sum + item.found, 0),
    intentsClaimed: accountResults.reduce((sum, item) => sum + item.claimed, 0),
    intentsSubmitted: accountResults.reduce(
      (sum, item) => sum + item.submitted,
      0
    ),
    intentsBlocked: accountResults.reduce((sum, item) => sum + item.blocked, 0),
    intentsFailed: accountResults.reduce((sum, item) => sum + item.failed, 0),
    results,
  };
}

/** Internal operation: caller must hold the account lifecycle-mutation barrier. */
export async function syncSubmittedOrdersForAccountUnlocked(tradingAccountId: number) {
  const submittedIntents = await prisma.orderIntent.findMany({
    where: submittedOrderSyncIntentWhere(tradingAccountId),
    include: { brokerOrders: true },
    take: SUBMITTED_ORDER_BATCH_LIMIT_PER_ACCOUNT,
    orderBy: [
      { lastSubmittedOrderSyncAt: { sort: 'asc', nulls: 'first' } },
      { createdAt: 'asc' },
    ],
  });

  if (submittedIntents.length === 0) {
    return {
      found: 0,
      polled: false,
      synced: 0,
      failed: 0,
      failures: [],
      skipped: true,
      skipReason: 'no_local_submitted_orders' as const,
      deferred: false,
    } satisfies SubmittedOrderSyncResult;
  }

  const decision = await adaptivePollingCoordinator.getDecision(
    tradingAccountId,
    'submitted_order_sync'
  );

  if (!decision.due) {
    return {
      found: submittedIntents.length,
      polled: false,
      synced: 0,
      failed: 0,
      failures: [],
      skipped: true,
      skipReason:
        decision.reason === 'rate_limit_backoff'
          ? 'rate_limited'
          : 'adaptive_poll_not_due',
      deferred: false,
      mode: decision.mode,
      effectiveIntervalMs: decision.effectiveIntervalMs,
      nextDueAt: decision.nextDueAt?.toISOString() ?? null,
    } satisfies SubmittedOrderSyncResult;
  }

  let openOrders: Awaited<ReturnType<typeof getNormalizedOpenOrders>>;

  try {
    adaptivePollingCoordinator.recordAttempt(
      'submitted_order_sync',
      tradingAccountId,
      new Date()
    );
    openOrders = await getNormalizedOpenOrders(
      tradingAccountId,
      'submitted_order_sync'
    );
  } catch (error) {
    if (error instanceof AlpacaRateLimitDeferredError) {
      adaptivePollingCoordinator.recordRateLimitDeferred(
        'submitted_order_sync',
        tradingAccountId,
        error.backoffUntil,
        new Date()
      );

      return {
        found: submittedIntents.length,
        polled: false,
        synced: 0,
        failed: 0,
        failures: [],
        skipped: true,
        skipReason: 'rate_limited' as const,
        deferred: true,
        backoffUntil: error.backoffUntil?.toISOString() ?? null,
        mode: decision.mode,
        effectiveIntervalMs: decision.effectiveIntervalMs,
        nextDueAt: error.backoffUntil?.toISOString() ?? null,
      } satisfies SubmittedOrderSyncResult;
    }

    adaptivePollingCoordinator.recordFailure(
      'submitted_order_sync',
      tradingAccountId,
      new Date()
    );
    logger.trace({ error },
      'Alpaca open-order fetch failed before account health persistence.');
    throw error;
  }

  const openOrdersByBrokerOrderId = new Map(
    openOrders.map((order) => [order.id, order])
  );

  let synced = 0;
  const failures: SubmittedOrderSyncResult['failures'] = [];

  for (const intent of submittedIntents) {
    try {
      // Persist progress before inspecting local or provider order evidence so a
      // missing relation, 404, or retryable failure cannot monopolize the batch.
      await prisma.orderIntent.update({
        where: { id: intent.id },
        data: { lastSubmittedOrderSyncAt: new Date() },
      });
      const brokerOrder = intent.brokerOrders[0];
      if (!brokerOrder) {
        await recordMissingLocalBrokerOrderDiagnostic({
          orderIntentId: intent.id,
          clientOrderId: intent.clientOrderId,
          intentStatus: intent.status,
        }).catch(() => undefined);
        continue;
      }

      const alpacaOrder = openOrdersByBrokerOrderId.get(brokerOrder.brokerOrderId) ??
        await getAlpacaOrderById(tradingAccountId, brokerOrder.brokerOrderId, 'submitted_order_sync');

      if (!alpacaOrder) continue;

      const previousStatus = brokerOrder.status;
      const nextStatus = alpacaOrder.status;

      await syncTrailingStopOrderStatus({
        tradingAccountId,
        clientOrderId: brokerOrder.clientOrderId,
        brokerOrderId: brokerOrder.brokerOrderId,
        orderStatus: nextStatus,
        rawBrokerJson: {
          brokerOrderId: brokerOrder.brokerOrderId,
          clientOrderId: brokerOrder.clientOrderId,
          previousStatus: brokerOrder.status,
          nextStatus,
          matchedOpenOrder: alpacaOrder.status ?? null,
        } as Prisma.InputJsonValue,
      });

      if (previousStatus !== nextStatus) {
        const updated = await prisma.brokerOrder.updateMany({
          where: {
            id: brokerOrder.id,
            status: previousStatus,
          },
          data: {
            status: nextStatus,
            rawBrokerJson: alpacaOrder as unknown as Prisma.InputJsonValue,
          },
        });

        if (updated.count !== 1) {
          logger.trace({ brokerOrderId: brokerOrder.id },
            'Broker order status was already updated.');

          continue;
        }

        await prisma.orderIntent.update({
          where: { id: brokerOrder.orderIntentId },
          data: {
            status: nextStatus,
          },
        });
        if (brokerOrder.side.toLowerCase() === 'buy') {
          const claimStatus = nextStatus === 'partially_filled'
            ? 'PARTIALLY_FILLED'
            : nextStatus === 'filled'
              ? 'FILLED_AWAITING_POSITION'
              : 'BROKER_ORDER_ACTIVE';
          await transitionEntryExposureClaim({
            orderIntentId: brokerOrder.orderIntentId,
            status: claimStatus,
            eventType: 'BROKER_ORDER_STATUS_OBSERVED',
            evidence: { brokerOrderId: brokerOrder.brokerOrderId, previousStatus, nextStatus },
          }).catch(() => undefined);
          await releaseConfirmedTerminalEntryClaim({
            orderIntentId: brokerOrder.orderIntentId,
            brokerStatus: nextStatus,
          });
        }

        await createSystemEvent({
          type: `order.${nextStatus}`,
          entityType: 'brokerOrder',
          entityId: brokerOrder.id,
          tradingAccountId: brokerOrder.tradingAccountId,
          severity: brokerOrderStatusSeverity(nextStatus),
          payloadJson: {
            orderIntentId: brokerOrder.orderIntentId,
            brokerOrderId: brokerOrder.brokerOrderId,
            symbol: brokerOrder.symbol,
            side: brokerOrder.side,
            previousStatus,
            nextStatus,
          } as Prisma.InputJsonValue,
        });

        logger.trace({ brokerOrderId: brokerOrder.id, previousStatus, nextStatus },
          'Broker order status changed.');
        synced += 1;
      } else if (
        brokerOrder.side.toLowerCase() === 'buy' &&
        ['replaced', 'done_for_day', 'calculated'].includes(nextStatus.toLowerCase())
      ) {
        // These statuses are not sufficient release evidence by themselves.
        // Re-evaluate the replacement/open-order chain on later polling ticks.
        await releaseConfirmedTerminalEntryClaim({
          orderIntentId: brokerOrder.orderIntentId,
          brokerStatus: nextStatus,
        });
      }
    } catch (error) {
      const brokerOrder = intent.brokerOrders[0];
      const message = sanitizeError(error);
      failures.push({
        orderIntentId: intent.id,
        brokerOrderRecordId: brokerOrder?.id ?? null,
        error: message,
      });
      logger.trace({
        workflow: 'submitted_orders',
        tradingAccountId,
        orderIntentId: intent.id,
        brokerOrderRecordId: brokerOrder?.id ?? null,
        outcome: 'FAILED',
        error: message,
      }, 'Submitted-order item failure captured for account health.');
    }
  }

  const completedAt = new Date();
  if (failures.length > 0) {
    adaptivePollingCoordinator.recordFailure(
      'submitted_order_sync',
      tradingAccountId,
      completedAt
    );
  } else {
    adaptivePollingCoordinator.recordSuccess(
      'submitted_order_sync',
      tradingAccountId,
      completedAt,
      decision.effectiveIntervalMs
    );
  }

  return {
    found: submittedIntents.length,
    polled: true,
    synced,
    failed: failures.length,
    failures,
    deferred: false,
    skipped: false,
    skipReason: null,
    mode: decision.mode,
    effectiveIntervalMs: decision.effectiveIntervalMs,
    nextDueAt:
      decision.effectiveIntervalMs === null
        ? null
        : new Date(completedAt.getTime() + decision.effectiveIntervalMs).toISOString(),
  } satisfies SubmittedOrderSyncResult;
}

/** Public/manual operation: acquires the account lifecycle-mutation barrier. */
export async function syncSubmittedOrdersForAccount(tradingAccountId: number) {
  const result = await withTradingAccountWorkflowLock({
    tradingAccountId, workflowKey: ACCOUNT_WORKFLOW_LOCK_FAMILIES.LIFECYCLE_MUTATION,
    processInstanceId: `submitted-order-sync:${Date.now()}`,
    execute: () => syncSubmittedOrdersForAccountUnlocked(tradingAccountId),
  });
  if (result.outcome !== 'ACQUIRED_AND_COMPLETED') throw (result.outcome === 'WORKFLOW_ERROR' || result.outcome === 'LOCK_ERROR' ? result.error : new Error('Lifecycle mutation is already in progress.'));
  return result.value;
}

export async function syncSubmittedOrdersAcrossAccounts() {
  const accounts = await enumerateLifecycleAccounts('submitted_orders');
  const results: SubmittedOrderAccountResult[] = [];

  for (const account of accounts) {
    if (!account.eligible) {
      const outcome =
        account.reason === 'credentials_unavailable_with_exposure'
          ? 'CREDENTIALS_UNAVAILABLE'
          : 'SKIPPED';
      results.push({ workflow: 'submitted_orders', account, outcome });
      continue;
    }

    try {
      const run = await runTradingAccountWorkflow({
        tradingAccountId: account.tradingAccountId,
        workerKey: 'submitted_order_sync',
        lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.LIFECYCLE_MUTATION,
        execute: () => syncSubmittedOrdersForAccountUnlocked(account.tradingAccountId),
        classify: (result) => result.failed > 0
          ? {
              outcome: 'failure',
              error: new Error(`${result.failed} submitted order synchronization(s) failed.`),
              errorCode: 'SUBMITTED_ORDER_ITEM_FAILURE',
              summary: result,
            }
          : result.skipped
            ? { outcome: 'skipped', skipReason: 'not_due', summary: result }
            : { outcome: 'success', workSucceeded: result.synced > 0, summary: result },
      });
      if (run.outcome === 'FAILED') {
        if (run.value !== undefined) {
          results.push({
            workflow: 'submitted_orders', account, outcome: 'FAILED', result: run.value,
          });
          continue;
        }
        throw run.error;
      }
      if (run.outcome !== 'PROCESSED') {
        results.push({ workflow: 'submitted_orders', account, outcome: run.outcome });
        continue;
      }
      const result = run.value;
      results.push({
        workflow: 'submitted_orders',
        account,
        outcome:
          result.failed > 0
            ? 'FAILED'
            : result.skipped
              ? 'SKIPPED'
              : 'PROCESSED',
        result,
      });
    } catch (error) {
      const message = sanitizeError(error);
      results.push({
        workflow: 'submitted_orders',
        account,
        outcome: 'FAILED',
        error: message,
      });
      logger.trace({
        workflow: 'submitted_orders',
        tradingAccountId: account.tradingAccountId,
        displayName: account.displayName,
        environment: account.environment,
        outcome: 'FAILED',
        error: message,
      }, 'Submitted-order account failure captured for account health.');
    }
  }

  return {
    workflow: 'submitted_orders' as const,
    processedAccounts: results.filter((item) => item.outcome === 'PROCESSED')
      .length,
    failedAccounts: results.filter((item) => item.outcome === 'FAILED').length,
    results,
  };
}

// Compatibility wrapper for explicit legacy/manual callers. Scheduled worker
// execution uses syncSubmittedOrdersAcrossAccounts.
export async function syncSubmittedOrders() {
  return syncSubmittedOrdersForAccount(await resolveDefaultTradingAccountId());
}
