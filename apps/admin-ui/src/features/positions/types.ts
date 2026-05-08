export type TrackedPosition = {
  id: number;
  broker: string;
  symbol: string;
  side: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  status: string;
  openedAt: string;
  lastSyncedAt: string;
  closedAt: string | null;
  subscriptionId: number | null;
  subscription?: {
    key: string;
  } | null;
};
