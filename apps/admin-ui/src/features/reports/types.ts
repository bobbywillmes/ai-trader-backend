export type AccountSnapshot = {
  id: number;
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
  dayPnL: number | null;
  dayPnLPct: number | null;
  tradingBlocked: boolean;

  snapshotHash: string;
  changed: boolean;
  rawJson: unknown;
  createdAt: string;
};

export type AccountSnapshotsResponse = {
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

export type TradePerformanceResponse = {
  generatedAt: string;
  filters: {
    dateFrom: string | null;
    dateTo: string | null;
    strategyId: number | null;
    subscriptionId: number | null;
    exitProfileId: number | null;
    mode: string | null;
    limit: number;
  };
  summary: TradePerformanceSummary;
  groups: {
    byStrategy: TradePerformanceGroup[];
    bySubscription: TradePerformanceGroup[];
    byExitProfile: TradePerformanceGroup[];
    bySecurity: TradePerformanceGroup[];
    byExitReason: TradePerformanceGroup[];
  };
};

export type TradePerformanceQuery = {
  limit?: number;
  mode?: string;
  dateFrom?: string;
  dateTo?: string;
  strategyId?: number;
  subscriptionId?: number;
  exitProfileId?: number;
};
