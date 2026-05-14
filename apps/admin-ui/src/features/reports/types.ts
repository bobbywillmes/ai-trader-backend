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