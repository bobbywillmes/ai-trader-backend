import {
  SECURITY_ASSET_TYPES,
  SUBSCRIPTION_RISK_MODES,
  type SecurityAssetType,
  type SubscriptionRiskMode,
} from './securityPolicies.js';

export const EXIT_PROFILE_KEYS = {
  ETF_DIP_CORE_TARGET: 'exit_etf_dip_core_target',
  ETF_DIP_CONSERVATIVE_BRACKET: 'exit_etf_dip_conservative_bracket',
  ETF_DIP_AGGRESSIVE_TRAILING: 'exit_etf_dip_aggressive_trailing',

  STOCK_DIP_CORE_TARGET: 'exit_stock_dip_core_target',
  STOCK_DIP_CONSERVATIVE_BRACKET: 'exit_stock_dip_conservative_bracket',
  STOCK_DIP_AGGRESSIVE_TRAILING: 'exit_stock_dip_aggressive_trailing',

  ETF_MOMENTUM_BRACKET: 'exit_etf_momentum_bracket',
  ETF_MOMENTUM_TRAILING: 'exit_etf_momentum_trailing',

  STOCK_MOMENTUM_FAIL_FAST: 'exit_stock_momentum_fail_fast',
  STOCK_MOMENTUM_TRAILING: 'exit_stock_momentum_trailing',

  AI_ASSISTED: 'exit_ai_assisted',

  QUICK_TEST: 'exit_quick_test',
} as const;

export type ExitProfileKey =
  (typeof EXIT_PROFILE_KEYS)[keyof typeof EXIT_PROFILE_KEYS];

export type ExitProfileSeed = {
  key: ExitProfileKey;
  name: string;
  description: string;
  targetPct: number | null;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  maxHoldDays: number | null;
  exitMode: string;
  takeProfitBehavior: string;
  enabled: boolean;
};

export const EXIT_PROFILE_SEEDS: ExitProfileSeed[] = [
  {
    key: EXIT_PROFILE_KEYS.ETF_DIP_CORE_TARGET,
    name: 'ETF Dip Core Target',
    description:
      'Core ETF dip exit using a simple fixed target. Used for normal ETF pullback trades.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: null,
    maxHoldDays: 10,
    exitMode: 'fixed_target',
    takeProfitBehavior: 'fixed',
    enabled: true,
  },
  {
    key: EXIT_PROFILE_KEYS.ETF_DIP_CONSERVATIVE_BRACKET,
    name: 'ETF Dip Conservative Bracket',
    description:
      'Conservative ETF dip exit with fixed target and fixed stop protection.',
    targetPct: 1,
    stopLossPct: 1,
    trailingStopPct: null,
    maxHoldDays: 5,
    exitMode: 'fixed_bracket',
    takeProfitBehavior: 'fixed',
    enabled: true,
  },
  {
    key: EXIT_PROFILE_KEYS.ETF_DIP_AGGRESSIVE_TRAILING,
    name: 'ETF Dip Aggressive Trailing',
    description:
      'Aggressive ETF dip exit that targets recovery first, then allows trailing upside capture.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: 0.5,
    maxHoldDays: 10,
    exitMode: 'hybrid',
    takeProfitBehavior: 'trail_after_target',
    enabled: true,
  },

  {
    key: EXIT_PROFILE_KEYS.STOCK_DIP_CORE_TARGET,
    name: 'Stock Dip Core Target',
    description:
      'Core single-stock dip exit using a simple fixed target.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: null,
    maxHoldDays: 10,
    exitMode: 'fixed_target',
    takeProfitBehavior: 'fixed',
    enabled: true,
  },
  {
    key: EXIT_PROFILE_KEYS.STOCK_DIP_CONSERVATIVE_BRACKET,
    name: 'Stock Dip Conservative Bracket',
    description:
      'Conservative single-stock dip exit with fixed target and fixed stop protection.',
    targetPct: 2,
    stopLossPct: 3,
    trailingStopPct: null,
    maxHoldDays: 5,
    exitMode: 'fixed_bracket',
    takeProfitBehavior: 'fixed',
    enabled: true,
  },
  {
    key: EXIT_PROFILE_KEYS.STOCK_DIP_AGGRESSIVE_TRAILING,
    name: 'Stock Dip Aggressive Trailing',
    description:
      'Aggressive single-stock dip exit that targets recovery first, then allows trailing upside capture.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: 0.5,
    maxHoldDays: 10,
    exitMode: 'hybrid',
    takeProfitBehavior: 'trail_after_target',
    enabled: true,
  },

  {
    key: EXIT_PROFILE_KEYS.ETF_MOMENTUM_BRACKET,
    name: 'ETF Momentum Bracket',
    description:
      'Production-intended ETF momentum exit with a quick target and defined downside protection.',
    targetPct: 1,
    stopLossPct: 0.75,
    trailingStopPct: null,
    maxHoldDays: 1,
    exitMode: 'fixed_bracket',
    takeProfitBehavior: 'fixed',
    enabled: true,
  },
  {
    key: EXIT_PROFILE_KEYS.ETF_MOMENTUM_TRAILING,
    name: 'ETF Momentum Trailing',
    description:
      'Production-intended ETF momentum exit that allows continuation while protecting failed momentum.',
    targetPct: 1.5,
    stopLossPct: 0.75,
    trailingStopPct: 0.5,
    maxHoldDays: 3,
    exitMode: 'hybrid',
    takeProfitBehavior: 'trail_after_target',
    enabled: true,
  },

  {
    key: EXIT_PROFILE_KEYS.STOCK_MOMENTUM_FAIL_FAST,
    name: 'Stock Momentum Fail Fast',
    description:
      'Production-intended stock momentum exit. Failed momentum should be exited quickly and not averaged down.',
    targetPct: 1,
    stopLossPct: 0.75,
    trailingStopPct: null,
    maxHoldDays: 1,
    exitMode: 'fixed_bracket',
    takeProfitBehavior: 'fixed',
    enabled: true,
  },
  {
    key: EXIT_PROFILE_KEYS.STOCK_MOMENTUM_TRAILING,
    name: 'Stock Momentum Trailing',
    description:
      'Production-intended stock momentum exit that trails after confirmation of continuation.',
    targetPct: 1.5,
    stopLossPct: 0.75,
    trailingStopPct: 0.5,
    maxHoldDays: 3,
    exitMode: 'hybrid',
    takeProfitBehavior: 'trail_after_target',
    enabled: true,
  },

  {
    key: EXIT_PROFILE_KEYS.AI_ASSISTED,
    name: 'AI Assisted Exit',
    description:
      'Reserved for future AI-assisted exit decisions. Not used for current production seed subscriptions.',
    targetPct: 2,
    stopLossPct: null,
    trailingStopPct: 0.5,
    maxHoldDays: 10,
    exitMode: 'ai_assisted',
    takeProfitBehavior: 'ai_confirm',
    enabled: false,
  },

  {
    key: EXIT_PROFILE_KEYS.QUICK_TEST,
    name: 'Quick Test Exit',
    description:
      'Non-production exit profile used for fast backend order lifecycle validation.',
    targetPct: 0.05,
    stopLossPct: 0.05,
    trailingStopPct: null,
    maxHoldDays: null,
    exitMode: 'fixed_bracket',
    takeProfitBehavior: 'fixed',
    enabled: true,
  },
];

