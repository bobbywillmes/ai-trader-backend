import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {} as {
    TRADING_CREDENTIAL_ENCRYPTION_KEY?: string;
    TRADING_CREDENTIAL_ENCRYPTION_KEY_ID?: string;
  },
}));

vi.mock('../config/env.js', () => ({
  env: mocks.env,
}));

import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
} from './trading-credential-crypto.service.js';

function base64Key(seed: number) {
  return Buffer.alloc(32, seed).toString('base64');
}

describe('trading credential crypto service', () => {
  beforeEach(() => {
    mocks.env.TRADING_CREDENTIAL_ENCRYPTION_KEY = base64Key(1);
    mocks.env.TRADING_CREDENTIAL_ENCRYPTION_KEY_ID = 'test-key-v1';
  });

  it('round trips encrypted secrets without storing plaintext in the payload', () => {
    const payload = encryptSecret('alpaca-secret-value');

    expect(payload).toMatch(/^v1:aes-256-gcm:test-key-v1:/);
    expect(payload).not.toContain('alpaca-secret-value');
    expect(decryptSecret(payload)).toBe('alpaca-secret-value');
  });

  it('changes ciphertext for the same plaintext because each encryption uses a random iv', () => {
    const firstPayload = encryptSecret('same-secret');
    const secondPayload = encryptSecret('same-secret');

    expect(firstPayload).not.toBe(secondPayload);
    expect(decryptSecret(firstPayload)).toBe('same-secret');
    expect(decryptSecret(secondPayload)).toBe('same-secret');
  });

  it('fails clearly when an encrypted payload has been tampered with', () => {
    const payload = encryptSecret('tamper-sensitive-secret');
    const parts = payload.split(':');
    parts[5] = Buffer.from('tampered-ciphertext').toString('base64');

    expect(() => decryptSecret(parts.join(':'))).toThrow(
      'Encrypted credential payload could not be authenticated or decrypted'
    );
  });

  it('fails clearly when decrypting with the wrong key', () => {
    const payload = encryptSecret('wrong-key-secret');

    mocks.env.TRADING_CREDENTIAL_ENCRYPTION_KEY = base64Key(2);

    expect(() => decryptSecret(payload)).toThrow(
      'Encrypted credential payload could not be authenticated or decrypted'
    );
  });

  it('fails clearly when the encryption key is missing', () => {
    delete mocks.env.TRADING_CREDENTIAL_ENCRYPTION_KEY;

    expect(() => encryptSecret('missing-key-secret')).toThrow(
      'TRADING_CREDENTIAL_ENCRYPTION_KEY is required'
    );
    expect(() =>
      decryptSecret('v1:aes-256-gcm:test-key-v1:iv:tag:ciphertext')
    ).toThrow('TRADING_CREDENTIAL_ENCRYPTION_KEY is required');
  });

  it('fails clearly when the encryption key is not a base64-encoded 32-byte key', () => {
    mocks.env.TRADING_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(31, 1).toString(
      'base64'
    );

    expect(() => encryptSecret('invalid-key-secret')).toThrow(
      'TRADING_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key'
    );
  });

  it('fails clearly when the encryption key id is missing for encryption', () => {
    delete mocks.env.TRADING_CREDENTIAL_ENCRYPTION_KEY_ID;

    expect(() => encryptSecret('missing-key-id-secret')).toThrow(
      'TRADING_CREDENTIAL_ENCRYPTION_KEY_ID is required'
    );
  });

  it('creates stable non-plaintext SHA-256 fingerprints', () => {
    const first = fingerprintSecret('secret-value');
    const second = fingerprintSecret('secret-value');

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toContain('secret-value');
  });
});
