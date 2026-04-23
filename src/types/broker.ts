export type BrokerMode = 'paper' | 'live';

export type BrokerAccountSummary = {
  broker: 'alpaca';
  mode: BrokerMode;
  status: string;
  currency: string;
  accountNumber: string;
  cash: number;
  buyingPower: number;
  equity: number;
  portfolioValue: number;
  lastEquity: number;
  dayPnL: number;
  dayPnLPct: number | null;
  tradingBlocked: boolean;
};

export type BrokerPosition = {
  broker: 'alpaca';
  assetId: string;
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
};

export type BrokerOpenOrder = {
  broker: 'alpaca';
  id: string;
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderType: string;
  timeInForce: string;
  qty: number | null;
  notional: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  status: string;
  submittedAt: string;
  filledQty: number;
  filledAvgPrice: number | null;
};