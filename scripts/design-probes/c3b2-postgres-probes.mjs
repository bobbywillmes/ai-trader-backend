// Primitive design probes for docs/architecture/tradingview-c3b2-final-dispatch-transaction.md (section 10.1).
// Revision 4 adds real-schema probes: c3b2-r4-real-schema-probes.ts (section 10.2).
// DISPOSABLE SERVERS ONLY. It creates and drops a scratch database, needs a superuser-capable URL to a throwaway
// PostgreSQL server, touches no application schema and makes no broker call.
//   PROBE_BASE_URL=postgresql://postgres:pw@localhost:55416 node scripts/design-probes/c3b2-postgres-probes.mjs
import pg from 'pg';
const { Client } = pg;
const base = process.env.PROBE_BASE_URL;
if (!base || /\/[^/]+$/.test(new URL(base).pathname) && new URL(base).pathname !== '/') { console.error('Set PROBE_BASE_URL to a server URL without a database path.'); process.exit(64); }
const out = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mk = async db => { const c = new Client({ connectionString: `${base}/${db}` }); await c.connect(); return c; };
const admin = await mk('postgres');
const db = `probe_${Date.now()}`;
await admin.query(`CREATE DATABASE ${db}`);
const setup = await mk(db);
out.version = (await setup.query('SHOW server_version')).rows[0].server_version;
out.trackCommitTimestamp = (await setup.query('SHOW track_commit_timestamp')).rows[0].track_commit_timestamp;
await setup.query(`
CREATE TABLE claim(id int primary key, status text);
CREATE TABLE ev(id serial primary key, claim_id int);
CREATE TABLE fence(claim_id int primary key, version bigint);
CREATE TABLE res(id serial primary key, consumption_id int unique, kind text);
CREATE TABLE trig_log(at timestamptz, note text);
INSERT INTO claim VALUES (1,'ENTRY_SUBMITTING'); INSERT INTO fence VALUES (1,1);`);

// P1: lock-only competitor is invisible to a SERIALIZABLE row touch; xmin fence passes; the fence counter detects it.
{
  const a = await mk(db), b = await mk(db);
  await a.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  const before = (await a.query('SELECT count(*)::int n FROM ev WHERE claim_id=1')).rows[0].n;
  await b.query('BEGIN'); await b.query('SELECT * FROM claim WHERE id=1 FOR UPDATE'); await b.query('INSERT INTO ev(claim_id) VALUES (1)'); await b.query('COMMIT');
  let touch = 'ok';
  try { await a.query(`UPDATE claim SET status=status WHERE id=1`); } catch (e) { touch = e.code; }
  const after = touch === 'ok' ? (await a.query('SELECT count(*)::int n FROM ev WHERE claim_id=1')).rows[0].n : null;
  const xminMatches = touch === 'ok' ? (await a.query(`SELECT xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text AS m FROM claim WHERE id=1`)).rows[0].m : null;
  out.p1_lockOnlyCompetitor = { eventsSeenBeforeTouch: before, touchOutcome: touch, eventsSeenAfterTouch: after, xminEqualsCurrentXid: xminMatches };
  await a.query('ROLLBACK').catch(() => {});
  // fence counter variant
  await a.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); await a.query('SELECT count(*) FROM ev');
  await b.query('BEGIN'); await b.query('SELECT * FROM claim WHERE id=1 FOR UPDATE'); await b.query('INSERT INTO ev(claim_id) VALUES (1)'); await b.query('UPDATE fence SET version=version+1 WHERE claim_id=1'); await b.query('COMMIT');
  let fenceOutcome = 'ok'; try { await a.query('SELECT version FROM fence WHERE claim_id=1 FOR UPDATE'); } catch (e) { fenceOutcome = e.code; }
  out.p1_fenceCounter = { lockFenceAfterCompetitorCommit: fenceOutcome };
  await a.query('ROLLBACK').catch(() => {});
  // fence counter variant under a stale snapshot where the competitor did NOT write the fence (negative control for the counter)
  await a.end(); await b.end();
}

// P1b: xmin inside a subtransaction (plpgsql EXCEPTION block) differs from the top-level xid.
{
  await setup.query(`CREATE FUNCTION touch_in_subxact() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN BEGIN UPDATE claim SET status=status WHERE id=1; EXCEPTION WHEN others THEN RAISE; END; RETURN (SELECT xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text FROM claim WHERE id=1); END $$`);
  await setup.query('BEGIN'); const r = (await setup.query('SELECT touch_in_subxact() AS m')).rows[0].m; await setup.query('ROLLBACK');
  out.p1b_xminAfterSubtransactionTouchEqualsTopLevelXid = r;
}

