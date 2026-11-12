import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgresDatabase, type DisposablePostgresDatabase } from './disposable-postgres.js';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';

// Phase 4A.2C3B.2-1: a GENUINE upgrade. A disposable database is migrated to the 108 accepted migrations with `prisma migrate deploy`, populated
// with historical marked TradingView state through the accepted C1/C2 triggers, and then upgraded with the real Prisma runner applying the
// 109th migration. The same file proves the lock order, the all-or-nothing behavior and the operator's failed-migration recovery procedure.

const NEW_MIGRATION = '20261103120000_tradingview_receipt_clock_dispatch_fence_foundation';
const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const REPLACED = ['external_signal_broker_consumption_guard', 'external_signal_broker_evidence_quarantine', 'external_signal_entry_obligation_guard', 'external_signal_broker_worker_claim_guard'];

(enabled ? describe : describe.skip)('TradingView C3B.2-1 upgrade from 108 migrations (PostgreSQL, real Prisma runner)', () => {
  const fetchSpy = vi.fn(async () => { throw new Error('C3B.2-1 upgrade tests forbid broker network access'); });
  const baseUrl = process.env.DATABASE_URL!;
  let scratch: string;
  let configPath: string;
  let baselineConfig: string;
  const disposables: DisposablePostgresDatabase[] = [];
  const open: Client[] = [];
  const connect = async (url: string) => { const client = new Client({ connectionString: url }); await client.connect(); open.push(client); return client; };

  const prisma = (config: string | null, url: string, ...args: string[]) => spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args, ...(config ? ['--config', config] : [])],
    { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 180_000 });

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    scratch = await mkdtemp(path.join(tmpdir(), 'c3b21-upgrade-'));
    const allMigrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
    const migrations = allMigrations.filter(name => name <= NEW_MIGRATION);
    expect(migrations.at(-1)).toBe(NEW_MIGRATION);
    expect(migrations).toHaveLength(109); // This pinned historical upgrade remains 108 -> 109 after later migrations are added.
    await cp('prisma/migrations', path.join(scratch, 'migrations'), { recursive: true, filter: source => {
      const normalized = source.replaceAll('\\', '/');
      const migration = normalized.match(/prisma\/migrations\/(\d+_[^/]+)/)?.[1];
      return migration === undefined || migration < NEW_MIGRATION;
    } });
    await cp('prisma/migrations', path.join(scratch, 'upgrade-migrations'), { recursive: true, filter: source => {
      const normalized = source.replaceAll('\\', '/');
      const migration = normalized.match(/prisma\/migrations\/(\d+_[^/]+)/)?.[1];
      return migration === undefined || migration <= NEW_MIGRATION;
    } });
    baselineConfig = path.join(scratch, 'prisma.config.mjs');
    await writeFile(baselineConfig, `export default { schema: ${JSON.stringify(path.resolve('prisma/schema.prisma').replaceAll('\\', '/'))}, migrations: { path: ${JSON.stringify(path.join(scratch, 'migrations').replaceAll('\\', '/'))} }, datasource: { url: process.env.DATABASE_URL } };\n`);
    configPath = path.join(scratch, 'upgrade-prisma.config.mjs');
    await writeFile(configPath, `export default { schema: ${JSON.stringify(path.resolve('prisma/schema.prisma').replaceAll('\\', '/'))}, migrations: { path: ${JSON.stringify(path.join(scratch, 'upgrade-migrations').replaceAll('\\', '/'))} }, datasource: { url: process.env.DATABASE_URL } };\n`);
  }, 120_000);

  afterAll(async () => {
    for (const client of open) await client.query('ROLLBACK').catch(() => undefined);
    await (await import('../../services/trading-account-workflow-lock.service.js')).closeTradingAccountWorkflowLockPool().catch(() => undefined);
    await (await import('../prisma.js')).prisma.$disconnect().catch(() => undefined);
    for (const client of open) await client.end().catch(() => undefined);
    for (const database of disposables) await database.drop().catch(() => undefined);
    if (scratch) await rm(scratch, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  /** A disposable database at exactly the 108 accepted migrations, applied by the real Prisma runner. */
  async function baseline(label: string) {
    const database = await createDisposablePostgresDatabase(baseUrl, label);
    disposables.push(database);
    const result = prisma(baselineConfig, database.url, 'migrate', 'deploy');
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const client = await connect(database.url);
    expect((await client.query(`SELECT count(*)::int n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).rows[0].n).toBe(108);
    expect((await client.query(`SELECT to_regclass('public."ExternalSignalDispatchFence"') IS NULL AS absent`)).rows[0].absent).toBe(true);
    return { database, client };
  }
  const definitions = async (client: Client) => (await client.query(`SELECT p.proname, encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS sha FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname = ANY($1::text[]) ORDER BY 1`, [REPLACED])).rows;
  const objectCounts = async (client: Client) => (await client.query(`SELECT (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal) triggers, (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace) functions,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','i')) relations,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='Signal') signal_columns,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='ExternalSignalBrokerDispatchConsumption') consumption_columns,
      to_regclass('public."ExternalSignalDispatchFence"') IS NOT NULL AS fence_table`)).rows[0];
  const SNAPSHOT_TABLES = ['ExternalSignalBrokerWorkerClaim', 'EntryExposureClaim', 'EntryExposureClaimEvent', 'OrderIntent', 'Signal', 'ExternalSignalEntryExecutionObligation', 'ExternalSignalTradeCycleAccount', 'ExternalSignalTradeCycle', 'ExternalSignalEntryExecutionAuthorization', 'TrackedPosition', 'SignalRoute', 'SignalRoutingRun'];
  const snapshot = async (client: Client) => {
    const out: Record<string, string> = {};
    // Every historical row, whole, in key order. Signal is compared without the new column: that column is the migration's own addition.
    for (const table of SNAPSHOT_TABLES) out[table] = (await client.query(`SELECT coalesce(md5(string_agg((to_jsonb(t) - 'receivedAt')::text, '|' ORDER BY id)), '') AS h FROM "${table}" t`)).rows[0].h;
    return out;
  };

  // =============================================================================================================
  describe('historical marked state survives the upgrade and stays recoverable', () => {
    let client: Client; let url: string;
    let fx: Awaited<ReturnType<typeof createTradingViewGraphFixture>>;
    const historical: Record<'received' | 'pending' | 'submitting' | 'blocked' | 'released' | 'releasedByService', { intentId: number; claimId: number; signalId: number; clientOrderId: string; obligationId: number; accountCycleId: number; target: unknown }> = {} as never;
    let unmarkedPaper: number, unmarkedLive: number;
    let before: Record<string, string>; let hashesBefore: unknown;
    let svc: { worker: typeof import('../../services/external-signal-broker-worker.service.js'); recovery: typeof import('../../services/entry-dispatch-recovery.service.js'); prisma: (typeof import('../prisma.js'))['prisma'] };

    beforeAll(async () => {
      const base = await baseline('c3b21up');
      client = base.client; url = base.database.url;
      process.env.DATABASE_URL = url;
      fx = await createTradingViewGraphFixture(client);
      const notSent = (graph: { claimId: number }, workerClaimId: number) => client.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'NOT_SENT_EVIDENCE_RECORDED',$2)`, [graph.claimId, JSON.stringify({ classification: 'NOT_SENT_PRE_DISPATCH', producer: 'TRADINGVIEW_C2_PRE_DISPATCH_RECOVERY', workerClaimId })]);
      const pick = async (label: keyof typeof historical, build: () => Promise<Awaited<ReturnType<typeof fx.admit>>>) => {
        const graph = await build();
        historical[label] = { intentId: graph.intentId, claimId: graph.claimId, signalId: graph.signalId, clientOrderId: graph.clientOrderId, obligationId: graph.obligationId, accountCycleId: graph.accountCycleId, target: graph.target };
        return graph;
      };
      await pick('received', () => fx.admit('hist-received'));
      const pending = await pick('pending', () => fx.admit('hist-pending')); await client.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [pending.intentId]);
      const submitting = await pick('submitting', () => fx.admit('hist-submitting')); await fx.workerClaim(submitting);
      const blocked = await pick('blocked', () => fx.admit('hist-blocked')); const blockedWorker = await fx.workerClaim(blocked);
      await notSent(blocked, blockedWorker); await client.query(`UPDATE "OrderIntent" SET status='blocked',"blockReason"='hist-blocked' WHERE id=$1`, [blocked.intentId]);
      const released = await pick('released', () => fx.admit('hist-released')); const releasedWorker = await fx.workerClaim(released);
      await notSent(released, releasedWorker); await client.query(`UPDATE "OrderIntent" SET status='blocked',"blockReason"='hist-released' WHERE id=$1`, [released.intentId]);
      await client.query(`UPDATE "EntryExposureClaim" SET status='RELEASED',"releasedAt"=(now() AT TIME ZONE 'UTC'),"releaseReason"='hist-released' WHERE id=$1`, [released.claimId]);
      const releasedByService = await pick('releasedByService', () => fx.admit('hist-svc')); const svcWorker = await fx.workerClaim(releasedByService);
      await notSent(releasedByService, svcWorker); await client.query(`UPDATE "OrderIntent" SET status='blocked',"blockReason"='hist-svc' WHERE id=$1`, [releasedByService.intentId]);
      const insertUnmarked = async (accountId: number, side: string) => (await client.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('manual','UMH',$3,'market','day','received',$2,'{}',$1,now(),now()) RETURNING id`, [accountId, `um-${randomUUID()}`, side])).rows[0].id as number;
      const liveId = (await client.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","tradingBlocked","createdAt","updatedAt") VALUES ($1,'upgrade live','LIVE','PAUSED',false,true,false,now(),now()) RETURNING id`, [fx.ownerId])).rows[0].id as number;
      unmarkedPaper = await insertUnmarked(fx.paperId, 'sell'); unmarkedLive = await insertUnmarked(liveId, 'sell');
      before = await snapshot(client); hashesBefore = await definitions(client);
      svc = {
        worker: await import('../../services/external-signal-broker-worker.service.js'),
        recovery: await import('../../services/entry-dispatch-recovery.service.js'),
        prisma: (await import('../prisma.js')).prisma,
      };
    }, 240_000);

    it('had no receipt column, no fence table and no consumption columns before the upgrade (a true 108-migration state)', async () => {
      expect((await client.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='Signal' AND column_name='receivedAt'`)).rows[0].n).toBe(0);
      expect(await objectCounts(client)).toMatchObject({ fence_table: false, consumption_columns: 12 });
      for (const key of Object.keys(historical)) expect((await client.query(`SELECT count(*)::int n FROM "OrderIntent" WHERE id=$1 AND "externalSignalAccountCycleId" IS NOT NULL`, [historical[key as keyof typeof historical].intentId])).rows[0].n).toBe(1);
    });

    it('applies with the real Prisma runner (`migrate deploy` against the full migration directory) and records exactly one new migration', () => {
      const result = prisma(configPath, url, 'migrate', 'deploy');
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain(NEW_MIGRATION);
      expect(result.stdout).not.toMatch(/\d{14}_(?!tradingview_receipt_clock)/);
    }, 180_000);

    it('gave every historical marked intent a version-1 fence, no unmarked intent a fence, and produced no missing or unexpected fence', async () => {
      const marked = Object.values(historical).map(row => row.intentId);
      expect((await client.query(`SELECT "orderIntentId", version::int FROM "ExternalSignalDispatchFence" ORDER BY "orderIntentId"`)).rows).toEqual(marked.sort((a, b) => a - b).map(id => ({ orderIntentId: id, version: 1 })));
      expect((await client.query(`SELECT count(*)::int n FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = ANY($1::int[])`, [[unmarkedPaper, unmarkedLive]])).rows[0].n).toBe(0);
      expect((await client.query(`SELECT count(*)::int n FROM "OrderIntent" i WHERE i."externalSignalAccountCycleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ExternalSignalDispatchFence" f WHERE f."orderIntentId"=i.id)`)).rows[0].n).toBe(0);
    });

    it('left every historical row byte-identical (worker claims, exposure claims, events, intents, signals, obligations, cycles, authorizations, positions, routes)', async () => {
      expect(await snapshot(client)).toEqual(before);
    });

    it('manufactured no receipt: every historical signal still has receivedAt NULL and is not open under any TimeZone', async () => {
      for (const zone of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
        await client.query(`SET TIME ZONE '${zone}'`);
        const rows = (await client.query(`SELECT s.id, s."receivedAt" IS NULL AS no_receipt, external_signal_signal_receipt_open(s.id) AS open, external_signal_signal_received_since(s.id, '1970-01-01') AS since FROM "Signal" s ORDER BY s.id`)).rows;
        expect(rows.length).toBeGreaterThanOrEqual(6);
        expect(rows.every(row => row.no_receipt && !row.open && !row.since), zone).toBe(true);
      }
      await client.query(`SET TIME ZONE 'UTC'`);
    });

    it('does not make a historical signal newly eligible: the C2 worker refuses a historical pending intent and creates no worker claim', async () => {
      await client.query(`UPDATE "TradingAccount" SET status='ACTIVE',"tradingEnabled"=true,"killSwitchEnabled"=false WHERE id=$1`, [fx.paperId]);
      const refused = await svc.worker.processTradingViewOrderIntentForC2(historical.pending.intentId, { db: svc.prisma });
      expect(refused.outcome).toBe('C2_DISPATCH_REFUSED');
      expect((await client.query(`SELECT count(*)::int n FROM "ExternalSignalBrokerWorkerClaim" WHERE "orderIntentId"=$1`, [historical.pending.intentId])).rows[0].n).toBe(0);
      expect((await client.query(`SELECT status::text FROM "OrderIntent" WHERE id=$1`, [historical.pending.intentId])).rows[0].status).toBe('blocked');
    }, 120_000);

    it('lets C2 recovery work on the historical states after the upgrade, and the fence only ever increases', async () => {
      const fence = async (id: number) => Number((await client.query(`SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [id])).rows[0].version);
      // A stranded, historical ENTRY_SUBMITTING claim: not-sent evidence, block and release through the production service.
      const before1 = await fence(historical.submitting.intentId);
      expect(await svc.worker.recoverTradingViewC2Claim(historical.submitting.intentId, { db: svc.prisma })).toBeDefined();
      expect((await client.query(`SELECT i.status::text, ec.status::text AS claim, ec."releasedAt" IS NOT NULL AS released FROM "OrderIntent" i JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=i.id WHERE i.id=$1`, [historical.submitting.intentId])).rows[0]).toEqual({ status: 'blocked', claim: 'RELEASED', released: true });
      expect(await fence(historical.submitting.intentId)).toBeGreaterThan(before1);
      // A historical BLOCKED intent whose claim is still held and whose not-sent evidence is recorded releases through the shared release path.
      const before2 = await fence(historical.blocked.intentId);
      await svc.recovery.releaseUnsubmittedOrRouteToRecovery({ orderIntentId: historical.blocked.intentId, reason: 'TRADINGVIEW_C2_STALE_PRE_DISPATCH_CLAIM', source: 'WORKER', dispatchAttempted: false });
      expect((await client.query(`SELECT ec.status::text AS claim FROM "EntryExposureClaim" ec WHERE ec."orderIntentId"=$1`, [historical.blocked.intentId])).rows[0].claim).toBe('RELEASED');
      expect(await fence(historical.blocked.intentId)).toBeGreaterThan(before2);
      // The historical released claim stays released and its fence is still 1: nothing touched it.
      expect(await fence(historical.released.intentId)).toBe(1);
      expect((await client.query(`SELECT status::text FROM "EntryExposureClaim" WHERE id=$1`, [historical.released.claimId])).rows[0].status).toBe('RELEASED');
    }, 180_000);

    it('replaced the four guard functions and nothing else about the reviewed security surface drifted', async () => {
      const after = await definitions(client);
      expect(after).toHaveLength(REPLACED.length);
      expect(after).not.toEqual(hashesBefore);
      expect((await client.query(`SELECT count(*)::int n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).rows[0].n).toBe(109);
      expect((await objectCounts(client)).fence_table).toBe(true);
    }, 120_000);

    it('fails on its own precondition when applied a second time and changes nothing', async () => {
      const sql = await readFile(`prisma/migrations/${NEW_MIGRATION}/migration.sql`, 'utf8');
      const stateBefore = { counts: await objectCounts(client), definitions: await definitions(client), snapshot: await snapshot(client) };
      await expect(client.query(sql)).rejects.toThrow(/precondition: the dispatch fence table already exists/);
      expect({ counts: await objectCounts(client), definitions: await definitions(client), snapshot: await snapshot(client) }).toEqual(stateBefore);
    });
  });

  // =============================================================================================================
  describe('lock order, atomicity and the operator recovery procedure', () => {
    const sqlText = () => readFile(`prisma/migrations/${NEW_MIGRATION}/migration.sql`, 'utf8');

    it('acquires ACCESS EXCLUSIVE on Signal and the consumption table first and then the others in the documented order, upgrading nothing', async () => {
      const text = await sqlText();
      const locks = [...text.matchAll(/^LOCK TABLE [\s\S]*?;/gm)].map(match => match[0]);
      expect(locks[0]).toBe('LOCK TABLE "Signal" IN ACCESS EXCLUSIVE MODE;');
      expect(locks[1]).toBe('LOCK TABLE "ExternalSignalBrokerDispatchConsumption" IN ACCESS EXCLUSIVE MODE;');
      expect(locks).toHaveLength(3);
      expect(locks[2]).toMatch(/IN SHARE ROW EXCLUSIVE MODE;$/);
      expect(text.indexOf('SET LOCAL lock_timeout')).toBeLessThan(text.indexOf('LOCK TABLE'));
      expect(text).toMatch(/SET LOCAL lock_timeout = '15s';/);
      // A statement-level transaction wrapper (not the BEGIN keyword that opens a PL/pgSQL body) would end Prisma's implicit transaction early.
      expect(text).not.toMatch(/^\s*(BEGIN|COMMIT|START TRANSACTION|ROLLBACK)\s*;/im);
      expect(text).not.toMatch(/LOCK TABLE[^;]*\bIN (SHARE|ROW EXCLUSIVE|EXCLUSIVE|ACCESS SHARE|ROW SHARE) MODE/);
      const { database, client } = await baseline('c3b21lk');
      const untouched = await objectCounts(client);
      const holder = await connect(database.url);
      const migrator = await connect(database.url);
      // Hold a conflicting lock on the ninth table of the list, so the migration blocks part-way through the ordered acquisition.
      await holder.query('BEGIN'); await holder.query(`LOCK TABLE "BrokerActivity" IN ROW EXCLUSIVE MODE`);
      const pid = (await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const shortened = text.replace(`SET LOCAL lock_timeout = '15s';`, `SET LOCAL lock_timeout = '4s';`);
      expect(shortened).not.toBe(text);
      const running = migrator.query(shortened).then(() => null, (error: unknown) => error);
      let waiting = 0;
      for (let i = 0; i < 300 && waiting === 0; i += 1) { await sleep(20); waiting = (await client.query(`SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND NOT granted`, [pid])).rows[0].n; }
      expect(waiting).toBe(1);
      const held = (await client.query(`SELECT c.relname, l.mode, l.granted FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid=$1 AND c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.relname`, [pid])).rows;
      const mode = (table: string) => held.filter(row => row.relname === table).map(row => `${row.mode}${row.granted ? '' : ' (waiting)'}`);
      expect(mode('Signal')).toEqual(['AccessExclusiveLock']);
      expect(mode('ExternalSignalBrokerDispatchConsumption')).toEqual(['AccessExclusiveLock']);
      for (const table of ['OrderIntent', 'EntryExposureClaim', 'EntryExposureClaimEvent', 'ExternalSignalBrokerWorkerClaim', 'MarketPolicyBrokerDispatchDecision', 'MarketPolicyBrokerUnenforcedDispatch', 'OrderIntentBrokerOpportunityEvent', 'BrokerOrder']) expect(mode(table), table).toEqual(['ShareRowExclusiveLock']);
      expect(mode('BrokerActivity')).toEqual(['ShareRowExclusiveLock (waiting)']);
      for (const table of ['MarketPolicyBrokerDispatchConsumption', 'ExternalSignalTradeCycleAccount', 'ExternalSignalEntryExecutionObligation']) expect(mode(table), table).toEqual([]);
      const failure = await running;
      expect(message(failure)).toMatch(/lock timeout|canceling statement due to lock timeout/);
      await holder.query('ROLLBACK');
      // A clean failure: nothing persisted and every lock was released.
      expect(await objectCounts(client)).toEqual(untouched);
      expect((await client.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='Signal' AND column_name='receivedAt'`)).rows[0].n).toBe(0);
      expect((await client.query(`SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND locktype='relation' AND granted`, [pid])).rows[0].n).toBe(0);
      expect((await migrator.query(`SELECT count(*)::int n FROM "Signal"`)).rows[0].n).toBe(0);
    }, 120_000);

    it('holds the strongest mode on every locked table at the end of a successful run and no lock waits (applied in one explicit transaction, then rolled back)', async () => {
      const { database, client } = await baseline('c3b21lm');
      const session = await connect(database.url);
      const pid = (await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await session.query('BEGIN');
      try {
        await session.query(await sqlText());
        const rows = (await client.query(`SELECT c.relname, l.mode, l.granted FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid=$1 AND c.relnamespace='public'::regnamespace AND c.relkind='r'`, [pid])).rows;
        expect(rows.every(row => row.granted)).toBe(true);
        const rank = ['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'];
        const strongest = (table: string) => rows.filter(row => row.relname === table).map(row => row.mode).sort((a, b) => rank.indexOf(b) - rank.indexOf(a))[0];
        expect(strongest('Signal')).toBe('AccessExclusiveLock');
        expect(strongest('ExternalSignalBrokerDispatchConsumption')).toBe('AccessExclusiveLock');
        for (const table of ['OrderIntent', 'EntryExposureClaim', 'EntryExposureClaimEvent', 'ExternalSignalBrokerWorkerClaim', 'MarketPolicyBrokerDispatchDecision', 'MarketPolicyBrokerUnenforcedDispatch', 'OrderIntentBrokerOpportunityEvent', 'BrokerOrder', 'BrokerActivity', 'MarketPolicyBrokerDispatchConsumption', 'ExternalSignalTradeCycleAccount', 'ExternalSignalEntryExecutionObligation']) expect(strongest(table), table).toBe('ShareRowExclusiveLock');
      } finally { await session.query('ROLLBACK'); }
      expect((await objectCounts(client)).fence_table).toBe(false);
    }, 120_000);

    it('is all-or-nothing: a failing precondition leaves no table, column, trigger, function replacement or row behind (simple-query script, as Prisma sends it)', async () => {
      const { database, client } = await baseline('c3b21at');
      const fx = await createTradingViewGraphFixture(client).catch(() => null);
      const before = { counts: await objectCounts(client), definitions: await definitions(client) };
      // Plant a TradingView consumption row (a pair must not pre-exist) with the foreign keys switched off for this one statement only.
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role='replica'`);
      await client.query(`INSERT INTO "ExternalSignalBrokerDispatchConsumption" ("orderIntentId","executionObligationId","workerClaimId","marketPolicyDispatchConsumptionId","rolloutGenerationId","executionAuthorizationId","dispatchStateVersion","clientOrderId","evidenceJson") VALUES (900001,900001,900001,900001,1,1,1,'planted','{}')`);
      await client.query('COMMIT');
      const runner = await connect(database.url);
      await expect(runner.query(await sqlText())).rejects.toThrow(/precondition: no TradingView consumption pair may exist/);
      expect({ counts: await objectCounts(client), definitions: await definitions(client) }).toEqual(before);
      expect((await runner.query(`SELECT 1 AS ok`)).rows[0].ok).toBe(1); // the connection is usable again: the failed script's transaction ended
      expect(fx === null || fx.paperId > 0).toBe(true);
    }, 120_000);

    it('follows the runbook end to end: a failed `prisma migrate deploy` leaves a failed history row and no change, which the documented checks prove before `migrate resolve --rolled-back` and a successful retry', async () => {
      const { database, client } = await baseline('c3b21rb');
      const holder = await connect(database.url);
      await holder.query('BEGIN'); await holder.query(`LOCK TABLE "BrokerOrder" IN ROW EXCLUSIVE MODE`);
      const before = { counts: await objectCounts(client), definitions: await definitions(client) };
      const failed = prisma(configPath, database.url, 'migrate', 'deploy'); // blocks on the held lock for 15 s, then fails on lock_timeout
      expect(failed.status).not.toBe(0);
      expect(`${failed.stderr}${failed.stdout}`).toMatch(/lock timeout|55P03|failed to apply/i);
      await holder.query('ROLLBACK');
      // The runbook's read-only inspection and the proof of no persistent change.
      const history = (await client.query(`SELECT finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name=$1`, [NEW_MIGRATION])).rows[0];
      expect(history.finished_at).toBeNull();
      expect({ counts: await objectCounts(client), definitions: await definitions(client) }).toEqual(before);
      expect((await client.query(`SELECT to_regclass('public."ExternalSignalDispatchFence"') IS NULL AS a`)).rows[0].a).toBe(true);
      expect((await client.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE '%dispatch_fence%' OR tgname LIKE '%\\_a\\_epoch\\_stamp' OR tgname = 'Signal_received_at_guard' OR tgname = 'BrokerDispatchConsumption_a_lock_prelude'`)).rows[0].n).toBe(0);
      expect((await client.query(`SELECT count(*)::int n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).rows[0].n).toBe(108);
      // Only after that proof: mark rolled back and retry.
      const blocked = prisma(configPath, database.url, 'migrate', 'deploy');
      expect(blocked.status, 'a failed migration blocks further deploys until it is resolved').not.toBe(0);
      const resolved = prisma(configPath, database.url, 'migrate', 'resolve', '--rolled-back', NEW_MIGRATION);
      expect(resolved.status, `${resolved.stderr}\n${resolved.stdout}`).toBe(0);
      const retried = prisma(configPath, database.url, 'migrate', 'deploy');
      expect(retried.status, `${retried.stderr}\n${retried.stdout}`).toBe(0);
      expect((await client.query(`SELECT count(*)::int n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`)).rows[0].n).toBe(109);
      expect((await objectCounts(client)).fence_table).toBe(true);
    }, 240_000);
  });
});
