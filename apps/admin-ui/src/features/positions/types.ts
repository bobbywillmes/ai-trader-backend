import type { TradingAccountSummary } from "../../types/tradingAccount";

export type PositionExitState = {
  id?: number;
  trackedPositionId?: number;

  status?: string | null;
  exitProfileKey?: string | null;
  exitMode: string | null;
  takeProfitBehavior?: string | null;

  targetPct?: number | null;
  trailingStopPct?: number | null;

  targetUnlocked?: boolean;
  targetUnlockedAt?: string | null;
  targetUnlockedPrice?: number | null;
  targetUnlockedPnlPct?: number | null;

  highWaterMark?: number | null;
  trailStopPrice?: number | null;

  trailBroker?: string | null;
  trailBrokerOrderId?: string | null;
  trailClientOrderId?: string | null;
  trailOrderStatus?: string | null;

  attentionRequired?: boolean;
  attentionCode?: string | null;
  attentionMessage?: string | null;
  attentionAt?: string | null;
  attentionClearedAt?: string | null;

  // Legacy/current UI fields kept as optional so existing code remains safe.
  exitTarget?: number | null;
  exitSubmittedAt?: string | null;
  exitStatus?: string | null;
};

export type TrackedPosition = {
  id: number;
  tradingAccountId: number | null;
  tradingAccount: TradingAccountSummary | null;
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

  exitState: PositionExitState | null;
};
