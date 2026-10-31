import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';

vi.mock('../../services/risk-gate.service.js', () => ({
  evaluateOrderRisk: vi.fn(async () => ({ allowed: true, statusCode: 200, reason: 'allowed', details: { rule: 'c3a-integration' } })),
  logRiskGateBlockedOrder: vi.fn(async () => undefined),
}));

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
const C2_MIGRATION = '20261030180000_tradingview_controlled_worker_claim';
const C2_MIGRATION_SHA256 = '0553f72918251f8221bd62a0590377bb022ff4c52f9328f11615f9def14e1e77';
const C3A_MIGRATION = '20261031120000_tradingview_dispatch_safety_hardening';

type Isolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
const [RC, RR, SER]: Isolation[] = ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];
const EVENT_TYPES = ['ADAPTER_INVOCATION_STARTED', 'DISPATCH_OUTCOME_RECORDED', 'BROKER_DELIVERY_UNCERTAIN'] as const;
const INTERLEAVINGS = ['EVENT_COMMITS_BEFORE_STALE_RELEASE', 'RELEASE_COMMITS_BEFORE_STALE_EVENT', 'EVENT_HOLDS_ROW_RELEASE_WAITS', 'RELEASE_HOLDS_ROW_EVENT_WAITS'] as const;
type Interleaving = typeof INTERLEAVINGS[number];
const REQUIRED_PAIRS: Array<[Isolation, Isolation]> = [[RC!, RC!], [RC!, RR!], [RC!, SER!], [SER!, RC!], [SER!, SER!]];
const EXTENDED_PAIRS: Array<[Isolation, Isolation]> = [[RR!, RC!], [RR!, RR!], [RR!, SER!], [SER!, RR!]];
const matrix = (pairs: Array<[Isolation, Isolation]>) => pairs.flatMap(([eventIsolation, releaseIsolation]) => INTERLEAVINGS.flatMap(interleaving =>
  EVENT_TYPES.map(eventType => ({ eventIsolation, releaseIsolation, interleaving, eventType }))));

