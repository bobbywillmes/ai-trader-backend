export type StrategyTradingAccount = {
  id: number;
  displayName: string;
};

export type StrategyExitProfileUsage = {
  id: number;
  key: string;
  name: string;
  subscriptionCount: number;
};

export type Strategy = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  allowedSymbolsJson?: unknown;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  subscriptionCount: number;
  activeSubscriptionCount: number;
  symbols: string[];
  tradingAccounts: StrategyTradingAccount[];
  exitProfiles: StrategyExitProfileUsage[];
};

export type StrategyChangeImpact = {
  strategyId: number;
  currentEnabled: boolean;
  totalSubscriptions: number;
  enabledSubscriptions: number;
  disabledSubscriptions: number;
  distinctSymbols: number;
  distinctTradingAccounts: number;
  enabledMomentumSubscriptions: number;
  enablingCouldMakeMomentumSubscriptionsEligible: boolean;
  disablingMakesEnabledMomentumSubscriptionsIneligible: boolean;
  effects: string[];
};

export type StrategySubscription = {
  id: number;
  key: string;
  name: string;
  symbol: string;
  enabled: boolean;
  security: { name: string };
  exitProfile: { id: number; key: string; name: string };
  accountSubscriptions: Array<{
    id: number;
    enabled: boolean;
    entriesEnabled: boolean;
    sizingType: string;
    fixedQty: number | null;
    maxPositionNotional: number | null;
    tradingAccount: StrategyTradingAccount & { status: string };
    allocation: {
      id: number;
      key: string;
      name: string;
      enabled: boolean;
    } | null;
  }>;
};

export type StrategyDetail = {
  strategy: Pick<
    Strategy,
    "id" | "key" | "name" | "description" | "enabled" | "createdAt" | "updatedAt"
  >;
  usage: {
    totalSubscriptions: number;
    enabledSubscriptions: number;
    disabledSubscriptions: number;
    symbols: string[];
    tradingAccounts: StrategyTradingAccount[];
    exitProfiles: StrategyExitProfileUsage[];
  };
  subscriptions: {
    data: StrategySubscription[];
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  };
  implications: {
    momentumStrategy: boolean;
    enabledMomentumSubscriptions: number;
    currentlyQualifyingMomentumSubscriptions: number;
    eligibilityMessage: string | null;
  };
};

export type StrategyUpdateResult = {
  strategy: StrategyDetail["strategy"];
  changed: boolean;
  impact: StrategyChangeImpact;
};
