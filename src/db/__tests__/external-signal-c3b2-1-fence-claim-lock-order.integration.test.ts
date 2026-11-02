import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgresDatabase, type DisposablePostgresDatabase } from './disposable-postgres.js';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';

// Phase 4A.2C3B.2-1 acceptance correction: fence / claim lock ordering.
//
// The dispatch-fence AFTER triggers used to take the fence row after the OrderIntent row but without the EntryExposureClaim, while a claim
// mutation holds the claim and then reaches the fence. Intent-or-event -> fence -> claim against claim -> fence is a cycle (40P01).
// The corrected bump functions lock the claim of a marked intent FOR NO KEY UPDATE before the fence advance, so every path is claim -> fence.
//
// Every interleaving below is driven with real SQL on separate connections and synchronised on pg_stat_activity lock waits, not on sleeps.
// The same adaptive protocol runs against the corrected functions (must finish, no 40P01, durable outcomes intact) and, as a negative
// control, against the uncorrected bodies reinstalled inside this disposable database (must deadlock).
//
// Coverage limitation: the operator-remediation and terminal-sweep SERVICES need an authoritative Alpaca lookup; none is performed here
// (fetch is a failing spy). The statements are therefore the exact SQL shapes those services issue (intent update, evidence insert,
// claim update, and the lease UPDATE of leaseRecoveryAttempt), not calls through the service.

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code ?? null;

type Isolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
const ISOLATIONS: Isolation[] = ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];

// The bodies as shipped in cfc1196, before the correction (verbatim from the original migration).
const UNCORRECTED_BUMP_INTENT = `CREATE OR REPLACE FUNCTION external_signal_dispatch_fence_bump_intent() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM external_signal_dispatch_fence_advance(ARRAY[NEW.id]);
  RETURN NULL;
END $$`;
const UNCORRECTED_BUMP_CLAIM_EVENT = `CREATE OR REPLACE FUNCTION external_signal_dispatch_fence_bump_claim_event() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM external_signal_dispatch_fence_advance(ARRAY(SELECT c."orderIntentId" FROM "EntryExposureClaim" c WHERE c.id = NEW."claimId"));
  RETURN NULL;
END $$`;

type Result = { ok: true; rowCount: number } | { ok: false; code: string | null; message: string };
type Step = { result: Promise<Result>; settled: () => boolean };

