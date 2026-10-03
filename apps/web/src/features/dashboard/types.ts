import type { TradingAccountSummary } from "../../types/tradingAccount";

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

export type DashboardAccountIdentity = {
  id: number;
  displayName: string;
  accountHolderName: string;
  broker: string;
  environment: "PAPER" | "LIVE";
  status: string;
  baseCurrency: string;
  brokerAccountNumberMasked: string | null;
  brokerAccountStatus: string | null;
};
export type DashboardCredentials = {
  exists: boolean;
  status: string;
  usable: boolean;
  verifiedAt: string | null;
  lastFailedAt: string | null;
  revokedAt: string | null;
};
export type EntryReadiness = {
  status: "READY" | "READY_WITH_WARNINGS" | "BLOCKED" | "UNAVAILABLE";
  canEnter: boolean;
  blockers: string[];
  warnings: string[];
  evaluatedAt: string;
  entrySession: RiskStatus["entrySession"] | null;
  usage: null | {
    dailyEntryOrderCount: number;
    dailyEntryNotional: number;
    activePositionCount: number;
    openPositionNotional: number;
    pendingEntryNotional: number;
    totalOpenNotional: number;
    activeSymbols: string[];
  };
  systemBlockers: {
    tradingEnabled: boolean | null;
    killSwitchEnabled: boolean | null;
  };
};
export type TradingAccountDashboardResponse = {
  account: DashboardAccountIdentity;
  credentials: DashboardCredentials;
  safety: { tradingEnabled: boolean; killSwitchEnabled: boolean };
  broker: {
    available: boolean;
    observedAt: string | null;
    account: BrokerAccountSummary | null;
    error?: string;
  };
  exposure: {
    openPositionNotional: number | null;
    pendingEntryNotional: number | null;
    openPositionCount: number | null;
    openOrderCount: number | null;
    positions: BrokerPosition[] | null;
    openOrders: BrokerOpenOrder[] | null;
  };
  readiness: EntryReadiness;
  partialFailures: Record<string, string>;
};
export type DashboardOverviewRow = {
  account: DashboardAccountIdentity;
  credentials: DashboardCredentials;
  safety: { tradingEnabled: boolean; killSwitchEnabled: boolean };
  readiness: {
    status: "READY" | "BLOCKED" | "UNAVAILABLE";
    primaryBlocker: string | null;
    blockers: string[];
  };
  exposure: {
    openPositionCount: number;
    openOrderCount: number;
    openPositionNotional: number;
  };
  financialSnapshot: null | {
    portfolioValue: number;
    equity: number;
    cash: number;
    buyingPower: number;
    dayPnL: number | null;
    dayPnLPct: number | null;
  };
  freshness: { observedAt: string | null; stale: boolean; available: boolean };
};
export type DashboardAccountsOverviewResponse = {
  generatedAt: string;
  summary: {
    tradingAccountCount: number;
    paperCount: number;
    liveCount: number;
    readyCount: number;
    blockedCount: number;
    unavailableCount: number;
    attentionCount: number;
    openPositionCount: number;
    openOrderCount: number;
  };
  accounts: DashboardOverviewRow[];
};

export type DashboardEtfSymbol = "SPY" | "QQQ" | "DIA" | "IWM";

export type DashboardReferencePrice = {
  symbol: DashboardEtfSymbol;
  provider: "TIINGO_CONSOLIDATED";
  price: number | null;
  basis: "TIINGO_TNGO_LAST" | "TIINGO_LQ_REF_PRICE" | null;
  observedAt: string | null;
  fetchedAt: string;
  freshness: "FRESH" | "STALE" | "UNKNOWN" | "FUTURE";
  available: boolean;
  unavailableReason: string | null;
  providerError: string | null;
};
export type DashboardReferencePricesResponse = { symbols: DashboardReferencePrice[] };

export type DashboardMarketSymbol = {
  symbol: DashboardEtfSymbol;
  referencePrice: DashboardReferencePrice;
  observationPhase: "PREMARKET" | "REGULAR" | "POSTMARKET" | "CLOSED" | "UNKNOWN";
  previousClose: { sessionDate: string | null; close: number | null; source: "TIINGO_REGULAR_MINUTE"; reason: string | null };
  splitCompatibility: { status: "SAME_SESSION" | "COMPARABLE" | "SPLIT_BOUNDARY" | "UNRESOLVED" | "NOT_EVALUATED";
    fromSession: string | null; throughSession: string | null; eventIds: string[]; executionDates: string[]; reason: string | null };
  regularSession: { sessionDate: string; state: "PARTIAL" | "COMPLETE" | "UNAVAILABLE";
    high: number | null; low: number | null; close: number | null; observedThrough: string | null;
    reason: string | null; source: "TIINGO_REGULAR_MINUTE" } | null;
  change: number | null;
  changePercent: number | null;
  changeReason: string | null;
  rangePosition: number | null;
  rangeReason: string | null;
};
export type DashboardMarketStateResponse = { updatedAt: string; symbols: DashboardMarketSymbol[] };

export type SystemEvent = {
  id: number;
  tradingAccountId: number | null;
  tradingAccount: TradingAccountSummary | null;
  type: string;
  entityType: string | null;
  entityId: string | null;
  payloadJson: unknown;
  severity: "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  createdAt: string;
};

export type SystemEventsResponse = {
  events: SystemEvent[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};
