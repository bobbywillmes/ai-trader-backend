// Upgrade probes for revision 5 (HIGH finding): the C3B.2 migration applied to a database that ALREADY holds marked TradingView intents.
// DISPOSABLE SERVERS ONLY. Replays every repository migration, builds historical marked intents with the production fixture in the
// states ENTRY_PENDING, ENTRY_SUBMITTING, BLOCKED and RELEASED (plus an unmarked intent), then applies scripts/design-probes/
// c3b2-r5-overlay.sql exactly as the Prisma migration runner would (one multi-statement simple query = one transaction) and proves:
// every marked intent has a version-1 fence, no unmarked intent has one, no existing row changed, no receipt was manufactured,
// historical signals stay ineligible for final authorization, C2 recovery still works, and the migration is concurrency-safe and atomic.
//   PROBE_BASE_URL=postgresql://postgres:pw@localhost:55416 npx tsx scripts/design-probes/c3b2-r5-upgrade-probes.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { attempt, makeMarketIntelligence, pidOf, sleep } from './c3b2-r5-common.js';

const { Client } = pg;
const base = process.env.PROBE_BASE_URL;
if (!base || !['', '/'].includes(new URL(base).pathname)) { console.error('Set PROBE_BASE_URL to a throwaway server URL without a database path.'); process.exit(64); }
globalThis.fetch = (async () => { throw new Error('design probes forbid network access'); }) as typeof fetch;
const results: Record<string, unknown> = {}; const failures: string[] = [];
const check = (section: string, name: string, condition: boolean, detail?: unknown) => { const b = (results[section] ??= {}) as Record<string, unknown>; b[name] = { pass: condition, ...(detail === undefined ? {} : { detail }) }; if (!condition) failures.push(`${section}.${name}`); };
const mk = async (url: string) => { const c = new Client({ connectionString: url }); await c.connect(); return c; };

const admin = await mk(`${base}/postgres`);
const database = `r5u_${Date.now()}`;
await admin.query(`CREATE DATABASE ${database}`);
const url = `${base}/${database}`;
const db = await mk(url);
results.server = (await db.query('SHOW server_version')).rows[0].server_version;
const overlay = await readFile('scripts/design-probes/c3b2-r5-overlay.sql', 'utf8');
const S = 'upgrade';

