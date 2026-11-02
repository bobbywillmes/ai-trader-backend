// Real-schema design probes for docs/architecture/tradingview-c3b2-final-dispatch-transaction.md (revision 5).
// DISPOSABLE SERVERS ONLY. It creates and drops a scratch database, replays every repository migration into it, applies
// scripts/design-probes/c3b2-r5-overlay.sql (the PROPOSED C3B.2 migration body, not a migration) and builds real TradingView and
// Market Intelligence graphs with the repository's production services. It never touches an application database and never contacts
// a broker (global fetch is replaced by a spy that fails the run if a request is attempted).
//   PROBE_BASE_URL=postgresql://postgres:pw@localhost:55416 npx tsx scripts/design-probes/c3b2-r5-real-schema-probes.ts
//   PROBE_ONLY=fence,receipt,compat,consumption,scope,epoch,order,integrity   (optional section filter)
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { attempt, canonicalLocks, makeMarketIntelligence, pidOf, sleep } from './c3b2-r5-common.js';

const { Client } = pg;
const base = process.env.PROBE_BASE_URL;
if (!base || !['', '/'].includes(new URL(base).pathname)) { console.error('Set PROBE_BASE_URL to a throwaway server URL without a database path.'); process.exit(64); }
const only = new Set((process.env.PROBE_ONLY ?? 'fence,receipt,compat,consumption,scope,epoch,order,integrity').split(','));

const brokerRequests: string[] = [];
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => { brokerRequests.push(`${init?.method ?? 'GET'} ${String(input)}`); throw new Error('design probes forbid network access'); }) as typeof fetch;

const results: Record<string, unknown> = {};
const failures: string[] = [];
function check(section: string, name: string, condition: boolean, detail?: unknown) {
  const bucket = (results[section] ??= {}) as Record<string, unknown>;
  bucket[name] = { pass: condition, ...(detail === undefined ? {} : { detail }) };
  if (!condition) failures.push(`${section}.${name}`);
}
const mk = async (url: string) => { const c = new Client({ connectionString: url }); await c.connect(); return c; };

const admin = await mk(`${base}/postgres`);
const database = `r5_${Date.now()}`;
await admin.query(`CREATE DATABASE ${database}`);
const url = `${base}/${database}`;
const db = await mk(url);
const version = (await db.query('SHOW server_version')).rows[0].server_version as string;
results.server = version;