// P2: unique index insert serializes a send permit against an expiry terminalization, in both commit orders.
{
  const p = await mk(db), e = await mk(db);
  await p.query('BEGIN'); await p.query(`INSERT INTO res(consumption_id,kind) VALUES (7,'SEND_PERMIT')`);
  await e.query('BEGIN');
  let eRes = 'pending'; const ep = e.query(`INSERT INTO res(consumption_id,kind) VALUES (7,'EXPIRED_NEVER_SENT')`).then(() => { eRes = 'inserted'; }, err => { eRes = err.code; });
  await sleep(700); const blockedWhilePermitOpen = eRes === 'pending';
  await p.query('COMMIT'); await ep;
  out.p2_permitFirst = { expiryBlockedUntilPermitResolved: blockedWhilePermitOpen, expiryOutcomeAfterPermitCommit: eRes };
  await e.query('ROLLBACK').catch(() => {});
  // expiry first, permit rolls back? then permit blocked until expiry commits
  await p.query('BEGIN'); await p.query(`INSERT INTO res(consumption_id,kind) VALUES (8,'EXPIRED_NEVER_SENT')`);
  await e.query('BEGIN'); let pRes = 'pending'; const pp = e.query(`INSERT INTO res(consumption_id,kind) VALUES (8,'SEND_PERMIT')`).then(() => { pRes = 'inserted'; }, err => { pRes = err.code; });
  await sleep(700); const blocked2 = pRes === 'pending'; await p.query('COMMIT'); await pp;
  out.p2_expiryFirst = { permitBlockedUntilExpiryResolved: blocked2, permitOutcomeAfterExpiryCommit: pRes };
  // abort path: permit rolls back, expiry then succeeds
  await e.query('ROLLBACK').catch(() => {});
  await p.query('BEGIN'); await p.query(`INSERT INTO res(consumption_id,kind) VALUES (9,'SEND_PERMIT')`);
  await e.query('BEGIN'); let aRes = 'pending'; const ap = e.query(`INSERT INTO res(consumption_id,kind) VALUES (9,'EXPIRED_NEVER_SENT')`).then(() => { aRes = 'inserted'; }, err => { aRes = err.code; });
  await sleep(500); await p.query('ROLLBACK'); await ap; await e.query('COMMIT');
  out.p2_permitRollsBack = { expiryOutcome: aRes };
  await p.end(); await e.end();
}

// P3: a deferrable constraint trigger is not a commit-time guarantee.
{
  await setup.query(`
  CREATE TABLE cons(id serial primary key);
  CREATE FUNCTION log_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO trig_log VALUES (clock_timestamp(), 'deferred check ran'); RETURN NULL; END $$;
  CREATE CONSTRAINT TRIGGER cons_fresh AFTER INSERT ON cons DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION log_check();
  CREATE TABLE lockme(id int);`);
  const t = await mk(db), h = await mk(db);
  await h.query('BEGIN'); await h.query('LOCK TABLE lockme IN ACCESS EXCLUSIVE MODE');
  await t.query('BEGIN'); await t.query('SET CONSTRAINTS ALL IMMEDIATE'); const start = Date.now();
  await t.query('INSERT INTO cons DEFAULT VALUES');
  const ranAtInsert = Date.now() - start;
  const waiting = t.query('LOCK TABLE lockme IN ACCESS SHARE MODE');
  await sleep(1500); await h.query('COMMIT'); await waiting; await t.query('COMMIT');
  const total = Date.now() - start;
  out.p3_setConstraintsAllImmediate = { checkRanDuringInsertMs: ranAtInsert, commitReachedMsAfterInsertStart: total, checkRowsLogged: (await setup.query('SELECT count(*)::int n FROM trig_log')).rows[0].n };
  let ts; try { ts = (await setup.query(`SELECT pg_xact_commit_timestamp(xmin) FROM cons LIMIT 1`)).rows[0]; } catch (e) { ts = `error: ${e.message}`; }
  out.p3_commitTimestamp = ts;
  await t.end(); await h.end();
}

await setup.end();
await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
await admin.end();
console.log(JSON.stringify(out, null, 2));
