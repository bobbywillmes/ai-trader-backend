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
  let securityId: number;
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
    securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ('P3C4','Authority fixture',false,'STOCK',now(),now()) RETURNING id`)).rows[0].id;
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

  it('counts every canonical lifecycle exposure kind and excludes released or terminal evidence', async () => {
    const authority = await import('../../services/paper-broker-write-authority.service.js');
    const { encryptSecret, fingerprintSecret } = await import('../../services/trading-credential-crypto.service.js');
    await db.query(`UPDATE "TradingAccountCredential" SET "apiKeyCiphertext"=$2,"keyFingerprint"=$3 WHERE "tradingAccountId"=$1`, [accountId, encryptSecret(apiKey), fingerprintSecret(apiKey)]);
    const insertIntent = async (status: string, side = 'buy') => Number((await db.query(
      `INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('test','P3C4',$2,'market','day',$3,'{}',$1,now(),now()) RETURNING id`,
      [accountId, side, status])).rows[0].id);
    const assertCounts = async (expected: Partial<{ activePositions: number; nonterminalBrokerOrders: number; activeOrderIntents: number; activeEntryClaims: number }>) => {
      await expect(authority.assessPaperBrokerWriteAuthorityForAccount(accountId)).resolves.toMatchObject({ openLifecycleExposure: true, exposure: expected });
    };

    for (const status of ['received', 'pending', 'submitting', 'submitted']) {
      const id = await insertIntent(status);
      await assertCounts({ activeOrderIntents: 1 });
      await db.query(`DELETE FROM "OrderIntent" WHERE id=$1`, [id]);
    }
    const filled = await insertIntent('filled');
    await assertCounts({ activeOrderIntents: 1 });
    await db.query(`DELETE FROM "OrderIntent" WHERE id=$1`, [filled]);

    const claimIntent = await insertIntent('blocked');
    const claimId = Number((await db.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"acquiredAt","createdAt","updatedAt") VALUES ($1,$2,$3,'authority-claim','UNRESOLVED',now(),now(),now()) RETURNING id`, [accountId, securityId, claimIntent])).rows[0].id);
    await assertCounts({ activeEntryClaims: 1 });
    await db.query(`UPDATE "EntryExposureClaim" SET status='RELEASED',"releasedAt"=now(),"releaseReason"='TEST' WHERE id=$1`, [claimId]);
    await expect(authority.assessPaperBrokerWriteAuthorityForAccount(accountId)).resolves.toMatchObject({ openLifecycleExposure: false, exposure: { activeEntryClaims: 0 } });
    await db.query(`DELETE FROM "EntryExposureClaim" WHERE id=$1`, [claimId]);
    await db.query(`DELETE FROM "OrderIntent" WHERE id=$1`, [claimIntent]);

    const brokerIntent = await insertIntent('failed');
    const brokerOrderId = Number((await db.query(`INSERT INTO "BrokerOrder" ("orderIntentId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","securityId","tradingAccountId","createdAt","updatedAt") VALUES ($1,'alpaca','p3c4-order','p3c4-client','P3C4','buy','new','{}',$2,$3,now(),now()) RETURNING id`, [brokerIntent, securityId, accountId])).rows[0].id);
    await assertCounts({ nonterminalBrokerOrders: 1 });
    await db.query(`UPDATE "BrokerOrder" SET status='filled' WHERE id=$1`, [brokerOrderId]);
    await expect(authority.assessPaperBrokerWriteAuthorityForAccount(accountId)).resolves.toMatchObject({ openLifecycleExposure: false, exposure: { nonterminalBrokerOrders: 0 } });
    await db.query(`DELETE FROM "BrokerOrder" WHERE id=$1`, [brokerOrderId]);
    await db.query(`DELETE FROM "OrderIntent" WHERE id=$1`, [brokerIntent]);

    const positionId = Number((await db.query(`INSERT INTO "TrackedPosition" (broker,symbol,side,qty,"avgEntryPrice","currentPrice","marketValue","costBasis","unrealizedPnL","unrealizedPnLPct",status,"openedAt","lastSyncedAt","rawPositionJson","securityId","tradingAccountId","createdAt","updatedAt") VALUES ('alpaca','P3C4','long',1,1,1,1,1,0,0,'closing',now(),now(),'{}',$1,$2,now(),now()) RETURNING id`, [securityId, accountId])).rows[0].id);
    await assertCounts({ activePositions: 1 });
    await db.query(`UPDATE "TrackedPosition" SET status='closed',"closedAt"=now() WHERE id=$1`, [positionId]);
    await expect(authority.assessPaperBrokerWriteAuthorityForAccount(accountId)).resolves.toMatchObject({ openLifecycleExposure: false, exposure: { activePositions: 0 } });
  });
});
