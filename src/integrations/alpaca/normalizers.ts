import { env } from '../../config/env.js';
import type {
  AlpacaAccount,
  AlpacaPosition,
  AlpacaOrder
} from './alpaca.types.js';
import type {
  BrokerAccountSummary,
  BrokerPosition,
  BrokerOpenOrder,
  BrokerMode
} from '../../types/broker.js';

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBrokerMode(): BrokerMode {
  return env.ALPACA_BASE_URL.includes('paper') ? 'paper' : 'live';
}

export function normalizeAccount(raw: AlpacaAccount): BrokerAccountSummary {
  const equity = toNumber(raw.equity);
  const lastEquity = toNumber(raw.last_equity);
  const dayPnL = equity - lastEquity;
  const dayPnLPct = lastEquity !== 0 ? dayPnL / lastEquity : null;

  return {
    broker: 'alpaca',
    mode: getBrokerMode(),
    status: raw.status,
    currency: raw.currency,
    accountNumber: raw.account_number,
    cash: toNumber(raw.cash),
    buyingPower: toNumber(raw.buying_power),
    equity,
    portfolioValue: toNumber(raw.portfolio_value),
    lastEquity,
    dayPnL,
    dayPnLPct,
    tradingBlocked: raw.trading_blocked
  };
}

export function normalizePosition(raw: AlpacaPosition): BrokerPosition {
  return {
    broker: 'alpaca',
    assetId: raw.asset_id,
    symbol: raw.symbol,
    side: raw.side,
    qty: toNumber(raw.qty),
    avgEntryPrice: toNumber(raw.avg_entry_price),
    currentPrice: toNumber(raw.current_price),
    marketValue: toNumber(raw.market_value),
    costBasis: toNumber(raw.cost_basis),
    unrealizedPnL: toNumber(raw.unrealized_pl),
    unrealizedPnLPct: toNumber(raw.unrealized_plpc)
  };
}

export function normalizeOpenOrder(raw: AlpacaOrder): BrokerOpenOrder {
  return {
    broker: 'alpaca',
    id: raw.id,
    clientOrderId: raw.client_order_id,
    symbol: raw.symbol,
    side: raw.side,
    orderType: raw.type,
    timeInForce: raw.time_in_force,
    qty: toNullableNumber(raw.qty),
    notional: toNullableNumber(raw.notional),
    limitPrice: toNullableNumber(raw.limit_price),
    stopPrice: toNullableNumber(raw.stop_price),
    status: raw.status,
    submittedAt: raw.submitted_at,
    filledQty: toNumber(raw.filled_qty),
    filledAvgPrice: toNullableNumber(raw.filled_avg_price)
  };
}