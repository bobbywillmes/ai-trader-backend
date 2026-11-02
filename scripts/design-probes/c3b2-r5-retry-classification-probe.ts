// Retry-classification probe (revision 5, item 8). DISPOSABLE SERVERS ONLY. Captures the REAL error objects the production PrismaPg
// adapter (src/db/prisma.ts) produces for raw queries, model operations and interactive Serializable transactions, with real
// serialization failures, real deadlocks, trigger-raised SQLSTATEs and look-alike message text, and runs the shipped classifier
// (retryableConcurrencyFailure, external-signal-broker-worker.service.ts) over each. Output is the actual structure, so the document's
// examples are measured, not assumed.
//   PROBE_BASE_URL=postgresql://postgres:pw@localhost:55416 npx tsx scripts/design-probes/c3b2-r5-retry-classification-probe.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

const { Client } = pg;
const base = process.env.PROBE_BASE_URL;
if (!base || !['', '/'].includes(new URL(base).pathname)) { console.error('Set PROBE_BASE_URL to a throwaway server URL without a database path.'); process.exit(64); }
globalThis.fetch = (async () => { throw new Error('design probes forbid network access'); }) as typeof fetch;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const admin = new Client({ connectionString: `${base}/postgres` }); await admin.connect();
const database = `r5r_${Date.now()}`;
await admin.query(`CREATE DATABASE ${database}`);
const url = `${base}/${database}`;
const db = new Client({ connectionString: url }); await db.connect();
const out: Record<string, unknown> = { server: (await db.query('SHOW server_version')).rows[0].server_version };
const failures: string[] = [];
const rows: any[] = [];