(enabled ? describe : describe.skip)('TradingView C3B.2-1 fence/claim lock ordering (PostgreSQL)', () => {
  const fetchSpy = vi.fn(async () => { throw new Error('C3B.2-1 lock-order tests forbid broker network access'); });
  let disposable: DisposablePostgresDatabase;
  let db: Client, observer: Client;
  let fx: Awaited<ReturnType<typeof createTradingViewGraphFixture>>;
  const open: Client[] = [];
  let lastDeadlocks = 0;

  const connect = async (isolation?: Isolation) => {
    const client = new Client({ connectionString: disposable.url });
    await client.connect(); open.push(client);
    await client.query(`SET deadlock_timeout='300ms'`);
    await client.query(`SET lock_timeout='20s'`);
    if (isolation) await client.query(`SET default_transaction_isolation='${isolation.toLowerCase()}'`);
    return client;
  };
  const pidOf = async (c: Client) => Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const lockWaiting = async (pid: number) => (await observer.query(`SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`, [pid])).rowCount === 1;

  /** Starts a statement without awaiting it. */
  const start = (c: Client, sql: string, params: unknown[] = []): Step => {
    let done = false;
    const result = c.query(sql, params).then<Result, Result>(
      r => { done = true; return { ok: true, rowCount: r.rowCount ?? 0 }; },
      (e: Error) => { done = true; return { ok: false, code: codeOf(e), message: e.message }; });
    return { result, settled: () => done };
  };
  /** Waits until the statement either finished or is waiting on a lock: the interleaving's synchronisation point. */
  const reach = async (step: Step, pid: number, label: string): Promise<'settled' | 'blocked'> => {
    for (let i = 0; i < 1500; i += 1) {
      if (step.settled()) return 'settled';
      if (await lockWaiting(pid)) return step.settled() ? 'settled' : 'blocked';
      await sleep(10);
    }
    throw new Error(`synchronisation point not reached: ${label}`);
  };
  const exec = async (c: Client, sql: string, params: unknown[] = []) => (await start(c, sql, params).result);
  const must = async (c: Client, sql: string, params: unknown[] = []) => {
    const r = await exec(c, sql, params);
    if (!r.ok) throw new Error(`unexpected failure (${r.code}): ${r.message} :: ${sql}`);
    return r;
  };
  const finish = async (c: Client, result: Result | null) => { await exec(c, result && !result.ok ? 'ROLLBACK' : 'COMMIT'); };

  /** Deadlocks the server counted since the last call (statistics flush with a delay). */
  async function newDeadlocks(settleMs = 1700) {
    await sleep(settleMs);
    const total = Number((await observer.query(`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)).rows[0].deadlocks);
    const delta = total - lastDeadlocks; lastDeadlocks = total; return delta;
  }

  const fenceOf = async (intentId: number) => Number((await db.query(`SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [intentId])).rows[0].version);
  const claimOf = async (claimId: number) => (await db.query(`SELECT status, "releasedAt", "lastDiagnosedAt" FROM "EntryExposureClaim" WHERE id=$1`, [claimId])).rows[0] as { status: string; releasedAt: Date | null; lastDiagnosedAt: Date | null };
  const intentStatus = async (intentId: number) => (await db.query(`SELECT status FROM "OrderIntent" WHERE id=$1`, [intentId])).rows[0].status as string;
  const eventTypes = async (claimId: number) => (await db.query(`SELECT "eventType" FROM "EntryExposureClaimEvent" WHERE "claimId"=$1 ORDER BY id`, [claimId])).rows.map(r => r.eventType as string);
  const brokerRows = async (intentId: number) => (await db.query(`SELECT (SELECT count(*)::int FROM "BrokerOrder" WHERE "orderIntentId"=$1) + (SELECT count(*)::int FROM "BrokerActivity" WHERE "orderIntentId"=$1) AS n`, [intentId])).rows[0].n as number;

  type Graph = Awaited<ReturnType<typeof fx.admit>>;
  /** A marked intent with its ENTRY_PENDING claim and fence, not yet worker-claimed. */
  const pending = () => fx.admit(`lock-order-${randomUUID().slice(0, 8)}`);
  /** A marked intent claimed by the worker (intent 'submitting', claim ENTRY_SUBMITTING) whose pre-boundary failure is recorded and the intent closed. */
  async function notSentTerminal() {
    const g = await pending();
    const workerClaimId = await fx.workerClaim(g);
    const claimEvent = (await db.query(`SELECT id FROM "EntryExposureClaimEvent" WHERE "claimId"=$1 AND "eventType"='WORKER_CLAIMED_FOR_SUBMISSION'`, [g.claimId])).rows[0];
    expect(claimEvent).toBeTruthy();
    await db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'NOT_SENT_EVIDENCE_RECORDED',$2)`,
      [g.claimId, JSON.stringify({ producer: 'WORKER_PRE_BOUNDARY_FAILURE', workerClaimId, classification: 'LOCAL_NOT_SENT' })]);
    await db.query(`UPDATE "OrderIntent" SET status='failed',"blockReason"='pre-boundary failure',"updatedAt"=now() WHERE id=$1`, [g.intentId]);
    return g;
  }
  /** A stale admission: ENTRY_PENDING claim acquired more than 15 minutes ago on a still-received intent. */
  async function staleAdmission() {
    const g = await pending();
    // acquiredAt is immutable by design; ageing it models history, so the immutability guard is bypassed deliberately, as the table owner, for this one statement.
    await db.query('BEGIN');
    await db.query(`SET LOCAL session_replication_role='replica'`);
    await db.query(`UPDATE "EntryExposureClaim" SET "acquiredAt"=now()-interval '20 minutes' WHERE id=$1`, [g.claimId]);
    await db.query('COMMIT');
    return g;
  }

  const touchIntent = `UPDATE "OrderIntent" SET "updatedAt"=now() WHERE id=$1`;
  const touchClaim = `UPDATE "EntryExposureClaim" SET "lastDiagnosedAt"=now() WHERE id=$1`;
  // The exact lease statement of leaseRecoveryAttempt (entry-dispatch-recovery.service.ts): advances lastDiagnosedAt only while due and held.
  const lease = `UPDATE "EntryExposureClaim" SET "lastDiagnosedAt"=now() WHERE id=$1 AND "releasedAt" IS NULL AND ("lastDiagnosedAt" IS NULL OR "lastDiagnosedAt" <= now() - interval '5 minutes')`;
  const insertEvent = `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,$2,$3)`;
  const release = `UPDATE "EntryExposureClaim" SET status='RELEASED',"releasedAt"=now(),"releaseReason"='C3B.2-1 lock-order release' WHERE id=$1`;

  type Outcome = { codes: Array<string | null>; deadlocked: boolean; syncPoints: string[] };
  const deadlocked = (codes: Array<string | null>) => codes.includes('40P01');
  /** A legitimate non-deadlock failure: only a serialization failure under a snapshot isolation level. */
  const legitimate = (isolation: Isolation, code: string | null) => code === null || (code === '40001' && isolation !== 'READ COMMITTED');

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    disposable = await createDisposablePostgresDatabase(process.env.DATABASE_URL!, 'c3b21lo');
    await disposable.migrate();
    process.env.DATABASE_URL = disposable.url;
    db = await connect(); observer = await connect();
    fx = await createTradingViewGraphFixture(db);
    await newDeadlocks(0);
  }, 300_000);

  // Every interleaving opens its own sessions; close them as soon as the test is over instead of holding up to a hundred until the end.
  afterEach(async () => {
    for (const client of open.splice(2)) { await client.query('ROLLBACK').catch(() => undefined); await client.end().catch(() => undefined); }
  });

  afterAll(async () => {
    for (const client of open) await client.query('ROLLBACK').catch(() => undefined);
    await (await import('../../services/trading-account-workflow-lock.service.js')).closeTradingAccountWorkflowLockPool().catch(() => undefined);
    await (await import('../prisma.js')).prisma.$disconnect();
    for (const client of open) await client.end().catch(() => undefined);
    await disposable?.drop();
    vi.unstubAllGlobals();
  });

  // -----------------------------------------------------------------------------------------------------------------------------------
  // The five interleavings. Each is ADAPTIVE: it observes whether a statement ran or queued and takes the only legal continuation, so the same
  // body is run on the corrected functions (expecting the corrected path) and on the uncorrected ones (expecting the deadlock).
  // -----------------------------------------------------------------------------------------------------------------------------------

  /** S1: A = intent UPDATE then claim UPDATE. B = claim FOR UPDATE (taken first) then claim UPDATE. */
  async function s1(isolation: Isolation): Promise<Outcome & { g: Graph; fenceBefore: number }> {
    const g = await pending(); const fenceBefore = await fenceOf(g.intentId);
    const a = await connect(isolation), b = await connect(isolation); const [pa, pb] = [await pidOf(a), await pidOf(b)];
    const sync: string[] = [];
    await must(b, 'BEGIN'); await must(b, `SELECT id FROM "EntryExposureClaim" WHERE id=$1 FOR UPDATE`, [g.claimId]); sync.push('B holds the claim');
    await must(a, 'BEGIN');
    const a1 = start(a, touchIntent, [g.intentId]); const s1State = await reach(a1, pa, 'S1 A intent update'); sync.push(`A intent update ${s1State}`);
    const b2 = start(b, touchClaim, [g.claimId]); const s2State = await reach(b2, pb, 'S1 B claim update'); sync.push(`B claim update ${s2State}`);
    const codes: Array<string | null> = [];
    if (s1State === 'blocked') {
      // Corrected: A queues on the claim, B proceeds and commits, then A resumes.
      const r2 = await b2.result; codes.push(r2.ok ? null : r2.code); await finish(b, r2);
      const r1 = await a1.result; codes.push(r1.ok ? null : r1.code);
      if (r1.ok) { const r3 = await exec(a, touchClaim, [g.claimId]); codes.push(r3.ok ? null : r3.code); await finish(a, r3); } else await finish(a, r1);
    } else {
      // Uncorrected: A holds the fence; A's claim update now closes the cycle with B.
      const a3 = start(a, touchClaim, [g.claimId]);
      const [r2, r3] = await Promise.all([b2.result, a3.result]);
      codes.push(r2.ok ? null : r2.code, r3.ok ? null : r3.code);
      await Promise.all([finish(a, r3), finish(b, r2)]);
    }
    return { codes, deadlocked: deadlocked(codes), syncPoints: sync, g, fenceBefore };
  }

  /** S1r: the reverse queue order. A does the intent UPDATE first; B then asks for the claim FOR UPDATE. */
  async function s1r(isolation: Isolation): Promise<Outcome & { g: Graph; fenceBefore: number }> {
    const g = await pending(); const fenceBefore = await fenceOf(g.intentId);
    const a = await connect(isolation), b = await connect(isolation); const [pa, pb] = [await pidOf(a), await pidOf(b)];
    const sync: string[] = [];
    await must(a, 'BEGIN'); await must(b, 'BEGIN');
    const a1 = start(a, touchIntent, [g.intentId]); sync.push(`A intent update ${await reach(a1, pa, 'S1r A intent update')}`); const r1 = await a1.result;
    const b1 = start(b, `SELECT id FROM "EntryExposureClaim" WHERE id=$1 FOR UPDATE`, [g.claimId]); const bState = await reach(b1, pb, 'S1r B claim lock'); sync.push(`B claim lock ${bState}`);
    const codes: Array<string | null> = [r1.ok ? null : r1.code];
    if (bState === 'blocked') {
      const r3 = await exec(a, touchClaim, [g.claimId]); codes.push(r3.ok ? null : r3.code); await finish(a, r3);
      const rb1 = await b1.result; codes.push(rb1.ok ? null : rb1.code);
      if (rb1.ok) { const rb2 = await exec(b, touchClaim, [g.claimId]); codes.push(rb2.ok ? null : rb2.code); await finish(b, rb2); } else await finish(b, rb1);
    } else {
      await b1.result;
      const a3 = start(a, touchClaim, [g.claimId]); sync.push(`A claim update ${await reach(a3, pa, 'S1r A claim update')}`);
      const b2 = start(b, touchClaim, [g.claimId]);
      const [ra, rb] = await Promise.all([a3.result, b2.result]);
      codes.push(ra.ok ? null : ra.code, rb.ok ? null : rb.code);
      await Promise.all([finish(a, ra), finish(b, rb)]);
    }
    return { codes, deadlocked: deadlocked(codes), syncPoints: sync, g, fenceBefore };
  }

  /** S2: A = stale-admission failure (intent -> failed, not-sent evidence, claim release). B = autocommit lease update. */
  async function s2(isolation: Isolation): Promise<Outcome & { g: Graph; fenceBefore: number; leaseResult: Result }> {
    const g = await staleAdmission(); const fenceBefore = await fenceOf(g.intentId);
    const a = await connect(isolation), b = await connect(isolation); const [pa, pb] = [await pidOf(a), await pidOf(b)];
    const sync: string[] = [];
    await must(a, 'BEGIN');
    const a1 = start(a, `UPDATE "OrderIntent" SET status='failed',"blockReason"='stale admission',"updatedAt"=now() WHERE id=$1`, [g.intentId]);
    sync.push(`A intent failure ${await reach(a1, pa, 'S2 A intent failure')}`); const r1 = await a1.result;
    const lb = start(b, lease, [g.claimId]); sync.push(`B lease ${await reach(lb, pb, 'S2 B lease')}`);
    const evidence = JSON.stringify({ producer: 'STALE_ADMISSION_NEVER_EXECUTABLE', source: 'STALE_ADMISSION_RECOVERY', proof: { basis: 'CLAIM_NEVER_LEFT_ENTRY_PENDING' } });
    const a2 = start(a, insertEvent, [g.claimId, 'NOT_SENT_EVIDENCE_RECORDED', evidence]); const a2State = await reach(a2, pa, 'S2 A not-sent evidence'); sync.push(`A not-sent evidence ${a2State}`);
    const codes: Array<string | null> = [r1.ok ? null : r1.code];
    let leaseResult: Result;
    if (a2State === 'settled') {
      const r2 = await a2.result; codes.push(r2.ok ? null : r2.code);
      const r3 = r2.ok ? await exec(a, release, [g.claimId]) : r2; if (r2.ok) codes.push(r3.ok ? null : r3.code);
      await finish(a, r3); leaseResult = await lb.result;
    } else {
      const [r2, rl] = await Promise.all([a2.result, lb.result]); leaseResult = rl;
      codes.push(r2.ok ? null : r2.code); await finish(a, r2);
    }
    codes.push(leaseResult.ok ? null : leaseResult.code);
    return { codes, deadlocked: deadlocked(codes), syncPoints: sync, g, fenceBefore, leaseResult };
  }

  /** S3 / S3d: A = an evidence event (operator authorization / revalidation-blocked diagnostic) then a claim update. B = terminal-sweep lease. */
  async function s3(isolation: Isolation, kind: 'authorized' | 'diagnostic'): Promise<Outcome & { g: Graph; fenceBefore: number; leaseResult: Result }> {
    const g = await notSentTerminal(); const fenceBefore = await fenceOf(g.intentId);
    const a = await connect(isolation), b = await connect(isolation); const [pa, pb] = [await pidOf(a), await pidOf(b)];
    const sync: string[] = [];
    const eventType = kind === 'authorized' ? 'OPERATOR_REMEDIATION_AUTHORIZED' : 'DISPATCH_RECOVERY_REVALIDATION_BLOCKED';
    const claimUpdate = kind === 'authorized' ? release : `UPDATE "EntryExposureClaim" SET "updatedAt"=now() WHERE id=$1`;
    await must(a, 'BEGIN');
    const a1 = start(a, insertEvent, [g.claimId, eventType, JSON.stringify({ mode: 'OPERATOR', actorUserId: fx.ownerId, revalidation: kind === 'diagnostic' ? ['LOCAL_BROKER_ORDER_PRESENT'] : undefined })]);
    sync.push(`A ${eventType} ${await reach(a1, pa, 'S3 A evidence event')}`); const r1 = await a1.result;
    const lb = start(b, lease, [g.claimId]); sync.push(`B terminal-sweep lease ${await reach(lb, pb, 'S3 B lease')}`);
    const a2 = start(a, claimUpdate, [g.claimId]); const a2State = await reach(a2, pa, 'S3 A claim update'); sync.push(`A claim update ${a2State}`);
    const codes: Array<string | null> = [r1.ok ? null : r1.code];
    let leaseResult: Result;
    if (a2State === 'settled') {
      const r2 = await a2.result; codes.push(r2.ok ? null : r2.code); await finish(a, r2); leaseResult = await lb.result;
    } else {
      const [r2, rl] = await Promise.all([a2.result, lb.result]); leaseResult = rl;
      codes.push(r2.ok ? null : r2.code); await finish(a, r2);
    }
    codes.push(leaseResult.ok ? null : leaseResult.code);
    return { codes, deadlocked: deadlocked(codes), syncPoints: sync, g, fenceBefore, leaseResult };
  }

  // -----------------------------------------------------------------------------------------------------------------------------------
  describe('corrected functions: no deadlock under any isolation level', () => {
    describe.each(ISOLATIONS)('%s', isolation => {
      it('S1: intent update then claim update versus a claim-first competitor', async () => {
        await newDeadlocks(0);
        const run = await s1(isolation);
        expect(run.syncPoints).toEqual(['B holds the claim', 'A intent update blocked', 'B claim update settled']); // both reached their points; A queued on the CLAIM
        expect(run.deadlocked).toBe(false);
        const [bCode, aIntentCode, aClaimCode = null] = run.codes;
        expect(bCode).toBeNull();
        expect(legitimate(isolation, aIntentCode ?? null)).toBe(true);
        if (isolation === 'READ COMMITTED') { expect(aIntentCode).toBeNull(); expect(aClaimCode).toBeNull(); }
        expect((await claimOf(run.g.claimId)).lastDiagnosedAt).not.toBeNull();
        expect(await fenceOf(run.g.intentId)).toBeGreaterThan(run.fenceBefore);
        expect(await intentStatus(run.g.intentId)).toBe('received');
        expect(await brokerRows(run.g.intentId)).toBe(0);
        expect(await newDeadlocks()).toBe(0);
      }, 90_000);

      it('S1r: the same operations in the reverse queue order', async () => {
        await newDeadlocks(0);
        const run = await s1r(isolation);
        expect(run.syncPoints).toEqual(['A intent update settled', 'B claim lock blocked']); // B queued behind A's claim lock
        expect(run.deadlocked).toBe(false);
        const [aIntent, aClaim, bLock, bClaim = null] = run.codes;
        expect(aIntent).toBeNull(); expect(aClaim).toBeNull();
        expect(legitimate(isolation, bLock ?? null)).toBe(true);
        if (isolation === 'READ COMMITTED') { expect(bLock).toBeNull(); expect(bClaim).toBeNull(); }
        expect((await claimOf(run.g.claimId)).lastDiagnosedAt).not.toBeNull();
        expect(await fenceOf(run.g.intentId)).toBeGreaterThan(run.fenceBefore);
        expect(await brokerRows(run.g.intentId)).toBe(0);
        expect(await newDeadlocks()).toBe(0);
      }, 90_000);

      it('S2: stale-admission failure and release versus an autocommit lease update', async () => {
        await newDeadlocks(0);
        const run = await s2(isolation);
        expect(run.syncPoints).toEqual(['A intent failure settled', 'B lease blocked', 'A not-sent evidence settled']);
        expect(run.deadlocked).toBe(false);
        expect(run.codes.slice(0, 3)).toEqual([null, null, null]); // A: intent, evidence, release
        const claim = await claimOf(run.g.claimId);
        // The stale admission is durably released as NOT SENT, exactly once, and no delivery evidence exists.
        expect(claim.status).toBe('RELEASED'); expect(claim.releasedAt).not.toBeNull();
        expect(await intentStatus(run.g.intentId)).toBe('failed');
        expect(await eventTypes(run.g.claimId)).toEqual(['NOT_SENT_EVIDENCE_RECORDED']);
        // The lease queued behind a released claim: it updates nothing (READ COMMITTED re-check) or fails serialization (snapshot levels).
        if (isolation === 'READ COMMITTED') expect(run.leaseResult).toEqual({ ok: true, rowCount: 0 });
        else expect(run.leaseResult.ok ? run.leaseResult.rowCount : run.leaseResult.code).toSatisfy((v: unknown) => v === 0 || v === '40001');
        expect(claim.lastDiagnosedAt).toBeNull();
        expect(await fenceOf(run.g.intentId)).toBeGreaterThan(run.fenceBefore);
        expect(await brokerRows(run.g.intentId)).toBe(0);
        expect(await newDeadlocks()).toBe(0);
      }, 90_000);

      it.each(['authorized', 'diagnostic'] as const)('%s: operator evidence event then claim update versus a terminal-sweep lease (S3 / S3d)', async kind => {
        await newDeadlocks(0);
        const run = await s3(isolation, kind);
        const eventType = kind === 'authorized' ? 'OPERATOR_REMEDIATION_AUTHORIZED' : 'DISPATCH_RECOVERY_REVALIDATION_BLOCKED';
        expect(run.syncPoints).toEqual([`A ${eventType} settled`, 'B terminal-sweep lease blocked', 'A claim update settled']);
        expect(run.deadlocked).toBe(false);
        expect(run.codes.slice(0, 2)).toEqual([null, null]);
        const claim = await claimOf(run.g.claimId);
        const events = await eventTypes(run.g.claimId);
        // C3A guarantees survive: the not-sent evidence is untouched, no delivery or uncertainty evidence was invented, the intent stays terminal.
        expect(events).toEqual(['WORKER_CLAIMED_FOR_SUBMISSION', 'NOT_SENT_EVIDENCE_RECORDED', eventType]);
        expect(events).not.toContain('BROKER_DELIVERY_UNCERTAIN');
        expect(await intentStatus(run.g.intentId)).toBe('failed');
        if (kind === 'authorized') {
          expect(claim.status).toBe('RELEASED'); expect(claim.releasedAt).not.toBeNull(); expect(claim.lastDiagnosedAt).toBeNull();
          if (isolation === 'READ COMMITTED') expect(run.leaseResult).toEqual({ ok: true, rowCount: 0 });
        } else {
          expect(claim.status).toBe('ENTRY_SUBMITTING'); expect(claim.releasedAt).toBeNull();
          if (isolation === 'READ COMMITTED') { expect(run.leaseResult).toEqual({ ok: true, rowCount: 1 }); expect(claim.lastDiagnosedAt).not.toBeNull(); }
        }
        expect(run.leaseResult.ok ? true : (run.leaseResult as { code: string | null }).code).toSatisfy((v: unknown) => v === true || v === '40001');
        expect(await fenceOf(run.g.intentId)).toBeGreaterThan(run.fenceBefore);
        expect(await brokerRows(run.g.intentId)).toBe(0);
        expect(await newDeadlocks()).toBe(0);
      }, 90_000);

      it('C1 control: the canonical intent-before-claim order against a canonical competitor completes without a deadlock', async () => {
        await newDeadlocks(0);
        const g = await pending(); const before = await fenceOf(g.intentId);
        const a = await connect(isolation), b = await connect(isolation); const [pa, pb] = [await pidOf(a), await pidOf(b)];
        await must(a, 'BEGIN'); await must(b, 'BEGIN');
        const a1 = start(a, touchIntent, [g.intentId]); expect(await reach(a1, pa, 'C1 A intent')).toBe('settled'); await a1.result;
        const b1 = start(b, touchIntent, [g.intentId]); expect(await reach(b1, pb, 'C1 B intent')).toBe('blocked'); // queued on the intent row
        const a2 = await exec(a, touchClaim, [g.claimId]); expect(a2.ok).toBe(true); await finish(a, a2);
        const rb1 = await b1.result; const codes: Array<string | null> = [rb1.ok ? null : rb1.code];
        if (rb1.ok) { const rb2 = await exec(b, touchClaim, [g.claimId]); codes.push(rb2.ok ? null : rb2.code); await finish(b, rb2); } else await finish(b, rb1);
        expect(deadlocked(codes)).toBe(false);
        expect(codes.every(code => legitimate(isolation, code))).toBe(true);
        if (isolation === 'READ COMMITTED') expect(codes).toEqual([null, null]);
        expect(await fenceOf(g.intentId)).toBeGreaterThan(before);
        expect(await newDeadlocks()).toBe(0);
      }, 90_000);
    });

    it('an unmarked (legacy PAPER/LIVE) intent and claim write never touch a fence and do not take extra locks', async () => {
      const tx = await connect(); const other = await connect();
      const target = await fx.createTarget();
      // An unmarked intent with its own claim: the bump functions must lock nothing for it.
      const intentId = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('manual',$2,'sell','market','day','received',$1,'{}',$3,now(),now()) RETURNING id`, [`unmarked-${randomUUID()}`, target.symbol, fx.paperId])).rows[0].id as number;
      const claimId = (await db.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,'ENTRY_PENDING',now(),now()) RETURNING id`, [fx.paperId, target.securityId, intentId, `lock-order-unmarked:${randomUUID()}`])).rows[0].id as number;
      await must(tx, 'BEGIN'); await must(tx, touchIntent, [intentId]);
      // A competing claim FOR UPDATE must NOT queue behind an unmarked intent update (the corrected bump takes no claim lock for it).
      await must(other, 'BEGIN');
      const row = await exec(other, `SELECT id FROM "EntryExposureClaim" WHERE id=$1 FOR UPDATE NOWAIT`, [claimId]);
      expect(row.ok, 'unmarked claim must stay unlocked by an unmarked intent update').toBe(true);
      await exec(other, 'ROLLBACK'); await exec(tx, 'ROLLBACK');
      expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [intentId])).rows[0].n).toBe(0);
    }, 60_000);

    it('keeps failing closed for a marked intent whose fence is missing, and fabricates nothing', async () => {
      const g = await pending();
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role='replica'`);
      await db.query(`DELETE FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [g.intentId]); // models a lost fence; owner-only deliberate bypass
      await db.query('COMMIT');
      const intentFailure = await exec(db, touchIntent, [g.intentId]);
      expect(intentFailure.ok ? '' : intentFailure.message).toMatch(/marked intent \d+ has no dispatch fence/);
      const eventFailure = await exec(db, insertEvent, [g.claimId, 'DISPATCH_RECOVERY_REVALIDATION_BLOCKED', '{}']);
      expect(eventFailure.ok ? '' : eventFailure.message).toMatch(/marked intent \d+ has no dispatch fence/);
      expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [g.intentId])).rows[0].n).toBe(0);
      await db.query('BEGIN'); await db.query(`SET LOCAL session_replication_role='replica'`);
      await db.query(`INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId","version") VALUES ($1,1)`, [g.intentId]); await db.query('COMMIT');
    }, 60_000);
  });

  // -----------------------------------------------------------------------------------------------------------------------------------
  describe('negative control: the uncorrected cfc1196 bump functions reproduce the deadlock on the same interleavings', () => {
    const swap = async <T>(body: () => Promise<T>) => {
      const saved = [
        (await db.query(`SELECT pg_get_functiondef('external_signal_dispatch_fence_bump_intent()'::regprocedure) AS def`)).rows[0].def as string,
        (await db.query(`SELECT pg_get_functiondef('external_signal_dispatch_fence_bump_claim_event()'::regprocedure) AS def`)).rows[0].def as string,
      ];
      await db.query(UNCORRECTED_BUMP_INTENT); await db.query(UNCORRECTED_BUMP_CLAIM_EVENT);
      try { return await body(); } finally { for (const def of saved) await db.query(def); }
    };
    const proves = async (name: string, run: () => Promise<Outcome>) => {
      await newDeadlocks(0);
      const mark = open.length;
      const outcome = await swap(run);
      // A backend publishes its deadlock count when it exits; disconnect this run's sessions so the counter below is current.
      for (const client of open.splice(mark)) await client.end().catch(() => undefined);
      expect(outcome.deadlocked, `${name}: the uncorrected bumps must deadlock (codes ${JSON.stringify(outcome.codes)})`).toBe(true);
      // The server's own counter confirms it (statistics flush with a delay).
      let counted = 0; for (let i = 0; i < 6 && counted === 0; i += 1) counted = await newDeadlocks(1000);
      expect(counted).toBeGreaterThan(0);
    };

    it.each(ISOLATIONS)('S1 deadlocks without the correction (%s)', isolation => proves('S1', () => s1(isolation)), 120_000);
    it('S1r deadlocks without the correction', () => proves('S1r', () => s1r('READ COMMITTED')), 120_000);
    it('S2 deadlocks without the correction', () => proves('S2', () => s2('READ COMMITTED')), 120_000);
    it('S3 deadlocks without the correction', () => proves('S3', () => s3('READ COMMITTED', 'authorized')), 120_000);
    it('S3d deadlocks without the correction', () => proves('S3d', () => s3('READ COMMITTED', 'diagnostic')), 120_000);

    it('restored the corrected functions afterwards', async () => {
      for (const fn of ['external_signal_dispatch_fence_bump_intent()', 'external_signal_dispatch_fence_bump_claim_event()']) {
        const def = (await db.query(`SELECT pg_get_functiondef($1::regprocedure) AS def`, [fn])).rows[0].def as string;
        expect(def).toContain('FOR NO KEY UPDATE');
      }
    });
  });

  it('performed no network call', () => { expect(fetchSpy).not.toHaveBeenCalled(); });
});
