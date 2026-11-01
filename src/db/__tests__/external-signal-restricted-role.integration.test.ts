import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';
import { assessDatabaseSecurity, CRITICAL_TRIGGERS, type SecurityReadinessMode } from '../../services/database-security-readiness.service.js';

vi.mock('../../services/risk-gate.service.js', () => ({
  evaluateOrderRisk: vi.fn(async () => ({ allowed: true, statusCode: 200, reason: 'allowed', details: { rule: 'restricted-role' } })),
  logRiskGateBlockedOrder: vi.fn(async () => undefined),
}));

// Roles are cluster-wide, so this suite runs only against a throwaway PostgreSQL server: it creates
// and drops ai_trader_migrator and ai_trader_app. Never enable it against a persistent cluster.
const enabled = process.env.RUN_RESTRICTED_ROLE_TESTS === '1' && process.env.DATABASE_URL;

const TRUSTED_PATH = 'search_path=pg_catalog, public, pg_temp';
// The catalog audit: every function the application schema owns, other than extension members and C or
// internal routines, must carry exactly the trusted function-level path.
const applicationFunctions = `FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
  WHERE n.nspname='public' AND p.prokind IN ('f','p') AND l.lanname NOT IN ('c','internal')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`;
const unpinnedFunctionsSql = `SELECT p.oid::regprocedure::text AS fn, p.proconfig ${applicationFunctions} AND NOT ('${TRUSTED_PATH}' = ANY (coalesce(p.proconfig, ARRAY[]::text[])))`;
const releaseSql = `UPDATE public."EntryExposureClaim" SET status='RELEASED',"releasedAt"=now(),"releaseReason"='hostile' WHERE id=$1`;
const resetLifecycleSql = `UPDATE public."OrderIntent" SET status='pending' WHERE id=$1`;
const GUARDS = ['external_signal_exposure_claim_c2_guard()', 'external_signal_order_intent_dispatch_quarantine()'];

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
      // Database-level privilege change: the cutover runs it as the superuser that owns this database.
      await superuser.query(await readFile('docs/database/least-privilege-temporary-revocation.sql', 'utf8'));
      expect((await superuser.query(`SELECT has_database_privilege('ai_trader_app', current_database(), 'TEMPORARY') AS app, has_database_privilege('ai_trader_migrator', current_database(), 'TEMPORARY') AS migrator`)).rows[0]).toEqual({ app: false, migrator: true });
      expect(prismaCli(['migrate', 'deploy'], roleUrl('ai_trader_migrator')).status).toBe(0);
      expect(prismaCli(['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], roleUrl('ai_trader_migrator')).status).toBe(0);

      // A later migration by the migrator can replace a guard and gets application grants by default.
      // CREATE OR REPLACE discards function settings, so a replacing migration must restate the path.
      await migrator.query(`CREATE OR REPLACE FUNCTION external_signal_stale_admission_elapsed(observed_utc timestamp, at_instant timestamptz) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$ SELECT (observed_utc AT TIME ZONE 'UTC') <= at_instant - interval '15 minutes' $$`);
      await migrator.query(`CREATE TABLE future_migration_probe (id serial PRIMARY KEY)`);
      runtime = new Client({ connectionString: roleUrl('ai_trader_app') }); await runtime.connect();
      await runtime.query(`INSERT INTO future_migration_probe DEFAULT VALUES`);
      await expect(runtime.query(`CREATE TEMP TABLE "OrderIntent" (id integer)`)).rejects.toThrow(/permission denied to create temporary tables/);
      // Every application function, including ones the cutover transferred, keeps the trusted path.
      expect((await superuser.query(unpinnedFunctionsSql)).rows).toEqual([]);
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

  describe('temporary-table shadowing (Phase 4A.2C3A security correction)', () => {
    const attackers: Client[] = [];
    let counter = 0; const next = () => ++counter;
    const connect = async (role = 'ai_trader_app', sessionSql?: string) => {
      const client = new Client({ connectionString: urlFor(role) }); await client.connect(); attackers.push(client);
      if (sessionSql) await client.query(sessionSql);
      return client;
    };
    afterAll(async () => { await Promise.all(attackers.map(client => client.end().catch(() => undefined))); });
    const shadow = async (client: Client, tables: string[]) => {
      for (const table of tables) await client.query(`CREATE TEMP TABLE "${table}" (LIKE public."${table}")`);
    };
    const allTables = async () => (await superDb.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY 1`)).rows.map(row => row.tablename as string);
    const claimState = async (claimId: number) => (await app.query(`SELECT status,"releasedAt" IS NOT NULL AS released FROM "EntryExposureClaim" WHERE id=$1`, [claimId])).rows[0];
    const intentStatus = async (intentId: number) => (await app.query(`SELECT status FROM "OrderIntent" WHERE id=$1`, [intentId])).rows[0].status as string;
    const attempt = (client: Client, sql: string, id: number) => client.query(sql, [id]).then(() => null, (error: Error) => error);
    const uncertainSql = `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'BROKER_DELIVERY_UNCERTAIN','{}')`;

    /** Attack A: a claimed intent with recorded uncertain delivery, released while OrderIntent is shadowed. */
    const attackA = async (client: Client, label: string, tables: string[]) => {
      const graph = await fixture.admit(label); await fixture.workerClaim(graph);
      await app.query(uncertainSql, [graph.claimId]);
      await shadow(client, tables);
      return { error: await attempt(client, releaseSql, graph.claimId), claim: await claimState(graph.claimId) };
    };
    /** Attack B: a worker-owned submitting intent moved back to pending while the event and worker-claim tables are shadowed. */
    const attackB = async (client: Client, label: string, tables: string[]) => {
      const graph = await fixture.admit(label); await fixture.workerClaim(graph);
      await shadow(client, tables);
      return { error: await attempt(client, resetLifecycleSql, graph.intentId), intent: await intentStatus(graph.intentId) };
    };
    const HERMES_A = ['OrderIntent'], HERMES_B = ['EntryExposureClaimEvent', 'ExternalSignalBrokerWorkerClaim'];
    const sessionModes: Array<[string, string | undefined]> = [['the default session path', undefined], ['a hostile session path that searches pg_temp first', 'SET search_path = pg_temp, public'], ['a session path containing only pg_temp', 'SET search_path = pg_temp']];
    const unpinGuards = async () => { for (const fn of GUARDS) await superDb.query(`ALTER FUNCTION ${fn} RESET search_path`); };
    const repinGuards = async () => { for (const fn of GUARDS) await superDb.query(`ALTER FUNCTION ${fn} SET search_path = pg_catalog, public, pg_temp`); };

    it('verifies the attack environment is real: the application role can shadow relations while TEMPORARY is inherited from PUBLIC', async () => {
      expect((await app.query(`SELECT has_database_privilege(current_user, current_database(), 'TEMPORARY') AS temporary`)).rows[0].temporary).toBe(true);
      const client = await connect();
      await shadow(client, ['OrderIntent']);
      expect((await client.query(`SELECT (SELECT count(*)::int FROM "OrderIntent") AS visible, to_regclass('"OrderIntent"')::oid <> 'public."OrderIntent"'::regclass::oid AS shadowed`)).rows[0]).toEqual({ visible: 0, shadowed: true });
    });

    it('audits the catalog: every application function pins exactly the trusted path, none is SECURITY DEFINER, ownership is unchanged', async () => {
      expect((await superDb.query(unpinnedFunctionsSql)).rows).toEqual([]);
      const counted = (await superDb.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE l.lanname='plpgsql')::int AS plpgsql, count(*) FILTER (WHERE p.prosecdef)::int AS definers, count(*) FILTER (WHERE pg_get_userbyid(p.proowner)<>'ai_trader_migrator')::int AS foreign_owner, count(*) FILTER (WHERE array_length(p.proconfig,1)<>1)::int AS extra_settings ${applicationFunctions}`)).rows[0];
      expect(counted).toEqual({ total: 117, plpgsql: 113, definers: 0, foreign_owner: 0, extra_settings: 0 });
    });

    it('closes nested name resolution: every application function that another application function calls is itself pinned', async () => {
      const edges = (await superDb.query(`SELECT caller.proname AS caller, callee.proname AS callee, caller.proconfig IS NOT NULL AND callee.proconfig IS NOT NULL AS both_pinned
        FROM pg_proc caller JOIN pg_namespace cn ON cn.oid=caller.pronamespace
        JOIN pg_proc callee ON callee.pronamespace=caller.pronamespace AND callee.oid<>caller.oid
        WHERE cn.nspname='public' AND caller.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('plpgsql','sql'))
          AND callee.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('plpgsql','sql'))
          AND caller.prosrc ~ ('\\m' || callee.proname || '\\s*\\(')`)).rows;
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.filter(edge => !edge.both_pinned)).toEqual([]);
    });

    it('negative control: without the function-level path, both original attacks succeed against this schema', async () => {
      try {
        await unpinGuards();
        const a = await attackA(await connect(), `control-a-${next()}`, HERMES_A);
        expect(a.error).toBeNull(); expect(a.claim.released).toBe(true);
        const b = await attackB(await connect(), `control-b-${next()}`, HERMES_B);
        expect(b.error).toBeNull(); expect(b.intent).toBe('pending');
      } finally { await repinGuards(); }
      expect((await superDb.query(unpinnedFunctionsSql)).rows).toEqual([]);
    });

    it.each(sessionModes)('Attack A (uncertain-delivery release) is rejected with TEMPORARY available, under %s', async (_label, sessionSql) => {
      const result = await attackA(await connect('ai_trader_app', sessionSql), `attack-a-${next()}`, HERMES_A);
      expect(result.error?.message).toMatch(/current uncontradicted|possible-delivery/);
      expect(result.claim).toEqual({ status: 'ENTRY_SUBMITTING', released: false });
    });

    it.each(sessionModes)('Attack B (submitting to pending reset) is rejected with TEMPORARY available, under %s', async (_label, sessionSql) => {
      const result = await attackB(await connect('ai_trader_app', sessionSql), `attack-b-${next()}`, HERMES_B);
      expect(result.error?.message).toMatch(/quarantined/);
      expect(result.intent).toBe('submitting');
    });

    it('rejects both attacks even when every application relation is shadowed by an empty temporary table', async () => {
      const tables = await allTables();
      expect(tables.length).toBeGreaterThan(100);
      const a = await attackA(await connect('ai_trader_app', 'SET search_path = pg_temp, public'), `shadow-all-a-${next()}`, tables);
      expect(a.error?.message).toMatch(/current uncontradicted|possible-delivery/);
      expect(a.claim).toEqual({ status: 'ENTRY_SUBMITTING', released: false });
      const b = await attackB(await connect('ai_trader_app', 'SET search_path = pg_temp, public'), `shadow-all-b-${next()}`, tables);
      expect(b.error?.message).toMatch(/quarantined/);
      expect(b.intent).toBe('submitting');
    });

    it('refuses the TEMPORARY revocation to the runtime role, and fails loudly when a role membership would restore it', async () => {
      const script = await readFile('docs/database/least-privilege-temporary-revocation.sql', 'utf8');
      await expect((await connect()).query(script)).rejects.toThrow(/run as a superuser or the owner of database/);
      try {
        await superDb.query(`CREATE ROLE restricted_temp_group NOLOGIN`);
        await superDb.query(`GRANT TEMPORARY ON DATABASE "${database}" TO restricted_temp_group`);
        await superDb.query(`GRANT restricted_temp_group TO ai_trader_app`);
        await expect(superDb.query(script)).rejects.toThrow(/ai_trader_app must hold no role membership.*restricted_temp_group.*nothing was changed/s);
      } finally {
        await superDb.query(`REVOKE restricted_temp_group FROM ai_trader_app`).catch(() => undefined);
        await superDb.query(`REVOKE TEMPORARY ON DATABASE "${database}" FROM restricted_temp_group`).catch(() => undefined);
        await superDb.query(`DROP ROLE IF EXISTS restricted_temp_group`);
      }
    });

    it('revokes TEMPORARY as the database owner, keeps it for the migrator, and drained connections cannot create temporary tables', async () => {
      const survivor = await connect(); survivor.on('error', () => undefined); await shadow(survivor, ['OrderIntent']);
      const survivorPid = (await survivor.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
      const script = await readFile('docs/database/least-privilege-temporary-revocation.sql', 'utf8');
      const owner = await connect('ai_trader_migrator'); await owner.query(script);
      expect((await owner.query(`SELECT has_database_privilege('ai_trader_app', current_database(), 'TEMPORARY') AS app, has_database_privilege('ai_trader_migrator', current_database(), 'TEMPORARY') AS migrator, has_database_privilege('public', current_database(), 'TEMPORARY') AS pub`)).rows[0]).toEqual({ app: false, migrator: true, pub: false });
      await owner.query(script); // idempotent
      await expect((await connect()).query(`CREATE TEMP TABLE probe (id integer)`)).rejects.toThrow(/permission denied to create temporary tables/);
      // PostgreSQL checks TEMPORARY on every creation in a session's temporary schema, so even a session
      // that predates the revocation cannot create more. What it already created stays, so the cutover
      // still ends old sessions: a shadow table left in a surviving session is not removed by the REVOKE.
      await expect(survivor.query(`CREATE TEMP TABLE survivor_probe (id integer)`)).rejects.toThrow(/permission denied for schema pg_temp/);
      expect((await survivor.query(`SELECT to_regclass('"OrderIntent"')::oid <> 'public."OrderIntent"'::regclass::oid AS shadowed`)).rows[0].shadowed).toBe(true);
      await superDb.query(`SELECT pg_terminate_backend($1)`, [survivorPid]);
      await expect(survivor.query('SELECT 1')).rejects.toThrow();
    });

    it('with TEMPORARY revoked, shadow creation is denied, and the guards still reject the release even with their path unpinned', async () => {
      const client = await connect();
      await expect(shadow(client, ['OrderIntent'])).rejects.toThrow(/permission denied to create temporary tables/);
      await expect(client.query(`CREATE TEMPORARY TABLE x AS SELECT 1`)).rejects.toThrow(/permission denied to create temporary tables/);
      try {
        await unpinGuards();
        const graph = await fixture.admit(`revoked-only-${next()}`); await fixture.workerClaim(graph);
        await app.query(uncertainSql, [graph.claimId]);
        await expect(shadow(client, HERMES_A)).rejects.toThrow(/permission denied/);
        expect((await attempt(client, releaseSql, graph.claimId))?.message).toMatch(/current uncontradicted|possible-delivery/);
        expect(await claimState(graph.claimId)).toEqual({ status: 'ENTRY_SUBMITTING', released: false });
      } finally { await repinGuards(); }
      expect((await superDb.query(unpinnedFunctionsSql)).rows).toEqual([]);
    });

    it('with both defenses active, a fresh application connection still performs normal DML, function and trigger calls', async () => {
      const client = await connect();
      const graph = await fixture.admit(`both-${next()}`);
      await client.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [graph.intentId]);
      expect((await client.query(`SELECT external_signal_stale_admission_elapsed((now() AT TIME ZONE 'UTC') - interval '20 minutes', now()) AS elapsed`)).rows[0].elapsed).toBe(true);
      await client.query(`SET search_path = pg_temp, public`);
      await client.query(`UPDATE "OrderIntent" SET status='failed' WHERE id=$1`, [graph.intentId]);
      await expect(client.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [graph.intentId])).rejects.toThrow(/terminal TradingView intent/);
    });
  });

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

  it('cannot delete a TradingView-marked exposure claim, including an unclaimed ENTRY_PENDING claim with no events', async () => {
    expect((await app.query(`SELECT has_table_privilege(current_user,'"EntryExposureClaim"','DELETE') AS can_delete`)).rows[0].can_delete).toBe(true);
    const unclaimed = await fixture.admit('restricted-delete-unclaimed');
    expect((await app.query(`SELECT ec.status,count(e.id)::int events FROM "EntryExposureClaim" ec LEFT JOIN "EntryExposureClaimEvent" e ON e."claimId"=ec.id WHERE ec.id=$1 GROUP BY ec.status`, [unclaimed.claimId])).rows[0]).toEqual({ status: 'ENTRY_PENDING', events: 0 });
    const claimed = await fixture.admit('restricted-delete-claimed'); await fixture.workerClaim(claimed);
    for (const target of [unclaimed, claimed]) {
      await expect(app.query(`DELETE FROM "EntryExposureClaim" WHERE id=$1`, [target.claimId])).rejects.toThrow(/marked exposure ownership is permanent/);
      expect((await app.query(`SELECT count(*)::int n FROM "EntryExposureClaim" WHERE id=$1`, [target.claimId])).rows[0].n).toBe(1);
    }
    await expect(app.query(`DELETE FROM "EntryExposureClaim" WHERE "orderIntentId" IN ($1,$2)`, [unclaimed.intentId, claimed.intentId])).rejects.toThrow(/permanent/);
  });

  // ---------------------------------------------------------------------------------------------
  // Phase 4A.2C3B.1: role-membership revocation and the read-only security preflight. A second
  // database keeps these scenarios independent of the TEMPORARY state the tests above leave behind.
  // ---------------------------------------------------------------------------------------------
  describe('role-membership security and database security readiness', () => {
    const secDatabase = `restricted_sec_${randomUUID().replaceAll('-', '')}`;
    let sec: Client, runtime: Client, versionNum = 0;
    const secUrl = (role?: string) => { const url = new URL(sourceUrl); if (role) { url.username = role; url.password = password; } url.pathname = `/${secDatabase}`; url.searchParams.delete('schema'); return url.toString(); };
    const rowsOf = (client: Client) => async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows;
    const preflight = (mode: SecurityReadinessMode, client = runtime) => assessDatabaseSecurity(rowsOf(client) as never, { mode, runtimeRole: 'ai_trader_app' });
    const codes = async (client = runtime) => (await preflight('BROKER_ENABLED', client)).findings.map(finding => finding.code);
    const script = () => readFile('docs/database/least-privilege-temporary-revocation.sql', 'utf8');
    const resetTemporary = async () => { await sec.query(`GRANT TEMPORARY ON DATABASE "${secDatabase}" TO PUBLIC`); await sec.query(`REVOKE TEMPORARY ON DATABASE "${secDatabase}" FROM ai_trader_app`); };
    const scenario = async (setup: string[], restore: string[], expected: string) => {
      try {
        for (const sql of setup) await sec.query(sql);
        const broker = await preflight('BROKER_ENABLED'); const development = await preflight('DEVELOPMENT_OBSERVATION');
        expect(broker.findings.map(finding => finding.code), JSON.stringify(broker.findings)).toContain(expected);
        expect(broker.ready).toBe(false); expect(broker.startupAllowed).toBe(false);
        expect(development.findings.map(finding => finding.code)).toContain(expected); expect(development.startupAllowed).toBe(true);
      } finally { for (const sql of restore) await sec.query(sql); }
    };

    beforeAll(async () => {
      await admin.query(`CREATE DATABASE "${secDatabase}" OWNER ai_trader_migrator`);
      const migrated = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: secUrl('ai_trader_migrator') }, encoding: 'utf8', timeout: 180_000 });
      expect(migrated.status, `${migrated.stderr}\n${migrated.stdout}`).toBe(0);
      const migrator = new Client({ connectionString: secUrl('ai_trader_migrator') }); await migrator.connect();
      await migrator.query(await readFile('docs/database/least-privilege-grants.sql', 'utf8')); await migrator.end();
      sec = new Client({ connectionString: secUrl() }); await sec.connect();
      runtime = new Client({ connectionString: secUrl('ai_trader_app') }); await runtime.connect();
      versionNum = Number((await sec.query(`SHOW server_version_num`)).rows[0].server_version_num);
    }, 240_000);
    afterAll(async () => {
      await runtime?.end().catch(() => undefined); await sec?.end().catch(() => undefined);
      await admin?.query(`DROP DATABASE IF EXISTS "${secDatabase}" WITH (FORCE)`);
    });

    it('reports the TEMPORARY gap as outstanding hardening: development may start, broker-enabled readiness fails closed', async () => {
      const development = await preflight('DEVELOPMENT_OBSERVATION'); const broker = await preflight('BROKER_ENABLED');
      expect(development.findings.map(finding => finding.code)).toEqual(['RUNTIME_ROLE_TEMPORARY_PRIVILEGE']);
      expect(development).toMatchObject({ ready: false, startupAllowed: true });
      expect(broker).toMatchObject({ ready: false, startupAllowed: false });
    });

    it('revokes TEMPORARY with the administrative script, repeatably, keeps the migrator privilege, then reads clean at both levels', async () => {
      await sec.query(await script()); await sec.query(await script());
      expect((await sec.query(`SELECT has_database_privilege('ai_trader_app',current_database(),'TEMPORARY') AS app, has_database_privilege('ai_trader_migrator',current_database(),'TEMPORARY') AS migrator`)).rows[0]).toEqual({ app: false, migrator: true });
      for (const mode of ['DEVELOPMENT_OBSERVATION', 'BROKER_ENABLED'] as const) expect(await preflight(mode)).toMatchObject({ ready: true, startupAllowed: true, findings: [], runtimeRole: 'ai_trader_app' });
    });

    it('runs without any access to the migration history table', async () => {
      expect((await runtime.query(`SELECT has_table_privilege(current_user,'"_prisma_migrations"','SELECT') AS can_read`)).rows[0].can_read).toBe(false);
      await expect(runtime.query(`SELECT 1 FROM "_prisma_migrations"`)).rejects.toThrow(/permission denied/);
      expect((await preflight('BROKER_ENABLED')).ready).toBe(true);
    });

    it('is read-only: the whole assessment runs inside a read-only transaction without error', async () => {
      await runtime.query('BEGIN READ ONLY');
      try { expect((await preflight('BROKER_ENABLED')).findings).toEqual([]); } finally { await runtime.query('ROLLBACK'); }
    });

    describe.each([
      ['INHERIT FALSE, SET TRUE (the Hermes finding)', 'WITH INHERIT FALSE, SET TRUE'],
      ['INHERIT TRUE, SET FALSE', 'WITH INHERIT TRUE, SET FALSE'],
      ['INHERIT FALSE, SET FALSE', 'WITH INHERIT FALSE, SET FALSE'],
      ['ADMIN OPTION', 'WITH ADMIN OPTION'],
      ['INHERIT TRUE, SET TRUE', 'WITH INHERIT TRUE, SET TRUE'],
    ])('membership %s', (_label, options) => {
      it('is rejected by the revocation script before it changes anything, and is reported by the preflight', async () => {
        if (versionNum < 160000) return;
        await resetTemporary();
        await sec.query(`CREATE ROLE sec_member_group NOLOGIN`);
        try {
          await sec.query(`GRANT TEMPORARY ON DATABASE "${secDatabase}" TO sec_member_group`);
          await sec.query(`GRANT sec_member_group TO ai_trader_app ${options}`);
          await expect(sec.query(await script())).rejects.toThrow(/ai_trader_app must hold no role membership.*sec_member_group.*nothing was changed/s);
          // Nothing was revoked: PUBLIC still holds TEMPORARY, so the failure was not a half-applied cutover.
          expect((await sec.query(`SELECT has_database_privilege('public',current_database(),'TEMPORARY') AS pub`)).rows[0].pub).toBe(true);
          expect(await codes()).toContain('RUNTIME_ROLE_MEMBERSHIP');
        } finally {
          await sec.query(`REVOKE sec_member_group FROM ai_trader_app`).catch(() => undefined);
          await sec.query(`REVOKE TEMPORARY ON DATABASE "${secDatabase}" FROM sec_member_group`).catch(() => undefined);
          await sec.query(`DROP ROLE sec_member_group`);
          await sec.query(await script());
        }
      });
    });

    it('demonstrates why: a non-inherited SET-capable membership leaves has_database_privilege false yet permits TEMPORARY objects', async () => {
      if (versionNum < 160000) return;
      await resetTemporary();
      await sec.query(`CREATE ROLE sec_set_group NOLOGIN`);
      try {
        await sec.query(`REVOKE TEMPORARY ON DATABASE "${secDatabase}" FROM PUBLIC`);
        await sec.query(`GRANT TEMPORARY ON DATABASE "${secDatabase}" TO sec_set_group`);
        await sec.query(`GRANT sec_set_group TO ai_trader_app WITH INHERIT FALSE, SET TRUE`);
        expect((await runtime.query(`SELECT has_database_privilege(current_user,current_database(),'TEMPORARY') AS direct`)).rows[0].direct).toBe(false);
        const attacker = new Client({ connectionString: secUrl('ai_trader_app') }); await attacker.connect();
        try {
          await expect(attacker.query(`CREATE TEMP TABLE sneaky (id integer)`)).rejects.toThrow(/permission denied/);
          await attacker.query(`SET ROLE sec_set_group`);
          await attacker.query(`CREATE TEMP TABLE sneaky (id integer)`);
          await attacker.query(`RESET ROLE`);
        } finally { await attacker.end(); }
      } finally {
        await sec.query(`REVOKE sec_set_group FROM ai_trader_app`); await sec.query(`REVOKE TEMPORARY ON DATABASE "${secDatabase}" FROM sec_set_group`); await sec.query(`DROP ROLE sec_set_group`);
        await sec.query(await script());
      }
    });

    it('rejects a predefined-role membership and a role with a privileged attribute', async () => {
      await resetTemporary();
      try {
        await sec.query(`GRANT pg_read_all_data TO ai_trader_app`);
        await expect(sec.query(await script())).rejects.toThrow(/must hold no role membership.*pg_read_all_data/s);
      } finally { await sec.query(`REVOKE pg_read_all_data FROM ai_trader_app`); }
      try {
        await sec.query(`ALTER ROLE ai_trader_app CREATEDB`);
        await expect(sec.query(await script())).rejects.toThrow(/must be a plain role.*CREATEDB.*nothing was changed/s);
      } finally { await sec.query(`ALTER ROLE ai_trader_app NOCREATEDB`); await sec.query(await script()); }
      expect((await preflight('BROKER_ENABLED')).ready).toBe(true);
    });

    it('removes a direct TEMPORARY grant to the runtime role, so the post-check never has to fail', async () => {
      await sec.query(`GRANT TEMPORARY ON DATABASE "${secDatabase}" TO ai_trader_app`);
      await sec.query(await script());
      expect((await sec.query(`SELECT has_database_privilege('ai_trader_app',current_database(),'TEMPORARY') AS app`)).rows[0].app).toBe(false);
    });

    it.each([
      ['a superuser runtime role', [`ALTER ROLE ai_trader_app SUPERUSER`], [`ALTER ROLE ai_trader_app NOSUPERUSER`], 'RUNTIME_ROLE_SUPERUSER'],
      ['a CREATEROLE runtime role', [`ALTER ROLE ai_trader_app CREATEROLE`], [`ALTER ROLE ai_trader_app NOCREATEROLE`], 'RUNTIME_ROLE_PRIVILEGED_ATTRIBUTE'],
      ['a BYPASSRLS runtime role', [`ALTER ROLE ai_trader_app BYPASSRLS`], [`ALTER ROLE ai_trader_app NOBYPASSRLS`], 'RUNTIME_ROLE_PRIVILEGED_ATTRIBUTE'],
      ['a runtime role that owns a table', [`CREATE TABLE sec_owned_probe (id integer)`, `ALTER TABLE sec_owned_probe OWNER TO ai_trader_app`], [`DROP TABLE IF EXISTS sec_owned_probe`], 'RUNTIME_ROLE_OWNS_OBJECTS'],
      ['a runtime role that owns a guard function', [`ALTER FUNCTION external_signal_exposure_claim_delete_guard() OWNER TO ai_trader_app`], [`ALTER FUNCTION external_signal_exposure_claim_delete_guard() OWNER TO ai_trader_migrator`], 'RUNTIME_ROLE_OWNS_OBJECTS'],
      ['a role that may SET session_replication_role', [`GRANT SET ON PARAMETER session_replication_role TO ai_trader_app`], [`REVOKE SET ON PARAMETER session_replication_role FROM ai_trader_app`], 'RUNTIME_ROLE_CAN_BYPASS_TRIGGERS'],
      ['a role with the TEMPORARY privilege', [`GRANT TEMPORARY ON DATABASE current_database_placeholder TO ai_trader_app`], [`REVOKE TEMPORARY ON DATABASE current_database_placeholder FROM ai_trader_app`], 'RUNTIME_ROLE_TEMPORARY_PRIVILEGE'],
      ['a role that can read the migration history table', [`GRANT SELECT ON "_prisma_migrations" TO ai_trader_app`], [`REVOKE SELECT ON "_prisma_migrations" FROM ai_trader_app`], 'RUNTIME_ROLE_MIGRATION_ADMINISTRATOR'],
      ['a disabled critical trigger', [`ALTER TABLE "EntryExposureClaim" DISABLE TRIGGER "EntryExposureClaim_external_signal_delete_guard"`], [`ALTER TABLE "EntryExposureClaim" ENABLE TRIGGER "EntryExposureClaim_external_signal_delete_guard"`], 'CRITICAL_TRIGGER_UNSAFE'],
      ['a replica-only critical trigger', [`ALTER TABLE "EntryExposureClaim" ENABLE REPLICA TRIGGER "EntryExposureClaim_external_signal_c2_guard"`], [`ALTER TABLE "EntryExposureClaim" ENABLE TRIGGER "EntryExposureClaim_external_signal_c2_guard"`], 'CRITICAL_TRIGGER_UNSAFE'],
      ['a dropped critical trigger', [`DROP TRIGGER "EntryExposureClaim_external_signal_delete_guard" ON "EntryExposureClaim"`], [`CREATE TRIGGER "EntryExposureClaim_external_signal_delete_guard" BEFORE DELETE ON "EntryExposureClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_exposure_claim_delete_guard()`], 'CRITICAL_TRIGGER_UNSAFE'],
      ['a function that lost its search_path pin', [`ALTER FUNCTION external_signal_exposure_claim_c2_guard() RESET search_path`], [`ALTER FUNCTION external_signal_exposure_claim_c2_guard() SET search_path = pg_catalog, public, pg_temp`], 'FUNCTION_SEARCH_PATH_UNPINNED'],
      ['a function replaced by a migration without restating its pin', [`CREATE OR REPLACE FUNCTION external_signal_stale_admission_elapsed(observed_utc timestamp, at_instant timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT (observed_utc AT TIME ZONE 'UTC') <= at_instant - interval '15 minutes' $$`], [`ALTER FUNCTION external_signal_stale_admission_elapsed(timestamp, timestamptz) SET search_path = pg_catalog, public, pg_temp`], 'FUNCTION_SEARCH_PATH_UNPINNED'],
      ['a function with a different pinned path', [`ALTER FUNCTION external_signal_exposure_claim_c2_guard() SET search_path = public, pg_catalog`], [`ALTER FUNCTION external_signal_exposure_claim_c2_guard() SET search_path = pg_catalog, public, pg_temp`], 'FUNCTION_SEARCH_PATH_UNPINNED'],
      ['a protected function that became SECURITY DEFINER', [`ALTER FUNCTION external_signal_exposure_claim_c2_guard() SECURITY DEFINER`], [`ALTER FUNCTION external_signal_exposure_claim_c2_guard() SECURITY INVOKER`], 'FUNCTION_SECURITY_DEFINER'],
    ] as const)('detects %s', async (_label, setup, restore, expected) => {
      if (expected === 'RUNTIME_ROLE_CAN_BYPASS_TRIGGERS' && versionNum < 150000) return;
      const fill = (sql: string) => sql.replaceAll('current_database_placeholder', `"${secDatabase}"`);
      await scenario(setup.map(fill), restore.map(fill), expected);
      expect((await preflight('BROKER_ENABLED')).findings, 'the scenario was fully restored').toEqual([]);
    });

    it('treats an unevaluable check as a finding, so broker-enabled readiness fails closed and development still starts', async () => {
      const broken = await assessDatabaseSecurity(async () => { throw new Error('catalog unavailable'); }, { mode: 'BROKER_ENABLED', runtimeRole: 'ai_trader_app' });
      expect(broken.ready).toBe(false); expect(broken.startupAllowed).toBe(false);
      expect(broken.findings.map(finding => finding.code)).toContain('CHECK_UNAVAILABLE');
      expect((await assessDatabaseSecurity(async () => { throw new Error('catalog unavailable'); }, { mode: 'DEVELOPMENT_OBSERVATION' })).startupAllowed).toBe(true);
    });

    it('lists exactly the critical triggers a fresh migration installs', async () => {
      const installed = (await sec.query(`SELECT c.relname AS t, t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname LIKE 'external_signal%'`)).rows.map(row => `${row.t}/${row.n}`).sort();
      expect(CRITICAL_TRIGGERS.map(([table, trigger]) => `${table}/${trigger}`).sort()).toEqual(installed);
    });

    it('performs no write: nothing in the assessment changes the catalog state it reads', async () => {
      const snapshot = async () => (await sec.query(`SELECT (SELECT count(*) FROM pg_auth_members) AS members, (SELECT count(*) FROM pg_trigger) AS triggers, (SELECT md5(string_agg(proconfig::text || prosecdef::text, ',' ORDER BY oid)) FROM pg_proc WHERE pronamespace='public'::regnamespace) AS functions, (SELECT datacl::text FROM pg_database WHERE datname=current_database()) AS acl`)).rows[0];
      const before = await snapshot(); await preflight('BROKER_ENABLED'); await preflight('DEVELOPMENT_OBSERVATION');
      expect(await snapshot()).toEqual(before);
    });
  });
});
