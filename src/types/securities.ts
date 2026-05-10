export const SECURITY_ASSET_TYPES = ['ETF', 'STOCK'] as const;

export type SecurityAssetType = (typeof SECURITY_ASSET_TYPES)[number];

export type SeedSecurity = {
  symbol: string;
  name: string;
  assetType: SecurityAssetType;
  sector: string | null;
  industry: string | null;
};