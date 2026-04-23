export type AlpacaAccount = {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
  trading_blocked: boolean;
};

export type AlpacaPosition = {
  asset_id: string;
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  current_price: string;
  side: 'long' | 'short';
};

export type AlpacaOrder = {
  id: string;
  client_order_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  time_in_force: string;
  qty?: string;
  notional?: string;
  limit_price?: string | null;
  stop_price?: string | null;
  status: string;
  submitted_at: string;
  filled_qty?: string;
  filled_avg_price?: string | null;
};