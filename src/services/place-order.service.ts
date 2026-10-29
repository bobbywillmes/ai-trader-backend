import type { Prisma } from '@prisma/client';

import { HttpError } from '../errors/http-error.js';
import { prisma } from '../db/prisma.js';
import {
  getAlpacaOrderByClientOrderId,
  submitAlpacaEntryOrder,
} from '../integrations/alpaca/orders.adapter.js';
import {
  createOrderIntent,
  recordOrderIntentRiskEvaluation,
  transitionOrderIntentStatusFrom,
} from './order-audit.service.js';
import {
  evaluateOrderRisk,
  logRiskGateBlockedOrder,
} from './risk-gate.service.js';
import { resolveSubscriptionOrderInput } from './subscription.service.js';
import type {
  PlaceOrderInput,
  ResolvedPlaceOrderInput,
} from '../validators/place-order.schema.js';
import { buildClientOrderId } from './client-order-id.service.js';
import { adaptivePollingCoordinator } from './adaptive-polling.service.js';
import {
  ensureEntryDecisionCanLink,
  linkEntryDecisionToOrderIntent,
} from './entry-decision.service.js';
import {
  resolveRuntimeAccountSubscriptionSizing,
  type RuntimeAccountSubscriptionSizingResult,
} from './account-subscription-runtime-sizing.service.js';
import { evaluateAssignmentEntry } from './assignment-entry-evaluation.service.js';
import { validateActiveLiveEntryArming } from './live-entry-arming.service.js';
import { getBrokerWriteDeliveryClassification } from '../errors/broker-write-delivery-error.js';
import { bestEffortAppendBrokerOpportunityEvent, bestEffortCaptureOrderIntentBrokerPostOpportunity, createBrokerObservationBudget } from './order-intent-broker-opportunity.service.js';
import {
  requireEntryExposureClaim,
  requireExecutableEntryExposureClaim,
  releaseUnsubmittedEntryExposureClaim,
} from './entry-exposure-claim.service.js';
import { admitEntryOrderIntent, type TradingViewEntryExecutionContext } from './market-policy-entry-admission.service.js';
import { prepareEntryBrokerDispatch } from './market-policy-broker-dispatch.service.js';
import { recordAdapterInvocationStarted } from './entry-delivery-evidence.service.js';
import type { AlpacaOrder } from '../integrations/alpaca/alpaca.types.js';

type SubmitOrderOptions = {
  entryDecisionKey?: string;
  clientOrderId?: string;
  tradingViewExecution?: TradingViewEntryExecutionContext;
  liveEntryAcceptanceExecution?: {
    runId: number;
    actorUserId: number;
    requestKey: string;
    expectedPreviewRevision: number;
    expectedPreviewFingerprint: string;
  };
};

function previewOrder(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const order = value.order;
  return order && typeof order === 'object' && !Array.isArray(order) ? order : null;
}

function isEntrySubscriptionOrder(
  input: ResolvedPlaceOrderInput
): input is ResolvedPlaceOrderInput & {
  subscriptionId: number;
  tradingAccountSubscriptionId: number;
} {
  return (
    input.subscriptionId !== undefined &&
    input.tradingAccountSubscriptionId !== undefined &&
    input.side === 'buy' &&
    (input.signalType ?? 'entry') === 'entry'
  );
}

async function applyRuntimeAccountSubscriptionSizing(
  input: ResolvedPlaceOrderInput,
  tradingAccountId: number
): Promise<{
  input: ResolvedPlaceOrderInput;
  sizing: RuntimeAccountSubscriptionSizingResult | null;
}> {
  if (!isEntrySubscriptionOrder(input)) {
    return { input, sizing: null };
  }

  const sizing = await resolveRuntimeAccountSubscriptionSizing({
    tradingAccountSubscriptionId: input.tradingAccountSubscriptionId,
    tradingAccountId,
    subscriptionId: input.subscriptionId,
    symbol: input.symbol,
  });
  const { notional: _legacyNotional, ...inputWithoutNotional } = input;

  return {
    input: {
      ...inputWithoutNotional,
      qty: sizing.qty,
    },
    sizing,
  };
}

