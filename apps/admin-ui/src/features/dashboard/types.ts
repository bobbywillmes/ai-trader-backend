export type BrokerAccountSummary = {
  cash: number;
  buyingPower: number;
  equity: number;
  portfolioValue: number;
  lastEquity: number;
  dayPnL: number;
  dayPnLPct: number;
  tradingBlocked: boolean;
  mode: "paper" | "live";
  status: string;
  currency: string;
  accountNumber: string;
};

export type BrokerPosition = {
  symbol: string;
  side: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
};

export type BrokerOpenOrder = {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: string;
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

export type RuntimeTradingConfig = {
  tradingEnabled: boolean;
  paperMode: boolean;
};

export type RiskStatus = {
  canTrade: boolean;
  reason: string | null;
};

export type BootstrapResponse = {
  account: BrokerAccountSummary;
  positions: BrokerPosition[];
  openOrders: BrokerOpenOrder[];
  config: RuntimeTradingConfig;
  risk: RiskStatus;
};

export type SystemEvent = {
  id: number;
  type: string;
  entityType: string | null;
  entityId: string | null;
  payloadJson: string | null;
  processed: boolean;
  createdAt: string;
};
