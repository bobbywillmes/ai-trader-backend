import { HttpError } from '../errors/http-error.js';
import {
  getAlpacaOrderByClientOrderId,
  placeAlpacaOrder,
} from '../integrations/alpaca/orders.adapter.js';
import {
  createOrderIntent,
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
import { resolveDefaultTradingAccountId } from './trading-account.service.js';
import {
  resolveRuntimeAccountSubscriptionSizing,
  type RuntimeAccountSubscriptionSizingResult,
} from './account-subscription-runtime-sizing.service.js';

type SubmitOrderOptions = {
  entryDecisionKey?: string;
};

function isEntrySubscriptionOrder(
  input: ResolvedPlaceOrderInput
): input is ResolvedPlaceOrderInput & { subscriptionId: number } {
  return (
    input.subscriptionId !== undefined &&
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
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const subscriptionResolvedInput = await resolveSubscriptionOrderInput(input);

  if (options.entryDecisionKey) {
    await ensureEntryDecisionCanLink(options.entryDecisionKey);
  }

  const runtimeSizing = await applyRuntimeAccountSubscriptionSizing(
    subscriptionResolvedInput,
    tradingAccountId
  );
  const resolvedInput = runtimeSizing.input;
  const clientOrderId = buildClientOrderId(resolvedInput);

  const intent = await createOrderIntent(
    resolvedInput,
    'api',
    clientOrderId,
    tradingAccountId,
    runtimeSizing.sizing
      ? {
          tradingAccountSubscriptionId:
            runtimeSizing.sizing.tradingAccountSubscriptionId,
          accountSubscriptionSizing: runtimeSizing.sizing.snapshot,
        }
      : {}
  );

  if (options.entryDecisionKey) {
    await linkEntryDecisionToOrderIntent({
      decisionKey: options.entryDecisionKey,
      orderIntentId: intent.id,
      tradingAccountId,
      tradingAccountSubscriptionId:
        runtimeSizing.sizing?.tradingAccountSubscriptionId ?? null,
    });
  }

  const riskResult = await evaluateOrderRisk(resolvedInput, {
    requestedNotionalOverride:
      runtimeSizing.sizing?.estimatedNotional ?? null,
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
  clientOrderId: string;
};

export async function submitOrderToBroker(
  input: BrokerOrderSubmissionInput,
  options: { tradingAccountId?: number | undefined } = {}
) {
  const clientOrderId = input.clientOrderId;

  if (!clientOrderId) {
    throw new HttpError(
      500,
      'Cannot submit broker order without a stable clientOrderId.'
    );
  }

  const existing = await getAlpacaOrderByClientOrderId(
    clientOrderId,
    'pending_order_idempotency_check',
    { tradingAccountId: options.tradingAccountId }
  );

  if (existing) {
    return {
      duplicate: true,
      order: existing,
    };
  }

  const payload: {
    symbol: string;
    side: 'buy' | 'sell';
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

  const created = await placeAlpacaOrder(payload, 'pending_order_submission', {
    tradingAccountId: options.tradingAccountId,
  });

  adaptivePollingCoordinator.forceAfterBrokerOrderCreated(
    'broker_order_created'
  );

  return {
    duplicate: false,
    order: created,
  };
}
