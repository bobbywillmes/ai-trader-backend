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
  
  trailingUnlocked: boolean;
  trailingUnlockedAt: string | null;
  trailingUnlockedPrice: number | null;

  trailingStopOrderId: string | null;
  trailingStopClientOrderId: string | null;
  trailingStopSubmittedAt: string | null;
  trailingStopStatus: string | null;

  trailingStopTrailPercent: number | null;
  trailingStopHwm: number | null;
  trailingStopStopPrice: number | null;
  trailingStopLastSyncedAt: string | null;

  subscriptionId: number | null;
  subscription?: {
    key: string;
    exitProfile: {
      id: number;
      key: string;
      name: string;
      exitMode: string;
      targetPct: number | null;
    } | null;
  } | null;

  exitState: {
    exitMode: string | null;
    exitTarget: number | null;
    exitSubmittedAt: string | null;
    exitStatus: string | null;
  }
};