export async function submitOrder(
  input: PlaceOrderInput,
  options: SubmitOrderOptions = {}
) {
  if ((input.signalType ?? 'entry') !== 'entry' || input.side === 'sell') {
    throw new HttpError(
      400,
      'Sell-side and generic exit OrderIntents are prohibited. Equity sells must use the verified tracked-position exit boundary.',
    );
  }
  if (options.entryDecisionKey) {
    await ensureEntryDecisionCanLink(options.entryDecisionKey);
  }

  const isAssignmentEntry = (input.signalType ?? 'entry') === 'entry';
  const entryEvaluation = isAssignmentEntry
    ? await evaluateAssignmentEntry({ input })
    : null;
  const subscriptionResolvedInput = entryEvaluation?.input ??
    await resolveSubscriptionOrderInput(input);
  const tradingAccountId = subscriptionResolvedInput.tradingAccountId;
  if (tradingAccountId === undefined) {
    throw new HttpError(400, 'Resolved order is missing tradingAccountId.');
  }

  const runtimeSizing = entryEvaluation
    ? { input: entryEvaluation.input, sizing: entryEvaluation.sizing }
    : await applyRuntimeAccountSubscriptionSizing(
        subscriptionResolvedInput,
        tradingAccountId
      );
  const resolvedInput = runtimeSizing.input;
  if (
    entryEvaluation &&
    entryEvaluation.outcomeCode === 'LIVE_ENTRY_POLICY_BLOCKED' &&
    !entryEvaluation.risk.allowed
  ) {
    throw new HttpError(
      entryEvaluation.risk.statusCode,
      entryEvaluation.risk.reason,
      entryEvaluation.risk.details
    );
  }
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: tradingAccountId },
    select: { environment: true, activeLiveEntryArmingId: true },
  });
  const clientOrderId =
    options.clientOrderId ??
    buildClientOrderId(resolvedInput, {
      tradingAccountId,
      environment: account.environment,
    });

  const intentOptions = runtimeSizing.sizing
    ? {
        tradingAccountSubscriptionId:
          runtimeSizing.sizing.tradingAccountSubscriptionId,
        accountSubscriptionSizing: runtimeSizing.sizing.snapshot,
      }
    : {};
  const claimOwnerKey = `entry:${tradingAccountId}:${clientOrderId}`;
  // Every BUY entry OrderIntent is admitted through the shared market-policy admission boundary,
  // which preserves the Phase 3C.0 claim admission unless an explicitly authorized PAPER assignment
  // is enforced under the active runtime rollout.
  const admissionBase = {
    tradingAccountId,
    tradingAccountSubscriptionId: runtimeSizing.sizing?.tradingAccountSubscriptionId ?? null,
    symbol: resolvedInput.symbol,
    clientOrderId,
    ownerKey: claimOwnerKey,
  };
  const admission = options.liveEntryAcceptanceExecution
    ? await admitEntryOrderIntent({
      ...admissionBase,
      requestSource: 'live_entry_acceptance',
      prepare: async (tx) => {
        const execution = options.liveEntryAcceptanceExecution!;
        await tx.$queryRaw`SELECT id FROM "LiveEntryAcceptanceRun" WHERE id = ${execution.runId} FOR UPDATE`;
        const run = await tx.liveEntryAcceptanceRun.findFirst({
          where: { id: execution.runId, tradingAccountId },
          include: {
            orderIntent: true,
            liveEntryArming: true,
          },
        });
        if (!run) throw new HttpError(404, 'Live-entry acceptance run not found.');
        if (run.orderIntent) {
          if (run.executionRequestKey !== execution.requestKey) {
            throw new HttpError(409, 'Acceptance execution was already claimed by another request.');
          }
          return run.orderIntent;
        }
        if (run.terminalAt || run.executionClaimedAt || run.executionUncertainAt) {
          throw new HttpError(409, 'Acceptance execution is no longer claimable.');
        }
        if (
          run.previewRevision !== execution.expectedPreviewRevision ||
          run.previewFingerprint !== execution.expectedPreviewFingerprint
        ) {
          throw new HttpError(409, 'Acceptance execution preview is stale.');
        }
        const reviewed = previewOrder(run.previewJson);
        if (
          !reviewed ||
          reviewed.symbol !== resolvedInput.symbol ||
          reviewed.side !== resolvedInput.side ||
          reviewed.qty !== resolvedInput.qty ||
          reviewed.orderType !== resolvedInput.orderType ||
          reviewed.timeInForce !== resolvedInput.timeInForce ||
          reviewed.extendedHours !== resolvedInput.extendedHours
        ) {
          throw new HttpError(409, 'Current canonical order no longer matches the reviewed preview.');
        }
        if (
          !run.liveEntryArming ||
          run.liveEntryArming.id !== account.activeLiveEntryArmingId ||
          run.liveEntryArming.liveEntryAcceptanceRunId !== run.id ||
          run.liveEntryArming.entryApprovalExpiresAt <= new Date()
        ) {
          throw new HttpError(409, 'Acceptance execution requires its exact active unexpired arming.');
        }
        const currentAuthority = await validateActiveLiveEntryArming(tradingAccountId, tx);
        if (
          !currentAuthority.valid ||
          currentAuthority.arming.id !== run.liveEntryArming.id ||
          currentAuthority.arming.liveEntryAcceptanceRunId !== run.id
        ) {
          throw new HttpError(
            409,
            `Acceptance execution authority changed after preview: ${currentAuthority.valid ? 'ARMING_MISMATCH' : currentAuthority.reason}.`,
          );
        }
        await tx.liveEntryAcceptanceRun.update({
          where: { id: run.id },
          data: {
            executionClaimedAt: new Date(),
            executionRequestedByUserId: execution.actorUserId,
            executionRequestKey: execution.requestKey,
          },
        });
        return null;
      },
      createIntent: (tx) => createOrderIntent(
        resolvedInput, 'live_entry_acceptance', clientOrderId, tradingAccountId,
        { ...intentOptions, liveEntryAcceptanceRunId: options.liveEntryAcceptanceExecution!.runId }, tx,
      ),
    })
    : await admitEntryOrderIntent({
      ...admissionBase,
      requestSource: 'api',
      ...(options.tradingViewExecution ? { tradingViewExecution: options.tradingViewExecution } : {}),
      createIntent: (tx) => createOrderIntent(
        resolvedInput, options.tradingViewExecution ? 'tradingview' : 'api', clientOrderId, tradingAccountId,
        { ...intentOptions, ...(options.tradingViewExecution ? { externalSignalAccountCycleId: options.tradingViewExecution.accountCycleId } : {}) }, tx,
      ),
    });
  const intent = admission.intent;
  const marketPolicyEnforcement = admission.marketPolicy.enforced
    ? { attemptId: admission.marketPolicy.attemptId, obligationId: admission.marketPolicy.obligationId, disposition: admission.marketPolicy.disposition }
    : null;

  if (admission.duplicate && !(options.tradingViewExecution && intent.status === 'received')) {
    return {
      ok: true,
      intentId: intent.id,
      status: intent.status,
      duplicate: true,
      entryDecisionKey: options.entryDecisionKey ?? null,
    };
  }

  try {
  if (options.entryDecisionKey) {
    await linkEntryDecisionToOrderIntent({
      decisionKey: options.entryDecisionKey,
      orderIntentId: intent.id,
      tradingAccountId,
      tradingAccountSubscriptionId:
        runtimeSizing.sizing?.tradingAccountSubscriptionId ?? null,
    });
  }

  const riskResult =
    entryEvaluation?.risk ??
    (await evaluateOrderRisk(resolvedInput, {
      tradingAccountId,
      requestedNotionalOverride:
        runtimeSizing.sizing?.estimatedNotional ?? null,
    }));
  await recordOrderIntentRiskEvaluation({
    orderIntentId: intent.id,
    allowed: riskResult.allowed,
    reason: riskResult.allowed ? null : riskResult.reason,
    details: riskResult.details,
  });

  if (!riskResult.allowed) {
    requireAdmissionStillReceived(await transitionOrderIntentStatusFrom(intent.id, 'received', 'blocked', riskResult.reason), intent.id);
    await releaseUnsubmittedEntryExposureClaim({
      orderIntentId: intent.id,
      reason: 'ADMISSION_RISK_BLOCKED',
    });

    await logRiskGateBlockedOrder({
      orderIntentId: intent.id,
      tradingAccountId,
      input: resolvedInput,
      result: riskResult,
    });

    throw new HttpError(
      riskResult.statusCode,
      riskResult.reason,
      riskResult.details
    );
  }

  // Compare-and-set: an admission that outlived the stale-admission threshold may already have been
  // failed and its claim released by recovery; it must never become executable afterwards.
  requireAdmissionStillReceived(await transitionOrderIntentStatusFrom(intent.id, 'received', 'pending'), intent.id);

  return {
    ok: true,
    intentId: intent.id,
    status: 'pending',
    entryDecisionKey: options.entryDecisionKey ?? null,
    ...(marketPolicyEnforcement ? { marketPolicyEnforcement } : {}),
  };
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await tx.orderIntent.updateMany({
        where: { id: intent.id, status: { in: ['received', 'pending'] } },
        data: {
          status: 'failed',
          blockReason: error instanceof Error ? error.message : 'Entry admission failed after claim acquisition.',
        },
      });
      await releaseUnsubmittedEntryExposureClaim({
        orderIntentId: intent.id,
        reason: 'ADMISSION_FAILED_BEFORE_BROKER_SUBMISSION',
        db: tx,
      });
    }).catch(() => undefined);
    throw error;
  }
}

