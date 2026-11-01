// Real-schema design probes for docs/architecture/tradingview-c3b2-final-dispatch-transaction.md (revision 4).
// DISPOSABLE SERVERS ONLY. It creates and drops a scratch database, replays every repository migration into it, applies
// scripts/design-probes/c3b2-r4-overlay.sql (the PROPOSED fence and receipt objects, not a migration), and builds real
// TradingView/Market Intelligence graphs with the repository's production services. It never touches an application
// database and never contacts a broker (global fetch is replaced by a spy that fails the run if a request is attempted).
//   PROBE_BASE_URL=postgresql://postgres:pw@localhost:55416 npx tsx scripts/design-probes/c3b2-r4-real-schema-probes.ts
//   PROBE_ONLY=fence,receipt,locks,compat   (optional section filter)
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

const { Client } = pg;
const base = process.env.PROBE_BASE_URL;
if (!base || !['', '/'].includes(new URL(base).pathname)) { console.error('Set PROBE_BASE_URL to a throwaway server URL without a database path.'); process.exit(64); }
const only = new Set((process.env.PROBE_ONLY ?? 'fence,receipt,locks,compat').split(','));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const brokerRequests: string[] = [];
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => { brokerRequests.push(`${init?.method ?? 'GET'} ${String(input)}`); throw new Error('design probes forbid network access'); }) as typeof fetch;

type Outcome = { ok: boolean; code?: string; message?: string; rows?: any[] };
const results: Record<string, unknown> = {};
const failures: string[] = [];
function check(section: string, name: string, condition: boolean, detail?: unknown) {
  const bucket = (results[section] ??= {}) as Record<string, unknown>;
  bucket[name] = { pass: condition, ...(detail === undefined ? {} : { detail }) };
  if (!condition) failures.push(`${section}.${name}`);
}
const mk = async (url: string) => { const c = new Client({ connectionString: url }); await c.connect(); return c; };
const attempt = async (c: pg.Client, sql: string, params: unknown[] = []): Promise<Outcome> => {
  try { const r = await c.query(sql, params); return { ok: true, rows: r.rows }; } catch (e: any) { return { ok: false, code: e.code, message: String(e.message).slice(0, 140) }; }
};
const pidOf = (c: pg.Client) => (c as unknown as { processID: number }).processID;

