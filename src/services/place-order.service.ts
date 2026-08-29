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
  updateOrderIntentStatus,
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

type SubmitOrderOptions = {
  entryDecisionKey?: string;
  clientOrderId?: string;
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
  let duplicateAcceptanceExecution = false;
  const intent = options.liveEntryAcceptanceExecution
    ? await prisma.$transaction(async (tx) => {
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
          duplicateAcceptanceExecution = true;
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
        return createOrderIntent(
          resolvedInput,
          'live_entry_acceptance',
          clientOrderId,
          tradingAccountId,
          {
            ...intentOptions,
            liveEntryAcceptanceRunId: run.id,
          },
          tx,
        );
      })
    : await createOrderIntent(
        resolvedInput,
        'api',
        clientOrderId,
        tradingAccountId,
        intentOptions,
      );

  if (duplicateAcceptanceExecution) {
    return {
      ok: true,
      intentId: intent.id,
      status: intent.status,
      duplicate: true,
      entryDecisionKey: options.entryDecisionKey ?? null,
    };
  }

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
    await updateOrderIntentStatus(intent.id, 'blocked', riskResult.reason);

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

  await updateOrderIntentStatus(intent.id, 'pending');

  return {
    ok: true,
    intentId: intent.id,
    status: 'pending',
    entryDecisionKey: options.entryDecisionKey ?? null,
  };
}

export type BrokerOrderSubmissionInput = ResolvedPlaceOrderInput & {
  side: 'buy';
  clientOrderId: string;
};

export async function submitOrderToBroker(
  input: BrokerOrderSubmissionInput,
  options: { tradingAccountId: number; orderIntentId: number }
) {
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

  const existing = await getAlpacaOrderByClientOrderId(
    options.tradingAccountId,
    clientOrderId,
    'pending_order_idempotency_check'
  );

  if (existing) {
    return {
      duplicate: true,
      order: existing,
    };
  }

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

  const created = await submitAlpacaEntryOrder(
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

  adaptivePollingCoordinator.forceAfterBrokerOrderCreated(
    options.tradingAccountId,
    'broker_order_created'
  );

  return {
    duplicate: false,
    order: created,
  };
}
