import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { env } from '../config/env.js';

const PAYLOAD_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PAYLOAD_PARTS = 6;

function credentialCryptoError(message: string) {
  return new Error(`Trading credential crypto error: ${message}`);
}

function requireEncryptionKey() {
  const encodedKey = env.TRADING_CREDENTIAL_ENCRYPTION_KEY;

  if (!encodedKey) {
    throw credentialCryptoError(
      'TRADING_CREDENTIAL_ENCRYPTION_KEY is required to encrypt or decrypt trading account credentials.'
    );
  }

  const key = Buffer.from(encodedKey, 'base64');

  if (key.length !== KEY_BYTES) {
    throw credentialCryptoError(
      'TRADING_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key generated with `openssl rand -base64 32`.'
    );
  }

  return key;
}

function requireEncryptionKeyId() {
  const keyId = env.TRADING_CREDENTIAL_ENCRYPTION_KEY_ID;

  if (!keyId) {
    throw credentialCryptoError(
      'TRADING_CREDENTIAL_ENCRYPTION_KEY_ID is required to encrypt trading account credentials.'
    );
  }

  if (keyId.includes(':')) {
    throw credentialCryptoError(
      'TRADING_CREDENTIAL_ENCRYPTION_KEY_ID cannot contain a colon.'
    );
  }

  return keyId;
}

function decodeBase64PayloadPart(value: string, label: string) {
  if (!value) {
    throw credentialCryptoError(`Encrypted credential payload is missing ${label}.`);
  }

  return Buffer.from(value, 'base64');
}

export function encryptSecret(plaintext: string): string {
  const key = requireEncryptionKey();
  const keyId = requireEncryptionKeyId();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    PAYLOAD_VERSION,
    ALGORITHM,
    keyId,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(payload: string): string {
  const key = requireEncryptionKey();
  const parts = payload.split(':');

  if (parts.length !== PAYLOAD_PARTS) {
    throw credentialCryptoError(
      'Encrypted credential payload must use v1:aes-256-gcm:<keyId>:<ivBase64>:<authTagBase64>:<ciphertextBase64> format.'
    );
  }

  const [version, algorithm, keyId, ivBase64, authTagBase64, ciphertextBase64] =
    parts;

  if (version !== PAYLOAD_VERSION) {
    throw credentialCryptoError(
      `Unsupported encrypted credential payload version "${version}".`
    );
  }

  if (algorithm !== ALGORITHM) {
    throw credentialCryptoError(
      `Unsupported encrypted credential payload algorithm "${algorithm}".`
    );
  }

  if (!keyId) {
    throw credentialCryptoError('Encrypted credential payload is missing key id.');
  }

  const iv = decodeBase64PayloadPart(ivBase64 ?? '', 'iv');
  const authTag = decodeBase64PayloadPart(authTagBase64 ?? '', 'auth tag');
  const ciphertext = decodeBase64PayloadPart(
    ciphertextBase64 ?? '',
    'ciphertext'
  );

  if (iv.length !== IV_BYTES) {
    throw credentialCryptoError('Encrypted credential payload has an invalid iv.');
  }

  if (authTag.length !== AUTH_TAG_BYTES) {
    throw credentialCryptoError(
      'Encrypted credential payload has an invalid auth tag.'
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw credentialCryptoError(
      'Encrypted credential payload could not be authenticated or decrypted.'
    );
  }
}

export function fingerprintSecret(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