export function getDipExitProfileForAssetTypeAndRiskMode(
  assetType: SecurityAssetType,
  riskMode: SubscriptionRiskMode,
): ExitProfileKey {
  if (assetType === SECURITY_ASSET_TYPES.ETF) {
    if (riskMode === SUBSCRIPTION_RISK_MODES.CONSERVATIVE) {
      return EXIT_PROFILE_KEYS.ETF_DIP_CONSERVATIVE_BRACKET;
    }

    if (riskMode === SUBSCRIPTION_RISK_MODES.CORE) {
      return EXIT_PROFILE_KEYS.ETF_DIP_CORE_TARGET;
    }

    if (riskMode === SUBSCRIPTION_RISK_MODES.AGGRESSIVE) {
      return EXIT_PROFILE_KEYS.ETF_DIP_AGGRESSIVE_TRAILING;
    }
  }

  if (assetType === SECURITY_ASSET_TYPES.STOCK) {
    if (riskMode === SUBSCRIPTION_RISK_MODES.CONSERVATIVE) {
      return EXIT_PROFILE_KEYS.STOCK_DIP_CONSERVATIVE_BRACKET;
    }

    if (riskMode === SUBSCRIPTION_RISK_MODES.CORE) {
      return EXIT_PROFILE_KEYS.STOCK_DIP_CORE_TARGET;
    }

    if (riskMode === SUBSCRIPTION_RISK_MODES.AGGRESSIVE) {
      return EXIT_PROFILE_KEYS.STOCK_DIP_AGGRESSIVE_TRAILING;
    }

    if (riskMode === SUBSCRIPTION_RISK_MODES.AI_CONFIRMED) {
      return EXIT_PROFILE_KEYS.STOCK_DIP_CORE_TARGET;
    }
  }

  throw new Error(
    `No dip exit profile configured for asset type "${assetType}" and risk mode "${riskMode}".`,
  );
}