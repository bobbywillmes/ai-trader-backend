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

export type SecuritiesQueryParams = {
  page: number;
  pageSize: number;
  search?: string;
  sector?: string;
  industry?: string;
};

export type SecuritiesResponse = {
  securities: Security[];
  data: Security[];
  pagination: SecuritiesPagination;
  filters: SecuritiesFilters;
};
