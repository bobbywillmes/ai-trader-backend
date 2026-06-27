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

type SubmitOrderOptions = {
  entryDecisionKey?: string;
};

export async function submitOrder(
  input: PlaceOrderInput,
  options: SubmitOrderOptions = {}
) {
  const resolvedInput = await resolveSubscriptionOrderInput(input);
  const tradingAccountId = await resolveDefaultTradingAccountId();
  const clientOrderId = buildClientOrderId(resolvedInput);

  if (options.entryDecisionKey) {
    await ensureEntryDecisionCanLink(options.entryDecisionKey);
  }

  const intent = await createOrderIntent(
    resolvedInput,
    'api',
    clientOrderId,
    tradingAccountId
  );

  if (options.entryDecisionKey) {
    await linkEntryDecisionToOrderIntent({
      decisionKey: options.entryDecisionKey,
      orderIntentId: intent.id,
      tradingAccountId,
    });
  }

  const riskResult = await evaluateOrderRisk(resolvedInput);

  if (!riskResult.allowed) {
    await updateOrderIntentStatus(intent.id, 'blocked', riskResult.reason);

    await logRiskGateBlockedOrder({
      orderIntentId: intent.id,
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

export async function submitOrderToBroker(input: BrokerOrderSubmissionInput) {
  const clientOrderId = input.clientOrderId;

  if (!clientOrderId) {
    throw new HttpError(
      500,
      'Cannot submit broker order without a stable clientOrderId.'
    );
  }

  const existing = await getAlpacaOrderByClientOrderId(
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

  const created = await placeAlpacaOrder(payload, 'pending_order_submission');

  adaptivePollingCoordinator.forceAfterBrokerOrderCreated(
    'broker_order_created'
  );

  return {
    duplicate: false,
    order: created,
  };
}
