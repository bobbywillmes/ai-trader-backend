export const STRATEGY_MARKET_POLICY_AUTHORITY = 'SHADOW_ONLY' as const;

export const STRATEGY_MARKET_POLICY_DIMENSIONS = Object.freeze([
  { dimension: 'TREND', algorithmVersion: 'TREND_V1', allowedStates: ['DOWN', 'NEUTRAL', 'UP'] },
  { dimension: 'VOLATILITY', algorithmVersion: 'VOLATILITY_V1', allowedStates: ['LOW', 'NORMAL', 'HIGH', 'EXTREME'] },
  { dimension: 'BREADTH', algorithmVersion: 'BREADTH_V1', allowedStates: ['NEGATIVE', 'MIXED', 'POSITIVE'] },
  { dimension: 'PARTICIPATION', algorithmVersion: 'PARTICIPATION_V1', allowedStates: ['QUIET', 'NORMAL', 'ACTIVE', 'INTENSE'] },
  { dimension: 'INTRADAY_STRESS', algorithmVersion: 'INTRADAY_STRESS_V1', allowedStates: ['NORMAL', 'ELEVATED', 'HIGH', 'SEVERE'] },
] as const);

export type StrategyMarketPolicyDimension = typeof STRATEGY_MARKET_POLICY_DIMENSIONS[number]['dimension'];

export function marketPolicyDimensionDefinition(dimension: string) {
  return STRATEGY_MARKET_POLICY_DIMENSIONS.find(item => item.dimension === dimension) ?? null;
}