function requireAdmissionStillReceived(transitioned: boolean, orderIntentId: number) {
  if (!transitioned) {
    throw new HttpError(409, 'Entry admission no longer owns its intent; it was not made executable.', {
      code: 'ENTRY_ADMISSION_ABANDONED', orderIntentId,
    });
  }
}

export type BrokerOrderSubmissionInput = ResolvedPlaceOrderInput & {
  side: 'buy';
  clientOrderId: string;
};

/**
 * Delivery classification of one entry submission attempt, advanced by submitOrderToBroker:
 * - UNCLASSIFIED: no positive proof either way; callers must treat a failure as possibly delivered.
 * - NOT_DISPATCHED: the stable-ID lookup confirmed absence, no local dispatch evidence exists, and the
 *   adapter has not been invoked. A failure here (including a broker-time market-policy refusal) is a
 *   definite non-send.
 * - EXISTING_ORDER_FOUND: an exact broker order already exists; it is recovered, never re-sent.
 * - DISPATCH_STARTED: the final dispatch authorization committed (a consumption, or an un-enforced
 *   dispatch record) and the adapter may have reached Alpaca. That record permanently prohibits
 *   another POST for the intent; a failure here goes to evidence-based claim recovery.
 * - BROKER_RESPONDED: Alpaca confirmed the order.
 */
