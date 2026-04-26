import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';

import { HttpError } from '../errors/http-error.js';
import { normalizeOpenOrder } from '../integrations/alpaca/normalizers.js';
import {
  getAlpacaOrderByClientOrderId,
  placeAlpacaOrder
} from '../integrations/alpaca/orders.adapter.js';
import { getNormalizedAccount } from './account.service.js';
import { getRuntimeTradingConfig } from './config.service.js';
import {
  createBrokerOrder,
  createOrderIntent,
  updateOrderIntentStatus
} from './order-audit.service.js';
import type { PlaceOrderInput } from '../validators/place-order.schema.js';

function buildClientOrderId(input: PlaceOrderInput): string {
  return [
    'ai',
    input.symbol,
    input.side,
    input.orderType,
    Date.now().toString(),
    crypto.randomUUID().slice(0, 8)
  ]
    .join('-')
    .slice(0, 128);
}

export async function submitOrder(input: PlaceOrderInput) {
  const intent = await createOrderIntent(input, 'api');

  const runtimeConfig = await getRuntimeTradingConfig();

  if (!runtimeConfig.tradingEnabled) {
    await updateOrderIntentStatus(intent.id, 'blocked', 'Trading is disabled.');
    throw new HttpError(403, 'Trading is disabled.');
  }

  if (!runtimeConfig.allowedTickers.includes(input.symbol)) {
    const reason = `Ticker ${input.symbol} is not allowed.`;
    await updateOrderIntentStatus(intent.id, 'blocked', reason);
    throw new HttpError(403, reason);
  }

  const account = await getNormalizedAccount();

  if (account.tradingBlocked) {
    await updateOrderIntentStatus(intent.id, 'blocked', 'Broker account is trading blocked.');
    throw new HttpError(403, 'Broker account is trading blocked.');
  }

  await updateOrderIntentStatus(intent.id, 'pending');

  return {
    ok: true,
    intentId: intent.id,
    status: 'pending'
  };
}

export async function submitOrderToBroker(input: PlaceOrderInput) {
  const clientOrderId = input.clientOrderId ?? buildClientOrderId(input);

  const existing = await getAlpacaOrderByClientOrderId(clientOrderId);

  if (existing) {
    return {
      duplicate: true,
      order: existing
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
    client_order_id: clientOrderId
  };

  if (input.qty !== undefined) payload.qty = String(input.qty);
  if (input.notional !== undefined) payload.notional = String(input.notional);
  if (input.limitPrice !== undefined) payload.limit_price = String(input.limitPrice);
  if (input.extendedHours) payload.extended_hours = true;

  const created = await placeAlpacaOrder(payload);

  return {
    duplicate: false,
    order: created
  };
}