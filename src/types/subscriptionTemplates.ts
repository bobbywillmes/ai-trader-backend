import { STRATEGY_KEYS, type StrategyKey } from './strategies.js';
import {
  SECURITY_ASSET_TYPES,
  SUBSCRIPTION_RISK_MODES,
  getDefaultDipStrategyForAssetType,
  type SecurityAssetType,
  type SubscriptionRiskMode,
} from './securityPolicies.js';
import {
  EXIT_PROFILE_KEYS,
  getDipExitProfileForAssetTypeAndRiskMode,
  type ExitProfileKey,
} from './exitProfiles.js';

export type SubscriptionTemplateInput = {
  symbol: string;
  assetType: SecurityAssetType;
};

export type SubscriptionSeed = {
  key: string;
  name: string;
  symbol: string;
  strategyKey: StrategyKey;
  exitProfileKey: ExitProfileKey;
  enabled: boolean;
};

function toSymbolKey(symbol: string) {
  return symbol.toLowerCase();
}

function formatSymbolName(symbol: string, label: string) {
  return `${symbol} ${label}`;
}

function buildBaseSubscription({
  symbol,
  keySuffix,
  nameLabel,
  strategyKey,
  exitProfileKey,
  enabled,
}: {
  symbol: string;
  keySuffix: string;
  nameLabel: string;
  strategyKey: StrategyKey;
  exitProfileKey: ExitProfileKey;
  enabled: boolean;
}): SubscriptionSeed {
  return {
    key: `${toSymbolKey(symbol)}_${keySuffix}`,
    name: formatSymbolName(symbol, nameLabel),
    symbol,
    strategyKey,
    exitProfileKey,
    enabled,
  };
}

function getMomentumStrategyForAssetType(assetType: SecurityAssetType): StrategyKey {
  if (assetType === SECURITY_ASSET_TYPES.ETF) {
    return STRATEGY_KEYS.MOMENTUM_ETF;
  }

  if (assetType === SECURITY_ASSET_TYPES.STOCK) {
    return STRATEGY_KEYS.MOMENTUM_STOCK;
  }

  throw new Error(`Unsupported asset type for momentum strategy: ${assetType}`);
}

function getMomentumConservativeExitProfileForAssetType(
  assetType: SecurityAssetType,
): ExitProfileKey {
  if (assetType === SECURITY_ASSET_TYPES.ETF) {
    return EXIT_PROFILE_KEYS.ETF_MOMENTUM_BRACKET;
  }

  if (assetType === SECURITY_ASSET_TYPES.STOCK) {
    return EXIT_PROFILE_KEYS.STOCK_MOMENTUM_FAIL_FAST;
  }

  throw new Error(
    `Unsupported asset type for conservative momentum exit profile: ${assetType}`,
  );
}

function getMomentumCoreExitProfileForAssetType(
  assetType: SecurityAssetType,
): ExitProfileKey {
  if (assetType === SECURITY_ASSET_TYPES.ETF) {
    return EXIT_PROFILE_KEYS.ETF_MOMENTUM_TRAILING;
  }

  if (assetType === SECURITY_ASSET_TYPES.STOCK) {
    return EXIT_PROFILE_KEYS.STOCK_MOMENTUM_TRAILING;
  }

  throw new Error(`Unsupported asset type for core momentum exit profile: ${assetType}`);
}

function buildDipSubscription(
  input: SubscriptionTemplateInput,
  riskMode: SubscriptionRiskMode,
): SubscriptionSeed {
  const { symbol, assetType } = input;
  const strategyKey = getDefaultDipStrategyForAssetType(assetType);
  const exitProfileKey = getDipExitProfileForAssetTypeAndRiskMode(
    assetType,
    riskMode,
  );

  if (riskMode === SUBSCRIPTION_RISK_MODES.CORE) {
    return buildBaseSubscription({
      symbol,
      keySuffix: 'dip_core',
      nameLabel: 'Dip Core',
      strategyKey,
      exitProfileKey,
      enabled: true,
    });
  }

  if (riskMode === SUBSCRIPTION_RISK_MODES.CONSERVATIVE) {
    return buildBaseSubscription({
      symbol,
      keySuffix: 'dip_conservative',
      nameLabel: 'Dip Conservative',
      strategyKey,
      exitProfileKey,
      enabled: false,
    });
  }

  if (riskMode === SUBSCRIPTION_RISK_MODES.AGGRESSIVE) {
    return buildBaseSubscription({
      symbol,
      keySuffix: 'dip_aggressive',
      nameLabel: 'Dip Aggressive',
      strategyKey,
      exitProfileKey,
      enabled: false,
    });
  }

  throw new Error(`Unsupported dip subscription risk mode: ${riskMode}`);
}

function buildMomentumSubscriptions(
  input: SubscriptionTemplateInput,
): SubscriptionSeed[] {
  const { symbol, assetType } = input;
  const strategyKey = getMomentumStrategyForAssetType(assetType);

  return [
    buildBaseSubscription({
      symbol,
      keySuffix: 'momentum_conservative',
      nameLabel: 'Momentum Conservative',
      strategyKey,
      exitProfileKey: getMomentumConservativeExitProfileForAssetType(assetType),
      enabled: false,
    }),
    buildBaseSubscription({
      symbol,
      keySuffix: 'momentum_core',
      nameLabel: 'Momentum Core',
      strategyKey,
      exitProfileKey: getMomentumCoreExitProfileForAssetType(assetType),
      enabled: false,
    }),
  ];
}

function buildAiConfirmedDipSubscription(
  input: SubscriptionTemplateInput,
): SubscriptionSeed | null {
  const { symbol, assetType } = input;

  if (assetType !== SECURITY_ASSET_TYPES.STOCK) {
    return null;
  }

  return buildBaseSubscription({
    symbol,
    keySuffix: 'ai_confirmed_dip',
    nameLabel: 'AI Confirmed Dip',
    strategyKey: STRATEGY_KEYS.AI_CONFIRMED_DIP_STOCK,
    exitProfileKey: getDipExitProfileForAssetTypeAndRiskMode(
      assetType,
      SUBSCRIPTION_RISK_MODES.AI_CONFIRMED,
    ),
    enabled: false,
  });
}

function buildQuickTestSubscription(
  input: SubscriptionTemplateInput,
): SubscriptionSeed {
  const { symbol } = input;

  return buildBaseSubscription({
    symbol,
    keySuffix: 'test_momentum',
    nameLabel: 'Test Momentum',
    strategyKey: STRATEGY_KEYS.QUICK_TEST_MOMENTUM,
    exitProfileKey: EXIT_PROFILE_KEYS.QUICK_TEST,
    enabled: false,
  });
}

export function buildSubscriptionsForSecurity(
  input: SubscriptionTemplateInput,
): SubscriptionSeed[] {
  const aiConfirmedDipSubscription = buildAiConfirmedDipSubscription(input);

  return [
    buildDipSubscription(input, SUBSCRIPTION_RISK_MODES.CORE),
    buildDipSubscription(input, SUBSCRIPTION_RISK_MODES.CONSERVATIVE),
    buildDipSubscription(input, SUBSCRIPTION_RISK_MODES.AGGRESSIVE),
    ...buildMomentumSubscriptions(input),
    ...(aiConfirmedDipSubscription ? [aiConfirmedDipSubscription] : []),
    buildQuickTestSubscription(input),
  ];
}
