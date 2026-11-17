import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposablePostgresDatabase, type DisposablePostgresDatabase } from './disposable-postgres.js';

const MIGRATION = '20261116120000_tradingview_atomic_send_consumption_foundation';
const BASELINE = '20261111120000_tradingview_send_permission_foundation';
const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

(enabled ? describe : describe.skip)('C3C.1B.1 upgrade from the accepted 110-migration schema', () => {
  let disposable: DisposablePostgresDatabase;
  let scratch: string;
  let baselineConfig: string;
  let upgradeConfig: string;
  let db: Client;
  let historical: { intentId: number; claimId: number; fence: string; events: Array<{ id: number; eventType: string; evidenceJson: unknown; createdAt: Date }> };

  const prisma = (config: string, ...args: string[]) => spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args, '--config', config], {
    env: { ...process.env, DATABASE_URL: disposable.url }, encoding: 'utf8', timeout: 180_000,
  });

  beforeAll(async () => {
    disposable = await createDisposablePostgresDatabase(process.env.DATABASE_URL!, 'c3c1b1_upgrade');
    scratch = await mkdtemp(path.join(tmpdir(), 'c3c1b1-upgrade-'));
    const names = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    expect(names.at(-1)).toBe(MIGRATION);
    expect(names).toHaveLength(111);
    const baselinePath = path.join(scratch, 'baseline');
    const upgradePath = path.join(scratch, 'upgrade');
    await cp('prisma/migrations', baselinePath, { recursive: true, filter: source => {
      const name = source.replaceAll('\\', '/').match(/prisma\/migrations\/(\d+_[^/]+)/)?.[1];
      return name === undefined || name <= BASELINE;
    } });
    await cp('prisma/migrations', upgradePath, { recursive: true });
    baselineConfig = path.join(scratch, 'baseline.config.ts');
    upgradeConfig = path.join(scratch, 'upgrade.config.ts');
    const schema = path.resolve('prisma/schema.prisma').replaceAll('\\', '/');
    await writeFile(baselineConfig, `export default { schema: ${JSON.stringify(schema)}, migrations: { path: ${JSON.stringify(baselinePath.replaceAll('\\', '/'))} }, datasource: { url: process.env.DATABASE_URL } };\n`);
    await writeFile(upgradeConfig, `export default { schema: ${JSON.stringify(schema)}, migrations: { path: ${JSON.stringify(upgradePath.replaceAll('\\', '/'))} }, datasource: { url: process.env.DATABASE_URL } };\n`);
    const baseline = prisma(baselineConfig, 'migrate', 'deploy');
    expect(baseline.status, `${baseline.stderr}\n${baseline.stdout}`).toBe(0);
    db = new Client({ connectionString: disposable.url }); await db.connect();
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL session_replication_role='replica'`);
      const userId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('c3c-upgrade-history@test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id as number;
      const accountId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","tradingBlocked","createdAt","updatedAt") VALUES ($1,'C3C upgrade history','PAPER','ACTIVE',true,false,false,now(),now()) RETURNING id`, [userId])).rows[0].id as number;
      const securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ('C3CHIST','C3CHIST',true,'STOCK',now(),now()) RETURNING id`)).rows[0].id as number;
      const intentId = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('manual','C3CHIST','buy','market','day','submitting','c3c-upgrade-history','{}',$1,now()-interval '2 hours',now()-interval '2 hours') RETURNING id`, [accountId])).rows[0].id as number;
      const claimId = (await db.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"createdAt","updatedAt") VALUES ($1,$2,$3,'c3c-upgrade-history','UNRESOLVED',now()-interval '2 hours',now()-interval '2 hours') RETURNING id`, [accountId, securityId, intentId])).rows[0].id as number;
      await db.query(`INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId",version) VALUES ($1,9)`, [intentId]);
      await db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson","createdAt") VALUES
        ($1,'ADAPTER_INVOCATION_STARTED','{"history":"expired"}',now()-interval '2 hours'),
        ($1,'HISTORICAL_DIAGNOSTIC','{"history":"valid"}',now()-interval '1 minute')`, [claimId]);
      await db.query('COMMIT');
      historical = {
        intentId, claimId, fence: '9',
        events: (await db.query(`SELECT id,"eventType","evidenceJson","createdAt" FROM "EntryExposureClaimEvent" WHERE "claimId"=$1 ORDER BY id`, [claimId])).rows,
      };
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }, 240_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    await disposable?.drop().catch(() => undefined);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('starts at the accepted 110-migration C3C.1A schema', async () => {
    expect((await db.query(`SELECT count(*)::int n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).rows[0].n).toBe(110);
    expect((await db.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1`)).rows[0].migration_name).toBe(BASELINE);
    expect((await db.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='EntryExposureClaimEvent' AND column_name='externalSignalBrokerProtocol'`)).rows[0].n).toBe(0);
    expect(historical.events.map(event => event.eventType)).toEqual(['ADAPTER_INVOCATION_STARTED', 'HISTORICAL_DIAGNOSTIC']);
  });

  it('applies only the forward C3C.1B.1 migration and leaves Prisma at zero drift', async () => {
    const deploy = prisma(upgradeConfig, 'migrate', 'deploy');
    expect(deploy.status, `${deploy.stderr}\n${deploy.stdout}`).toBe(0);
    expect(deploy.stdout).toContain(MIGRATION);
    expect((await db.query(`SELECT count(*)::int n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).rows[0].n).toBe(111);
    const drift = prisma(upgradeConfig, 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code');
    expect(drift.status, `${drift.stderr}\n${drift.stdout}`).toBe(0);
    expect(drift.stdout).toContain('No difference detected');
    expect((await db.query(`SELECT version::text FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [historical.intentId])).rows[0].version).toBe(historical.fence);
    expect((await db.query(`SELECT id,"eventType","evidenceJson","createdAt" FROM "EntryExposureClaimEvent" WHERE "claimId"=$1 ORDER BY id`, [historical.claimId])).rows).toEqual(historical.events);
    expect((await db.query(`SELECT count(*)::int n FROM "EntryExposureClaimEvent" WHERE "claimId"=$1 AND "externalSignalBrokerProtocol" IS NOT NULL`, [historical.claimId])).rows[0].n).toBe(0);
  }, 240_000);
});
