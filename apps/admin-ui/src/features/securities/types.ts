export type AssetType = 'STOCK' | 'ETF' | 'INDEX' | 'FUND' | 'OTHER';

export const ASSET_TYPES: AssetType[] = ['STOCK', 'ETF', 'INDEX', 'FUND', 'OTHER'];

export type Security = {
  id: number;
  symbol: string;
  name: string;
  enabled: boolean;
  assetType: AssetType;
  sector: string | null;
  industry: string | null;
  subscriptionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateSecurityPayload = {
  symbol: string;
  name: string;
  assetType: AssetType;
  sector?: string;
  industry?: string;
};

export type UpdateSecurityPayload = {
  name?: string;
  enabled?: boolean;
  assetType?: AssetType;
  sector?: string;
  industry?: string;
};

export type SecurityForm = {
  symbol: string;
  name: string;
  assetType: string;
  sector: string;
  industry: string;
  enabled: boolean;
};

export type SecuritiesPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type SecuritiesFilters = {
  sectors: string[];
  industries: string[];
};

export type SubscriptionStatusFilter =
  | 'all'
  | 'configured'
  | 'unconfigured';

export type EnabledStatusFilter = 'all' | 'enabled' | 'disabled';

export type SecuritiesQueryParams = {
  page: number;
  pageSize: number;
  search?: string;
  sector?: string;
  industry?: string;
  enabled?: boolean;
  subscriptionStatus?: SubscriptionStatusFilter;
};

export type SecuritiesResponse = {
  securities: Security[];
  data: Security[];
  pagination: SecuritiesPagination;
  filters: SecuritiesFilters;
};

export type SecurityStrategy = {
  id: number;
  key: string;
  name: string;
  enabled: boolean;
};

export type SecurityExitProfile = {
  id: number;
  key: string;
  name: string;
  enabled: boolean;
  targetPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  maxHoldDays: number | null;
  exitMode: string;
  takeProfitBehavior: string;
};

export type SecuritySubscription = {
  id: number;
  key: string;
  name: string;
  symbol: string;
  broker: string;
  brokerMode: string;
  sizingType: 'fixed_qty' | 'dollar_amount';
  sizingValue: number;
  enabled: boolean;
  strategy: SecurityStrategy | null;
  exitProfile: SecurityExitProfile | null;
  createdAt: string;
  updatedAt: string;
};

export type SecurityDetail = Security & {
  subscriptions: SecuritySubscription[];
};

export type SecurityDetailResponse = {
  security: SecurityDetail;
};

export type UpdateSecurityInput = {
  name?: string;
  enabled?: boolean;
  assetType?: string;
  sector?: string | null;
  industry?: string | null;
};

export type SecuritiesSummary = {
  total: number;
  enabled: number;
  disabled: number;
  configured: number;
  unconfigured: number;
  enabledSubscriptions: number;
};

export type SecuritiesSummaryResponse = {
  summary: SecuritiesSummary;
};
