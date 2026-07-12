import type { TradingAccountSummary } from "../../types/tradingAccount";

export type AccountSnapshot = {
  id: number;
  tradingAccountId: number | null;
  tradingAccount: TradingAccountSummary | null;
  broker: string;
  mode: string;
  accountStatus: string | null;
  currency: string | null;
  accountNumber: string | null;

  reason: string;
  runKey: string | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;

  cash: number;
  buyingPower: number;
  equity: number;
  portfolioValue: number;
  lastEquity: number | null;
  longMarketValue: number | null;
  shortMarketValue: number | null;
  dayPnL: number | null;
  dayPnLPct: number | null;
  tradingBlocked: boolean;

  snapshotHash: string;
  changed: boolean;
  rawJson: unknown;
  createdAt: string;
  exposure: {
    longExposure: number | null;
    shortExposure: number | null;
    grossExposure: number | null;
    netExposure: number | null;
    grossExposurePct: number | null;
  };
};

export type AccountSnapshotsResponse = {
  snapshots: AccountSnapshot[];
};

export type AccountSnapshotQuery = {
  limit?: number;
  mode?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type AccountSnapshotTrendsResponse = {
  generatedAt: string;
  filters: {
    dateFrom: string | null;
    dateTo: string | null;
    mode: string | null;
    limit: number;
  };
  snapshots: AccountSnapshot[];
};

export type ManualAccountSnapshotResponse = {
  created: boolean;
  skipped: boolean;
  reason: string;
  snapshot: AccountSnapshot;
};

export type BrokerActivity = {
  id: number;
  tradingAccountId: number | null;
  tradingAccount: TradingAccountSummary | null;
  broker: string;
  mode: string;

  activityId: string;
  activityType: string;
  activityCategory: string | null;

  symbol: string | null;
  side: string | null;

  qty: number | null;
  cumQty: number | null;
  leavesQty: number | null;
  price: number | null;
  netAmount: number | null;

  orderId: string | null;
  orderIntentId: number | null;
  brokerOrderRecordId: number | null;

  transactionTime: string | null;
  rawBrokerJson: unknown;

  createdAt: string;
  updatedAt: string;
};

export type BrokerActivitiesResponse = {
  activities: BrokerActivity[];
};

export type BrokerActivitySyncResponse = {
  broker: string;
  mode: string;
  activityType: string;
  after: string;
  seen: number;
  created: number;
  updated: number;
};

export type BrokerActivitiesQuery = {
  limit?: number;
  symbol?: string;
  activityType?: string;
};

export type TradePerformanceGroup = {
  id: string;
  label: string;
  tradeCount: number;
  reportableTradeCount: number;
  totalRealizedPnl: number;
  averageReturnPct: number | null;
  winRate: number | null;
  winnerCount: number;
  loserCount: number;
  averageWinner: number | null;
  averageLoser: number | null;
  profitFactor: number | null;
  averageHoldingDurationMs: number | null;
};

export type TradePerformanceSummary = Omit<
  TradePerformanceGroup,
  "id" | "label"
>;

export type TradePerformanceOutcome = "all" | "winner" | "loser" | "breakeven";
export type TradePerformanceSortBy =
  | "closedAt"
  | "openedAt"
  | "symbol"
  | "realizedPnl"
  | "returnPct"
  | "holdingDurationMs";
export type TradePerformanceSortDirection = "asc" | "desc";

export type TradePerformanceTradeRow = {
  id: number;
  tradingAccountId: number | null;
  tradingAccount: TradingAccountSummary | null;
  symbol: string;
  side: string;
  mode: string | null;
  openedAt: string;
  closedAt: string | null;
  quantity: number;
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  realizedPnl: number | null;
  returnPct: number | null;
  holdingDurationMs: number | null;
  strategy: {
    id: number | null;
    key: string | null;
    name: string | null;
  } | null;
  subscription: {
    id: number | null;
    key: string | null;
    name: string | null;
    brokerMode?: string | null;
  } | null;
  exitProfile: {
    id: number | null;
    key: string | null;
    name: string | null;
  } | null;
  entryDecision: {
    id: number;
    decisionKey: string;
    evaluatedAt: string;
    source: string;
    decisionState: string;
    decisionReason: string | null;
    signalCreated: boolean;
    signalBlocked: boolean;
    blockingReason: string | null;
    persistenceReason: string;
  } | null;
  exitReason: string | null;
};

export type TradePerformanceResponse = {
  generatedAt: string;
  filters: {
    dateFrom: string | null;
    dateTo: string | null;
    symbol: string | null;
    strategyId: number | null;
    subscriptionId: number | null;
    exitProfileId: number | null;
    exitReason: string | null;
    outcome: TradePerformanceOutcome;
    mode: string | null;
    limit: number | null;
    page: number;
    pageSize: number;
    sortBy: TradePerformanceSortBy;
    sortDirection: TradePerformanceSortDirection;
  };
  summary: TradePerformanceSummary;
  groups: {
    byStrategy: TradePerformanceGroup[];
    bySubscription: TradePerformanceGroup[];
    byExitProfile: TradePerformanceGroup[];
    bySecurity: TradePerformanceGroup[];
    byExitReason: TradePerformanceGroup[];
    byEntryDecisionState: TradePerformanceGroup[];
  };
  trades: TradePerformanceTradeRow[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

export type TradePerformanceQuery = {
  mode?: string;
  dateFrom?: string;
  dateTo?: string;
  symbol?: string;
  strategyId?: number;
  subscriptionId?: number;
  exitProfileId?: number;
  exitReason?: string;
  outcome?: TradePerformanceOutcome;
  page?: number;
  pageSize?: number;
  sortBy?: TradePerformanceSortBy;
  sortDirection?: TradePerformanceSortDirection;
};