export type EntryBrokerSubmissionPhase = 'UNCLASSIFIED' | 'NOT_DISPATCHED' | 'EXISTING_ORDER_FOUND' | 'DISPATCH_STARTED' | 'BROKER_RESPONDED';
export type EntryBrokerSubmissionBoundary = { phase: EntryBrokerSubmissionPhase };

export function createEntryBrokerSubmissionBoundary(): EntryBrokerSubmissionBoundary {
  return { phase: 'UNCLASSIFIED' };
}

function assertExistingEntryOrderIdentity(order: AlpacaOrder, expected: { clientOrderId: string; symbol: string }) {
  const mismatches = [
    ...(order.client_order_id !== expected.clientOrderId ? ['clientOrderId'] : []),
    ...(order.symbol?.trim().toUpperCase() !== expected.symbol.trim().toUpperCase() ? ['symbol'] : []),
    ...(order.side?.trim().toLowerCase() !== 'buy' ? ['side'] : []),
  ];
  if (mismatches.length) {
    // Never guess attribution: the order stays unresolved for recovery and is never re-sent.
    throw new HttpError(409, 'Broker order found by stable client order ID does not match the entry identity.', {
      code: 'EXISTING_BROKER_ORDER_IDENTITY_MISMATCH', mismatches, brokerOrderId: order.id,
    });
  }
}

