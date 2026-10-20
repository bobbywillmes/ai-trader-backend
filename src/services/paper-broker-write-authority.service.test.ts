import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadWith(role: string, authorizations: string, ownership = JSON.stringify([
  { tradingAccountId: 999, role: 'EXECUTOR', expectedBrokerAccountId: 'validation-paper' },
])) {
  vi.stubEnv('PAPER_BROKER_WRITE_DEPLOYMENT_ROLE', role);
  vi.stubEnv('PAPER_BROKER_WRITE_AUTHORIZATIONS', authorizations);
  vi.stubEnv('PAPER_BROKER_WRITE_OWNERSHIP', ownership);
  return import('./paper-broker-write-authority.service.js');
}

const fingerprintA = `sha256:${crypto.createHash('sha256').update('not-logged').digest('hex')}`;
const fingerprintB = `sha256:${'b'.repeat(64)}`;
const config = (brokerAccountId: string | null, keyFingerprint: string | null) => ({
  tradingAccountId: 999,
  environment: 'PAPER' as const,
  baseUrl: 'https://paper-api.alpaca.markets',
  apiKey: 'not-logged', apiSecret: 'not-logged', source: 'trading_account_credential' as const,
  credentialId: 7, brokerAccountId, keyFingerprint,
});

describe('PAPER broker-write deployment authority', () => {
  it('denies all writes in observation-only mode regardless of local account id', async () => {
    const policy = await loadWith('OBSERVATION_ONLY', '[]', JSON.stringify([{ tradingAccountId: 999, role: 'OBSERVER' }]));
    expect(() => policy.authorizePaperBrokerWrite(config('bobby-paper', fingerprintA)))
      .toThrow('OBSERVATION_ONLY');
  });

  it('denies observer, undeclared, and mismatched ownership before broker dispatch', async () => {
    const authorization = JSON.stringify([{ brokerAccountId: 'validation-paper', keyFingerprint: fingerprintA }]);
    const observer = await loadWith('PAPER_EXECUTOR', authorization, JSON.stringify([
      { tradingAccountId: 999, role: 'OBSERVER' },
      { tradingAccountId: 1000, role: 'EXECUTOR', expectedBrokerAccountId: 'validation-paper' },
    ]));
    expect(() => observer.authorizePaperBrokerWrite(config('validation-paper', fingerprintA))).toThrow('not declared as an EXECUTOR');
    vi.resetModules();
    const mismatched = await loadWith('PAPER_EXECUTOR', JSON.stringify([
      { brokerAccountId: 'validation-paper', keyFingerprint: fingerprintA },
      { brokerAccountId: 'other-paper', keyFingerprint: fingerprintB },
    ]), JSON.stringify([
      { tradingAccountId: 999, role: 'EXECUTOR', expectedBrokerAccountId: 'other-paper' },
      { tradingAccountId: 1000, role: 'EXECUTOR', expectedBrokerAccountId: 'validation-paper' },
    ]));
    expect(() => mismatched.authorizePaperBrokerWrite(config('validation-paper', fingerprintA))).toThrow('does not match');
    vi.resetModules();
    const undeclared = await loadWith('PAPER_EXECUTOR', authorization, JSON.stringify([
      { tradingAccountId: 1000, role: 'EXECUTOR', expectedBrokerAccountId: 'validation-paper' },
    ]));
    expect(() => undeclared.authorizePaperBrokerWrite(config('validation-paper', fingerprintA))).toThrow('not declared as an EXECUTOR');
  });

  it('allows only an exact brokerage account and credential fingerprint pair', async () => {
    const policy = await loadWith('PAPER_EXECUTOR', JSON.stringify([
      { brokerAccountId: 'validation-paper', keyFingerprint: fingerprintA },
    ]));
    expect(() => policy.authorizePaperBrokerWrite(config('validation-paper', fingerprintA))).not.toThrow();
    expect(() => policy.authorizePaperBrokerWrite(config('bobby-paper', fingerprintA))).toThrow('does not match the EXECUTOR ownership declaration');
    expect(() => policy.authorizePaperBrokerWrite(config('validation-paper', fingerprintB))).toThrow('does not match its stored fingerprint');
    expect(() => policy.authorizePaperBrokerWrite(config(null, fingerprintA))).toThrow('incomplete');
  });

  it('denies a stored fingerprint that is internally consistent but differs from the allowlist', async () => {
    const otherKey = 'internally-consistent-rotated-key';
    const otherFingerprint = `sha256:${crypto.createHash('sha256').update(otherKey).digest('hex')}`;
    const policy = await loadWith('PAPER_EXECUTOR', JSON.stringify([
      { brokerAccountId: 'validation-paper', keyFingerprint: fingerprintA },
    ]));
    expect(() => policy.authorizePaperBrokerWrite({ ...config('validation-paper', otherFingerprint), apiKey: otherKey }))
      .toThrow('not authorized');
  });
});
