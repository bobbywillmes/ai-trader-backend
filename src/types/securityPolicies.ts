import { STRATEGY_KEYS, type StrategyKey } from './strategies.js';

export const SECURITY_ASSET_TYPES = {
  ETF: 'ETF',
  STOCK: 'STOCK',
} as const;

export type SecurityAssetType =
  (typeof SECURITY_ASSET_TYPES)[keyof typeof SECURITY_ASSET_TYPES];

export const SUBSCRIPTION_RISK_MODES = {
  CONSERVATIVE: 'conservative',
  CORE: 'core',
  AGGRESSIVE: 'aggressive',
  AI_CONFIRMED: 'ai_confirmed',
  TEST: 'test',
} as const;

export type SubscriptionRiskMode =
  (typeof SUBSCRIPTION_RISK_MODES)[keyof typeof SUBSCRIPTION_RISK_MODES];

export type SecurityAssetPolicy = {
  assetType: SecurityAssetType;
  label: string;
  description: string;
  allowedStrategies: readonly StrategyKey[];
  defaultDipStrategyKey: StrategyKey;
  seededRiskModes: readonly SubscriptionRiskMode[];
  allowsAiConfirmedDip: boolean;
  requiresCompanyNewsContext: boolean;
  allowsAutomatedDoubleDown: boolean;
  notes: readonly string[];
};

export const SECURITY_ASSET_POLICIES: Record<
  SecurityAssetType,
  SecurityAssetPolicy
> = {
  [SECURITY_ASSET_TYPES.ETF]: {
    assetType: SECURITY_ASSET_TYPES.ETF,
    label: 'ETF',
    description:
      'Exchange-traded fund strategies are primarily broad-market or sector exposure trades.',
    allowedStrategies: [
      STRATEGY_KEYS.DIP_N_RIDE_ETF,
      STRATEGY_KEYS.MOMENTUM_ETF,
      STRATEGY_KEYS.QUICK_TEST_MOMENTUM,
    ],
    defaultDipStrategyKey: STRATEGY_KEYS.DIP_N_RIDE_ETF,
    seededRiskModes: [
      SUBSCRIPTION_RISK_MODES.CONSERVATIVE,
      SUBSCRIPTION_RISK_MODES.CORE,
      SUBSCRIPTION_RISK_MODES.AGGRESSIVE,
      SUBSCRIPTION_RISK_MODES.TEST,
    ],
    allowsAiConfirmedDip: false,
    requiresCompanyNewsContext: false,
    allowsAutomatedDoubleDown: false,
    notes: [
      'ETF dip strategies can be more mechanical than single-stock dip strategies.',
      'ETF momentum may be production-eligible earlier than stock momentum, but should still require dedicated exit profiles.',
      'AI-confirmed dip subscriptions are not seeded for ETFs.',
    ],
  },

  [SECURITY_ASSET_TYPES.STOCK]: {
    assetType: SECURITY_ASSET_TYPES.STOCK,
    label: 'Stock',
    description:
      'Single-stock strategies carry company-specific risk and require stricter context checks.',
    allowedStrategies: [
      STRATEGY_KEYS.DIP_N_RIDE_STOCK,
      STRATEGY_KEYS.MOMENTUM_STOCK,
      STRATEGY_KEYS.AI_CONFIRMED_DIP_STOCK,
      STRATEGY_KEYS.QUICK_TEST_MOMENTUM,
    ],
    defaultDipStrategyKey: STRATEGY_KEYS.DIP_N_RIDE_STOCK,
    seededRiskModes: [
      SUBSCRIPTION_RISK_MODES.CONSERVATIVE,
      SUBSCRIPTION_RISK_MODES.CORE,
      SUBSCRIPTION_RISK_MODES.AGGRESSIVE,
      SUBSCRIPTION_RISK_MODES.AI_CONFIRMED,
      SUBSCRIPTION_RISK_MODES.TEST,
    ],
    allowsAiConfirmedDip: true,
    requiresCompanyNewsContext: true,
    allowsAutomatedDoubleDown: false,
    notes: [
      'Single-stock dip trades should account for company-specific news, earnings, downgrades, and sector weakness.',
      'AI-confirmed dip is currently an entry filter, not an AI-managed exit.',
      'Failed momentum trades should not be averaged down.',
    ],
  },
};

export function isSecurityAssetType(value: string): value is SecurityAssetType {
  return value === SECURITY_ASSET_TYPES.ETF || value === SECURITY_ASSET_TYPES.STOCK;
}

export function getSecurityAssetPolicy(
  assetType: string,
): SecurityAssetPolicy {
  if (!isSecurityAssetType(assetType)) {
    throw new Error(`Unsupported security asset type: ${assetType}`);
  }

  return SECURITY_ASSET_POLICIES[assetType];
}

export function getDefaultDipStrategyForAssetType(
  assetType: string,
): StrategyKey {
  return getSecurityAssetPolicy(assetType).defaultDipStrategyKey;
}

export function isStrategyAllowedForAssetType(
  assetType: string,
  strategyKey: StrategyKey,
): boolean {
  return getSecurityAssetPolicy(assetType).allowedStrategies.includes(strategyKey);
}

export function assertStrategyAllowedForAssetType(
  assetType: string,
  strategyKey: StrategyKey,
): void {
  const policy = getSecurityAssetPolicy(assetType);

  if (!policy.allowedStrategies.includes(strategyKey)) {
    throw new Error(
      `Strategy "${strategyKey}" is not allowed for asset type "${assetType}".`,
    );
  }
}