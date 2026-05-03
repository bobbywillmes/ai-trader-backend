export type AdminUser = {
  id: number;
  email: string;
  role: string;
  enabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminSession = {
  id: number;
  adminUserId: number;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
};

export type LoginResponse = {
  ok: true;
  token: string;
  tokenType: 'Bearer';
  adminUser: AdminUser;
  session: AdminSession;
};

export type MeResponse = {
  ok: true;
  adminUser: AdminUser;
  session: AdminSession;
};

export type Strategy = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  allowedSymbolsJson: string[] | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ExitProfile = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  targetPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  maxHoldDays: number | null;
  exitMode: string;
  takeProfitBehavior: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Subscription = {
  id: number;
  key: string;
  name: string;
  symbol: string;
  broker: string;
  brokerMode: string;
  sizingType: string;
  sizingValue: number;
  enabled: boolean;
  strategyId: number;
  exitProfileId: number;
  createdAt: string;
  updatedAt: string;
  strategy?: Strategy;
  exitProfile?: ExitProfile;
};

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
  subscription?: Subscription | null;
};

export type OpenOrder = {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty?: string | number | null;
  filled_qty?: string | number | null;
  filledQty?: string | number | null;
  limit_price?: string | number | null;
  limitPrice?: string | number | null;
  stop_price?: string | number | null;
  stopPrice?: string | number | null;
  status: string;
  submitted_at?: string | null;
  submittedAt?: string | null;
  client_order_id?: string | null;
  clientOrderId?: string | null;
};