async function assertNoLocalEntryDispatchEvidence(orderIntentId: number) {
  const [consumptions, unenforcedDispatches, dispatchEvents, brokerOrders] = await Promise.all([
    prisma.marketPolicyBrokerDispatchConsumption.count({ where: { orderIntentId } }),
    prisma.marketPolicyBrokerUnenforcedDispatch.count({ where: { orderIntentId } }),
    prisma.orderIntentBrokerOpportunityEvent.count({
      where: { orderIntentId, eventType: { in: ['ADAPTER_DISPATCH_REACHED', 'BROKER_RESPONSE_CONFIRMED', 'BROKER_REJECTED', 'DELIVERY_UNCERTAIN'] } },
    }),
    prisma.brokerOrder.count({ where: { orderIntentId } }),
  ]);
  if (consumptions || unenforcedDispatches || dispatchEvents || brokerOrders) {
    // A lookup miss is not proof that an earlier dispatch never reached Alpaca.
    throw new HttpError(409, 'Entry has prior dispatch evidence; a missing broker lookup result is not proof of non-delivery.', {
      code: 'PRIOR_ENTRY_DISPATCH_EVIDENCE', orderIntentId, consumptions, unenforcedDispatches, dispatchEvents, brokerOrders,
    });
  }
}

export async function submitOrderToBroker(
  input: BrokerOrderSubmissionInput,
  options: { tradingAccountId: number; orderIntentId: number; boundary?: EntryBrokerSubmissionBoundary }
) {
  const boundary = options.boundary ?? createEntryBrokerSubmissionBoundary();
  boundary.phase = 'UNCLASSIFIED';
  const clientOrderId = input.clientOrderId;

  if (!clientOrderId) {
    throw new HttpError(
      500,
      'Cannot submit broker order without a stable clientOrderId.'
    );
  }
  if (input.side !== 'buy' || (input.signalType ?? 'entry') !== 'entry') {
    throw new HttpError(400, 'The entry broker boundary accepts BUY entry orders only.');
  }
  const executable = await requireExecutableEntryExposureClaim({
    orderIntentId: options.orderIntentId,
    tradingAccountId: options.tradingAccountId,
    symbol: input.symbol,
    clientOrderId,
  });

  const existing = await getAlpacaOrderByClientOrderId(
    options.tradingAccountId,
    clientOrderId,
    'pending_order_idempotency_check'
  );

  if (existing) {
    // An already-delivered order is recovered as-is: no market-policy re-gating and no second POST.
    boundary.phase = 'EXISTING_ORDER_FOUND';
    assertExistingEntryOrderIdentity(existing, { clientOrderId, symbol: input.symbol });
    await bestEffortAppendBrokerOpportunityEvent({orderIntentId:options.orderIntentId,eventType:'BROKER_ORDER_MATERIALIZED',evidence:{source:'pre_post_idempotency_lookup',brokerOrderId:existing.id}},undefined,createBrokerObservationBudget());
    return {
      duplicate: true,
      order: existing,
    };
  }

  // Confirmed absence and no local dispatch evidence: a genuinely new dispatch opportunity. Until the
  // dispatch authorization is consumed below, nothing can have been written to Alpaca.
  await assertNoLocalEntryDispatchEvidence(options.orderIntentId);
  boundary.phase = 'NOT_DISPATCHED';
  const dispatch = await prepareEntryBrokerDispatch({
    orderIntentId: options.orderIntentId,
    tradingAccountId: options.tradingAccountId,
    symbol: input.symbol,
    clientOrderId,
  });

  const payload: {
    symbol: string;
    side: 'buy';
    type: 'market' | 'limit';
    time_in_force: 'day' | 'gtc';
    qty?: string;
    notional?: string;
    limit_price?: string;
    extended_hours?: boolean;
    client_order_id: string;
  } = {
    symbol: input.symbol,
    side: input.side,
    type: input.orderType,
    time_in_force: input.timeInForce,
    client_order_id: clientOrderId,
  };

  if (input.qty !== undefined) payload.qty = String(input.qty);
  if (input.notional !== undefined) payload.notional = String(input.notional);
  if (input.limitPrice !== undefined) payload.limit_price = String(input.limitPrice);
  if (input.extendedHours) payload.extended_hours = true;

  const prePostObservationBudget=createBrokerObservationBudget();
  const opportunity=await bestEffortCaptureOrderIntentBrokerPostOpportunity(options.orderIntentId,undefined,prePostObservationBudget);
  // Final pre-dispatch boundary: consumes the single-use broker-time authorization (or records the
  // final un-enforced authorization) with a fresh PostgreSQL clock. A refusal, or a committed record
  // whose acknowledgement was lost, throws here, still NOT_DISPATCHED: this attempt sends nothing.
  await dispatch.authorizeDispatch(opportunity?.id ?? null);
  // The adapter-invocation marker, durable before the adapter is invoked. If this write fails the
  // phase is still NOT_DISPATCHED and nothing is sent; a committed record from the authorization above
  // still prohibits any further POST and goes to evidence-based recovery.
  await recordAdapterInvocationStarted(prisma, { claimId: executable.claim.id, orderIntentId: options.orderIntentId, clientOrderId });
  boundary.phase = 'DISPATCH_STARTED';
  await bestEffortAppendBrokerOpportunityEvent({opportunityId:opportunity?.id??null,eventType:'ADAPTER_DISPATCH_REACHED',evidence:{adapter:'alpaca',operation:'pending_order_submission'}},undefined,prePostObservationBudget);
  let created;
  try {
    created = await submitAlpacaEntryOrder(
      options.tradingAccountId,
      payload,
      isEntrySubscriptionOrder(input)
        ? {
            subtype: 'NEW_POSITION_ENTRY',
            orderIntentId: options.orderIntentId,
            tradingAccountSubscriptionId: input.tradingAccountSubscriptionId,
            subscriptionId: input.subscriptionId,
            symbol: input.symbol,
            side: 'buy',
            clientOrderId,
          }
        : undefined,
    );
  } catch(error) {
    const classification=getBrokerWriteDeliveryClassification(error);
    const eventType=classification==='BROKER_REJECTED'?'BROKER_REJECTED':classification==='NOT_SENT_BLOCKED'?'DEFINITELY_NOT_SENT':classification==='NOT_SENT_RETRYABLE'?'DEFERRED':'DELIVERY_UNCERTAIN';
    const statusCode=typeof error==='object'&&error!==null&&'statusCode' in error&&typeof (error as {statusCode:unknown}).statusCode==='number'?(error as {statusCode:number}).statusCode:null;
    await bestEffortAppendBrokerOpportunityEvent({opportunityId:opportunity?.id??null,eventType,evidence:{classification:classification??'UNCLASSIFIED',statusCode}},undefined,createBrokerObservationBudget());
    throw error;
  }
  boundary.phase = 'BROKER_RESPONDED';
  const postResponseObservationBudget=createBrokerObservationBudget();
  await bestEffortAppendBrokerOpportunityEvent({opportunityId:opportunity?.id??null,eventType:'BROKER_RESPONSE_CONFIRMED',evidence:{brokerOrderId:created.id,status:created.status}},undefined,postResponseObservationBudget);
  await bestEffortAppendBrokerOpportunityEvent({opportunityId:opportunity?.id??null,eventType:'BROKER_ORDER_MATERIALIZED',evidence:{source:'post_response',brokerOrderId:created.id,status:created.status}},undefined,postResponseObservationBudget);

  adaptivePollingCoordinator.forceAfterBrokerOrderCreated(
    options.tradingAccountId,
    'broker_order_created'
  );

  return {
    duplicate: false,
    order: created,
  };
}