try {
  const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  for (const name of migrations) await db.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
  await db.query(`CREATE FUNCTION r5_raise(code text, msg text) RETURNS int LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '%', msg USING ERRCODE = code; END $$`);
  await db.query(`CREATE FUNCTION r5_event_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.type = 'R5_T_40001' THEN RAISE EXCEPTION 'trigger says serialization' USING ERRCODE = '40001';
      ELSIF NEW.type = 'R5_T_40P01' THEN RAISE EXCEPTION 'trigger says deadlock' USING ERRCODE = '40P01';
      ELSIF NEW.type = 'R5_T_P0001_TEXT' THEN RAISE EXCEPTION 'could not serialize access due to concurrent update (SQLSTATE 40001) deadlock detected 40P01';
      END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER r5_event_t BEFORE INSERT ON "SystemEvent" FOR EACH ROW EXECUTE FUNCTION r5_event_trigger()`);
  process.env.DATABASE_URL = `${url}?application_name=r5r-prisma`;
  const { prisma } = await import('../../src/db/prisma.js');
  const { Prisma } = await import('@prisma/client');
  const { retryableConcurrencyFailure } = await import('../../src/services/external-signal-broker-worker.service.js');

  const plain = (v: unknown, depth = 0): unknown => {
    if (v == null || typeof v !== 'object') return typeof v === 'string' ? v.slice(0, 160) : v;
    if (depth >= 4) return '[depth]';
    if (Array.isArray(v)) return v.slice(0, 4).map(x => plain(x, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 14).map(([k, x]) => [k, plain(x, depth + 1)]));
  };
  const describe = (label: string, error: any, expectRetry: boolean) => {
    const row = {
      label, ctor: error?.constructor?.name, isPrismaKnown: error instanceof Prisma.PrismaClientKnownRequestError, prismaCode: error?.code, name: error?.name,
      meta: plain(error?.meta), cause: plain(error?.cause), messageHead: String(error?.message ?? '').split('\n').map((s: string) => s.trim()).filter(Boolean).slice(-2).join(' | ').slice(0, 220),
      classifiedRetryable: retryableConcurrencyFailure(error), expectedRetryable: expectRetry,
    };
    rows.push(row); if (row.classifiedRetryable !== expectRetry) failures.push(label);
    return row;
  };
  const capture = async (label: string, fn: () => Promise<unknown>, expectRetry: boolean) => { try { await fn(); describe(`${label} (UNEXPECTED SUCCESS)`, new Error('no error'), expectRetry); failures.push(`${label}: no error`); } catch (e) { return describe(label, e, expectRetry); } };

  // --- structured SQLSTATE raised by the server, through every Prisma API path
  await capture('raw $queryRaw, server raises 40001', () => prisma.$queryRaw`SELECT r5_raise('40001', 'raised serialization')`, true);
  await capture('raw $queryRaw, server raises 40P01', () => prisma.$queryRaw`SELECT r5_raise('40P01', 'raised deadlock')`, true);
  await capture('raw $executeRaw, server raises 40001', () => prisma.$executeRaw`SELECT r5_raise('40001', 'raised serialization')`, true);
  await capture('raw, application raise P0001 whose MESSAGE contains "40001" and "deadlock detected"', () => prisma.$queryRaw`SELECT r5_raise('P0001', 'could not serialize access (SQLSTATE 40001) deadlock detected 40P01')`, false);
  await capture('raw, unique violation 23505', async () => { await prisma.$executeRaw`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('dup@r5','SYSTEM_OWNER',true,now(),now())`; await prisma.$executeRaw`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('dup@r5','SYSTEM_OWNER',true,now(),now())`; }, false);
  await capture('raw, lock_timeout 55P03', async () => { await db.query('BEGIN'); await db.query(`LOCK TABLE "SystemEvent" IN ACCESS EXCLUSIVE MODE`); try { await prisma.$transaction(async tx => { await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`; await tx.$queryRaw`SELECT count(*) FROM "SystemEvent"`; }); } finally { await db.query('ROLLBACK'); } }, false);
  // --- trigger-raised, through the MODEL API and through raw INSERT
  const ev = (type: string) => ({ type, entityType: 'probe', entityId: '1', severity: 'INFO' as const, message: 'm', payloadJson: {} });
  await capture('model create, BEFORE INSERT trigger raises 40001', () => prisma.systemEvent.create({ data: ev('R5_T_40001') }), true);
  await capture('model create, BEFORE INSERT trigger raises 40P01', () => prisma.systemEvent.create({ data: ev('R5_T_40P01') }), true);
  await capture('model create, trigger raises P0001 with SQLSTATE text in the message only', () => prisma.systemEvent.create({ data: ev('R5_T_P0001_TEXT') }), false);
  await capture('raw INSERT, trigger raises 40001', () => prisma.$executeRaw`INSERT INTO "SystemEvent" (type,"entityType","entityId",severity,message,"payloadJson","createdAt") VALUES ('R5_T_40001','probe','1','INFO','m','{}',now())`, true);
  // --- inside an interactive Serializable transaction (the shape F uses)
  await capture('interactive Serializable tx, statement raises 40001', () => prisma.$transaction(async tx => { await tx.$queryRaw`SELECT r5_raise('40001', 'raised serialization')`; }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), true);
  await capture('interactive Serializable tx, trigger-raised 40001 through a model write', () => prisma.$transaction(async tx => { await tx.systemEvent.create({ data: ev('R5_T_40001') }); }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }), true);
  // --- real serialization failure (write skew) between two interactive Serializable transactions
  const skew = async (label: string) => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let arrived = 0;
    const one = (n: number) => prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT count(*)::int FROM "SystemEvent" WHERE type = ${`R5_SKEW_${label}`}`;
      arrived += 1; if (arrived === 2) release(); await gate;
      await tx.systemEvent.create({ data: ev(`R5_SKEW_${label}`) });
      await sleep(n * 30);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 });
    const settled = await Promise.allSettled([one(0), one(1)]);
    return settled.find(s => s.status === 'rejected') as PromiseRejectedResult | undefined;
  };
  const skewFailure = await skew('a');
  if (skewFailure) describe('REAL write-skew serialization failure (two interactive Serializable transactions)', skewFailure.reason, true); else failures.push('write skew produced no failure');
  // --- real deadlock between two interactive transactions
  {
    await db.query(`INSERT INTO "SystemEvent" (type,"entityType","entityId",severity,message,"payloadJson","createdAt") VALUES ('R5_DL_A','probe','1','INFO','a','{}',now()),('R5_DL_B','probe','1','INFO','b','{}',now())`);
    const ids = (await db.query(`SELECT id FROM "SystemEvent" WHERE type IN ('R5_DL_A','R5_DL_B') ORDER BY type`)).rows.map((r: any) => r.id as number);
    let arrived = 0; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const one = (first: number, second: number) => prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "SystemEvent" WHERE id = ${first} FOR UPDATE`;
      arrived += 1; if (arrived === 2) release(); await gate;
      await tx.$queryRaw`SELECT id FROM "SystemEvent" WHERE id = ${second} FOR UPDATE`;
    }, { timeout: 20000 });
    const settled = await Promise.allSettled([one(ids[0]!, ids[1]!), one(ids[1]!, ids[0]!)]);
    const failed = settled.find(s => s.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) describe('REAL deadlock 40P01 (two interactive transactions, READ COMMITTED)', failed.reason, true); else failures.push('deadlock produced no failure');
  }
  // --- connection termination (57P01) mid-transaction
  await capture('backend terminated mid-transaction (57P01)', async () => {
    await prisma.$transaction(async tx => { const pid = (await tx.$queryRaw<any[]>`SELECT pg_backend_pid() AS pid`)[0].pid; await admin.query('SELECT pg_terminate_backend($1)', [pid]); await sleep(100); await tx.$queryRaw`SELECT 1`; }, { timeout: 10000 });
  }, false);
  // --- look-alikes that must NEVER classify as retryable
  describe('plain Error whose message names 40001', new Error('ERROR: could not serialize access due to read/write dependencies among transactions (SQLSTATE 40001)'), false);
  { // Hermes\'s shape: a Prisma P2010 whose SQLSTATE appears only inside message text
    const real = rows.find(r => r.label.startsWith('raw, application raise P0001'));
    const synthetic = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `40001`. Message: `ERROR: could not serialize access`', { code: 'P2010', clientVersion: 'probe', meta: { modelName: undefined } as any });
    describe('P2010 constructed with SQLSTATE 40001 in its MESSAGE only (no structured field)', synthetic, false);
    void real;
  }
  { const synthetic = new Prisma.PrismaClientKnownRequestError('x', { code: 'P2010', clientVersion: 'probe', meta: { driverAdapterError: { cause: { originalMessage: 'ERROR: 40001 serialization' } } } as any }); describe('P2010 whose driverAdapterError.cause lacks originalCode (message text only)', synthetic, false); }
  { const lookalike = Object.assign(new Error('fake'), { code: '40001', name: 'DatabaseError' }); describe('constructed lookalike with code 40001 (not a pg DatabaseError)', lookalike, false); }

  out.examples = rows;
  out.summary = { cases: rows.length, retryable: rows.filter(r => r.classifiedRetryable).length, notRetryable: rows.filter(r => !r.classifiedRetryable).length, misclassified: failures };
} finally {
  const { prisma } = await import('../../src/db/prisma.js').catch(() => ({ prisma: undefined as undefined | { $disconnect(): Promise<void> } }));
  await prisma?.$disconnect().catch(() => undefined);
  await db.end().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
console.log(JSON.stringify(out, null, 2));
if (failures.length) { console.error(`MISCLASSIFIED: ${failures.join(' | ')}`); process.exitCode = 1; }
