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

describe('PAPER broker-write environment validation', () => {
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const authorization = JSON.stringify([{ brokerAccountId: 'paper-account', keyFingerprint: fingerprint }]);

  it('accepts observation-only with no identities and an executor with exact identities', () => {
    expect(envSchema.safeParse({ ...base, PAPER_BROKER_WRITE_DEPLOYMENT_ROLE: 'OBSERVATION_ONLY', PAPER_BROKER_WRITE_AUTHORIZATIONS: '[]' }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, PAPER_BROKER_WRITE_DEPLOYMENT_ROLE: 'PAPER_EXECUTOR', PAPER_BROKER_WRITE_AUTHORIZATIONS: authorization }).success).toBe(true);
  });

  it.each([
    ['OBSERVATION_ONLY', authorization],
    ['PAPER_EXECUTOR', '[]'],
    ['PAPER_EXECUTOR', 'not-json'],
    ['PAPER_EXECUTOR', JSON.stringify([{ brokerAccountId: '', keyFingerprint: fingerprint }])],
    ['PAPER_EXECUTOR', JSON.stringify([{ brokerAccountId: 'paper-account', keyFingerprint: 'plaintext-key' }])],
  ])('rejects contradictory or malformed authority (%s)', (role, authorizations) => {
    expect(envSchema.safeParse({ ...base, PAPER_BROKER_WRITE_DEPLOYMENT_ROLE: role, PAPER_BROKER_WRITE_AUTHORIZATIONS: authorizations }).success).toBe(false);
  });

  it('rejects contradictory account and fingerprint cardinality', () => {
    const fingerprint2 = `sha256:${'b'.repeat(64)}`;
    expect(envSchema.safeParse({ ...base, PAPER_BROKER_WRITE_DEPLOYMENT_ROLE: 'PAPER_EXECUTOR', PAPER_BROKER_WRITE_AUTHORIZATIONS: JSON.stringify([
      { brokerAccountId: 'one', keyFingerprint: fingerprint }, { brokerAccountId: 'one', keyFingerprint: fingerprint2 },
    ]) }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, PAPER_BROKER_WRITE_DEPLOYMENT_ROLE: 'PAPER_EXECUTOR', PAPER_BROKER_WRITE_AUTHORIZATIONS: JSON.stringify([
      { brokerAccountId: 'one', keyFingerprint: fingerprint }, { brokerAccountId: 'two', keyFingerprint: fingerprint },
    ]) }).success).toBe(false);
  });

  it('requires exact, unique ownership declarations for expected executors', () => {
    const executor = JSON.stringify([{ tradingAccountId: 7, role: 'EXECUTOR', expectedBrokerAccountId: 'paper-7' }]);
    expect(envSchema.safeParse({ ...base, PAPER_BROKER_WRITE_DEPLOYMENT_ROLE: 'PAPER_EXECUTOR', PAPER_BROKER_WRITE_AUTHORIZATIONS: authorization, PAPER_BROKER_WRITE_OWNERSHIP: executor }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, PAPER_BROKER_WRITE_OWNERSHIP: JSON.stringify([{ tradingAccountId: 7, role: 'EXECUTOR' }]) }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, PAPER_BROKER_WRITE_OWNERSHIP: JSON.stringify([
      { tradingAccountId: 7, role: 'OBSERVER' }, { tradingAccountId: 7, role: 'EXECUTOR', expectedBrokerAccountId: 'paper-7' },
    ]) }).success).toBe(false);
  });
});
