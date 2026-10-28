import { describe, expect, it } from 'vitest';
import { createStrategySignalBindingSchema, externalSignalEnvelopeSchema, externalSignalEnvelopeV1Schema, newExternalStrategyKeySchema, updateStrategySignalBindingSchema } from './external-signal.schema.js';

describe('new external strategy keys', () => {
  it.each([0, -1, 1.5, '1', 'acceptance-2', null, 2147483648])('rejects non-positive-integer strategy revision %j', revision => {
    expect(externalSignalEnvelopeV1Schema.shape.strategyRevision.safeParse(revision).success).toBe(false);
  });
  it('accepts integer revisions and prevents caller-assigned initial revision configuration', () => {
    expect(externalSignalEnvelopeV1Schema.shape.strategyRevision.parse(2)).toBe(2);
    for (const field of ['revision', 'strategyRevision', 'expectedRevision', 'revisions']) {
      expect(createStrategySignalBindingSchema.safeParse({ signalSourceId: 1, strategyId: 2, externalStrategyKey: 'test', [field]: 2 }).success).toBe(false);
      expect(updateStrategySignalBindingSchema.safeParse({ enabled: true, [field]: 2 }).success).toBe(false);
    }
  });
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
    expect(createStrategySignalBindingSchema.parse({ signalSourceId: 1, strategyId: 2, externalStrategyKey: ' Legacy Key ' }).externalStrategyKey).toBe('legacy-key');
    expect(externalSignalEnvelopeV1Schema.shape.externalStrategyKey.parse(' Legacy Key ')).toBe('Legacy Key');
    expect(updateStrategySignalBindingSchema.safeParse({ externalStrategyKey: 'legacy-key', enabled: true }).success).toBe(false);
  });
  it('selects contract v2 explicitly and preserves exact bounded ASCII identifiers', () => {
    const base = { externalStrategyKey: 'test', strategyRevision: 1, event: 'ENTRY_LONG', symbol: 'SPY', timeframe: '15m', signalTime: '2026-10-28T14:30:00Z' };
    expect(externalSignalEnvelopeSchema.safeParse({ ...base, externalEventId: 'event:1', externalTradeCycleRef: 'cycle:1' }).success).toBe(false);
    expect(externalSignalEnvelopeSchema.parse({ ...base, schemaVersion: 2, externalEventId: 'Event:1', externalTradeCycleRef: 'Cycle:1' })).toMatchObject({ externalEventId: 'Event:1', externalTradeCycleRef: 'Cycle:1' });
    for (const invalid of [' event', 'event ', 'café', 'x'.repeat(129)]) {
      expect(externalSignalEnvelopeSchema.safeParse({ ...base, schemaVersion: 2, externalEventId: invalid, externalTradeCycleRef: 'cycle:1' }).success).toBe(false);
    }
  });
});
