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

export type TradeCycleDetail = TradeCycleSummary & {
  rawPositionJson: unknown;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  exitState: unknown;
  orderIntents: unknown[];
  brokerOrders: unknown[];
  brokerActivities: unknown[];
  systemEvents: unknown[];
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
