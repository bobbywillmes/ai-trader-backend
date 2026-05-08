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
