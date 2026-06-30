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
