import { describe, expect, it } from 'vitest';
import { validateMarketPolicyRules } from './strategy-market-policy.service.js';
import { STRATEGY_MARKET_POLICY_DIMENSIONS } from './strategy-market-policy.definition.js';

const rules = () => STRATEGY_MARKET_POLICY_DIMENSIONS.map(item => ({
  dimension: item.dimension, algorithmVersion: item.algorithmVersion,
  requirement: 'IGNORED', allowedStates: [] as Array<{ state: string }>,
}));

describe('strategy market policy validation', () => {
  it('accepts an explicit rule for all five dimensions including IGNORED dimensions', () => {
    expect(validateMarketPolicyRules(rules())).toEqual({ valid: true, errors: [] });
  });

  it('requires nonempty, vocabulary-checked states for REQUIRED dimensions', () => {
    const input = rules(); input[0] = { ...input[0]!, requirement: 'REQUIRED' };
    expect(validateMarketPolicyRules(input).errors).toContainEqual(expect.objectContaining({ dimension: 'TREND', code: 'ALLOWED_STATES_REQUIRED' }));
    input[0]!.allowedStates = [{ state: 'BULLISH' }];
    expect(validateMarketPolicyRules(input).errors).toContainEqual(expect.objectContaining({ dimension: 'TREND', code: 'STATE_INVALID' }));
  });

  it('does not let IGNORED dimensions grant eligibility through allowed states', () => {
    const input = rules(); input[4]!.allowedStates = [{ state: 'NORMAL' }];
    expect(validateMarketPolicyRules(input).errors).toContainEqual(expect.objectContaining({ dimension: 'INTRADAY_STRESS', code: 'IGNORED_STATES_FORBIDDEN' }));
  });

  it('rejects missing, duplicate, unsupported, and wrong-version rules', () => {
    const input: Array<{ dimension: string; algorithmVersion: string; requirement: string; allowedStates: Array<{ state: string }> }> = rules();
    input.pop(); input[0] = { ...input[0]!, algorithmVersion: 'TREND_V2' };
    const result = validateMarketPolicyRules(input);
    expect(result.valid).toBe(false);
    expect(result.errors.map(error => error.code)).toEqual(expect.arrayContaining(['DIMENSION_RULE_REQUIRED', 'ALGORITHM_VERSION_INVALID']));
  });
});