async function untilBlocked(pid: number, settled: () => boolean) {
  for (let i = 0; i < 600 && !settled(); i += 1) {
    if ((await admin.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked) return true;
    await sleep(10);
  }
  return false;
}

try {
  const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  for (const name of migrations) await db.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
  results.migrations = migrations.length;
  await db.query('CREATE EXTENSION IF NOT EXISTS pgrowlocks');
  // The security catalog BEFORE the overlay: it must equal the reviewed manifest (zero drift), so any later difference is the overlay's.
  process.env.DATABASE_URL = `${url}?application_name=r5-prisma`;
  const readiness = await import('../../src/services/database-security-readiness.service.js');
  const sqlRows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as any[];
  const catalogBefore = await readiness.readSecurityCatalog(sqlRows as any);
  const driftBefore = readiness.compareWithManifest(catalogBefore);
  (results as any).catalogBefore = { functions: Object.keys(catalogBefore.functions).length, triggers: Object.keys(catalogBefore.triggers).length, drift: { functionsChanged: driftBefore.functionsChanged.length, functionsMissing: driftBefore.functionsMissing.length, functionsUnreviewed: driftBefore.functionsUnreviewed.length, triggersChanged: driftBefore.triggersChanged.length, triggersMissing: driftBefore.triggersMissing.length, triggersUnreviewed: driftBefore.triggersUnreviewed.length } };

  await db.query(await readFile('scripts/design-probes/c3b2-r5-overlay.sql', 'utf8'));

  const { createTradingViewGraphFixture } = await import('../../src/db/__tests__/tradingview-graph.fixture.js');
  const fx = await createTradingViewGraphFixture(db);
  const { paperId, ownerId } = fx;
  const strategyId = (await db.query(`SELECT id FROM "Strategy" WHERE key='tv-graph'`)).rows[0].id as number;
  const miSide = await makeMarketIntelligence({ db, paperId, ownerId, strategyId });
  const { mi, assignmentOf } = miSide;
  const liveId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","tradingBlocked","createdAt","updatedAt") VALUES ($1,'R5 LIVE account','LIVE','ACTIVE',true,false,false,now(),now()) RETURNING id`, [ownerId])).rows[0].id as number;

  type Graph = Awaited<ReturnType<typeof fx.admit>> & { workerClaimId: number; symbol: string; securityId: number };
  const dispatchStateVersion = async () => (await db.query('SELECT version FROM "ExternalSignalBrokerDispatchState" WHERE id=1')).rows[0].version as number;
  const fenceOf = async (c: pg.Client, intentId: number) => { const r = await c.query('SELECT version::int AS v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [intentId]); return r.rows[0]?.v as number | undefined; };
  let labelSeq = 0;
  async function admitted() {
    const g = await fx.admit(`r5-${(labelSeq += 1)}`);
    const row = (await db.query('SELECT i.symbol, s.id AS "securityId" FROM "OrderIntent" i JOIN "Subscription" sub ON sub.id=i."subscriptionId" JOIN "Security" s ON s.id=sub."securityId" WHERE i.id=$1', [g.intentId])).rows[0];
    return { ...g, symbol: row.symbol as string, securityId: row.securityId as number };
  }
  async function claimed(): Promise<Graph> {
    const g = await admitted();
    const workerClaimId = await fx.workerClaim(g);
    return { ...g, workerClaimId };
  }
  const decided = (g: Graph, options?: Parameters<typeof miSide.decided>[1]) => miSide.decided(g, options);
  const lockRows = (c: pg.Client, g: Graph) => canonicalLocks(db, c, g, miSide.authorizationOf.get(g.intentId)!);
  const miInsert = (c: pg.Client, g: Graph, decisionId: number) => c.query(
    `INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,$3,'{}') RETURNING id`, [decisionId, g.intentId, g.clientOrderId]).then(r => r.rows[0].id as number);
  const tvInsert = async (c: pg.Client, g: Graph, miId: number, fenceVersion: number | null) => c.query(
    `INSERT INTO "ExternalSignalBrokerDispatchConsumption" ("orderIntentId","executionObligationId","workerClaimId","marketPolicyDispatchConsumptionId","rolloutGenerationId","executionAuthorizationId","dispatchStateVersion","clientOrderId","fenceVersion","evidenceJson")
     SELECT $1,$2,$3,$4,o."rolloutGenerationId",o."authorizationId",$5,$6,$7,'{}' FROM "ExternalSignalEntryExecutionObligation" o WHERE o.id=$2`,
    [g.intentId, g.obligationId, g.workerClaimId, miId, await dispatchStateVersion(), g.clientOrderId, fenceVersion]);
  const pairCount = async (g: Graph) => (await db.query(`SELECT (SELECT count(*)::int FROM "MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1) AS mi, (SELECT count(*)::int FROM "ExternalSignalBrokerDispatchConsumption" WHERE "orderIntentId"=$1) AS tv`, [g.intentId])).rows[0] as { mi: number; tv: number };

  const smoke = await claimed();
  const smokeDecision = await decided(smoke);
  check('setup', 'real graph, worker claim, MI authorization (production services) and seeded ALLOWED decision with its frozen obligation build on the migrated schema', Boolean(smokeDecision.decisionId) && smokeDecision.obligationId > 0, { prepared: smokeDecision, fenceAfterSetup: await fenceOf(db, smoke.intentId) });

  const guarded = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (error: any) {
      failures.push(`${name}: section aborted`);
      results[`${name}_aborted`] = { message: String(error?.message ?? error).slice(0, 300), stack: String(error?.stack ?? '').split(String.fromCharCode(10)).slice(0, 4).join(' | ') };
    }
  };
  const ctx = { db, admin, url, version, mk, attempt, pidOf, untilBlocked, sleep, check, results, fx, admitted, claimed, decided, miInsert, tvInsert, pairCount, fenceOf, paperId, ownerId, liveId, strategyId, dispatchStateVersion, mi, assignmentOf, lockRows, readiness, sqlRows, catalogBefore, base, migrations };
  if (only.has('fence')) await guarded('fence', async () => (await import('./c3b2-r5-fence-section.js')).run(ctx));
  if (only.has('receipt')) await guarded('receipt', async () => (await import('./c3b2-r4-receipt-section.js')).run({ db, admin, check, attempt, mk, url, results, claimed, admitted }));
  if (only.has('compat')) await guarded('compat', async () => (await import('./c3b2-r5-compat-section.js')).run(ctx));
  if (only.has('consumption')) await guarded('consumption', async () => (await import('./c3b2-r5-consumption-section.js')).run(ctx));
  if (only.has('scope')) await guarded('scope', async () => (await import('./c3b2-r5-scope-section.js')).run(ctx));
  if (only.has('epoch')) await guarded('epoch', async () => (await import('./c3b2-r5-epoch-section.js')).run(ctx));
  if (only.has('order')) await guarded('order', async () => (await import('./c3b2-r5-order-section.js')).run(ctx));
  if (only.has('integrity')) await guarded('integrity', async () => (await import('./c3b2-r5-integrity-section.js')).run(ctx));

  check('network', 'no broker request was attempted', brokerRequests.length === 0, brokerRequests);
} finally {
  const { prisma } = await import('../../src/db/prisma.js').catch(() => ({ prisma: undefined as undefined | { $disconnect(): Promise<void> } }));
  await prisma?.$disconnect().catch(() => undefined);
  await db.end().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
console.log(JSON.stringify(results, null, 2));
if (failures.length) { console.error(`FAILED CHECKS: ${failures.join(', ')}`); process.exitCode = 1; }