(enabled ? describe : describe.skip)('TradingView Phase 4A.2C3A dispatch safety', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const currentDatabase = `tv_c3a_${suffix}`;
  const c2Database = `tv_c2_${suffix}`;
  const fetchSpy = vi.fn(async () => { throw new Error('C3A tests forbid broker network access'); });
  let admin: Client, db: Client, c2: Client;
  let currentUrl: string, c2Url: string;
  let fixture: Awaited<ReturnType<typeof createTradingViewGraphFixture>>;
  let ownerId: number, paperId: number;
  let sequence = 0;
  const next = () => { sequence += 1; return sequence; };

  const urlFor = (database: string) => { const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); return url.toString(); };
  const applyMigrations = async (client: Client, names: string[]) => { for (const name of names) await client.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8')); };

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${currentDatabase}"`); await admin.query(`CREATE DATABASE "${c2Database}"`);
    currentUrl = urlFor(currentDatabase); c2Url = urlFor(c2Database);
    db = new Client({ connectionString: currentUrl }); await db.connect();
    c2 = new Client({ connectionString: c2Url }); await c2.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    await applyMigrations(db, migrations);
    await applyMigrations(c2, migrations.filter(name => name <= C2_MIGRATION));
    process.env.DATABASE_URL = currentUrl;

    fixture = await createTradingViewGraphFixture(db);
    ({ ownerId, paperId } = fixture);
  }, 180_000);

  afterAll(async () => {
    await (await import('../../services/trading-account-workflow-lock.service.js')).closeTradingAccountWorkflowLockPool().catch(() => undefined);
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    await db?.end(); await c2?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${currentDatabase}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS "${c2Database}" WITH (FORCE)`);
      await admin.end();
    }
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------------------------
  // Seeded claims. Triggers and foreign keys are off only while the disposable row is created; every
  // race below runs with all production triggers enabled. Their account has no credential, so the
  // scheduler never processes them.
  // ---------------------------------------------------------------------------------------------
  const SEED_ACCOUNT_ID = 999_999;
  type Seed = { claimId: number; intentId: number; workerClaimId: number | null };
  async function seed(client: Client, options: { marked?: boolean; worker?: boolean; intentStatus?: string; claimStatus?: string; notSent?: boolean; acquiredAtUtc?: string } = {}): Promise<Seed> {
    const { marked = true, worker = true, intentStatus = 'blocked', claimStatus = 'ENTRY_SUBMITTING', notSent = true, acquiredAtUtc } = options;
    const n = next();
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL session_replication_role='replica'`);
      await client.query(`INSERT INTO "TradingAccount" (id,"accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,$1,'C3A seed','PAPER','PAUSED',false,true,now(),now()) ON CONFLICT (id) DO NOTHING`, [SEED_ACCOUNT_ID]);
      const securityId = (await client.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ($1,$1,true,'STOCK',now(),now()) RETURNING id`, [`SEED${randomUUID().slice(0, 8)}`])).rows[0].id as number;
      const intentId = (await client.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('seed','SEED','buy','market','day',$1,$2,'{}',$3,$4,now(),now()) RETURNING id`, [intentStatus, `seed-${randomUUID()}`, SEED_ACCOUNT_ID, marked ? 900_000 + n : null])).rows[0].id as number;
      const claimId = (await client.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"acquiredAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,coalesce($6::timestamp,(now() AT TIME ZONE 'UTC')),now(),now()) RETURNING id`, [SEED_ACCOUNT_ID, securityId, intentId, `seed:${randomUUID()}`, claimStatus, acquiredAtUtc ?? null])).rows[0].id as number;
      let workerClaimId: number | null = null;
      if (worker) {
        workerClaimId = (await client.query(`INSERT INTO "ExternalSignalBrokerWorkerClaim" ("orderIntentId","executionObligationId","accountCycleId","rolloutGenerationId","dispatchStateVersion","clientOrderId","claimFingerprint") VALUES ($1,$2,$2,1,1,$3,$4) RETURNING id`, [intentId, 900_000 + n, `seed-${n}`, createHash('sha256').update(randomUUID()).digest('hex')])).rows[0].id as number;
        await client.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'WORKER_CLAIMED_FOR_SUBMISSION',$2)`, [claimId, JSON.stringify({ markerProtocol: 'ADAPTER_MARKER_V1', workerClaimId })]);
      }
      if (notSent) await client.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'NOT_SENT_EVIDENCE_RECORDED',$2)`, [claimId, JSON.stringify({ classification: 'NOT_SENT_PRE_DISPATCH', producer: 'TRADINGVIEW_C2_DISPATCH_UNAVAILABLE', workerClaimId })]);
      await client.query('COMMIT');
      return { claimId, intentId, workerClaimId };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  const insertEventSql = `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,$2,'{}')`;
  const releaseSql = `UPDATE "EntryExposureClaim" SET status='RELEASED',"releasedAt"=(now() AT TIME ZONE 'UTC'),"releaseReason"='C3A race' WHERE id=$1`;
  const codeOf = (error: unknown) => (error as { code?: string } | null)?.code ?? null;
  const attempt = (client: Client, sql: string, params: unknown[] = []) => client.query(sql, params).then(() => null, (error: unknown) => error);

  async function untilBlocked(pid: number, settled: () => boolean) {
    for (let index = 0; index < 500 && !settled(); index += 1) {
      if ((await admin.query(`SELECT cardinality(pg_blocking_pids($1))>0 AS blocked`, [pid])).rows[0].blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  async function runRace(url: string, control: Client, testCase: { eventIsolation: Isolation; releaseIsolation: Isolation; interleaving: Interleaving; eventType: string }) {
    const { claimId } = await seed(control);
    const eventClient = new Client({ connectionString: url }); const releaseClient = new Client({ connectionString: url });
    await eventClient.connect(); await releaseClient.connect();
    const failures: { event: unknown; release: unknown } = { event: null, release: null };
    const snapshot = `SELECT count(*) FROM "EntryExposureClaimEvent" WHERE "claimId"=$1`;
    try {
      await eventClient.query(`BEGIN ISOLATION LEVEL ${testCase.eventIsolation}`);
      await releaseClient.query(`BEGIN ISOLATION LEVEL ${testCase.releaseIsolation}`);
      await eventClient.query(snapshot, [claimId]); await releaseClient.query(snapshot, [claimId]);
      const commitEvent = async () => { failures.event = failures.event ?? await attempt(eventClient, 'COMMIT'); };
      const commitRelease = async () => { failures.release = failures.release ?? await attempt(releaseClient, 'COMMIT'); };
      const event = () => attempt(eventClient, insertEventSql, [claimId, testCase.eventType]);
      const release = () => attempt(releaseClient, releaseSql, [claimId]);
      if (testCase.interleaving === 'EVENT_COMMITS_BEFORE_STALE_RELEASE') {
        failures.event = await event(); await commitEvent(); failures.release = await release(); await commitRelease();
      } else if (testCase.interleaving === 'RELEASE_COMMITS_BEFORE_STALE_EVENT') {
        failures.release = await release(); await commitRelease(); failures.event = await event(); await commitEvent();
      } else if (testCase.interleaving === 'EVENT_HOLDS_ROW_RELEASE_WAITS') {
        failures.event = await event();
        let done = false;
        const pending = release().then(result => { done = true; return result; });
        await untilBlocked((releaseClient as unknown as { processID: number }).processID, () => done);
        await commitEvent(); failures.release = await pending; await commitRelease();
      } else {
        failures.release = await release();
        let done = false;
        const pending = event().then(result => { done = true; return result; });
        await untilBlocked((eventClient as unknown as { processID: number }).processID, () => done);
        await commitRelease(); failures.event = await pending; await commitEvent();
      }
    } finally {
      await eventClient.query('ROLLBACK').catch(() => undefined); await releaseClient.query('ROLLBACK').catch(() => undefined);
      await eventClient.end(); await releaseClient.end();
    }
    const state = (await control.query(`SELECT ec."releasedAt" IS NOT NULL AS released,(SELECT count(*)::int FROM "EntryExposureClaimEvent" e WHERE e."claimId"=ec.id AND e."eventType"=$2) AS events FROM "EntryExposureClaim" ec WHERE ec.id=$1`, [claimId, testCase.eventType])).rows[0] as { released: boolean; events: number };
    return { released: state.released, eventCommitted: state.events === 1, contradictory: state.released && state.events === 1, eventCode: codeOf(failures.event), releaseCode: codeOf(failures.release) };
  }

  describe('cross-isolation evidence/release linearization', () => {
    it('reproduces the accepted C2 defect: the same harness finds exactly 12 contradictions in the required matrix', async () => {
      const contradictions: string[] = [];
      for (const testCase of matrix(REQUIRED_PAIRS)) {
        const result = await runRace(c2Url, c2, testCase);
        if (result.contradictory) contradictions.push(`${testCase.eventIsolation}/${testCase.releaseIsolation}/${testCase.interleaving}/${testCase.eventType}`);
      }
      expect(contradictions).toHaveLength(12);
      expect(contradictions.every(label => label.startsWith('READ COMMITTED/') && !label.startsWith('READ COMMITTED/READ COMMITTED'))).toBe(true);
    }, 300_000);

    it.each([...matrix(REQUIRED_PAIRS), ...matrix(EXTENDED_PAIRS)])('$eventType event=$eventIsolation release=$releaseIsolation $interleaving', async testCase => {
      const result = await runRace(currentUrl, db, testCase);
      expect(result.contradictory, JSON.stringify(result)).toBe(false);
      expect(result.released !== result.eventCommitted, JSON.stringify(result)).toBe(true);
      expect(testCase.interleaving.startsWith('EVENT') ? result.eventCommitted : result.released, JSON.stringify(result)).toBe(true);
      const refused = testCase.interleaving.startsWith('EVENT') ? { code: result.releaseCode, isolation: testCase.releaseIsolation } : { code: result.eventCode, isolation: testCase.eventIsolation };
      expect(refused.code, JSON.stringify(result)).toBe(refused.isolation === RC ? 'P0001' : '40001');
    }, 30_000);

    it.each(EVENT_TYPES)('refuses both same-transaction orderings for %s', async eventType => {
      for (const seeded of [await seed(db), await seed(db)]) {
        await db.query('BEGIN');
        try {
          if (seeded.claimId % 2 === 0) {
            await db.query(insertEventSql, [seeded.claimId, eventType]);
            await expect(db.query(releaseSql, [seeded.claimId])).rejects.toThrow(/current uncontradicted|possible-delivery/);
          } else {
            await db.query(releaseSql, [seeded.claimId]);
            await expect(db.query(insertEventSql, [seeded.claimId, eventType])).rejects.toThrow(/after exposure release/);
          }
        } finally { await db.query('ROLLBACK'); }
      }
    });

    it.each(EVENT_TYPES)('refuses release of an unclaimed marked claim with %s, which C2 allowed', async eventType => {
      const seeded = await seed(db, { worker: false, notSent: false, claimStatus: 'ENTRY_PENDING' });
      await db.query(insertEventSql, [seeded.claimId, eventType]);
      await expect(db.query(releaseSql, [seeded.claimId])).rejects.toThrow(/possible-delivery/);
    });

    it('changes the claim row version without touching lifecycle fields, and leaves unmarked claims alone', async () => {
      const read = async (claimId: number) => (await db.query(`SELECT xmin::text,status,"updatedAt","lastDiagnosedAt","releasedAt" FROM "EntryExposureClaim" WHERE id=$1`, [claimId])).rows[0];
      const marked = await seed(db); const before = await read(marked.claimId);
      await db.query(insertEventSql, [marked.claimId, 'BROKER_DELIVERY_UNCERTAIN']);
      const after = await read(marked.claimId);
      expect(after.xmin).not.toBe(before.xmin);
      expect({ ...after, xmin: null }).toEqual({ ...before, xmin: null });
      const legacy = await seed(db, { marked: false, worker: false }); const legacyBefore = await read(legacy.claimId);
      await db.query(insertEventSql, [legacy.claimId, 'BROKER_DELIVERY_UNCERTAIN']);
      expect(await read(legacy.claimId)).toEqual(legacyBefore);
    });

    it('a stale SERIALIZABLE shared release fails retryably, while READ COMMITTED refuses with a domain conflict', async () => {
      const { prisma } = await import('../prisma.js');
      const { releaseUnsubmittedEntryExposureClaim } = await import('../../services/entry-exposure-claim.service.js');
      const { retryableConcurrencyFailure } = await import('../../services/external-signal-broker-worker.service.js');
      for (const eventType of EVENT_TYPES) {
        const stale = await seed(db);
        let caught: unknown = null;
        await prisma.$transaction(async tx => {
          await tx.entryExposureClaimEvent.count({ where: { claimId: stale.claimId } });
          await db.query(insertEventSql, [stale.claimId, eventType]);
          await releaseUnsubmittedEntryExposureClaim({ orderIntentId: stale.intentId, reason: 'C3A_SHARED_RELEASE', db: tx });
        }, { isolationLevel: 'Serializable' }).catch((error: unknown) => { caught = error; });
        expect(retryableConcurrencyFailure(caught), JSON.stringify(caught)).toBe(true);
        expect((await db.query(`SELECT "releasedAt" FROM "EntryExposureClaim" WHERE id=$1`, [stale.claimId])).rows[0].releasedAt).toBeNull();
        const fresh = await seed(db);
        await db.query(insertEventSql, [fresh.claimId, eventType]);
        await expect(releaseUnsubmittedEntryExposureClaim({ orderIntentId: fresh.intentId, reason: 'C3A_SHARED_RELEASE' })).rejects.toMatchObject({ statusCode: 409, details: { code: 'ENTRY_EXPOSURE_UNRESOLVED' } });
      }
    }, 60_000);

    it('the evidence-verified release path keeps uncertain ownership without a broker write', async () => {
      const { releaseVerifiedEntryExposureClaim } = await import('../../services/entry-dispatch-recovery.service.js');
      const seeded = await seed(db);
      await db.query(insertEventSql, [seeded.claimId, 'BROKER_DELIVERY_UNCERTAIN']);
      const result = await releaseVerifiedEntryExposureClaim({ orderIntentId: seeded.intentId, mode: 'SYSTEM' });
      expect(result.released).toBe(false);
      expect((await db.query(`SELECT "releasedAt" FROM "EntryExposureClaim" WHERE id=$1`, [seeded.claimId])).rows[0].releasedAt).toBeNull();
    });
  });

  describe('legacy locking compatibility', () => {
    // Two ordinary legacy writers touch the same intent and claim in opposite orders. Before C2 the
    // event's FOR KEY SHARE could not conflict with anything here; C2's FOR UPDATE closed a cycle.
    async function legacyOppositeOrders(url: string, control: Client, marked: boolean) {
      const seeded = await seed(control, { marked, worker: false, notSent: false, intentStatus: 'pending', claimStatus: 'ENTRY_PENDING' });
      const eventFirst = new Client({ connectionString: url }); const intentFirst = new Client({ connectionString: url });
      await eventFirst.connect(); await intentFirst.connect();
      const updateIntent = `UPDATE "OrderIntent" SET "updatedAt"=now() WHERE id=$1`;
      try {
        await eventFirst.query('BEGIN'); await intentFirst.query('BEGIN');
        await eventFirst.query(insertEventSql, [seeded.claimId, 'DISPATCH_OUTCOME_RECORDED']);
        await intentFirst.query(updateIntent, [seeded.intentId]);
        const intentFirstDone = attempt(intentFirst, insertEventSql, [seeded.claimId, 'DISPATCH_OUTCOME_RECORDED']).then(async result => { await intentFirst.query(result ? 'ROLLBACK' : 'COMMIT'); return result; });
        const results = await Promise.all([intentFirstDone, attempt(eventFirst, updateIntent, [seeded.intentId])]);
        return results.map(codeOf);
      } finally {
        await eventFirst.query('ROLLBACK').catch(() => undefined); await intentFirst.query('ROLLBACK').catch(() => undefined);
        await eventFirst.end(); await intentFirst.end();
      }
    }

    it('reproduces the legacy two-transaction deadlock on C2 and removes it with the correction', async () => {
      await c2.query(`SET deadlock_timeout='100ms'`);
      expect(await legacyOppositeOrders(c2Url, c2, false)).toContain('40P01');
      const results = await Promise.race([
        legacyOppositeOrders(currentUrl, db, false),
        new Promise<string[]>(resolve => setTimeout(() => resolve(['TIMED_OUT']), 15_000)),
      ]);
      // After the correction the event writer needs only FOR KEY SHARE, so both complete.
      expect(results).toEqual([null, null]);
    }, 30_000);

    it('two legacy transactions may append events to two claims in opposite orders', async () => {
      const [first, second] = [await seed(db, { marked: false, worker: false, notSent: false }), await seed(db, { marked: false, worker: false, notSent: false })];
      const a = new Client({ connectionString: currentUrl }); const b = new Client({ connectionString: currentUrl });
      await a.connect(); await b.connect();
      try {
        await a.query('BEGIN'); await b.query('BEGIN');
        await a.query(insertEventSql, [first!.claimId, 'ADAPTER_INVOCATION_STARTED']);
        await b.query(insertEventSql, [second!.claimId, 'ADAPTER_INVOCATION_STARTED']);
        expect((await Promise.all([attempt(a, insertEventSql, [second!.claimId, 'ADAPTER_INVOCATION_STARTED']), attempt(b, insertEventSql, [first!.claimId, 'ADAPTER_INVOCATION_STARTED'])])).map(codeOf)).toEqual([null, null]);
        await a.query('COMMIT'); await b.query('COMMIT');
      } finally { await a.end(); await b.end(); }
    });

    it('mixed concurrent TradingView and legacy traffic deadlocks nothing and keeps every marked invariant', async () => {
      const legacy = await Promise.all(Array.from({ length: 6 }, () => seed(db, { marked: false, worker: false, notSent: false })));
      const marked = await Promise.all(Array.from({ length: 6 }, () => seed(db)));
      const clients = await Promise.all(Array.from({ length: 12 }, async () => { const client = new Client({ connectionString: currentUrl }); await client.connect(); return client; }));
      try {
        const outcomes = await Promise.all(clients.map(async (client, index) => {
          const legacyClaim = legacy[index % 6]!; const markedClaim = marked[index % 6]!;
          await client.query('BEGIN');
          const first = await attempt(client, insertEventSql, [legacyClaim.claimId, 'ADAPTER_INVOCATION_STARTED']);
          const second = index % 2 === 0 ? await attempt(client, insertEventSql, [markedClaim.claimId, 'BROKER_DELIVERY_UNCERTAIN']) : await attempt(client, releaseSql, [markedClaim.claimId]);
          const failure = first ?? second;
          const commit = failure ? await attempt(client, 'ROLLBACK') : await attempt(client, 'COMMIT');
          return codeOf(failure ?? commit);
        }));
        expect(outcomes).not.toContain('40P01');
      } finally { await Promise.all(clients.map(client => client.end())); }
      expect((await db.query(`SELECT count(*)::int n FROM "EntryExposureClaim" ec WHERE ec.id=ANY($1) AND ec."releasedAt" IS NOT NULL AND EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=ec.id AND e."eventType"='BROKER_DELIVERY_UNCERTAIN')`, [marked.map(row => row.claimId)])).rows[0].n).toBe(0);
    }, 30_000);

    it('closes the origin check: a claim cannot move onto or off a marked intent', async () => {
      const marked = await seed(db); const legacy = await seed(db, { marked: false, worker: false, notSent: false });
      await expect(db.query(`UPDATE "EntryExposureClaim" SET "orderIntentId"=$2 WHERE id=$1`, [marked.claimId, legacy.intentId])).rejects.toThrow(/immutable/);
      const otherMarked = await seed(db);
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL session_replication_role='replica'`);
        await db.query(`UPDATE "EntryExposureClaim" SET "orderIntentId"=NULL,"trackedPositionId"=$2 WHERE id=$1`, [legacy.claimId, 700_000 + next()]);
        await db.query(`UPDATE "EntryExposureClaim" SET "orderIntentId"=NULL,"trackedPositionId"=$2 WHERE id=$1`, [otherMarked.claimId, 700_000 + next()]);
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
      await expect(db.query(`UPDATE "EntryExposureClaim" SET "orderIntentId"=$2 WHERE id=$1`, [legacy.claimId, otherMarked.intentId])).rejects.toThrow(/immutable/);
    });
  });

  describe('structured PostgreSQL error classification', () => {
    it('classifies real Prisma commit-time serialization failures and ORM deadlocks, and rejects a real P0001', async () => {
      const { prisma } = await import('../prisma.js');
      const { retryableConcurrencyFailure } = await import('../../services/external-signal-broker-worker.service.js');
      const rows = await Promise.all([1, 2].map(() => prisma.security.create({ data: { symbol: `S${next()}`, name: 'C3A probe', enabled: true, assetType: 'STOCK' } })));
      const [first, second] = rows as [typeof rows[0], typeof rows[0]];

      // Write skew: each transaction reads what the other writes, so one fails at COMMIT or at its last write.
      const skewFailures: unknown[] = [];
      let readers = 0; let release!: () => void;
      const bothRead = new Promise<void>(resolve => { release = resolve; });
      const skew = (read: number, write: number) => prisma.$transaction(async tx => {
        await tx.security.findUnique({ where: { id: read } });
        readers += 1; if (readers === 2) release();
        await bothRead;
        await tx.security.update({ where: { id: write }, data: { name: `skew-${write}` } });
      }, { isolationLevel: 'Serializable' }).catch((error: unknown) => { skewFailures.push(error); });
      await Promise.all([skew(first.id, second.id), skew(second.id, first.id)]);
      expect(skewFailures.length).toBeGreaterThan(0);
      for (const failure of skewFailures) expect(retryableConcurrencyFailure(failure), JSON.stringify(failure)).toBe(true);

      const deadlockFailures: unknown[] = [];
      let writers = 0; let proceed!: () => void;
      const bothWrote = new Promise<void>(resolve => { proceed = resolve; });
      const crossed = (one: number, two: number) => prisma.$transaction(async tx => {
        await tx.security.update({ where: { id: one }, data: { name: `deadlock-${one}` } });
        writers += 1; if (writers === 2) proceed();
        await bothWrote;
        await tx.security.update({ where: { id: two }, data: { name: `deadlock-${two}` } });
      }).catch((error: unknown) => { deadlockFailures.push(error); });
      await Promise.all([crossed(first.id, second.id), crossed(second.id, first.id)]);
      expect(deadlockFailures).toHaveLength(1);
      expect(retryableConcurrencyFailure(deadlockFailures[0]), JSON.stringify(deadlockFailures[0])).toBe(true);

      const seeded = await seed(db);
      await db.query(releaseSql, [seeded.claimId]);
      const refusal = await prisma.entryExposureClaimEvent.create({ data: { claimId: seeded.claimId, eventType: 'BROKER_DELIVERY_UNCERTAIN', evidenceJson: {} } }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect(retryableConcurrencyFailure(refusal), JSON.stringify(refusal)).toBe(false);
    }, 60_000);
  });

  describe('stale-admission time and age authority', () => {
    const zones = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'];
    afterAll(async () => { await db.query(`SET TIME ZONE 'UTC'`); });

    it.each([
      // 2026-11-01 09:00 UTC is the America/Los_Angeles fall-back instant; 2026-03-08 10:00 UTC is its spring-forward.
      ['fall-back boundary', '2026-11-01 08:50:00', '2026-11-01 09:05:00+00', true],
      ['fall-back boundary, one minute young', '2026-11-01 08:51:00', '2026-11-01 09:05:00+00', false],
      ['spring-forward boundary', '2026-03-08 09:50:00', '2026-03-08 10:05:00+00', true],
      ['spring-forward boundary, one minute young', '2026-03-08 09:51:00', '2026-03-08 10:05:00+00', false],
      ['exact threshold', '2026-06-01 12:00:00', '2026-06-01 12:15:00+00', true],
    ])('%s has one result in every session zone', async (_label, acquired, instant, expected) => {
      for (const zone of zones) {
        await db.query(`SET TIME ZONE '${zone}'`);
        const result = await db.query(`SELECT external_signal_stale_admission_elapsed($1::timestamp,$2::timestamptz) AS elapsed`, [acquired, instant]);
        expect(result.rows[0].elapsed, zone).toBe(expected);
      }
      await db.query(`SET TIME ZONE 'UTC'`);
    });

    it('demonstrates the C2 session-zone dependency that the helper removes', async () => {
      const results: boolean[] = [];
      for (const zone of zones) {
        await db.query(`SET TIME ZONE '${zone}'`);
        results.push((await db.query(`SELECT $1::timestamp <= ($2::timestamptz - interval '15 minutes') AS elapsed`, ['2026-06-01 12:00:00', '2026-06-01 12:20:00+00'])).rows[0].elapsed);
      }
      await db.query(`SET TIME ZONE 'UTC'`);
      expect(new Set(results).size).toBeGreaterThan(1);
    });

    const staleEvidence = JSON.stringify({ classification: 'NOT_SENT_PRE_DISPATCH', producer: 'STALE_ADMISSION_NEVER_EXECUTABLE', source: 'STALE_ADMISSION_RECOVERY', proof: { basis: 'CLAIM_NEVER_LEFT_ENTRY_PENDING' } });
    const insertStale = (claimId: number) => db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'NOT_SENT_EVIDENCE_RECORDED',$2)`, [claimId, staleEvidence]);
    const utcAgo = async (minutes: number) => (await db.query(`SELECT to_char((clock_timestamp() - make_interval(mins => $1::int)) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') AS at`, [minutes])).rows[0].at as string;

    it.each(zones)('the not-sent guard applies one claim-age rule in a %s session and ignores JSON authority', async zone => {
      const young = await seed(db, { worker: false, notSent: false, intentStatus: 'failed', claimStatus: 'ENTRY_PENDING', acquiredAtUtc: await utcAgo(10) });
      const aged = await seed(db, { worker: false, notSent: false, intentStatus: 'failed', claimStatus: 'ENTRY_PENDING', acquiredAtUtc: await utcAgo(20) });
      await db.query(`SET TIME ZONE '${zone}'`);
      try {
        await expect(insertStale(young.claimId)).rejects.toThrow(/closed pre-claim refusal/);
        await insertStale(aged.claimId);
      } finally { await db.query(`SET TIME ZONE 'UTC'`); }
    });

    it('a marked acquiredAt cannot be backdated at insert or by update', async () => {
      const seeded = await seed(db, { worker: false, notSent: false, intentStatus: 'received', claimStatus: 'ENTRY_PENDING' });
      const securityOf = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ($1,$1,true,'STOCK',now(),now()) RETURNING id`, [`BD${next()}`])).rows[0].id as number;
      await expect(db.query(`UPDATE "EntryExposureClaim" SET "acquiredAt"='2020-01-01' WHERE id=$1`, [seeded.claimId])).rejects.toThrow(/immutable/);
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL session_replication_role='replica'`);
        await db.query(`UPDATE "EntryExposureClaim" SET "orderIntentId"=NULL,"trackedPositionId"=$2 WHERE id=$1`, [seeded.claimId, 700_000 + next()]);
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
      const inserted = (await db.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"acquiredAt","createdAt","updatedAt") SELECT $1::int,$2::int,$3::int,$4,'ENTRY_PENDING','2020-01-01'::timestamp,now(),now() RETURNING to_char("acquiredAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS acquired`, [SEED_ACCOUNT_ID, securityOf, seeded.intentId, `backdated:${randomUUID()}`])).rows[0];
      expect(Date.now() - new Date(inserted.acquired).getTime()).toBeLessThan(60_000);
    });
  });

  describe('lifecycle terminal integrity', () => {
    it.each([['blocked', 'failed'], ['failed', 'blocked']])('a marked %s intent without worker claim or evidence cannot become %s', async (from, to) => {
      const seeded = await seed(db, { worker: false, notSent: false, intentStatus: from!, claimStatus: 'ENTRY_PENDING' });
      await expect(db.query(`UPDATE "OrderIntent" SET status=$2 WHERE id=$1`, [seeded.intentId, to])).rejects.toThrow(/terminal TradingView intent/);
      for (const status of ['received', 'pending', 'submitting', 'submitted', 'filled']) {
        await expect(db.query(`UPDATE "OrderIntent" SET status=$2 WHERE id=$1`, [seeded.intentId, status])).rejects.toThrow(/terminal TradingView intent/);
      }
      await expect(db.query(`UPDATE "OrderIntent" SET "blockReason"='rewritten' WHERE id=$1`, [seeded.intentId])).rejects.toThrow(/terminal TradingView intent/);
      await expect(db.query(`UPDATE "OrderIntent" SET "rawRequestJson"=jsonb_set("rawRequestJson",'{riskEvaluation}','{"reason":"rewritten"}') WHERE id=$1`, [seeded.intentId])).rejects.toThrow(/terminal TradingView intent/);
    });

    it('legitimate terminalization and unrelated touches still work; unmarked intents are unaffected', async () => {
      const seeded = await seed(db, { worker: false, notSent: false, intentStatus: 'pending', claimStatus: 'ENTRY_PENDING' });
      await db.query(`UPDATE "OrderIntent" SET status='blocked',"blockReason"='first refusal' WHERE id=$1`, [seeded.intentId]);
      await db.query(`UPDATE "OrderIntent" SET "updatedAt"=now() WHERE id=$1`, [seeded.intentId]);
      const legacy = await seed(db, { marked: false, worker: false, notSent: false, intentStatus: 'blocked', claimStatus: 'ENTRY_PENDING' });
      await db.query(`UPDATE "OrderIntent" SET status='failed',"blockReason"='legacy correction' WHERE id=$1`, [legacy.intentId]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Real TradingView graphs through the real services and the top-level scheduler.
  // ---------------------------------------------------------------------------------------------
  const admit = (label: string) => fixture.admit(label);
  const workerClaim = (graph: Awaited<ReturnType<typeof admit>>) => fixture.workerClaim(graph);

  const backdate = async (graph: { intentId: number; claimId: number }, ages: { intent?: number; claim?: number }) => {
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL session_replication_role='replica'`);
      if (ages.intent != null) await db.query(`UPDATE "OrderIntent" SET "updatedAt"=(clock_timestamp() AT TIME ZONE 'UTC') - make_interval(mins => $2::int) WHERE id=$1`, [graph.intentId, ages.intent]);
      if (ages.claim != null) await db.query(`UPDATE "EntryExposureClaim" SET "acquiredAt"=(clock_timestamp() AT TIME ZONE 'UTC') - make_interval(mins => $2::int) WHERE id=$1`, [graph.claimId, ages.claim]);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  };
  const graphState = async (graph: { intentId: number; claimId: number }) => (await db.query(`SELECT i.status AS intent,ec.status AS claim,ec."releasedAt" IS NOT NULL AS released,
      (SELECT count(*)::int FROM "EntryExposureClaimEvent" e WHERE e."claimId"=ec.id AND e."eventType"='NOT_SENT_EVIDENCE_RECORDED') AS not_sent,
      (SELECT count(*)::int FROM "EntryExposureClaimEvent" e WHERE e."claimId"=ec.id AND e."eventType" IN ('DISPATCH_RECOVERY_ERROR','RECOVERY_ATTEMPT_FAILED','STALE_ADMISSION_RECOVERY_BLOCKED')) AS failures
    FROM "OrderIntent" i JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=i.id WHERE i.id=$1`, [graph.intentId])).rows[0];
  const tick = async () => (await import('../../workers/order.worker.js')).recoverStaleSubmittingIntents();
  const accountResult = (result: Awaited<ReturnType<typeof tick>>) => result.results.find(row => row.account.tradingAccountId === paperId);

  describe('stale-admission recovery through the scheduler', () => {
    it('releases only when both claim age and intent activity age have elapsed, then stays quiet', async () => {
      const graph = await admit('c3a-stale-both');
      await backdate(graph, { intent: 20, claim: 20 });
      expect(accountResult(await tick())?.outcome).toBe('PROCESSED');
      expect(await graphState(graph)).toEqual({ intent: 'failed', claim: 'RELEASED', released: true, not_sent: 1, failures: 0 });
      await tick();
      expect((await graphState(graph)).not_sent).toBe(1);
    }, 30_000);

    it.each([
      ['recent intent activity with an old claim', { intent: 1, claim: 20 }],
      ['a recent claim with old intent activity', { intent: 20, claim: 1 }],
    ])('%s is neither released nor reported as an error across ticks', async (_label, ages) => {
      const graph = await admit('c3a-stale-disagree');
      await backdate(graph, ages);
      for (let index = 0; index < 3; index += 1) await tick();
      expect(await graphState(graph)).toEqual({ intent: 'received', claim: 'ENTRY_PENDING', released: false, not_sent: 0, failures: 0 });
      // Close it so one unresolved fixture cannot affect later scheduler assertions.
      await backdate(graph, { intent: 20, claim: 20 });
      await db.query(`UPDATE "EntryExposureClaim" SET "lastDiagnosedAt"=NULL WHERE id=$1`, [graph.claimId]);
      await tick();
      expect((await graphState(graph)).released).toBe(true);
    }, 30_000);

    it('an application clock ahead of PostgreSQL defers instead of producing a trigger failure', async () => {
      const { recoverStaleAdmissionClaimsForAccount } = await import('../../services/entry-dispatch-recovery.service.js');
      const graph = await admit('c3a-stale-skew');
      const result = await recoverStaleAdmissionClaimsForAccount(paperId, new Date(Date.now() + 3_600_000));
      expect(result).toMatchObject({ deferred: 1, released: 0, failures: [] });
      expect(await graphState(graph)).toEqual({ intent: 'received', claim: 'ENTRY_PENDING', released: false, not_sent: 0, failures: 0 });
      await backdate(graph, { intent: 20, claim: 20 });
      await db.query(`UPDATE "EntryExposureClaim" SET "lastDiagnosedAt"=NULL WHERE id=$1`, [graph.claimId]);
      await tick();
      expect((await graphState(graph)).released).toBe(true);
    }, 30_000);
  });

  describe('delivery-uncertainty Operational Attention', () => {
    const attention = async (intentId: number) => (await db.query(`SELECT id,status::text,code,severity::text,"resolutionPolicy"::text AS policy,"occurrenceCount" AS occurrences,"resolvedAt","detailsJson" FROM "OperationalAttention" WHERE "orderIntentId"=$1 AND code='TRADINGVIEW_C2_WORKER_RECOVERY_REQUIRED'`, [intentId])).rows;
    const openedEvents = async (attentionId: number) => (await db.query(`SELECT count(*)::int n FROM "OperationalAttentionSystemEvent" WHERE "operationalAttentionId"=$1`, [attentionId])).rows[0].n as number;

    it.each(EVENT_TYPES)('a submitting claimed intent with %s retains ownership with one stable episode', async eventType => {
      const graph = await admit('c3a-uncertain-submitting');
      await workerClaim(graph);
      await db.query(insertEventSql, [graph.claimId, eventType]);
      for (let index = 0; index < 3; index += 1) await tick();
      expect(await graphState(graph)).toEqual({ intent: 'submitting', claim: 'ENTRY_SUBMITTING', released: false, not_sent: 0, failures: 0 });
      const rows = await attention(graph.intentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'OPEN', severity: 'ERROR', policy: 'AUTHORITATIVE_ONLY', resolvedAt: null });
      expect(rows[0].detailsJson).toMatchObject({ deliveryEventTypes: [eventType], exposureRetained: true, definitelyNotSent: false });
      expect(await openedEvents(rows[0].id)).toBe(1);
    }, 30_000);

    it('recovery reports evidence that commits after its first read as attention, not a repeating failure', async () => {
      const { recoverTradingViewC2Claim } = await import('../../services/external-signal-broker-worker.service.js');
      const { prisma } = await import('../prisma.js');
      const graph = await admit('c3a-uncertain-race');
      await workerClaim(graph);
      // A delegate that commits the evidence between recovery's uncertainty read and its refusal.
      let injected = false;
      const racing = new Proxy(prisma, { get(target, property, receiver) {
        if (property === '$transaction' && !injected) {
          return async (...args: Parameters<typeof prisma.$transaction>) => {
            injected = true;
            await db.query(insertEventSql, [graph.claimId, 'BROKER_DELIVERY_UNCERTAIN']);
            return (target.$transaction as (...inner: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      } });
      expect(await recoverTradingViewC2Claim(graph.intentId, { db: racing })).toEqual({ outcome: 'OPERATIONAL_ATTENTION' });
      expect(await attention(graph.intentId)).toHaveLength(1);
      expect(await graphState(graph)).toMatchObject({ released: false, not_sent: 0 });
    }, 30_000);

    it('uncertainty after not-sent evidence on a blocked intent is scheduled, retained, and never swept', async () => {
      const graph = await admit('c3a-uncertain-blocked');
      const workerClaimId = await workerClaim(graph);
      await db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'NOT_SENT_EVIDENCE_RECORDED',$2)`, [graph.claimId, JSON.stringify({ classification: 'NOT_SENT_PRE_DISPATCH', producer: 'TRADINGVIEW_C2_DISPATCH_UNAVAILABLE', workerClaimId })]);
      await db.query(`UPDATE "OrderIntent" SET status='blocked',"blockReason"='C3A refusal' WHERE id=$1`, [graph.intentId]);
      await db.query(insertEventSql, [graph.claimId, 'BROKER_DELIVERY_UNCERTAIN']);
      for (let index = 0; index < 3; index += 1) await tick();
      expect(await graphState(graph)).toEqual({ intent: 'blocked', claim: 'ENTRY_SUBMITTING', released: false, not_sent: 1, failures: 0 });
      expect(await attention(graph.intentId)).toHaveLength(1);
      const { describeUnreleasedTerminalEntryClaims } = await import('../../services/entry-dispatch-recovery.service.js');
      const described = (await describeUnreleasedTerminalEntryClaims({ tradingAccountIds: [paperId] })).find(row => row.orderIntentId === graph.intentId);
      expect(described).toMatchObject({ recoveryState: 'OPERATOR_INVESTIGATION', automaticRecoveryPossible: false, blockerReason: 'TRADINGVIEW_DELIVERY_UNCERTAIN' });
    }, 30_000);

    it('an unclaimed marked claim with uncertainty is reported, stays pending and is not recovered as stale', async () => {
      const graph = await admit('c3a-uncertain-unclaimed');
      await db.query(insertEventSql, [graph.claimId, 'DISPATCH_OUTCOME_RECORDED']);
      await backdate(graph, { intent: 20, claim: 20 });
      await tick(); await tick();
      expect(await graphState(graph)).toMatchObject({ intent: 'received', claim: 'ENTRY_PENDING', released: false, not_sent: 0 });
      expect(await attention(graph.intentId)).toHaveLength(1);
    }, 30_000);

    it('new evidence updates the same episode; absence of local evidence never resolves it or admits a manual close', async () => {
      const graph = await admit('c3a-uncertain-material');
      await workerClaim(graph);
      await db.query(insertEventSql, [graph.claimId, 'BROKER_DELIVERY_UNCERTAIN']);
      await tick();
      const [first] = await attention(graph.intentId);
      await db.query(insertEventSql, [graph.claimId, 'ADAPTER_INVOCATION_STARTED']);
      await tick();
      const after = await attention(graph.intentId);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(first.id);
      expect(after[0].detailsJson.deliveryEventTypes).toEqual(['ADAPTER_INVOCATION_STARTED', 'BROKER_DELIVERY_UNCERTAIN']);
      expect(await openedEvents(first.id)).toBe(2);
      expect((await db.query(`SELECT count(*)::int n FROM "BrokerOrder" WHERE "orderIntentId"=$1`, [graph.intentId])).rows[0].n).toBe(0);
      expect(after[0].status).toBe('OPEN');
      const { resolveOperationalAttentionManually } = await import('../../services/operational-attention.service.js');
      const { revision } = (await db.query(`SELECT revision FROM "OperationalAttention" WHERE id=$1`, [first.id])).rows[0];
      await expect(resolveOperationalAttentionManually({ id: first.id, expectedRevision: revision, actorUserId: ownerId, reason: 'C3A hostile manual close' })).rejects.toBeTruthy();
      expect((await attention(graph.intentId))[0].status).toBe('OPEN');
    }, 30_000);

    it('a claim that never had uncertainty still recovers as definitely not sent', async () => {
      const graph = await admit('c3a-crash-clean');
      await workerClaim(graph);
      await tick();
      expect(await graphState(graph)).toEqual({ intent: 'blocked', claim: 'RELEASED', released: true, not_sent: 1, failures: 0 });
      expect(await attention(graph.intentId)).toHaveLength(0);
    }, 30_000);
  });

  describe('runtime execution quarantine', () => {
    it('keeps every marked intent out of the ordinary worker and keeps the typed entrypoint unscheduled', async () => {
      const worker = await readFile('src/workers/order.worker.ts', 'utf8');
      expect(worker).toContain(`where: { status: 'pending', tradingAccountId, externalSignalAccountCycleId: null }`);
      const sources = (await readdir('src', { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.'));
      const callers: string[] = [];
      for (const entry of sources) {
        const path = `${entry.parentPath}/${entry.name}`;
        if (entry.name !== 'external-signal-broker-worker.service.ts' && (await readFile(path, 'utf8')).includes('processTradingViewOrderIntentForC2')) callers.push(path);
      }
      expect(callers).toEqual([]);
    });

    it('the refusal path stays inert: C2 refuses, with no consumption, marker, broker order or network write', async () => {
      const { processTradingViewOrderIntentForC2 } = await import('../../services/external-signal-broker-worker.service.js');
      const graph = await admit('c3a-inert');
      await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [graph.intentId]);
      expect(await processTradingViewOrderIntentForC2(graph.intentId)).toEqual({ outcome: 'C2_DISPATCH_REFUSED' });
      expect((await db.query(`SELECT i."blockReason",ec."releasedAt" IS NOT NULL AS released,
        (SELECT count(*)::int FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=i.id) AS tv,
        (SELECT count(*)::int FROM "MarketPolicyBrokerDispatchConsumption" c WHERE c."orderIntentId"=i.id) AS mi,
        (SELECT count(*)::int FROM "BrokerOrder" b WHERE b."orderIntentId"=i.id) AS orders,
        (SELECT count(*)::int FROM "EntryExposureClaimEvent" e WHERE e."claimId"=ec.id AND e."eventType"='ADAPTER_INVOCATION_STARTED') AS markers
        FROM "OrderIntent" i JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=i.id WHERE i.id=$1`, [graph.intentId])).rows[0])
        .toEqual({ blockReason: 'TRADINGVIEW_C2_BROKER_DISPATCH_UNAVAILABLE', released: true, tv: 0, mi: 0, orders: 0, markers: 0 });
      const writes = (fetchSpy.mock.calls as unknown as Array<[unknown, { method?: string }?]>).filter(([, init]) => (init?.method ?? 'GET').toUpperCase() !== 'GET');
      expect(writes).toEqual([]);
    });
  });

  describe('migration discipline', () => {
    it('leaves the applied C2 migration byte-identical', async () => {
      // Line endings are normalized so a CRLF checkout does not read as an edited migration.
      const body = (await readFile(`prisma/migrations/${C2_MIGRATION}/migration.sql`, 'utf8')).replaceAll('\r\n', '\n');
      expect(createHash('sha256').update(body).digest('hex')).toBe(C2_MIGRATION_SHA256);
    });

    it('upgrades a populated C2 database in place and preserves its rows, dispatch state and evidence', async () => {
      const claimed = await seed(c2); const legacy = await seed(c2, { marked: false, worker: false, notSent: false });
      await c2.query(insertEventSql, [claimed.claimId, 'BROKER_DELIVERY_UNCERTAIN']);
      const snapshot = async () => (await c2.query(`SELECT (SELECT count(*)::int FROM "EntryExposureClaim") AS claims,(SELECT count(*)::int FROM "EntryExposureClaimEvent") AS events,(SELECT count(*)::int FROM "OrderIntent") AS intents,(SELECT "activeRolloutGenerationId" FROM "ExternalSignalBrokerDispatchState" WHERE id=1) AS dispatch,(SELECT "acquiredAt"::text FROM "EntryExposureClaim" WHERE id=$1) AS acquired`, [claimed.claimId])).rows[0];
      const before = await snapshot();
      await applyMigrations(c2, [C3A_MIGRATION]);
      expect(await snapshot()).toEqual(before);
      expect(before.dispatch).toBeNull();
      await expect(c2.query(releaseSql, [claimed.claimId])).rejects.toThrow(/possible-delivery|current uncontradicted/);
      await c2.query(insertEventSql, [legacy.claimId, 'ADAPTER_INVOCATION_STARTED']);
      const triggers = (await c2.query(`SELECT tgname FROM pg_trigger WHERE tgrelid IN ('"EntryExposureClaim"'::regclass,'"EntryExposureClaimEvent"'::regclass) AND NOT tgisinternal ORDER BY 1`)).rows.map(row => row.tgname);
      expect(triggers).toEqual(expect.arrayContaining(['EntryExposureClaim_external_signal_acquired_at_stamp', 'EntryExposureClaim_external_signal_c2_guard', 'EntryExposureClaimEvent_external_signal_c2_delivery_fence', 'EntryExposureClaimEvent_external_signal_c2_not_sent_guard']));
    });
  });
});
