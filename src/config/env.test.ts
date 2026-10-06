import { describe, expect, it } from 'vitest';
import { envSchema } from './env.js';

const base = { ...process.env, MARKET_DAILY_TIINGO_CUTOVER_SESSION: undefined, MARKET_DAILY_MASSIVE_RESUME_SESSION: undefined };

describe('daily market authority environment validation', () => {
  it('accepts no boundaries, a Tiingo-only cutover, and an ordered Massive resume', () => {
    expect(envSchema.safeParse(base).success).toBe(true);
    expect(envSchema.safeParse({ ...base, MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-10-07' }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-10-07', MARKET_DAILY_MASSIVE_RESUME_SESSION: '2026-10-12' }).success).toBe(true);
  });

  it('rejects malformed boundaries and invalid authority sequences', () => {
    expect(envSchema.safeParse({ ...base, MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-02-30' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, MARKET_DAILY_MASSIVE_RESUME_SESSION: '2026-10-12' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-10-07', MARKET_DAILY_MASSIVE_RESUME_SESSION: '2026-10-07' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-10-07', MARKET_DAILY_MASSIVE_RESUME_SESSION: '2026-10-06' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-10-07', MARKET_DAILY_MASSIVE_RESUME_SESSION: '10/12/2026' }).success).toBe(false);
  });
});
