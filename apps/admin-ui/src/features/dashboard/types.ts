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
  killSwitchEnabled: boolean;
  maxDailyEntryOrders: number | null;
  maxDailyEntryNotional: number | null;
  maxOpenPositions: number | null;
  maxTotalOpenNotional: number | null;
  maxSymbolOpenNotional: number | null;
  maxSubscriptionOpenNotional: number | null;
  entrySessionGuardEnabled: boolean;
  entryStartMinutesAfterOpen: number;
  entryCutoffMinutesBeforeClose: number | null;
  failClosedOnMarketClockError: boolean;
  reconciliationWorkerEnabled: boolean;
  reconciliationWorkerIntervalMinutes: number;
};

export type RiskStatus = {
  canEnter: boolean;
  reasons: string[];
  broker: {
    name: string;
    mode: "paper" | "live";
    expectedMode: "paper" | "live";
    tradingBlocked: boolean;
  };
  limits: {
    maxDailyEntryOrders: number | null;
    maxDailyEntryNotional: number | null;
    maxOpenPositions: number | null;
    maxTotalOpenNotional: number | null;
    maxSymbolOpenNotional: number | null;
    maxSubscriptionOpenNotional: number | null;
  };
  entrySession: {
    enabled: boolean;
    status:
      | "disabled"
      | "allowed"
      | "market_closed"
      | "open_buffer"
      | "close_buffer"
      | "unavailable"
      | "degraded"
      | "invalid_window";
    canEnterNow: boolean;
    marketOpen: boolean | null;
    evaluatedAt: string;
    sessionOpenAt: string | null;
    entryAllowedAt: string | null;
    entryCutoffAt: string | null;
    sessionCloseAt: string | null;
    nextOpenAt: string | null;
    nextCloseAt: string | null;
    openingBufferMinutes: number;
    closingBufferMinutes: number | null;
    failClosed: boolean;
    degraded: boolean;
    rule: string | null;
    error: { name: string; message: string } | null;
  };
  usage: {
    dailyEntryOrderCount: number;
    dailyEntryNotional: number;
    activePositionCount: number;
    totalOpenNotional: number;
    activeSymbols: string[];
  };
};

export type BootstrapResponse = {
  account: BrokerAccountSummary;
  positions: BrokerPosition[];
  openOrders: BrokerOpenOrder[];
  config: RuntimeTradingConfig;
  risk: RiskStatus;
};

export type IndexPerformanceSymbol = {
  symbol: "SPY" | "QQQ" | "DIA" | "IWM";
  lastPrice: number | null;
  todayChange: number | null;
  todayChangePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  previousClose: number | null;
  marketStatus: string | null;
  updatedTime: string | null;
};

export type IndexPerformanceResponse = {
  marketStatus: string | null;
  serverTime: string | null;
  updatedAt: string;
  symbols: IndexPerformanceSymbol[];
};

export type IndexChartRange = "1d" | "7d" | "14d" | "30d" | "6m" | "1y";

export type IndexIntradayPoint = {
  time: string;
  close: number;
};

export type IndexChartSummary = {
  open: number | null;
  close: number | null;
  change: number | null;
  changePercent: number | null;
  high: number | null;
  low: number | null;
};

export type IndexIntradaySymbol = {
  symbol: "SPY" | "QQQ" | "DIA" | "IWM";
  from: string | null;
  to: string | null;
  summary: IndexChartSummary;
  points: IndexIntradayPoint[];
};

export type IndexIntradayResponse = {
  updatedAt: string;
  range: IndexChartRange;
  rangeLabel: string;
  interval: {
    multiplier: number;
    timespan: string;
  };
  symbols: IndexIntradaySymbol[];
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
