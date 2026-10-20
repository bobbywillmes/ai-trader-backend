import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgresDatabase, type DisposablePostgresDatabase } from './disposable-postgres.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

(enabled ? describe : describe.skip)('PAPER broker-write authority PostgreSQL integration', () => {
  let disposable: DisposablePostgresDatabase;
  let db: Client;
  let accountId: number;
  const apiKey = 'paper-authority-integration-key';
  const brokerAccountId = 'PA3C4TEST';

  beforeAll(async () => {
    disposable = await createDisposablePostgresDatabase(process.env.DATABASE_URL!, 'paper_authority');
    await disposable.migrate();
    await disposable.verify();
    db = new Client({ connectionString: disposable.url });
    await db.connect();
    const userId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('paper-authority@test.invalid','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id;
    accountId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","brokerAccountId","createdAt","updatedAt") VALUES ($1,'Authority Paper','PAPER','PAUSED',false,true,$2,now(),now()) RETURNING id`, [userId, brokerAccountId])).rows[0].id;
    process.env.DATABASE_URL = disposable.url;
    process.env.NODE_ENV = 'production';
    process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.TRADING_CREDENTIAL_ENCRYPTION_KEY_ID = 'paper-authority-test';
    const fingerprint = `sha256:${createHash('sha256').update(apiKey).digest('hex')}`;
    process.env.PAPER_BROKER_WRITE_DEPLOYMENT_ROLE = 'PAPER_EXECUTOR';
    process.env.PAPER_BROKER_WRITE_AUTHORIZATIONS = JSON.stringify([{ brokerAccountId, keyFingerprint: fingerprint }]);
    process.env.PAPER_BROKER_WRITE_OWNERSHIP = JSON.stringify([{ tradingAccountId: accountId, role: 'EXECUTOR', expectedBrokerAccountId: brokerAccountId }]);
    vi.resetModules();
    const crypto = await import('../../services/trading-credential-crypto.service.js');
    await db.query(`INSERT INTO "TradingAccountCredential" ("tradingAccountId","authType",status,"apiKeyCiphertext","apiSecretCiphertext","keyFingerprint","encryptionVersion","verifiedAt","createdAt","updatedAt") VALUES ($1,'API_KEY','ACTIVE',$2,$3,$4,1,now(),now(),now())`,
      [accountId, crypto.encryptSecret(apiKey), crypto.encryptSecret('paper-authority-secret'), fingerprint]);
  }, 180_000);

  afterAll(async () => {
    const { prisma } = await import('../prisma.js');
    await prisma.$disconnect();
    if (db) await db.end();
    if (disposable) await disposable.drop();
    vi.unstubAllEnvs();
  });

  it('authorizes only the exact expected account identity and credential', async () => {
    const authority = await import('../../services/paper-broker-write-authority.service.js');
    await expect(authority.assessPaperBrokerWriteAuthorityForAccount(accountId)).resolves.toMatchObject({ outcome: 'AUTHORIZED', ready: true });
    await db.query(`UPDATE "TradingAccount" SET "brokerAccountId"='TYPO' WHERE id=$1`, [accountId]);
    await expect(authority.assessPaperBrokerWriteAuthorityForAccount(accountId)).resolves.toMatchObject({ outcome: 'DENIED', ready: false, brokerAccountIdVerified: false });
    await db.query(`UPDATE "TradingAccount" SET "brokerAccountId"=NULL WHERE id=$1`, [accountId]);
    await expect(authority.assessPaperBrokerWriteAuthorityForAccount(accountId)).resolves.toMatchObject({ outcome: 'UNKNOWN', ready: false, brokerAccountIdVerified: false });
    await db.query(`UPDATE "TradingAccount" SET "brokerAccountId"=$2 WHERE id=$1`, [accountId, brokerAccountId]);
  });

  it('fails closed for rotated, inconsistent, and unreadable credentials', async () => {
    const authority = await import('../../services/paper-broker-write-authority.service.js');
    await db.query(`UPDATE "TradingAccountCredential" SET "keyFingerprint"=$2 WHERE "tradingAccountId"=$1`, [accountId, `sha256:${'b'.repeat(64)}`]);
    await expect(authority.assessPaperBrokerWriteAuthorityForAccount(accountId)).resolves.toMatchObject({ outcome: 'DENIED', credentialFingerprintConsistent: false });
    await db.query(`UPDATE "TradingAccountCredential" SET "apiKeyCiphertext"='unreadable' WHERE "tradingAccountId"=$1`, [accountId]);
    await expect(authority.assessPaperBrokerWriteAuthorityForAccount(accountId)).resolves.toMatchObject({ outcome: 'UNKNOWN', ready: false });
  });

  it('opens, observes, and authoritatively resolves mismatch attention only after fresh verification', async () => {
    const authority = await import('../../services/paper-broker-write-authority.service.js');
    const attention = await import('../../services/paper-broker-write-authority-attention.service.js');
    const { fingerprintSecret, encryptSecret } = await import('../../services/trading-credential-crypto.service.js');
    const denied = await authority.assessPaperBrokerWriteAuthorityForAccount(accountId);
    const opened = await attention.reconcilePaperBrokerWriteAuthorityAttention({ ...denied, openLifecycleExposure: true });
    expect(opened).toMatchObject({ attention: { status: 'OPEN', occurrenceCount: 1 } });
    const observed = await attention.reconcilePaperBrokerWriteAuthorityAttention({ ...denied, openLifecycleExposure: true });
    expect(observed).toMatchObject({ attention: { status: 'OPEN', occurrenceCount: 2 } });
    const fingerprint = fingerprintSecret(apiKey);
    await db.query(`UPDATE "TradingAccountCredential" SET "apiKeyCiphertext"=$2,"keyFingerprint"=$3 WHERE "tradingAccountId"=$1`, [accountId, encryptSecret(apiKey), fingerprint]);
    const authorized = await authority.assessPaperBrokerWriteAuthorityForAccount(accountId);
    expect(authorized.outcome).toBe('AUTHORIZED');
    const resolved = await attention.reconcilePaperBrokerWriteAuthorityAttention(authorized);
    expect(resolved).toMatchObject({ status: 'RESOLVED' });
  });
});
