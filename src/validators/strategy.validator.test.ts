import { describe, expect, it } from 'vitest';

import { updateStrategyEnabledSchema } from './strategy.validator.js';

describe('strategy validators', () => {
  it('accepts only an enabled boolean', () => {
    expect(updateStrategyEnabledSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(updateStrategyEnabledSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it.each([
    null,
    [],
    {},
    { enabled: 'true' },
    { enabled: true, name: 'Changed' },
    { key: 'momentum_stock' },
  ])('rejects unsupported strategy update payload %j', (payload) => {
    expect(updateStrategyEnabledSchema.safeParse(payload).success).toBe(false);
  });
});
