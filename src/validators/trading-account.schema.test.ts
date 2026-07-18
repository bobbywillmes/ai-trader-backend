import { describe, expect, it } from 'vitest';
import { createTradingAccountSchema, updateTradingAccountSchema } from './trading-account.schema.js';

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

  it.each(['environment', 'broker', 'accountHolderUserId', 'brokerAccountId'])(
    'rejects immutable update field %s',
    (field) => expect(() => updateTradingAccountSchema.parse({ displayName: 'Updated', [field]: field === 'accountHolderUserId' ? 2 : 'LIVE' })).toThrow()
  );

  it('allows normal updates without identity fields', () => {
    expect(updateTradingAccountSchema.parse({ displayName: 'Updated', notes: 'Safe update' })).toEqual({ displayName: 'Updated', notes: 'Safe update' });
  });
});
