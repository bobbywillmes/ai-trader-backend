export type TradeCycleSummary = {
  id: number;
  broker: string;
  symbol: string;
  side: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  quantity: number;
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  realizedPnl: number | null;
  returnPct: number | null;
  holdingDurationMs: number | null;
  entryFillQty: number | null;
  closeFillQty: number | null;
  strategy: {
    id: number;
    key: string;
    name: string;
  } | null;
  subscription: {
    id: number;
    key: string;
    name: string;
    brokerMode: string;
  } | null;
  exitProfile: {
    id: number;
    key: string;
    name: string;
  } | null;
  exitReason: string | null;
  exitStateStatus: string | null;
};

export type TradeCycleTimelineItem = {
  type: string;
  occurredAt: string;
  source: string;
  summary: string;
  entityId: number | null;
};

export type TradeCycleOrderIntent = {
  id: number;
  source: string;
  symbol: string;
  side: string;
  orderType: string;
  timeInForce: string;
  qty: number | null;
  notional: number | null;
  limitPrice: number | null;
  extendedHours: boolean;
  clientOrderId: string | null;
  status: string;
  blockReason: string | null;
  rawRequestJson: unknown;
  createdAt: string;
  updatedAt: string;
  subscriptionId: number | null;
  subscriptionKey: string | null;
  trackedPositionId: number | null;
  brokerOrders: TradeCycleBrokerOrder[];
};

export type TradeCycleBrokerOrder = {
  id: number;
  orderIntentId: number;
  broker: string;
  brokerOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: string;
  status: string;
  rawBrokerJson: unknown;
  createdAt: string;
  updatedAt: string;
  securityId: number;
  trackedPositionId: number | null;
};

export type TradeCycleBrokerActivity = {
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
  trackedPositionId: number | null;
  trackedPositionLinkSource: string | null;
  trackedPositionLinkedAt: string | null;
  transactionTime: string | null;
  rawBrokerJson: unknown;
  createdAt: string;
  updatedAt: string;
};

export type TradeCycleSystemEvent = {
  id: number;
  type: string;
  entityType: string;
  entityId: string;
  message: string | null;
  payloadJson: unknown;
  processed: boolean;
  createdAt: string;
};

export type TradeCycleDetail = TradeCycleSummary & {
  rawPositionJson: unknown;
  configSnapshotJson: unknown;
  configSnapshotCapturedAt: string | null;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  exitState: unknown;
  orderIntents: TradeCycleOrderIntent[];
  brokerOrders: TradeCycleBrokerOrder[];
  brokerActivities: TradeCycleBrokerActivity[];
  systemEvents: TradeCycleSystemEvent[];
  timeline: TradeCycleTimelineItem[];
};

export type TradeCyclesResponse = {
  cycles: TradeCycleSummary[];
};

export type TradeCycleDetailResponse = {
  cycle: TradeCycleDetail;
};

export type TradeCyclesQuery = {
  limit?: number;
  symbol?: string;
  status?: "open" | "closing" | "closed";
  dateFrom?: string;
  dateTo?: string;
  strategyId?: number;
  subscriptionId?: number;
  exitProfileId?: number;
  exitReason?: string;
  mode?: string;
};