try {
  const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  for (const name of migrations) await db.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
  results.migrations = migrations.length;
  process.env.DATABASE_URL = `${url}?application_name=r5u-prisma`;
  const { createTradingViewGraphFixture } = await import('../../src/db/__tests__/tradingview-graph.fixture.js');
  const fx = await createTradingViewGraphFixture(db);
  const { paperId, ownerId } = fx;
  const strategyId = (await db.query(`SELECT id FROM "Strategy" WHERE key='tv-graph'`)).rows[0].id as number;

  const notSentSql = `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT c.id,'NOT_SENT_EVIDENCE_RECORDED',jsonb_build_object('classification','NOT_SENT_PRE_DISPATCH','producer','TRADINGVIEW_C2_PRE_DISPATCH_RECOVERY','workerClaimId',$2::int) FROM "EntryExposureClaim" c WHERE c."orderIntentId"=$1`;
  const blockSql = `UPDATE "OrderIntent" SET status='blocked',"blockReason"='R5 upgrade probe',"updatedAt"=now() WHERE id=$1`;
  const releaseSql = `UPDATE "EntryExposureClaim" SET status='RELEASED',"releasedAt"=(now() AT TIME ZONE 'UTC'),"releaseReason"='R5 upgrade probe' WHERE "orderIntentId"=$1`;

  // ---- Historical population BEFORE the migration. Each graph is a real marked intent written through the production triggers.
  const A = await fx.admit('hist-entry-pending');                                          // intent received, claim ENTRY_PENDING
  const B = await fx.admit('hist-entry-pending-intent-pending'); await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [B.intentId]); // intent pending, claim ENTRY_PENDING
  const C = await fx.admit('hist-submitting-recover'); const cWorker = await fx.workerClaim(C);                                              // ENTRY_SUBMITTING (will be recovered after the upgrade)
  const D = await fx.admit('hist-submitting-authorize'); const dWorker = await fx.workerClaim(D);                                             // ENTRY_SUBMITTING (final authorization must refuse it)
  const E = await fx.admit('hist-blocked'); const eWorker = await fx.workerClaim(E); await db.query(notSentSql, [E.intentId, eWorker]); await db.query(blockSql, [E.intentId]); // evidence + blocked, claim still held
  const F = await fx.admit('hist-released'); const fWorker = await fx.workerClaim(F); await db.query(notSentSql, [F.intentId, fWorker]); await db.query(blockSql, [F.intentId]); await db.query(releaseSql, [F.intentId]); // released
  const unmarked = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('legacy','SEED','buy','market','day','received','r5u-unmarked','{}',$1,now(),now()) RETURNING id`, [paperId])).rows[0].id as number;
  const marked = { A, B, C, D, E, F };
  const markedIds = Object.values(marked).map(g => g.intentId);
  const state = async () => (await db.query(`SELECT i.id, i.status AS intent, c.status AS claim, c."releasedAt" IS NOT NULL AS released FROM "OrderIntent" i LEFT JOIN "EntryExposureClaim" c ON c."orderIntentId"=i.id WHERE i.id = ANY($1) ORDER BY i.id`, [markedIds])).rows;
  const statesBefore = await state();
  const names: Record<number, string> = Object.fromEntries(Object.entries(marked).map(([k, g]) => [g.intentId, k]));
  check(S, 'U0 historical population: ENTRY_PENDING, ENTRY_SUBMITTING, BLOCKED (held) and released marked intents exist before the migration, and no fence table exists', statesBefore.length === 6 && (await db.query(`SELECT to_regclass('public."ExternalSignalDispatchFence"') AS t`)).rows[0].t === null, statesBefore.map((r: any) => `${names[r.id]}: intent ${r.intent}, claim ${r.claim}${r.released ? ' (released)' : ''}`));

  const tables = ['ExternalSignalBrokerWorkerClaim', 'EntryExposureClaim', 'EntryExposureClaimEvent', 'OrderIntent', 'Signal', 'ExternalSignalEntryExecutionObligation', 'ExternalSignalTradeCycleAccount', 'ExternalSignalTradeCycle', 'ExternalSignalEntryExecutionAuthorization', 'TrackedPosition'];
  // Row-for-row hash of every row that exists BEFORE the migration (id <= the pre-migration maximum), excluding the one column the migration adds.
  const maxIds: Record<string, number> = {};
  for (const t of tables) maxIds[t] = (await db.query(`SELECT coalesce(max(id),0)::int m FROM "${t}"`)).rows[0].m;
  const hashes = async () => { const out: Record<string, string> = {}; for (const t of tables) out[t] = (await db.query(`SELECT coalesce(md5(string_agg((to_jsonb(x) - 'receivedAt')::text, ',' ORDER BY id)), 'empty') AS h FROM "${t}" x WHERE id <= ${maxIds[t]}`)).rows[0].h; return out; };
  const before = await hashes();
  const signalsBefore = (await db.query(`SELECT count(*)::int n, min("createdAt") AS oldest FROM "Signal"`)).rows[0];

  // ---- U1: atomicity. The migration must wait for (or be refused by) an open writer and leave NOTHING behind when it fails.
  {
    const w = await mk(url);
    try {
      await w.query('BEGIN'); await w.query(`UPDATE "OrderIntent" SET "updatedAt"=now() WHERE id=$1`, [C.intentId]); // an open writer on a marked intent
      const impatient = overlay.replace("SET LOCAL lock_timeout = '15s';", "SET LOCAL lock_timeout = '300ms';");
      const failed = await attempt(db, impatient);
      const leftovers = (await db.query(`SELECT to_regclass('public."ExternalSignalDispatchFence"') AS fence, (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE '%dispatch_fence%' AND NOT tgisinternal) AS triggers, (SELECT count(*)::int FROM information_schema.columns WHERE table_name='Signal' AND column_name='receivedAt') AS col`)).rows[0];
      check(S, 'U1 with a writer holding a marked intent open, the migration fails on lock_timeout (55P03) and leaves no table, trigger or column behind', !failed.ok && failed.code === '55P03' && leftovers.fence === null && leftovers.triggers === 0 && leftovers.col === 0, { error: failed.message, leftovers });
    } finally { await w.query('ROLLBACK').catch(() => undefined); await w.end(); }
  }

  // ---- U2: concurrency. The migration holds SHARE ROW EXCLUSIVE on the fenced tables from its first statement to COMMIT. A writer that
  //          starts after the lock blocks and then proceeds AFTER commit, when the triggers exist. fx.admit (a marked intent created through the
  //          production inserts) is started while the migration transaction is open.
  let concurrentAdmit: Promise<any> | undefined; let blockedBehindMigration = false;
  {
    const m = await mk(url);
    try {
      const head = overlay.slice(0, overlay.indexOf('-- A. Dispatch fence'));
      const rest = overlay.slice(overlay.indexOf('-- A. Dispatch fence'));
      await m.query('BEGIN'); await m.query(head);                                           // sections 0: locks + preconditions, transaction stays open
      let admitted = false; concurrentAdmit = fx.admit('hist-concurrent-with-migration').then((g: any) => { admitted = true; return g; });
      // admit's first statement is on the db connection; wait until it is blocked behind the migration's table locks
      for (let i = 0; i < 500 && !admitted; i += 1) { const r = await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`, [pidOf(db)]); if (r.rows[0].n) { blockedBehindMigration = true; break; } await sleep(10); }
      await m.query(rest); await m.query('COMMIT');                                          // the rest of the migration, then commit
    } catch (e) { await m.query('ROLLBACK').catch(() => undefined); throw e; } finally { await m.end(); }
  }
  const concurrentGraph = await concurrentAdmit!;
  check(S, 'U2 a marked-intent writer started while the migration transaction was open BLOCKED behind its table locks and completed after COMMIT with a fence from the creation trigger (created at 1; admission own claim insert then advanced it)', blockedBehindMigration && (await db.query('SELECT version::int v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [concurrentGraph.intentId])).rows[0]?.v >= 2, { blockedBehindMigration, concurrentFence: (await db.query('SELECT version::int v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [concurrentGraph.intentId])).rows[0] });

  // ---- U3: the backfill result.
  {
    const fences = (await db.query(`SELECT f."orderIntentId", f.version::int v FROM "ExternalSignalDispatchFence" f ORDER BY 1`)).rows;
    const missing = (await db.query(`SELECT count(*)::int n FROM "OrderIntent" i WHERE i."externalSignalAccountCycleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ExternalSignalDispatchFence" f WHERE f."orderIntentId"=i.id)`)).rows[0].n;
    const extra = (await db.query(`SELECT count(*)::int n FROM "ExternalSignalDispatchFence" f JOIN "OrderIntent" i ON i.id=f."orderIntentId" WHERE i."externalSignalAccountCycleId" IS NULL`)).rows[0].n;
    const byId = new Map(fences.map((r: any) => [r.orderIntentId, r.v]));
    check(S, 'U3 every existing marked intent (all six historical states) has a fence at version 1; the unmarked intent has none; there are no extra fences and no marked intent is left without one', markedIds.every(id => byId.get(id) === 1) && !byId.has(unmarked) && missing === 0 && extra === 0, { fenceCount: fences.length, markedWithoutFence: missing, fencesForUnmarked: extra, historical: markedIds.map(id => `${names[id]}=${byId.get(id)}`) });
  }

  // ---- U4: nothing that existed was changed; no receipt was manufactured.
  {
    const after = await hashes();
    const changed = tables.filter(t => before[t] !== after[t]);
    const receipts = (await db.query(`SELECT count(*) FILTER (WHERE "receivedAt" IS NULL)::int AS null_receipts, count(*) FILTER (WHERE "receivedAt" IS NOT NULL)::int AS stamped, count(*)::int AS total FROM "Signal"`)).rows[0];
    const histSignals = (await db.query(`SELECT count(*)::int n, count(*) FILTER (WHERE s."receivedAt" IS NULL)::int AS nulls, count(*) FILTER (WHERE external_signal_signal_receipt_open(s.id))::int AS open FROM "Signal" s JOIN "ExternalSignalEntryExecutionObligation" o ON o."entrySignalId"=s.id WHERE o."orderIntentId" = ANY($1)`, [markedIds])).rows[0];
    check(S, 'U4a every row that existed before the migration is byte-identical afterwards in all ten tables (worker claims, claims, claim events, intents, signals, obligations, account cycles, cycles, authorizations, positions)', changed.length === 0, { tablesChecked: tables.length, changed, rowsHashed: maxIds });
    check(S, 'U4b no historical signal received a receipt (receivedAt stays NULL, the receipt functions report not-open) while the signal created by the concurrent post-migration writer has one', histSignals.n === 6 && histSignals.nulls === 6 && histSignals.open === 0 && receipts.stamped === 1 && receipts.total === signalsBefore.n + 1, { historical: histSignals, receipts, signalsBefore });
  }

  // ---- U5: C2 recovery still works on a historical ENTRY_SUBMITTING graph once the fence and bump triggers exist.
  {
    const v0 = (await db.query('SELECT version::int v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [C.intentId])).rows[0].v as number;
    const steps = [await attempt(db, notSentSql, [C.intentId, cWorker]), await attempt(db, blockSql, [C.intentId]), await attempt(db, releaseSql, [C.intentId])];
    const row = (await db.query(`SELECT i.status AS intent, c.status AS claim, c."releasedAt" IS NOT NULL AS released, (SELECT version::int FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=i.id) AS fence FROM "OrderIntent" i JOIN "EntryExposureClaim" c ON c."orderIntentId"=i.id WHERE i.id=$1`, [C.intentId])).rows[0];
    check(S, 'U5 C2 pre-dispatch recovery of a historical ENTRY_SUBMITTING graph (evidence, block, release) works after the upgrade; the fence only increases', steps.every(s => s.ok) && row.intent === 'blocked' && row.released === true && row.fence > v0, { steps: steps.map(s => s.ok || s.message), row, fenceBefore: v0 });
  }

  // ---- U6: a historical graph can never obtain a final authorization (no receipt) even with a valid decision, fence version and pair.
  {
    const miSide = await makeMarketIntelligence({ db, paperId, ownerId, strategyId });
    const dec = await miSide.decided({ intentId: D.intentId, clientOrderId: D.clientOrderId });
    const f = await mk(url);
    let outcome = 'unknown';
    try {
      await f.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const v = (await f.query('SELECT version::int v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [D.intentId])).rows[0].v;
      const miId = (await f.query(`INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,$3,'{}') RETURNING id`, [dec.decisionId, D.intentId, D.clientOrderId])).rows[0].id;
      const dsv = (await db.query('SELECT version FROM "ExternalSignalBrokerDispatchState" WHERE id=1')).rows[0].version;
      outcome = await f.query(`INSERT INTO "ExternalSignalBrokerDispatchConsumption" ("orderIntentId","executionObligationId","workerClaimId","marketPolicyDispatchConsumptionId","rolloutGenerationId","executionAuthorizationId","dispatchStateVersion","clientOrderId","fenceVersion","evidenceJson")
        SELECT $1,$2,$3,$4,o."rolloutGenerationId",o."authorizationId",$5,$6,$7,'{}' FROM "ExternalSignalEntryExecutionObligation" o WHERE o.id=$2`, [D.intentId, D.obligationId, dWorker, miId, dsv, D.clientOrderId, v]).then(() => 'INSERTED', (e: any) => String(e.message).slice(0, 100));
    } finally { await f.query('ROLLBACK').catch(() => undefined); await f.end(); }
    check(S, 'U6 a historical ENTRY_SUBMITTING graph with a valid decision and the current fence version is refused final authorization: its signal has no receipt', outcome !== 'INSERTED' && /ENTRY_SIGNAL_EXPIRED/.test(outcome), { outcome });
  }

  // ---- U7: release/evidence states survive: the historical BLOCKED (held) graph can still be released; the already-released graph is untouched.
  {
    const e = await attempt(db, releaseSql, [E.intentId]);
    const rows = (await db.query(`SELECT i.id, i.status, c.status AS claim FROM "OrderIntent" i JOIN "EntryExposureClaim" c ON c."orderIntentId"=i.id WHERE i.id = ANY($1) ORDER BY i.id`, [[E.intentId, F.intentId]])).rows;
    check(S, 'U7 the historical BLOCKED graph (evidence recorded, claim held) releases after the upgrade; the historical released graph stays released', e.ok && rows.every((r: any) => r.status === 'blocked' && r.claim === 'RELEASED'), { release: e.ok || e.message, rows });
  }

  // ---- U8: a second application of the migration is refused by its own precondition (re-run safety).
  {
    const again = await attempt(db, overlay);
    check(S, 'U8 applying the migration body a second time fails on its precondition and changes nothing', !again.ok && /fence table already exists|already exists/.test(again.message ?? ''), again.message);
  }

  // ---- U9: after the upgrade a new marked intent receives its fence and its signal a receipt.
  {
    const g = await fx.admit('post-upgrade');
    const r = (await db.query(`SELECT (SELECT version::int FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1) AS fence, (SELECT s."receivedAt" IS NOT NULL FROM "Signal" s JOIN "ExternalSignalEntryExecutionObligation" o ON o."entrySignalId"=s.id WHERE o."orderIntentId"=$1) AS receipt`, [g.intentId])).rows[0];
    check(S, 'U9 a marked intent created after the migration gets a fence (created at 1; admission own claim insert advanced it) and its entry signal a database receipt', r.fence >= 2 && r.receipt === true, r);
  }
} finally {
  const { prisma } = await import('../../src/db/prisma.js').catch(() => ({ prisma: undefined as undefined | { $disconnect(): Promise<void> } }));
  await prisma?.$disconnect().catch(() => undefined);
  await db.end().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
console.log(JSON.stringify(results, null, 2));
if (failures.length) { console.error(`FAILED CHECKS: ${failures.join(', ')}`); process.exitCode = 1; }
