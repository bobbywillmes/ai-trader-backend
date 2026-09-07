import { describe, expect, it } from 'vitest';
import { createStrategySignalBindingSchema, externalSignalEnvelopeSchema, newExternalStrategyKeySchema, updateStrategySignalBindingSchema } from './external-signal.schema.js';

describe('new external strategy keys', () => {
  it.each([
    ['  Mean   Reversion  ', 'mean-reversion'],
    ['ETF\tMean\nReversion', 'etf-mean-reversion'],
    [' ETF -- Mean---Reversion_v2 ', 'etf-mean-reversion_v2'],
    ['already_canonical-2', 'already_canonical-2'],
  ])('normalizes %j to %s on creation', (input, expected) => {
    expect(newExternalStrategyKeySchema.parse(input)).toBe(expected);
  });
  it.each(['', ' \t\n ', 'strategy/key', 'strategy.key', 'café', 'entry@long', 'x'.repeat(201)])('rejects invalid key %j', key => {
    expect(newExternalStrategyKeySchema.safeParse(key).success).toBe(false);
  });
  it('canonicalizes admin creation without changing webhook lookup or permitting key edits', () => {
    expect(createStrategySignalBindingSchema.parse({ signalSourceId: 1, strategyId: 2, externalStrategyKey: ' Legacy Key ', expectedRevision: 'r1' }).externalStrategyKey).toBe('legacy-key');
    expect(externalSignalEnvelopeSchema.shape.externalStrategyKey.parse(' Legacy Key ')).toBe('Legacy Key');
    expect(updateStrategySignalBindingSchema.safeParse({ externalStrategyKey: 'legacy-key', enabled: true }).success).toBe(false);
  });
});
