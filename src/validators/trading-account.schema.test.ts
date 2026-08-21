import { describe, expect, it } from 'vitest';
import { createTradingAccountSchema, stageLiveEntryCanarySchema, updateTradingAccountSchema } from './trading-account.schema.js';

describe('Trading Account identity validation', () => {
  it.each(['PAPER', 'LIVE'] as const)('accepts explicit %s creation with only provisioning fields', (environment) => {
    expect(createTradingAccountSchema.parse({ accountHolderUserId: 1, displayName: `Bobby ${environment}`, environment })).toMatchObject({ environment });
  });

  it('requires an explicit environment', () => {
    expect(() => createTradingAccountSchema.parse({ accountHolderUserId: 1, displayName: 'Bobby' })).toThrow();
  });

  it.each(['status', 'tradingEnabled', 'killSwitchEnabled', 'brokerAccountId', 'broker'])(
    'rejects client-controlled creation field %s',
    (field) => expect(() => createTradingAccountSchema.parse({ accountHolderUserId: 1, displayName: 'Bobby Paper', environment: 'PAPER', [field]: field === 'broker' ? 'ALPACA' : true })).toThrow()
  );

  it.each([
    'environment',
    'broker',
    'accountHolderUserId',
    'brokerAccountId',
    'status',
    'tradingEnabled',
    'killSwitchEnabled',
  ])(
    'rejects immutable or operational update field %s',
    (field) => expect(() => updateTradingAccountSchema.parse({ displayName: 'Updated', [field]: field === 'accountHolderUserId' ? 2 : 'LIVE' })).toThrow()
  );

  it('allows normal updates without identity fields', () => {
    expect(updateTradingAccountSchema.parse({ displayName: 'Updated', notes: 'Safe update' })).toEqual({ displayName: 'Updated', notes: 'Safe update' });
  });
});

describe('Live canary staging validation', () => {
  it('accepts the unresolved acceptance run binding', () => {
    expect(stageLiveEntryCanarySchema.parse({
      tradingAccountSubscriptionId: 8,
      liveEntryAcceptanceRunId: 10,
      reason: 'Stage Run 2',
    })).toEqual({
      tradingAccountSubscriptionId: 8,
      liveEntryAcceptanceRunId: 10,
      reason: 'Stage Run 2',
    });
  });
});