const admin = await mk(`${base}/postgres`);
const database = `r4_${Date.now()}`;
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
  // ---------------------------------------------------------------------------------------------------------------
  // Real schema: every repository migration, in order; then the proposed overlay.
  // ---------------------------------------------------------------------------------------------------------------
  const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  for (const name of migrations) await db.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
  results.migrations = migrations.length;
  await db.query('CREATE EXTENSION IF NOT EXISTS pgrowlocks');
  const rowlocksAvailable = true;
  await db.query(await readFile('scripts/design-probes/c3b2-r4-overlay.sql', 'utf8'));

  process.env.DATABASE_URL = `${url}?application_name=r4-prisma`;
  const { createTradingViewGraphFixture } = await import('../../src/db/__tests__/tradingview-graph.fixture.js');
    const fx = await createTradingViewGraphFixture(db);
  const { paperId, ownerId } = fx;

  type Graph = Awaited<ReturnType<typeof fx.admit>> & { workerClaimId: number; symbol: string };
  const dispatchStateVersion = async () => (await db.query('SELECT version FROM "ExternalSignalBrokerDispatchState" WHERE id=1')).rows[0].version as number;
  const fenceOf = async (c: pg.Client, intentId: number) => { const r = await c.query('SELECT version::int AS v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [intentId]); return r.rows[0]?.v as number | undefined; };
  let labelSeq = 0;
  async function admitted(): Promise<Omit<Graph, 'workerClaimId'>> {
    const g = await fx.admit(`r4-${(labelSeq += 1)}`);
    const symbol = (await db.query('SELECT symbol FROM "OrderIntent" WHERE id=$1', [g.intentId])).rows[0].symbol as string;
    return { ...g, symbol };
  }
  async function claimed(): Promise<Graph> {
    const g = await admitted();
    const workerClaimId = await fx.workerClaim(g);
    return { ...g, workerClaimId };
  }
  // A real Market Intelligence authorization (policy, enrollment and grant through the production services) is attached to
  // the graph's assignment AFTER admission, with the runtime rollout left inactive so intent creation needs no obligation.
  // The ALLOWED decision row itself is seeded with triggers off (the repository's own C3A seeds do the same); every
  // consumption, fence and release below then runs with all production triggers enabled. Seeding the decision with no
  // obligation also confirms the section 1.1 finding: the database does not require an MI obligation on a marked intent.
  const policy = await import('../../src/services/strategy-market-policy.service.js');
  const enrollment = await import('../../src/services/assignment-market-policy-enrollment.service.js');
  const enforcement = await import('../../src/services/assignment-market-policy-enforcement-authorization.service.js');
  const strategyId = (await db.query(`SELECT id FROM "Strategy" WHERE key='tv-graph'`)).rows[0].id as number;
  const created = await policy.createStrategyMarketPolicy(strategyId, ownerId, 'R4 probe policy');
  const draft = created.revisions[0]!;
  const saved = await policy.saveStrategyMarketPolicyRevision(strategyId, draft.id, {
    expectedConfigurationFingerprint: draft.configurationFingerprint,
    rules: draft.dimensionRules.map((rule: any) => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })),
  }, ownerId);
  await policy.activateStrategyMarketPolicyRevision(strategyId, saved.id, saved.configurationFingerprint, ownerId);
  async function grantMarketIntelligence(assignmentId: number) {
    const prepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(paperId, assignmentId, ownerId);
    const generation = await enrollment.activateAssignmentMarketPolicyEnrollment(paperId, assignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
    const auth = await enforcement.grantAssignmentMarketPolicyEnforcementAuthorization(paperId, assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'R4 probe' }, ownerId);
    return { generation, authorizationId: (auth as any).id as number };
  }
  const mi = {
    enroll: async (assignmentId: number) => {
      const prepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(paperId, assignmentId, ownerId);
      return enrollment.activateAssignmentMarketPolicyEnrollment(paperId, assignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
    },
    grant: (assignmentId: number, generation: any) => enforcement.grantAssignmentMarketPolicyEnforcementAuthorization(paperId, assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'R4 lock probe' }, ownerId),
    revoke: (assignmentId: number, authorizationId: number) => enforcement.revokeAssignmentMarketPolicyEnforcementAuthorization(paperId, assignmentId, { authorizationId, reason: 'R4 lock probe' }, ownerId),
  };
  const assignmentOf = async (intentId: number) => (await db.query(`SELECT "tradingAccountSubscriptionId" AS id FROM "OrderIntent" WHERE id=$1`, [intentId])).rows[0].id as number;
  async function decided(g: Graph) {
    const assignmentId = await assignmentOf(g.intentId);
    const { generation, authorizationId } = await grantMarketIntelligence(assignmentId);
    const a = (await db.query(`SELECT "authorizationFingerprint" AS fp, "policyRevisionId" AS rev, "enrollmentGenerationId" AS gen, "securityId", "securitySymbol", "strategyId", "subscriptionId" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [authorizationId])).rows[0];
    const rollout = (await db.query(`SELECT enabled, version FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id=1`)).rows[0];
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL session_replication_role='replica'`);
      const id = (await db.query(`INSERT INTO "MarketPolicyBrokerDispatchDecision" ("decisionKey","decisionVersion",authority,"orderIntentId","dispatchSequence","clientOrderId",environment,"tradingAccountId","accountSubscriptionId","subscriptionId","securityId","securitySymbol","strategyId","policyRevisionId","enrollmentGenerationId","authorizationId","authorizationFingerprint","rolloutEnabled","rolloutVersion","evaluatedAt","validUntil","dispatchExpiresAt","evaluatorVersion","marketRegimeAssessmentId","compositionVersion","compositionSourceSetFingerprint","compositionEvidenceHealth","obligationId","authorityVersion",outcome,"reasonCode","dispatchDisposition","evidenceJson","createdAt")
        VALUES ($1,'MARKET_POLICY_BROKER_TIME_ENFORCEMENT_V1','AUTHORITATIVE',$2,1,$3,'PAPER',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,clock_timestamp(),clock_timestamp() + interval '900 seconds',clock_timestamp() + interval '600 seconds','STRATEGY_MARKET_ELIGIBILITY_V1',1,'MARKET_REGIME_COMPOSITION_V1',repeat('c',64),'COMPLETE',1,'PAPER_MARKET_POLICY_ENFORCEMENT_V2','ALLOWED','R4_PROBE_ALLOWED','DISPATCH_AUTHORIZED','{}',clock_timestamp()) RETURNING id`,
        [`r4-${g.intentId}-${Date.now()}`, g.intentId, g.clientOrderId, paperId, assignmentId, a.subscriptionId, a.securityId, a.securitySymbol, a.strategyId, a.rev, a.gen, authorizationId, a.fp, rollout.enabled, rollout.version])).rows[0].id as number;
      await db.query('COMMIT');
      void generation;
      return { decisionId: id };
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }
  const miInsert = (c: pg.Client, g: Graph, decisionId: number) => c.query(
    `INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,$3,'{}') RETURNING id`, [decisionId, g.intentId, g.clientOrderId]).then(r => r.rows[0].id as number);
  const tvInsert = async (c: pg.Client, g: Graph, miId: number, fenceVersion: number | null) => c.query(
    `INSERT INTO "ExternalSignalBrokerDispatchConsumption" ("orderIntentId","executionObligationId","workerClaimId","marketPolicyDispatchConsumptionId","rolloutGenerationId","executionAuthorizationId","dispatchStateVersion","clientOrderId","fenceVersion","evidenceJson")
     SELECT $1,$2,$3,$4,o."rolloutGenerationId",o."authorizationId",$5,$6,$7,'{}' FROM "ExternalSignalEntryExecutionObligation" o WHERE o.id=$2`,
    [g.intentId, g.obligationId, g.workerClaimId, miId, await dispatchStateVersion(), g.clientOrderId, fenceVersion]);
  const pairCount = async (g: Graph) => (await db.query(`SELECT (SELECT count(*)::int FROM "MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1) AS mi, (SELECT count(*)::int FROM "ExternalSignalBrokerDispatchConsumption" WHERE "orderIntentId"=$1) AS tv`, [g.intentId])).rows[0] as { mi: number; tv: number };

  const smoke = await claimed();
  const smokeDecision = await decided(smoke);
  check('setup', 'real graph, worker claim and MI decision build on the migrated schema', Boolean(smokeDecision.decisionId), { prepared: smokeDecision, fenceAfterSetup: await fenceOf(db, smoke.intentId) });

  const guarded = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (error: any) {
      failures.push(`${name}: section aborted`);
      results[`${name}_aborted`] = { message: String(error?.message ?? error).slice(0, 300), stack: String(error?.stack ?? '').split(String.fromCharCode(10)).slice(0, 4).join(' | ') };
    }
  };
  if (only.has('fence')) await guarded('fence', async () => (await import('./c3b2-r4-fence-section.js')).run({ db, admin, url, version, mk, attempt, pidOf, untilBlocked, sleep, check, results, fx, admitted, claimed, decided, miInsert, tvInsert, pairCount, fenceOf, paperId, ownerId, dispatchStateVersion }));
  if (only.has('receipt')) await guarded('receipt', async () => (await import('./c3b2-r4-receipt-section.js')).run({ db, admin, check, attempt, mk, url, results, claimed, admitted }));
  if (only.has('compat')) await guarded('compat', async () => (await import('./c3b2-r4-compat-section.js')).run({ db, check, attempt, results, claimed, admitted, fenceOf, paperId, ownerId }));
  if (only.has('locks')) await guarded('locks', async () => (await import('./c3b2-r4-locks-section.js')).run({ db, admin, url, mk, attempt, pidOf, untilBlocked, sleep, check, results, fx, admitted, claimed, decided, miInsert, tvInsert, fenceOf, paperId, ownerId, dispatchStateVersion, mi, assignmentOf }));

  check('network', 'no broker request was attempted', brokerRequests.length === 0, brokerRequests);
  void rowlocksAvailable;
} finally {
  const { prisma } = await import('../../src/db/prisma.js').catch(() => ({ prisma: undefined as undefined | { $disconnect(): Promise<void> } }));
  await prisma?.$disconnect().catch(() => undefined);
  await db.end().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
console.log(JSON.stringify(results, null, 2));
if (failures.length) { console.error(`FAILED CHECKS: ${failures.join(', ')}`); process.exitCode = 1; }
