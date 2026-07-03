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
  totalOpenPositionNotional: number;
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

export type TradingAccountRiskSettings = {
  id: number;
  tradingAccountId: number;
  enabled: boolean;
  maxDailyEntryOrders: number | null;
  maxDailyEntryNotional: number | null;
  maxOpenPositions: number | null;
  maxTotalOpenNotional: number | null;
  maxSymbolOpenNotional: number | null;
  maxSubscriptionOpenNotional: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TradingAccountRiskSettingsResponse = {
  riskSettings: TradingAccountRiskSettings;
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

export type EntryRiskPreviewLayer =
  | "global"
  | "account"
  | "allocation"
  | "subscription"
  | "session"
  | "unknown"
  | null;

export type EntryRiskPreview = {
  ok: boolean;
  wouldSubmitIfSessionAllowed: boolean;
  tradingAccount: {
    id: number;
    displayName: string;
    broker: TradingBroker;
    environment: TradingAccountEnvironment;
    status: TradingAccountStatus;
  };
  subscription: {
    id: number;
    key: string;
    symbol: string;
    enabled: boolean;
  };
  accountSubscription: {
    id: number;
    enabled: boolean;
    entriesEnabled: boolean;
    exitsEnabled: boolean;
    allocationId: number | null;
    sizingType: PositionSizingType;
  } | null;
  allocation: {
    id: number;
    key: string;
    name: string;
    enabled: boolean;
    maxAllocatedNotional: number | null;
    maxOpenPositions: number | null;
    maxPositionNotional: number | null;
  } | null;
  sizing: {
    ok: boolean;
    code: string | null;
    message: string | null;
    sizingType: PositionSizingType | null;
    fixedQty: number | null;
    maxPositionNotional: number | null;
    minPositionNotional: number | null;
    maxQty: number | null;
    latestPrice: number | null;
    latestPriceAt: string | null;
    latestPriceSource: string | null;
    calculatedQty: number | null;
    estimatedNotional: number | null;
  };
  risk: {
    ok: boolean;
    code: string | null;
    layer: EntryRiskPreviewLayer;
    message: string | null;
    details: unknown;
  };
  allocationRisk: {
    checked: boolean;
    ok: boolean;
    code: string | null;
    layer: "allocation" | null;
    message: string | null;
    details: unknown;
  };
  session: {
    checked: boolean;
    marketOpen?: boolean | null;
    entryWindowOpen?: boolean;
    wouldBlockRealEntryNow?: boolean;
    code?: string | null;
    message?: string | null;
    note?: string;
    details?: unknown;
  };
  wouldCreateOrderIntent: false;
  wouldSubmitBrokerOrder: false;
};

export type EntryRiskPreviewResponse = {
  preview: EntryRiskPreview;
};

export type EntryRiskPreviewInput = {
  subscriptionKey: string;
  ignoreSession?: boolean;
};

export type AccountSubscriptionMarketContextStatus =
  | "active"
  | "all"
  | "disabled";

export type AccountSubscriptionPriceHistoryRange = "3m" | "6m" | "1y";

export type AccountSubscriptionMarketContextItem = {
  accountSubscriptionId: number;
  subscriptionId: number;
  symbol: string;
  subscriptionKey: string;
  latestPrice: number | null;
  latestPriceAt: string | null;
  latestPriceSource: string | null;
  week52High: number | null;
  week52Low: number | null;
  week52HighAt: string | null;
  week52LowAt: string | null;
  sizingType: PositionSizingType;
  fixedQty: number | null;
  maxPositionNotional: number | null;
  minPositionNotional: number | null;
  maxQty: number | null;
  estimatedQty: number | null;
  estimatedNotional: number | null;
  nextShareQty: number | null;
  nextShareNotional: number | null;
  dollarsToNextShare: number | null;
  warnings: string[];
};

export type AccountSubscriptionMarketContextResponse = {
  tradingAccountId: number;
  generatedAt: string;
  items: AccountSubscriptionMarketContextItem[];
};

export type AccountSubscriptionPriceHistoryCandle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type AccountSubscriptionPriceHistoryResponse = {
  tradingAccountId: number;
  accountSubscriptionId: number;
  subscriptionId: number;
  symbol: string;
  range: AccountSubscriptionPriceHistoryRange;
  generatedAt: string;
  candles: AccountSubscriptionPriceHistoryCandle[];
  summary: {
    latestClose: number | null;
    latestCloseAt: string | null;
    week52High: number | null;
    week52Low: number | null;
  };
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

export type TradingAccountRiskSettingsInput = Partial<{
  enabled: boolean;
  maxDailyEntryOrders: number | null;
  maxDailyEntryNotional: number | null;
  maxOpenPositions: number | null;
  maxTotalOpenNotional: number | null;
  maxSymbolOpenNotional: number | null;
  maxSubscriptionOpenNotional: number | null;
  notes: string | null;
}>;

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
