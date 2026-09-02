import { describe, expect, it } from 'vitest';
import { assertLifecycleRepairAcceptanceEnvironment, LIFECYCLE_REPAIR_ACCEPTANCE_SENTINEL } from './guard.js';

describe('lifecycle repair acceptance guard', () => {
  it('accepts only the exact disposable database and sentinel', () => {
    expect(assertLifecycleRepairAcceptanceEnvironment({ DATABASE_URL: 'postgresql://local@127.0.0.1/ai_trader_lifecycle_repair_acceptance', LIFECYCLE_REPAIR_ACCEPTANCE: LIFECYCLE_REPAIR_ACCEPTANCE_SENTINEL } as NodeJS.ProcessEnv).pathname).toBe('/ai_trader_lifecycle_repair_acceptance');
  });
  it.each(['ai_trader', 'ai_trader_live_entry_acceptance', 'postgres'])('refuses %s', (database) => {
    expect(() => assertLifecycleRepairAcceptanceEnvironment({ DATABASE_URL: `postgresql://local@127.0.0.1/${database}`, LIFECYCLE_REPAIR_ACCEPTANCE: LIFECYCLE_REPAIR_ACCEPTANCE_SENTINEL } as NodeJS.ProcessEnv)).toThrow('refuses every database');
  });
  it('refuses a missing sentinel', () => expect(() => assertLifecycleRepairAcceptanceEnvironment({ DATABASE_URL: 'postgresql://local@127.0.0.1/ai_trader_lifecycle_repair_acceptance' } as NodeJS.ProcessEnv)).toThrow('explicit sentinel'));
});
