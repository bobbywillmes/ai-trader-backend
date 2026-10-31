import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';

vi.mock('../../services/risk-gate.service.js', () => ({
  evaluateOrderRisk: vi.fn(async () => ({ allowed: true, statusCode: 200, reason: 'allowed', details: { rule: 'restricted-role' } })),
  logRiskGateBlockedOrder: vi.fn(async () => undefined),
}));

// Roles are cluster-wide, so this suite runs only against a throwaway PostgreSQL server: it creates
// and drops ai_trader_migrator and ai_trader_app. Never enable it against a persistent cluster.
const enabled = process.env.RUN_RESTRICTED_ROLE_TESTS === '1' && process.env.DATABASE_URL;

(enabled ? describe : describe.skip)('least-privilege runtime role (disposable cluster only)', () => {
  const database = `restricted_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  const sourceUrl = process.env.DATABASE_URL!;
  const fetchSpy = vi.fn(async () => { throw new Error('Restricted-role tests forbid broker network access'); });
  let admin: Client, superDb: Client, app: Client;
  let fixture: Awaited<ReturnType<typeof createTradingViewGraphFixture>>;

  const urlFor = (role: string) => { const url = new URL(sourceUrl); url.username = role; url.password = password; url.pathname = `/${database}`; url.searchParams.delete('schema'); return url.toString(); };
  const superUrl = () => { const url = new URL(sourceUrl); url.pathname = `/${database}`; url.searchParams.delete('schema'); return url.toString(); };

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    admin = new Client({ connectionString: sourceUrl }); await admin.connect();
    for (const role of ['ai_trader_migrator', 'ai_trader_app']) await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE "${database}" OWNER ai_trader_migrator`);
    const migrated = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: urlFor('ai_trader_migrator') }, encoding: 'utf8', timeout: 180_000 });
    expect(migrated.status, `${migrated.stderr}\n${migrated.stdout}`).toBe(0);
    const migrator = new Client({ connectionString: urlFor('ai_trader_migrator') }); await migrator.connect();
    await migrator.query(await readFile('docs/database/least-privilege-grants.sql', 'utf8'));
    await migrator.end();
    superDb = new Client({ connectionString: superUrl() }); await superDb.connect();
    process.env.DATABASE_URL = urlFor('ai_trader_app');
    app = new Client({ connectionString: urlFor('ai_trader_app') }); await app.connect();
    fixture = await createTradingViewGraphFixture(app);
  }, 240_000);

  afterAll(async () => {
    await (await import('../../services/trading-account-workflow-lock.service.js')).closeTradingAccountWorkflowLockPool().catch(() => undefined);
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    await app?.end(); await superDb?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      for (const role of ['ai_trader_migrator', 'ai_trader_app']) await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
    process.env.DATABASE_URL = sourceUrl;
    vi.unstubAllGlobals();
  });

  it('holds no administrative attribute, membership or table ownership', async () => {
    expect((await app.query(`SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0])
      .toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false });
    expect((await app.query(`SELECT count(*)::int n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user`)).rows[0].n).toBe(0);
    expect((await app.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=current_user AND c.relkind IN ('r','S','v','m')`)).rows[0].n).toBe(0);
    expect((await app.query(`SELECT count(*)::int n FROM information_schema.role_table_grants WHERE grantee=current_user AND privilege_type NOT IN ('SELECT','INSERT','UPDATE','DELETE')`)).rows[0].n).toBe(0);
  });

  it.each([
    ['disable a guard trigger', `ALTER TABLE "EntryExposureClaim" DISABLE TRIGGER "EntryExposureClaim_external_signal_c2_guard"`],
    ['drop a guard trigger', `DROP TRIGGER "EntryExposureClaim_external_signal_c2_guard" ON "EntryExposureClaim"`],
    ['replace a guard function', `CREATE OR REPLACE FUNCTION external_signal_c2_delivery_event_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`],
    ['bypass triggers by replication role', `SET session_replication_role='replica'`],
    ['truncate evidence', `TRUNCATE "EntryExposureClaimEvent"`],
    ['create a table', `CREATE TABLE restricted_probe (id integer)`],
    ['read migration history', `SELECT * FROM "_prisma_migrations"`],
    ['create a role', `CREATE ROLE restricted_probe`],
    ['create a database', `CREATE DATABASE restricted_probe`],
  ])('cannot %s', async (_label, sql) => {
    await expect(app.query(sql)).rejects.toThrow(/permission denied|must be owner|must be superuser/);
  });

  it('migrates fresh without superuser and leaves the schema without Prisma drift', () => {
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { env: { ...process.env, DATABASE_URL: urlFor('ai_trader_migrator') }, encoding: 'utf8', timeout: 60_000 });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  }, 70_000);

  it('cuts a superuser-owned database over, keeps Prisma history usable, and rolls back without schema work', async () => {
    const cutover = `restricted_cutover_${randomUUID().replaceAll('-', '')}`;
    const adminUrl = new URL(sourceUrl); adminUrl.pathname = `/${cutover}`; adminUrl.searchParams.delete('schema');
    const roleUrl = (role: string) => { const url = new URL(adminUrl); url.username = role; url.password = password; return url.toString(); };
    await admin.query(`CREATE DATABASE "${cutover}"`);
    const prismaCli = (args: string[], url: string) => spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 180_000 });
    const superuser = new Client({ connectionString: adminUrl.toString() }); let migrator: Client | null = null, runtime: Client | null = null;
    try {
      const superMigrated = prismaCli(['migrate', 'deploy'], adminUrl.toString());
      expect(superMigrated.status, superMigrated.stderr).toBe(0);
      await superuser.connect();
      await superuser.query(await readFile('docs/database/least-privilege-cutover.sql', 'utf8'));
      migrator = new Client({ connectionString: roleUrl('ai_trader_migrator') }); await migrator.connect();
      await migrator.query(await readFile('docs/database/least-privilege-grants.sql', 'utf8'));
      expect((await superuser.query(`SELECT c.relname,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_depend d ON d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i','e') WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') AND d.objid IS NULL AND pg_get_userbyid(c.relowner)<>'ai_trader_migrator'`)).rows).toEqual([]);
      expect(prismaCli(['migrate', 'deploy'], roleUrl('ai_trader_migrator')).status).toBe(0);
      expect(prismaCli(['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], roleUrl('ai_trader_migrator')).status).toBe(0);

      // A later migration by the migrator can replace a guard and gets application grants by default.
      await migrator.query(`CREATE OR REPLACE FUNCTION external_signal_stale_admission_elapsed(observed_utc timestamp, at_instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT (observed_utc AT TIME ZONE 'UTC') <= at_instant - interval '15 minutes' $$`);
      await migrator.query(`CREATE TABLE future_migration_probe (id serial PRIMARY KEY)`);
      runtime = new Client({ connectionString: roleUrl('ai_trader_app') }); await runtime.connect();
      await runtime.query(`INSERT INTO future_migration_probe DEFAULT VALUES`);
      await expect(runtime.query(`ALTER TABLE "EntryExposureClaim" DISABLE TRIGGER "EntryExposureClaim_external_signal_c2_guard"`)).rejects.toThrow(/must be owner/);

      // Rollback is only restoring the previous credential, which still has full access.
      await superuser.query(`ALTER TABLE "EntryExposureClaim" DISABLE TRIGGER "EntryExposureClaim_external_signal_c2_guard"`);
      await superuser.query(`ALTER TABLE "EntryExposureClaim" ENABLE TRIGGER "EntryExposureClaim_external_signal_c2_guard"`);
      expect((await superuser.query(`SELECT count(*)::int n FROM future_migration_probe`)).rows[0].n).toBe(1);
    } finally {
      await runtime?.end(); await migrator?.end(); await superuser.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${cutover}" WITH (FORCE)`);
    }
  }, 240_000);

  it('runs the worker refusal, stale recovery, uncertainty attention and shared release while triggers still bind', async () => {
    const worker = await import('../../services/external-signal-broker-worker.service.js');
    const scheduler = await import('../../workers/order.worker.js');

    const refused = await fixture.admit('restricted-refusal');
    await app.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [refused.intentId]);
    expect(await worker.processTradingViewOrderIntentForC2(refused.intentId)).toEqual({ outcome: 'C2_DISPATCH_REFUSED' });
    expect((await app.query(`SELECT "releasedAt" IS NOT NULL AS released FROM "EntryExposureClaim" WHERE id=$1`, [refused.claimId])).rows[0].released).toBe(true);
    await expect(app.query(`UPDATE "OrderIntent" SET status='failed' WHERE id=$1`, [refused.intentId])).rejects.toThrow(/terminal TradingView intent/);

    const crashed = await fixture.admit('restricted-crash');
    await fixture.workerClaim(crashed);
    await scheduler.recoverStaleSubmittingIntents();
    expect((await app.query(`SELECT i.status,ec."releasedAt" IS NOT NULL AS released FROM "OrderIntent" i JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=i.id WHERE i.id=$1`, [crashed.intentId])).rows[0]).toEqual({ status: 'blocked', released: true });

    const uncertain = await fixture.admit('restricted-uncertain');
    await fixture.workerClaim(uncertain);
    await app.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'BROKER_DELIVERY_UNCERTAIN','{}')`, [uncertain.claimId]);
    await scheduler.recoverStaleSubmittingIntents(); await scheduler.recoverStaleSubmittingIntents();
    expect((await app.query(`SELECT count(*)::int n FROM "OperationalAttention" WHERE "orderIntentId"=$1 AND status='OPEN'`, [uncertain.intentId])).rows[0].n).toBe(1);
    await expect(app.query(`UPDATE "EntryExposureClaim" SET status='RELEASED',"releasedAt"=now(),"releaseReason"='hostile' WHERE id=$1`, [uncertain.claimId])).rejects.toThrow(/current uncontradicted/);
    await expect(app.query(`UPDATE "EntryExposureClaimEvent" SET "evidenceJson"='{}' WHERE "claimId"=$1`, [uncertain.claimId])).rejects.toThrow(/immutable/);
    await expect(app.query(`DELETE FROM "EntryExposureClaimEvent" WHERE "claimId"=$1`, [uncertain.claimId])).rejects.toThrow(/immutable/);

    const stale = await fixture.admit('restricted-stale');
    await expect(app.query(`UPDATE "EntryExposureClaim" SET "acquiredAt"='2020-01-01' WHERE id=$1`, [stale.claimId])).rejects.toThrow(/immutable/);
    // Only the fixture's separate superuser connection can age the row.
    await superDb.query('BEGIN');
    await superDb.query(`SET LOCAL session_replication_role='replica'`);
    await superDb.query(`UPDATE "OrderIntent" SET "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC') - interval '20 minutes' WHERE id=$1`, [stale.intentId]);
    await superDb.query(`UPDATE "EntryExposureClaim" SET "acquiredAt"=(clock_timestamp() AT TIME ZONE 'UTC') - interval '20 minutes' WHERE id=$1`, [stale.claimId]);
    await superDb.query('COMMIT');
    await scheduler.recoverStaleSubmittingIntents();
    expect((await app.query(`SELECT i.status,ec."releasedAt" IS NOT NULL AS released FROM "OrderIntent" i JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=i.id WHERE i.id=$1`, [stale.intentId])).rows[0]).toEqual({ status: 'failed', released: true });

    const writes = (fetchSpy.mock.calls as unknown as Array<[unknown, { method?: string }?]>).filter(([, init]) => (init?.method ?? 'GET').toUpperCase() !== 'GET');
    expect(writes).toEqual([]);
  }, 120_000);
});
