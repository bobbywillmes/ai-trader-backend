import { describe, expect, it, vi } from 'vitest';
import type { AlpacaAccount } from './alpaca.types.js';

vi.mock('../../config/env.js', () => ({
  env: {
    ALPACA_BASE_URL: 'https://paper-api.alpaca.markets',
  },
}));

import { normalizeAccount } from './normalizers.js';

function account(overrides: Partial<AlpacaAccount> = {}): AlpacaAccount {
  return {
    id: 'account-1',
    account_number: 'PA123',
    status: 'ACTIVE',
    currency: 'USD',
    buying_power: '20000.50',
    cash: '10000.25',
    portfolio_value: '15000.75',
    equity: '15000.75',
    last_equity: '14000.25',
    trading_blocked: false,
    ...overrides,
  };
}

describe('Alpaca account normalization', () => {
  it('normalizes long and short market values from Alpaca account fields', () => {
    const normalized = normalizeAccount(
      account({
        long_market_value: '7000.25',
        short_market_value: '-1250.50',
      })
    );

    expect(normalized.longMarketValue).toBe(7000.25);
    expect(normalized.shortMarketValue).toBe(-1250.5);
  });

  it('keeps missing exposure values nullable for historical compatibility', () => {
    const normalized = normalizeAccount(account());

    expect(normalized.longMarketValue).toBeNull();
    expect(normalized.shortMarketValue).toBeNull();
  });
});
