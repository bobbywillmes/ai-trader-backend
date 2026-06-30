export type TradingBroker = "ALPACA";

export type TradingAccountEnvironment = "PAPER" | "LIVE";

export type TradingAccountStatus =
  | "ACTIVE"
  | "PAUSED"
  | "NEEDS_CREDENTIALS"
  | "ERROR"
  | "ARCHIVED";

export type BrokerCredentialStatus =
  | "ACTIVE"
  | "NEEDS_VERIFICATION"
  | "INVALID"
  | "REVOKED";

export type BrokerCredentialAuthType = "API_KEY";

export type PositionSizingType = "FIXED_QTY" | "MAX_NOTIONAL";

export type TradingAccountCredentialSummary = {
  exists: boolean;
  status: BrokerCredentialStatus | null;
  authType: BrokerCredentialAuthType | null;
  keyFingerprint: string | null;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  lastFailedAt: string | null;
  revokedAt: string | null;
};

export type TradingAccount = {
  id: number;
  displayName: string;
  broker: TradingBroker;
  environment: TradingAccountEnvironment;
  status: TradingAccountStatus;
  tradingEnabled: boolean;
  killSwitchEnabled: boolean;
  estimatedTradingCapital: number | null;
  baseCurrency: string;
  brokerAccountId: string | null;
  brokerAccountNumberMasked: string | null;
  brokerAccountStatus: string | null;
  lastBrokerSyncAt: string | null;
  lastCash: number | null;
  lastBuyingPower: number | null;
  lastEquity: number | null;
  lastPortfolioValue: number | null;
  pausedReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  credential: TradingAccountCredentialSummary;
};

export type TradingAccountsListResponse = {
  accounts: TradingAccount[];
};

export type TradingAccountResponse = {
  account: TradingAccount;
};

export type RevokeTradingAccountCredentialResponse = {
  revoked: boolean;
  account: TradingAccount;
};

export type TradingAccountAllocation = {
  id: number;
  tradingAccountId: number;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  maxAllocatedNotional: number | null;
  maxOpenPositions: number | null;
  maxPositionNotional: number | null;
  notes: string | null;
  accountSubscriptionCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type TradingAccountAllocationsResponse = {
  allocations: TradingAccountAllocation[];
};

export type TradingAccountAllocationResponse = {
  allocation: TradingAccountAllocation;
};

export type TradingAccountSubscriptionContext = {
  id: number;
  key: string;
  symbol: string;
  enabled: boolean;
  strategy?: {
    id: number;
    key: string;
    name: string;
  } | null;
  exitProfile?: {
    id: number;
    key: string;
    name: string;
  } | null;
};

export type TradingAccountSubscriptionAllocation = {
  id: number;
  key: string;
  name: string;
  enabled: boolean;
};

export type TradingAccountSubscription = {
  id: number;
  tradingAccountId: number;
  subscriptionId: number;
  allocationId: number | null;
  enabled: boolean;
  entriesEnabled: boolean;
  exitsEnabled: boolean;
  sizingType: PositionSizingType;
  fixedQty: number | null;
  maxPositionNotional: number | null;
  minPositionNotional: number | null;
  maxQty: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  subscription: TradingAccountSubscriptionContext;
  allocation: TradingAccountSubscriptionAllocation | null;
};

export type TradingAccountSubscriptionsResponse = {
  accountSubscriptions: TradingAccountSubscription[];
};

export type TradingAccountSubscriptionResponse = {
  accountSubscription: TradingAccountSubscription;
};

export type UpdateTradingAccountPayload = Partial<{
  displayName: string;
  estimatedTradingCapital: number | null;
  status: TradingAccountStatus;
  tradingEnabled: boolean;
  killSwitchEnabled: boolean;
  pausedReason: string | null;
  notes: string | null;
}>;

export type UpsertTradingAccountCredentialPayload = {
  authType?: BrokerCredentialAuthType;
  apiKey: string;
  apiSecret: string;
};

export type TradingAccountAllocationInput = {
  key: string;
  name: string;
  description?: string | null;
  enabled?: boolean;
  maxAllocatedNotional?: number | null;
  maxOpenPositions?: number | null;
  maxPositionNotional?: number | null;
  notes?: string | null;
};

export type TradingAccountSubscriptionInput = {
  allocationId?: number | null;
  enabled?: boolean;
  entriesEnabled?: boolean;
  exitsEnabled?: boolean;
  sizingType?: PositionSizingType;
  fixedQty?: number | null;
  maxPositionNotional?: number | null;
  minPositionNotional?: number | null;
  maxQty?: number | null;
  notes?: string | null;
};

export type CreateTradingAccountSubscriptionInput =
  TradingAccountSubscriptionInput & {
    subscriptionId: number;
  };
