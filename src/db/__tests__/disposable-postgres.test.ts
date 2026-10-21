import { describe, expect, it } from 'vitest';
import { assertDisposableDatabaseUrl } from './disposable-postgres.js';

describe('disposable PostgreSQL database safety guard', () => {
  it('refuses a normal database URL before test fixtures can write', () => {
    expect(() => assertDisposableDatabaseUrl(
      'postgresql://test:test@localhost:5432/ai_trader',
      'ai_trader_test_entry_lifecycle_expected',
    )).toThrow(/Refusing database test writes/);
  });

  it('requires the generated target identity, not only a test-like environment value', () => {
    expect(() => assertDisposableDatabaseUrl(
      'postgresql://test:test@localhost:5432/ai_trader_test_entry_lifecycle_other',
      'ai_trader_test_entry_lifecycle_expected',
    )).toThrow(/Refusing database test writes/);
  });
});
