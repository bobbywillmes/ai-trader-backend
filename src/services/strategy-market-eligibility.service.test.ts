import { describe, expect, it } from 'vitest';
import { evaluateStrategyMarketEligibility } from './strategy-market-eligibility.service.js';
import { STRATEGY_MARKET_POLICY_DIMENSIONS } from './strategy-market-policy.definition.js';

const at = new Date('2026-10-09T18:00:00Z');
const rules = (required = ['TREND']) => STRATEGY_MARKET_POLICY_DIMENSIONS.map(item => ({ dimension: item.dimension, algorithmVersion: item.algorithmVersion, requirement: required.includes(item.dimension) ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: required.includes(item.dimension) ? [{ state: item.allowedStates[0] }] : [] }));
const sources = (): Array<{ dimension: string; requiredAlgorithmVersion: string; sourceAssessmentId: number | null; sourceStatus: string | null; sourceValidUntil: Date | null; sourceEffectiveState: string | null; health: 'AVAILABLE' | 'MISSING' | 'UNAVAILABLE' | 'FAILED' | 'STALE' | 'EXPIRED' | 'INVALID'; reasonCode: string | null }> => STRATEGY_MARKET_POLICY_DIMENSIONS.map((item, index) => ({ dimension: item.dimension, requiredAlgorithmVersion: item.algorithmVersion, sourceAssessmentId: index + 1, sourceStatus: 'VALID', sourceValidUntil: new Date('2026-10-09T19:00:00Z'), sourceEffectiveState: item.allowedStates[0], health: 'AVAILABLE', reasonCode: null }));

describe('strategy market eligibility semantics', () => {
  it('allows healthy required evidence even when ignored composition slots are degraded', () => {
    const evidence = sources(); evidence[1] = { ...evidence[1]!, sourceAssessmentId: null, sourceStatus: 'FAILED', sourceEffectiveState: null, health: 'FAILED' };
    const result = evaluateStrategyMarketEligibility(rules(), evidence, at);
    expect(result.outcome).toBe('ALLOWED'); expect(result.gates[1]?.outcome).toBe('IGNORED'); expect(result.validUntil).toEqual(new Date('2026-10-09T19:00:00Z'));
  });

  it('blocks a healthy required state outside the snapshotted allow-list', () => {
    const evidence = sources(); evidence[0]!.sourceEffectiveState = 'UP';
    const result = evaluateStrategyMarketEligibility(rules(), evidence, at);
    expect(result.outcome).toBe('BLOCKED'); expect(result.gates[0]).toMatchObject({ outcome: 'BLOCKED', reasonCode: 'STATE_NOT_ALLOWED', sourceAssessmentId: 1 });
  });

  it('prioritizes insufficient required evidence over blocked evidence', () => {
    const evidence = sources(); evidence[0]!.sourceEffectiveState = 'UP'; evidence[1]!.health = 'FAILED';
    const result = evaluateStrategyMarketEligibility(rules(['TREND', 'VOLATILITY']), evidence, at);
    expect(result.outcome).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('recomputes expiration at evaluation time', () => {
    const evidence = sources(); evidence[0]!.sourceValidUntil = at;
    const result = evaluateStrategyMarketEligibility(rules(), evidence, at);
    expect(result.gates[0]).toMatchObject({ outcome: 'INSUFFICIENT_EVIDENCE', sourceHealth: 'EXPIRED', reasonCode: 'SOURCE_EXPIRED_AT_EVALUATION' });
  });
});
