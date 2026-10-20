import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadWith(role: string, authorizations: string) {
  vi.stubEnv('PAPER_BROKER_WRITE_DEPLOYMENT_ROLE', role);
  vi.stubEnv('PAPER_BROKER_WRITE_AUTHORIZATIONS', authorizations);
  return import('./paper-broker-write-authority.service.js');
}

const fingerprintA = `sha256:${'a'.repeat(64)}`;
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
    const policy = await loadWith('OBSERVATION_ONLY', '[]');
    expect(() => policy.authorizePaperBrokerWrite(config('bobby-paper', fingerprintA)))
      .toThrow('OBSERVATION_ONLY');
  });

  it('allows only an exact brokerage account and credential fingerprint pair', async () => {
    const policy = await loadWith('PAPER_EXECUTOR', JSON.stringify([
      { brokerAccountId: 'validation-paper', keyFingerprint: fingerprintA },
    ]));
    expect(() => policy.authorizePaperBrokerWrite(config('validation-paper', fingerprintA))).not.toThrow();
    expect(() => policy.authorizePaperBrokerWrite(config('bobby-paper', fingerprintA))).toThrow('not authorized');
    expect(() => policy.authorizePaperBrokerWrite(config('validation-paper', fingerprintB))).toThrow('not authorized');
    expect(() => policy.authorizePaperBrokerWrite(config(null, fingerprintA))).toThrow('incomplete');
  });
});
