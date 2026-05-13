export const STRATEGY_FAMILIES = {
  DIP_MEAN_REVERSION: 'DIP_MEAN_REVERSION',
  MOMENTUM_CONTINUATION: 'MOMENTUM_CONTINUATION',
  AI_CONFIRMED_ENTRY: 'AI_CONFIRMED_ENTRY',
  SYSTEM_TEST: 'SYSTEM_TEST',
} as const;

export type StrategyFamily =
  (typeof STRATEGY_FAMILIES)[keyof typeof STRATEGY_FAMILIES];

export const STRATEGY_ASSET_TYPES = {
  ETF: 'ETF',
  STOCK: 'STOCK',
  ANY: 'ANY',
} as const;

export type StrategyAssetType =
  (typeof STRATEGY_ASSET_TYPES)[keyof typeof STRATEGY_ASSET_TYPES];

export const STRATEGY_KEYS = {
  DIP_N_RIDE_ETF: 'dip_n_ride_etf',
  DIP_N_RIDE_STOCK: 'dip_n_ride_stock',

  MOMENTUM_ETF: 'momentum_etf',
  MOMENTUM_STOCK: 'momentum_stock',

  AI_CONFIRMED_DIP_STOCK: 'ai_confirmed_dip_stock',

  QUICK_TEST_MOMENTUM: 'quick_test_momentum',
} as const;

export type StrategyKey =
  (typeof STRATEGY_KEYS)[keyof typeof STRATEGY_KEYS];

export type StrategyDefinition = {
  key: StrategyKey;
  label: string;
  family: StrategyFamily;
  assetType: StrategyAssetType;
  productionEligible: boolean;
  description: string;
};

export const STRATEGY_DEFINITIONS: Record<StrategyKey, StrategyDefinition> = {
  [STRATEGY_KEYS.DIP_N_RIDE_ETF]: {
    key: STRATEGY_KEYS.DIP_N_RIDE_ETF,
    label: 'Dip & Ride ETF',
    family: STRATEGY_FAMILIES.DIP_MEAN_REVERSION,
    assetType: STRATEGY_ASSET_TYPES.ETF,
    productionEligible: true,
    description:
      'Buys ETF pullbacks when the broader market thesis remains intact.',
  },

  [STRATEGY_KEYS.DIP_N_RIDE_STOCK]: {
    key: STRATEGY_KEYS.DIP_N_RIDE_STOCK,
    label: 'Dip & Ride Stock',
    family: STRATEGY_FAMILIES.DIP_MEAN_REVERSION,
    assetType: STRATEGY_ASSET_TYPES.STOCK,
    productionEligible: true,
    description:
      'Buys single-stock pullbacks when the move appears temporary rather than thesis-breaking.',
  },

  [STRATEGY_KEYS.MOMENTUM_ETF]: {
    key: STRATEGY_KEYS.MOMENTUM_ETF,
    label: 'Momentum ETF',
    family: STRATEGY_FAMILIES.MOMENTUM_CONTINUATION,
    assetType: STRATEGY_ASSET_TYPES.ETF,
    productionEligible: true,
    description:
      'Buys ETF strength when broad-market momentum appears likely to continue.',
  },

  [STRATEGY_KEYS.MOMENTUM_STOCK]: {
    key: STRATEGY_KEYS.MOMENTUM_STOCK,
    label: 'Momentum Stock',
    family: STRATEGY_FAMILIES.MOMENTUM_CONTINUATION,
    assetType: STRATEGY_ASSET_TYPES.STOCK,
    productionEligible: true,
    description:
      'Buys single-stock strength when relative strength and market context support continuation.',
  },

  [STRATEGY_KEYS.AI_CONFIRMED_DIP_STOCK]: {
    key: STRATEGY_KEYS.AI_CONFIRMED_DIP_STOCK,
    label: 'AI-Confirmed Stock Dip',
    family: STRATEGY_FAMILIES.AI_CONFIRMED_ENTRY,
    assetType: STRATEGY_ASSET_TYPES.STOCK,
    productionEligible: true,
    description:
      'Requires AI/news/context confirmation before buying a single-stock dip.',
  },

  [STRATEGY_KEYS.QUICK_TEST_MOMENTUM]: {
    key: STRATEGY_KEYS.QUICK_TEST_MOMENTUM,
    label: 'Quick Test Momentum',
    family: STRATEGY_FAMILIES.SYSTEM_TEST,
    assetType: STRATEGY_ASSET_TYPES.ANY,
    productionEligible: false,
    description:
      'System-test strategy used to verify the full order and exit lifecycle.',
  },
};

export const STRATEGY_LIST = Object.values(STRATEGY_DEFINITIONS);

export function isStrategyKey(value: string): value is StrategyKey {
  return value in STRATEGY_DEFINITIONS;
}

export function getStrategyDefinition(
  strategyKey: StrategyKey,
): StrategyDefinition {
  return STRATEGY_DEFINITIONS[strategyKey];
}