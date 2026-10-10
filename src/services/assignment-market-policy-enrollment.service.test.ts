import { describe, expect, it } from 'vitest';
import { marketOutcomePermitsConfigurationActivation } from './assignment-market-policy-enrollment.service.js';

describe('assignment market-policy enrollment activation boundary', () => {
  it.each(['ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE', null] as const)('does not require a favorable market outcome: %s', outcome => {
    expect(marketOutcomePermitsConfigurationActivation(outcome)).toBe(true);
  });
});
