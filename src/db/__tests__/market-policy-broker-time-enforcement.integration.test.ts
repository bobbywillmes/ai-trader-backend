import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposableDatabaseUrl, connectMaintenanceClient } from './disposable-postgres.js';

// Phase 3C.3 authoritative broker-time market-policy enforcement against real PostgreSQL. The real
// order worker drives submitOrderToBroker; Alpaca is stubbed only at the adapter boundary.
const PRE_INTENT_MIGRATION = '20261018150000_market_policy_pre_intent_enforcement';
const BROKER_TIME_MIGRATION = '20261018170000_market_policy_broker_time_enforcement';
const DISPATCH_RECOVERY_MIGRATION = '20261019120000_market_policy_dispatch_recovery';
const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

type BrokerOrder = { id: string; client_order_id: string; symbol: string; side: string; status: string; qty: string; filled_qty: string };

const harness = vi.hoisted(() => ({
  orders: new Map<string, BrokerOrder>(),
  lookupFailures: new Set<string>(),
  // An idempotency-GET failure shape per client order ID (AlpacaApiError 429/5xx, network TypeError).
  lookupErrors: new Map<string, () => Error>(),
  // One-shot transient database failure while verifying the executable claim, before any marker.
  executableClaimFailures: new Set<number>(),
  submitCalls: [] as Array<{ accountId: number; payload: { client_order_id: string; symbol: string } }>,
  submitError: null as null | (() => Promise<Error>),
  // An adapter-local guard failure before any network request (it never reaches submitCalls).
  adapterLocalError: null as null | (() => Promise<Error>),
  openBuys: new Map<string, BrokerOrder[]>(),
  openBuyFailures: new Set<string>(),
  positions: new Map<string, { symbol: string; side: string; qty: string }>(),
  onSubmit: null as null | (() => Promise<void>),
  beforeConsume: null as null | (() => Promise<void>),
  evaluatorMode: 'real' as 'real' | 'throw' | 'forge',
  admissionRiskBlocked: new Set<number>(),
  workerRiskBlocked: new Set<number>(),
}));

vi.mock('../../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderByClientOrderId: vi.fn(async (_accountId: number, clientOrderId: string) => {
    if (harness.lookupFailures.has(clientOrderId)) throw new Error('Alpaca client-order lookup unavailable');
    const lookupError = harness.lookupErrors.get(clientOrderId);
    if (lookupError) throw lookupError();
    return harness.orders.get(clientOrderId) ?? null;
  }),
  getAlpacaOrderById: vi.fn(async (_accountId: number, id: string) => [...harness.orders.values()].find(order => order.id === id) ?? null),
  getCompleteOpenAlpacaBuyOrders: vi.fn(async () => [...harness.openBuys.values()].flat()),
  getCompleteOpenAlpacaBuyOrdersForSymbol: vi.fn(async (_accountId: number, symbol: string) => {
    if (harness.openBuyFailures.has(symbol)) throw new Error('Alpaca open-order pagination did not advance.');
    return harness.openBuys.get(symbol) ?? [];
  }),
  getOpenAlpacaOrders: vi.fn(async () => []),
  submitAlpacaEntryOrder: vi.fn(async (accountId: number, payload: { client_order_id: string; symbol: string; qty?: string }) => {
    if (harness.adapterLocalError) throw await harness.adapterLocalError();
    harness.submitCalls.push({ accountId, payload });
    if (harness.onSubmit) await harness.onSubmit();
    if (harness.submitError) throw await harness.submitError();
    const order = { id: `alpaca-${harness.submitCalls.length}-${payload.client_order_id}`, client_order_id: payload.client_order_id, symbol: payload.symbol, side: 'buy', status: 'accepted', qty: payload.qty ?? '1', filled_qty: '0' };
    harness.orders.set(payload.client_order_id, order);
    return order;
  }),
  submitVerifiedAlpacaExitOrder: vi.fn(async () => { throw new Error('Exit submissions are outside these tests.'); }),
  cancelAlpacaOrder: vi.fn(), cancelAllAlpacaOrders: vi.fn(),
}));
vi.mock('../../services/entry-exposure-claim.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/entry-exposure-claim.service.js')>();
  return {
    ...actual,
    requireExecutableEntryExposureClaim: vi.fn(async (args: Parameters<typeof actual.requireExecutableEntryExposureClaim>[0]) => {
      if (harness.executableClaimFailures.delete(args.orderIntentId)) throw new Error('injected transient database failure: connection terminated unexpectedly');
      return actual.requireExecutableEntryExposureClaim(args);
    }),
  };
});
vi.mock('../../integrations/alpaca/positions.adapter.js', () => ({
  getAlpacaPositions: vi.fn(async () => [...harness.positions.values()]),
  getAlpacaPositionBySymbol: vi.fn(async (_accountId: number, symbol: string) => harness.positions.get(symbol) ?? null),
}));
// Compare-only telemetry is unavailable here; its loss must never change broker behavior. The capture
// call is also the natural seam between broker-time preparation and dispatch consumption.
vi.mock('../../services/order-intent-broker-opportunity.service.js', () => ({
  bestEffortCaptureOrderIntentBrokerPostOpportunity: vi.fn(async () => { if (harness.beforeConsume) await harness.beforeConsume(); return null; }),
  bestEffortAppendBrokerOpportunityEvent: vi.fn(async () => false),
  createBrokerObservationBudget: () => ({ startedAtMs: 0, deadlineAtMs: 250 }),
}));
vi.mock('../../services/risk-gate.service.js', () => ({
  evaluateOrderRisk: vi.fn(async (input: { tradingAccountSubscriptionId: number }) => harness.workerRiskBlocked.has(input.tradingAccountSubscriptionId)
    ? { allowed: false, statusCode: 409, reason: 'Daily entry order limit reached.', details: { rule: 'daily_entry_order_limit' } }
    : { allowed: true, statusCode: 200, reason: 'allowed', details: {} }),
  logRiskGateBlockedOrder: vi.fn(async () => undefined),
}));
vi.mock('../../services/strategy-market-eligibility.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/strategy-market-eligibility.service.js')>();
  return {
    ...actual,
    evaluateStrategyMarketEligibility: vi.fn((...args: Parameters<typeof actual.evaluateStrategyMarketEligibility>) => {
      if (harness.evaluatorMode === 'throw') throw new Error('injected evaluator failure');
      const result = actual.evaluateStrategyMarketEligibility(...args);
      // A forged ALLOWED with an unbounded-looking validity violates the PostgreSQL contract at commit.
      return harness.evaluatorMode === 'forge' && result.validUntil ? { ...result, validUntil: new Date(result.validUntil.getTime() + 86_400_000) } : result;
    }),
  };
});
// Pre-claim entry evaluation and worker-time subscription resolution read the exact assignment from
// PostgreSQL; sizing, reference prices and operational posture are exercised elsewhere.
vi.mock('../../services/assignment-entry-evaluation.service.js', () => ({
  evaluateAssignmentEntry: vi.fn(async ({ input }: { input: { tradingAccountSubscriptionId: number } }) => {
    const { prisma } = await import('../prisma.js');
    const assignment = await prisma.tradingAccountSubscription.findUniqueOrThrow({ where: { id: input.tradingAccountSubscriptionId }, include: { subscription: true } });
    const blocked = harness.admissionRiskBlocked.has(assignment.id);
    return {
      input: {
        tradingAccountId: assignment.tradingAccountId, tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId,
        subscriptionKey: assignment.subscription.key, symbol: assignment.subscription.symbol, side: 'buy' as const, orderType: 'market' as const,
        timeInForce: 'day' as const, extendedHours: false, signalType: 'entry' as const, qty: 1,
      },
      sizing: { tradingAccountSubscriptionId: assignment.id, qty: 1, estimatedNotional: 100, snapshot: { tradingAccountSubscriptionId: assignment.id, sizingType: 'FIXED_QTY', calculatedQty: 1 } },
      risk: blocked ? { allowed: false, statusCode: 409, reason: 'Daily entry order limit reached.', details: {} } : { allowed: true, statusCode: 200, reason: 'allowed', details: {} },
      blockers: [], outcomeCode: blocked ? 'ENTRY_RISK_BLOCKED' : 'ENTRY_ELIGIBLE',
    };
  }),
}));
vi.mock('../../services/subscription.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/subscription.service.js')>();
  return {
    ...actual,
    resolveSubscriptionOrderInput: vi.fn(async (input: { tradingAccountSubscriptionId: number }) => {
      const { prisma } = await import('../prisma.js');
      const assignment = await prisma.tradingAccountSubscription.findUniqueOrThrow({ where: { id: input.tradingAccountSubscriptionId }, include: { subscription: true } });
      return { ...input, tradingAccountId: assignment.tradingAccountId, tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId, subscriptionKey: assignment.subscription.key, symbol: assignment.subscription.symbol, side: 'buy', orderType: 'market', timeInForce: 'day' };
    }),
  };
});

type Generation = { id: number; configurationFingerprint: string; policyRevisionId: number };
type Fixture = { securityId: number; subscriptionId: number; assignmentId: number; symbol: string; accountId: number; generation?: Generation; authorizationId?: number };

(enabled ? describe : describe.skip)('Phase 3C.3 broker-time market-policy enforcement PostgreSQL integration', () => {
  const database = `ai_trader_test_broker_time_${randomUUID().replaceAll('-', '')}`;
  // Any real network request would mean an adapter escaped its mock; broker I/O must stay mocked.
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => { throw new Error(`Unexpected network request in a PostgreSQL integration test: ${String(input)}`); });
  let admin: Client, db: Client, databaseUrl: string;
  let ownerId: number, otherOwnerId: number, paperId: number, secondPaperId: number, liveId: number, exitProfileId: number;
  let mainStrategyId: number, legacyAuthorizationId: number;
  const extraClients: Client[] = [];
  let compositionSeq = 0;
  const T0 = Date.now() - 2 * 3_600_000;

  const services = async () => ({
    authz: await import('../../services/assignment-market-policy-enforcement-authorization.service.js'),
    enrollment: await import('../../services/assignment-market-policy-enrollment.service.js'),
    policy: await import('../../services/strategy-market-policy.service.js'),
    rollout: await import('../../services/market-policy-enforcement-rollout.service.js'),
    admission: await import('../../services/market-policy-entry-admission.service.js'),
    guard: await import('../../services/market-policy-broker-dispatch.service.js'),
    readiness: await import('../../services/market-policy-broker-readiness.service.js'),
    placeOrder: await import('../../services/place-order.service.js'),
    orderAudit: await import('../../services/order-audit.service.js'),
    claims: await import('../../services/entry-exposure-claim.service.js'),
    signals: await import('../../services/signal-entry.service.js'),
    worker: await import('../../workers/order.worker.js'),
    errors: await import('../../errors/broker-write-delivery-error.js'),
    recovery: await import('../../services/entry-dispatch-recovery.service.js'),
    remediation: await import('../../services/entry-exposure-remediation.service.js'),
    entryReadiness: await import('../../services/entry-exposure-readiness.service.js'),
    eligibility: await import('../../services/lifecycle-account-eligibility.service.js'),
  });
  const count = async (sql: string, params: unknown[] = []) => (await db.query(`SELECT count(*)::int AS count FROM ${sql}`, params)).rows[0].count as number;
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const user = async (email: string, role: string) => (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ($1,$2,true,now(),now()) RETURNING id`, [email, role])).rows[0].id as number;
  const account = async (name: string, environment: string, holder: number) => (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,'PAUSED',false,true,now(),now()) RETURNING id`, [holder, name, environment])).rows[0].id as number;
  const security = async (symbol: string) => (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ($1,$1,true,'STOCK',now(),now()) RETURNING id`, [symbol])).rows[0].id as number;
  const subscription = async (key: string, strategyId: number, securityId: number, symbol: string) => (await db.query(`INSERT INTO "Subscription" (key,name,symbol,enabled,"strategyId","exitProfileId","securityId","createdAt","updatedAt") VALUES ($1,$1,$2,true,$3,$4,$5,now(),now()) RETURNING id`, [key, symbol, strategyId, exitProfileId, securityId])).rows[0].id as number;
  const assign = async (accountId: number, subscriptionId: number) => (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [accountId, subscriptionId])).rows[0].id as number;
  const client = async () => { const value = new Client({ connectionString: databaseUrl }); await value.connect(); extraClients.push(value); return value; };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const posts = (clientOrderId: string) => harness.submitCalls.filter(call => call.payload.client_order_id === clientOrderId).length;
  const decisionsFor = (orderIntentId: number) => db.query(`SELECT d.*, (SELECT count(*)::int FROM "MarketPolicyBrokerDispatchGate" g WHERE g."decisionId"=d.id) AS "gateCount", (SELECT count(*)::int FROM "MarketPolicyBrokerDispatchConsumption" c WHERE c."decisionId"=d.id) AS consumed FROM "MarketPolicyBrokerDispatchDecision" d WHERE d."orderIntentId"=$1 ORDER BY d."dispatchSequence"`, [orderIntentId]).then(result => result.rows);
  const intentState = (orderIntentId: number) => one(`SELECT o.status, o."blockReason", c.status AS "claimStatus", c."releasedAt" IS NOT NULL AS "claimReleased", c."releaseReason",
      (SELECT count(*)::int FROM "BrokerOrder" b WHERE b."orderIntentId"=o.id) AS "brokerOrders",
      (SELECT count(*)::int FROM "MarketPolicyBrokerDispatchConsumption" x WHERE x."orderIntentId"=o.id) AS consumptions
    FROM "OrderIntent" o LEFT JOIN "EntryExposureClaim" c ON c."orderIntentId"=o.id WHERE o.id=$1`, [orderIntentId]);
  const rolloutVersion = async () => (await one(`SELECT version FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id=1`)).version as number;
  async function setRollout(enabledValue: boolean, reason: string) {
    const { rollout } = await services();
    return rollout.setMarketPolicyEnforcementRuntimeRollout(enabledValue, { expectedVersion: await rolloutVersion(), reason }, ownerId);
  }
  async function waitForLockWaiters(minimum: number) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const waiting = (await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n as number;
      if (waiting >= minimum) return;
      await sleep(25);
    }
    throw new Error(`Expected ${minimum} lock waiter(s).`);
  }

  async function strategy(key: string, trendStates: string[] = ['UP']) {
    const { policy } = await services();
    const id = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ($1,$1,true,now(),now()) RETURNING id`, [key])).rows[0].id as number;
    const created = await policy.createStrategyMarketPolicy(id, ownerId, `${key} fixture`);
    await activateRevision(id, created.revisions[0]!, trendStates);
    return id;
  }
  async function activateRevision(strategyId: number, revision: { id: number; configurationFingerprint: string; dimensionRules: Array<{ dimension: string; algorithmVersion: string }> }, trendStates: string[]) {
    const { policy } = await services();
    const saved = await policy.saveStrategyMarketPolicyRevision(strategyId, revision.id, { expectedConfigurationFingerprint: revision.configurationFingerprint, rules: revision.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: rule.dimension === 'TREND' ? trendStates : [] })) } as never, ownerId);
    await policy.activateStrategyMarketPolicyRevision(strategyId, saved.id, saved.configurationFingerprint, ownerId);
    return saved.id;
  }
  async function instrument(symbol: string, strategyId = mainStrategyId, accountId = paperId): Promise<Fixture> {
    const securityId = await security(symbol);
    const subscriptionId = await subscription(`sub-${symbol.toLowerCase()}-${strategyId}`, strategyId, securityId, symbol);
    return { securityId, subscriptionId, assignmentId: await assign(accountId, subscriptionId), symbol, accountId };
  }
  async function enroll(accountId: number, assignmentId: number): Promise<Generation> {
    const { enrollment } = await services();
    const prepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(accountId, assignmentId, ownerId);
    return enrollment.activateAssignmentMarketPolicyEnrollment(accountId, assignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
  }
  async function grant(fixture: Fixture) {
    const { authz } = await services();
    const generation = await enroll(fixture.accountId, fixture.assignmentId);
    const authorization = await authz.grantAssignmentMarketPolicyEnforcementAuthorization(fixture.accountId, fixture.assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'Authorize PAPER enforcement' }, ownerId);
    return Object.assign(fixture, { generation, authorizationId: authorization!.id });
  }
  async function enforced(symbol: string, strategyId = mainStrategyId, accountId = paperId) { return grant(await instrument(symbol, strategyId, accountId)); }
  async function revoke(fixture: Fixture, reason = 'Owner revoked after admission') {
    const { authz } = await services();
    try {
      return await authz.revokeAssignmentMarketPolicyEnforcementAuthorization(fixture.accountId, fixture.assignmentId, { authorizationId: fixture.authorizationId!, reason }, ownerId);
    } catch (error) {
      if ((error as { details?: { code?: string } }).details?.code !== 'CONCURRENT_AUTHORIZATION_CHANGE') throw error;
      return authz.revokeAssignmentMarketPolicyEnforcementAuthorization(fixture.accountId, fixture.assignmentId, { authorizationId: fixture.authorizationId!, reason }, ownerId);
    }
  }

  // Five immutable V1 sources; TREND is the only REQUIRED dimension in the fixture policies.
  async function composition(options: { trend?: string | null; trendValidUntil?: Date; compositionVersion?: string; failed?: boolean; trendAlgorithm?: string } = {}) {
    const trend = options.trend === undefined ? 'UP' : options.trend;
    const at = new Date(T0 + (++compositionSeq) * 1_000).toISOString();
    const defaultValid = new Date(Date.now() + 3_600_000);
    const trendValid = options.trendValidUntil ?? defaultValid;
    const dimensions = [['TREND', options.trendAlgorithm ?? 'TREND_V1', trend], ['VOLATILITY', 'VOLATILITY_V1', 'NORMAL'], ['BREADTH', 'BREADTH_V1', 'MIXED'], ['PARTICIPATION', 'PARTICIPATION_V1', 'NORMAL'], ['INTRADAY_STRESS', 'INTRADAY_STRESS_V1', 'NORMAL']] as const;
    const unhealthy = (dimension: string) => dimension === 'TREND' && trend === null;
    const validUntil = (dimension: string) => (dimension === 'TREND' ? trendValid : defaultValid).toISOString();
    const sourceIds = new Map<string, number>();
    for (const [dimension, version, state] of dimensions) {
      if (unhealthy(dimension)) continue;
      sourceIds.set(dimension, (await db.query(`INSERT INTO "MarketRegimeDimensionAssessment" (dimension,"algorithmVersion","evidenceSchemaVersion","targetAt","sessionDate",attempt,status,"rawState","effectiveState","dataThroughAt","validUntil","startedAt","completedAt","evidenceJson") VALUES ($1,$2,1,$3,DATE '2026-10-16',1,'VALID',$4,$4,$3,$5,$3,$3,'{}') RETURNING id`, [dimension, version, at, state, validUntil(dimension)])).rows[0].id);
    }
    const degraded = dimensions.some(([dimension]) => unhealthy(dimension));
    const aggregateValid = new Date(Math.min(trendValid.getTime(), defaultValid.getTime())).toISOString();
    await db.query('BEGIN');
    const row = (await db.query(`INSERT INTO "MarketRegimeAssessment" ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","dataThroughAt","validUntil","publicationStatus","publicationReasonCode","evidenceHealth","evidenceReasonCode","sourceSetFingerprint","startedAt","completedAt","evidenceJson") VALUES ($1,1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$2,$2,'{}') RETURNING id`,
      [options.compositionVersion ?? 'MARKET_REGIME_COMPOSITION_V1', at, degraded ? null : at, degraded ? null : aggregateValid, options.failed ? 'FAILED' : 'SUCCEEDED', options.failed ? 'TEST_FAILED_PUBLICATION' : null, degraded ? 'DEGRADED' : 'COMPLETE', degraded ? 'SOURCE_VECTOR_DEGRADED' : null, randomUUID().replaceAll('-', '').repeat(2)])).rows[0];
    for (const [ordinal, [dimension, version, state]] of dimensions.entries()) {
      const bad = unhealthy(dimension);
      await db.query(`INSERT INTO "MarketRegimeAssessmentSource" ("marketRegimeAssessmentId",dimension,"requiredAlgorithmVersion","expectedTargetAt","sourceAssessmentId","sourceEvidenceSchemaVersion","sourceAttempt","sourceStatus","sourceTargetAt","sourceCompletedAt","sourceDataThroughAt","sourceValidUntil","sourceRawState","sourceEffectiveState",health,"reasonCode",ordinal,"evidenceJson") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16,'{}')`,
        [row.id, dimension, version, at, sourceIds.get(dimension) ?? null, bad ? null : 1, bad ? null : 1, bad ? null : 'VALID', bad ? null : at, bad ? null : at, bad ? null : at, bad ? null : validUntil(dimension), bad ? null : state, bad ? 'MISSING' : 'AVAILABLE', bad ? 'TEST_MISSING' : null, ordinal + 1]);
    }
    await db.query('COMMIT');
    return row.id as number;
  }

  async function submit(assignmentId: number, clientOrderId: string) {
    const { placeOrder } = await services();
    return placeOrder.submitOrder({ tradingAccountSubscriptionId: assignmentId, signalType: 'entry', orderType: 'market', timeInForce: 'day', extendedHours: false }, { clientOrderId }) as Promise<{ intentId: number; status: string; duplicate?: boolean; marketPolicyEnforcement?: { obligationId: number } }>;
  }
  /** Admits an enforced entry on a fresh ALLOWED composition, so it carries a frozen obligation. */
  async function admitted(fixture: Fixture, clientOrderId: string, trendValidUntil?: Date) {
    await composition({ trend: 'UP', ...(trendValidUntil ? { trendValidUntil } : {}) });
    const result = await submit(fixture.assignmentId, clientOrderId);
    expect(result.marketPolicyEnforcement?.obligationId).toEqual(expect.any(Number));
    return result.intentId;
  }
  const dispatch = async (accountId = paperId) => (await services()).worker.processPendingOrdersForAccount(accountId);
  async function emulateWorkerClaim(orderIntentId: number) {
    const { claims } = await services();
    await db.query(`UPDATE "OrderIntent" SET status='submitting' WHERE id=$1 AND status='pending'`, [orderIntentId]);
    // The current worker claims under the adapter-marker protocol.
    await claims.transitionEntryExposureClaim({ orderIntentId, status: 'ENTRY_SUBMITTING', eventType: 'WORKER_CLAIMED_FOR_SUBMISSION', evidence: { markerProtocol: 'ADAPTER_MARKER_V1' } });
  }

  beforeAll(async () => {
    // CREATE/DROP DATABASE run from the maintenance database, never inside the application database.
    admin = (await connectMaintenanceClient(process.env.DATABASE_URL!)).client;
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    assertDisposableDatabaseUrl(databaseUrl, database);
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    expect((await db.query('SELECT current_database() AS name')).rows[0].name).toBe(database);
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    expect(migrations).toContain(BROKER_TIME_MIGRATION);
    expect(migrations).toContain(DISPATCH_RECOVERY_MIGRATION);
    // Replay up to Phase 3C.1 so a Security-unbound V1 grant exists when Phase 3C.2 invalidates it (L5).
    for (const migration of migrations.filter(name => name < PRE_INTENT_MIGRATION)) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    ownerId = await user('owner@phase3c3.test', 'SYSTEM_OWNER');
    otherOwnerId = await user('other-owner@phase3c3.test', 'SYSTEM_OWNER');
    paperId = await account('Paper', 'PAPER', ownerId);
    secondPaperId = await account('Second Paper', 'PAPER', otherOwnerId);
    liveId = await account('Live', 'LIVE', ownerId);
    exitProfileId = (await db.query(`INSERT INTO "ExitProfile" (key,name,"exitMode","takeProfitBehavior",enabled,"createdAt","updatedAt") VALUES ('phase3c3','Phase 3C.3','fixed','limit',true,now(),now()) RETURNING id`)).rows[0].id;
    process.env.DATABASE_URL = databaseUrl;
    // The shared Prisma client must bind to the verified disposable database, never the normal one.
    const { prisma } = await import('../prisma.js');
    expect((await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`)[0]!.name).toBe(database);
    mainStrategyId = await strategy('phase3c3-main');
    const legacy = await instrument('LGCY');
    const generation = await enroll(paperId, legacy.assignmentId);
    legacyAuthorizationId = (await db.query(`INSERT INTO "AssignmentMarketPolicyEnforcementAuthorization" ("enrollmentId","enrollmentGenerationId","authorizationSequence","authorityVersion",status,environment,"tradingAccountId","accountSubscriptionId","strategyId","policyRevisionId","accountHolderUserId","configurationFingerprint","authorizationFingerprint","authorizedByUserId","grantReason")
      SELECT g."enrollmentId", g.id, 1, 'PAPER_MARKET_POLICY_ENFORCEMENT_V1', 'AUTHORIZED', 'PAPER', g."tradingAccountId", g."accountSubscriptionId", g."strategyId", g."policyRevisionId", g."accountHolderUserId", g."configurationFingerprint", $2, $3, 'Phase 3C.1 grant'
      FROM "AssignmentMarketPolicyEnrollmentGeneration" g WHERE g.id=$1 RETURNING id`, [generation.id, 'e'.repeat(64), ownerId])).rows[0].id;
    for (const migration of migrations.filter(name => name >= PRE_INTENT_MIGRATION)) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    await setRollout(true, 'Begin PAPER enforcement for broker-time tests');
  }, 180_000);

  afterAll(async () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    // Dedicated pools bound to the disposable database close before it is force-dropped.
    const { closeBrokerObservationPrisma } = await import('../broker-observation-prisma.js');
    const { closeTradingAccountWorkflowLockPool } = await import('../../services/trading-account-workflow-lock.service.js');
    await closeBrokerObservationPrisma().catch(() => undefined);
    await closeTradingAccountWorkflowLockPool().catch(() => undefined);
    for (const value of extraClients) await value.end().catch(() => undefined);
    if (db) await db.end();
    if (admin) { assertDisposableDatabaseUrl(databaseUrl, database); await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); }
  });

  beforeEach(() => {
    harness.submitError = null; harness.onSubmit = null; harness.beforeConsume = null; harness.evaluatorMode = 'real';
    harness.adapterLocalError = null; harness.openBuys.clear(); harness.openBuyFailures.clear(); harness.positions.clear();
  });

  it('replays the complete migration chain without Prisma schema drift', () => {
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000 });
    expect(result.stdout, result.stderr).toContain('No difference detected');
  }, 70_000);

  // 1, 23: exactly one authorized POST with the stable client order ID, idempotent on repeat.
  it('dispatches exactly one POST after a fresh ALLOWED broker-time decision on the frozen policy', async () => {
    const fixture = await enforced('ALW');
    const intentId = await admitted(fixture, 'alw-1');
    const result = await dispatch();
    expect(result).toMatchObject({ submitted: 1, failed: 0 });
    expect(posts('alw-1')).toBe(1);
    expect(harness.submitCalls.at(-1)!.payload).toMatchObject({ client_order_id: 'alw-1', symbol: 'ALW' });
    const [decision] = await decisionsFor(intentId);
    const obligation = await one(`SELECT * FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=$1`, [intentId]);
    expect(decision).toMatchObject({
      outcome: 'ALLOWED', dispatchDisposition: 'DISPATCH_AUTHORIZED', obligationId: obligation.id, authorizationId: obligation.authorizationId,
      authorizationFingerprint: obligation.authorizationFingerprint, policyRevisionId: obligation.policyRevisionId, enrollmentGenerationId: obligation.enrollmentGenerationId,
      authorizationStatus: 'AUTHORIZED', decisionVersion: 'MARKET_POLICY_BROKER_TIME_ENFORCEMENT_V1', authority: 'AUTHORITATIVE', evaluatorVersion: 'STRATEGY_MARKET_ELIGIBILITY_V1',
      clientOrderId: 'alw-1', dispatchSequence: 1, gateCount: 5, consumed: 1, rolloutEnabled: true,
    });
    // A fresh evaluation, not the admission's: a later composition and evaluation time.
    expect(decision.marketRegimeAssessmentId).toBeGreaterThanOrEqual(obligation.marketRegimeAssessmentId);
    expect(decision.evaluatedAt.getTime()).toBeGreaterThanOrEqual(obligation.evaluatedAt.getTime());
    expect(decision.dispatchExpiresAt.getTime() - decision.evaluatedAt.getTime()).toBeLessThanOrEqual(30_000);
    expect(await intentState(intentId)).toMatchObject({ status: 'submitted', claimStatus: 'BROKER_ORDER_ACTIVE', claimReleased: false, brokerOrders: 1, consumptions: 1 });
    // Repeat invocation: nothing pending, and a stable-key retry recovers the same lifecycle.
    await dispatch();
    expect(await submit(fixture.assignmentId, 'alw-1')).toMatchObject({ intentId, duplicate: true });
    expect(posts('alw-1')).toBe(1);
    await expect(db.query(`UPDATE "MarketPolicyBrokerDispatchDecision" SET "reasonCode"='REWRITE' WHERE id=$1`, [decision.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM "MarketPolicyBrokerDispatchConsumption" WHERE "decisionId"=$1`, [decision.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE "MarketPolicyBrokerDispatchGate" SET "reasonCode"='REWRITE' WHERE "decisionId"=$1`, [decision.id])).rejects.toThrow(/immutable/);
  });

  // 2, 4: admission ALLOWED is historical evidence, not a permanent permit.
  it.each([
    ['BLOCKED', { trend: 'DOWN' }, 'REQUIRED_STATE_BLOCKED', 5],
    ['INSUFFICIENT_EVIDENCE', { trend: null }, 'REQUIRED_EVIDENCE_INSUFFICIENT', 5],
  ] as const)('sends no POST when the broker-time market evaluation is %s', async (outcome, market, reasonCode, gates) => {
    const fixture = await enforced(`MK${outcome.slice(0, 3)}`);
    const intentId = await admitted(fixture, `mk-${outcome}`);
    await composition(market);
    expect(await dispatch()).toMatchObject({ blocked: 1, submitted: 0, failed: 0 });
    expect(posts(`mk-${outcome}`)).toBe(0);
    const decisions = await decisionsFor(intentId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome, reasonCode, dispatchDisposition: 'DEFINITELY_NOT_SENT', gateCount: gates, consumed: 0, validUntil: null, dispatchExpiresAt: null });
    expect(await intentState(intentId)).toMatchObject({ status: 'blocked', blockReason: `MARKET_POLICY_BROKER_TIME:${outcome}:DEFINITELY_NOT_SENT:${reasonCode}:decision=${decisions[0].id}`, claimReleased: true, releaseReason: `BROKER_TIME_MARKET_POLICY_${outcome}_NOT_SENT`, brokerOrders: 0, consumptions: 0 });
    expect(await count(`"EntryExposureClaimEvent" e JOIN "EntryExposureClaim" c ON c.id=e."claimId" WHERE c."orderIntentId"=$1 AND e."eventType"='RELEASED_NO_BROKER_EXPOSURE'`, [intentId])).toBe(1);
    // The frozen obligation and its admission attempt are untouched history.
    expect(await count(`"OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=$1`, [intentId])).toBe(1);
    expect(await count(`"SystemEvent" WHERE type='MARKET_POLICY_BROKER_DISPATCH_REFUSED' AND "entityId"=$1`, [String(decisions[0].id)])).toBe(1);
  });

  // 3: the REQUIRED source validated at admission expired before dispatch.
  it('sends no POST when the admission-time source expired before the broker boundary', async () => {
    const fixture = await enforced('EXPS');
    const validUntil = new Date(Date.now() + 1_500);
    const intentId = await admitted(fixture, 'exps-1', validUntil);
    await sleep(Math.max(0, validUntil.getTime() - Date.now()) + 200);
    await dispatch();
    expect(posts('exps-1')).toBe(0);
    const [decision] = await decisionsFor(intentId);
    expect(decision).toMatchObject({ outcome: 'INSUFFICIENT_EVIDENCE', reasonCode: 'REQUIRED_EVIDENCE_INSUFFICIENT', consumed: 0 });
    expect(await one(`SELECT "reasonCode", "sourceHealth"::text FROM "MarketPolicyBrokerDispatchGate" WHERE "decisionId"=$1 AND dimension='TREND'`, [decision.id])).toEqual({ reasonCode: 'SOURCE_EXPIRED_AT_EVALUATION', sourceHealth: 'EXPIRED' });
    expect(await intentState(intentId)).toMatchObject({ status: 'blocked', claimReleased: true });
  });

  // 5, 6: subsequent authorization changes block a new POST; owner opt-out never applies to frozen intents.
  it('sends no POST after the owner revokes the authorization following admission', async () => {
    const fixture = await enforced('RVK');
    const intentId = await admitted(fixture, 'rvk-1');
    await revoke(fixture);
    await dispatch();
    expect(posts('rvk-1')).toBe(0);
    expect((await decisionsFor(intentId))[0]).toMatchObject({ outcome: 'AUTHORIZATION_REVOKED', authorizationStatus: 'REVOKED', authorizationId: fixture.authorizationId, gateCount: 0 });
    expect(await intentState(intentId)).toMatchObject({ status: 'blocked', claimReleased: true });
  });

  it('sends no POST after automatic invalidation, even after an owner lapse opt-out', async () => {
    const fixture = await enforced('INV');
    const intentId = await admitted(fixture, 'inv-1');
    const { enrollment, authz } = await services();
    await enrollment.disableAssignmentMarketPolicyEnrollment(paperId, fixture.assignmentId, fixture.generation!.id, ownerId, 'Disable after admission');
    await authz.resolveAssignmentMarketPolicyEnforcementLapse(paperId, fixture.assignmentId, { authorizationId: fixture.authorizationId!, reason: 'Opt out for future entries', confirmNonEnforced: true }, ownerId);
    await dispatch();
    expect(posts('inv-1')).toBe(0);
    expect((await decisionsFor(intentId))[0]).toMatchObject({ outcome: 'AUTHORIZATION_INVALIDATED', reasonCode: 'FROZEN_AUTHORIZATION_INVALIDATED_ENROLLMENT_DISABLED', authorizationStatus: 'INVALIDATED' });
    // The opt-out governs future non-enforced admission only.
    await composition({ trend: 'DOWN' });
    const later = await submit(fixture.assignmentId, 'inv-2');
    expect(later).not.toHaveProperty('marketPolicyEnforcement');
    await dispatch();
    expect(posts('inv-2')).toBe(1);
    expect(await decisionsFor(later.intentId)).toHaveLength(0);
  });

  // 7, 8: the frozen revision is never substituted by a newer one.
  it('sends no POST once the frozen policy revision is superseded, never evaluating the newer revision', async () => {
    const strategyId = await strategy('phase3c3-supersede', ['UP']);
    const fixture = await enforced('SUPR', strategyId);
    const intentId = await admitted(fixture, 'supr-1');
    const frozenRevisionId = fixture.generation!.policyRevisionId;
    const { policy, enrollment } = await services();
    const next = await policy.prepareStrategyMarketPolicyRevision(strategyId, ownerId, 'Allow DOWN trend');
    const newRevisionId = await activateRevision(strategyId, next as never, ['UP', 'DOWN']);
    await enrollment.disableAssignmentMarketPolicyEnrollment(paperId, fixture.assignmentId, fixture.generation!.id, ownerId, 'Re-enroll on the new revision').catch(() => undefined);
    await grant(fixture);
    expect(fixture.generation!.policyRevisionId).toBe(newRevisionId);
    // The newer revision would ALLOW this market; the frozen one is no longer the Strategy's ACTIVE revision.
    await composition({ trend: 'DOWN' });
    await dispatch();
    expect(posts('supr-1')).toBe(0);
    const [decision] = await decisionsFor(intentId);
    expect(decision).toMatchObject({ outcome: 'POLICY_REVISION_SUPERSEDED', policyRevisionId: frozenRevisionId, gateCount: 0, consumed: 0 });
    expect(decision.policyRevisionId).not.toBe(newRevisionId);
    // A new admission under the new authorization carries its own obligation and dispatches.
    const fresh = await submit(fixture.assignmentId, 'supr-2');
    expect(fresh.marketPolicyEnforcement).toBeDefined();
    await dispatch();
    expect(posts('supr-2')).toBe(1);
    expect((await decisionsFor(fresh.intentId))[0]).toMatchObject({ outcome: 'ALLOWED', policyRevisionId: newRevisionId, authorizationId: fixture.authorizationId });
  });

  // 9: an already-delivered order is recovered without re-gating or a second POST.
  it('recovers an exact existing broker order despite revocation and a BLOCKED market, without a decision or POST', async () => {
    const fixture = await enforced('RCVR');
    const intentId = await admitted(fixture, 'rcvr-1');
    harness.orders.set('rcvr-1', { id: 'alpaca-earlier-rcvr', client_order_id: 'rcvr-1', symbol: 'RCVR', side: 'buy', status: 'accepted', qty: '1', filled_qty: '0' });
    await revoke(fixture);
    await composition({ trend: 'DOWN' });
    expect(await dispatch()).toMatchObject({ submitted: 1, failed: 0 });
    expect(posts('rcvr-1')).toBe(0);
    expect(await decisionsFor(intentId)).toHaveLength(0);
    expect(await intentState(intentId)).toMatchObject({ status: 'submitted', claimStatus: 'BROKER_ORDER_ACTIVE', claimReleased: false, brokerOrders: 1 });
    expect(await one(`SELECT "brokerOrderId" FROM "BrokerOrder" WHERE "orderIntentId"=$1`, [intentId])).toEqual({ brokerOrderId: 'alpaca-earlier-rcvr' });
  });

  // 10: an inconclusive lookup is never proof of absence and never authorizes a POST, but a failure
  // before the adapter-invocation marker under the marker protocol is proven never sent.
  it('sends no POST and records proven pre-dispatch non-delivery when the stable client-order-ID lookup is inconclusive', async () => {
    const fixture = await enforced('AMBG');
    const intentId = await admitted(fixture, 'ambg-1');
    harness.lookupFailures.add('ambg-1');
    await dispatch();
    harness.lookupFailures.delete('ambg-1');
    expect(posts('ambg-1')).toBe(0);
    expect(await decisionsFor(intentId)).toHaveLength(0);
    expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: 'LOCAL_PRE_DISPATCH_FAILURE:Alpaca client-order lookup unavailable', claimReleased: true, releaseReason: 'WORKER_PROVEN_PRE_DISPATCH_BOUNDARY_FAILURE', consumptions: 0 });
  });

  // 11, 12: legacy queued intents and activation inventory.
  it('quarantines un-obligated queued BUYs that now require enforcement and reports them before dispatch', async () => {
    const { readiness } = await services();
    // (a) Queued while the rollout was inactive for an authorized assignment.
    const authorizedFixture = await enforced('LQA');
    await setRollout(false, 'Pause enforcement');
    await composition({ trend: 'DOWN' });
    const queuedInactive = await submit(authorizedFixture.assignmentId, 'lqa-1');
    expect(queuedInactive).not.toHaveProperty('marketPolicyEnforcement');
    await setRollout(true, 'Resume enforcement');
    // (b) Queued while never authorized; a later grant must not make it executable.
    const neverFixture = await instrument('LQB');
    const queuedNever = await submit(neverFixture.assignmentId, 'lqb-1');
    await grant(neverFixture);
    // (c) An obligated queued entry for comparison.
    const obligated = await enforced('LQC');
    const obligatedIntentId = await admitted(obligated, 'lqc-1');

    const report = await readiness.assessMarketPolicyBrokerEnforcementReadiness({ tradingAccountIds: [paperId] });
    const byIntent = new Map(report.inventory.map(item => [item.orderIntentId, item]));
    expect(byIntent.get(queuedInactive.intentId)).toMatchObject({ obligationPresent: false, assignmentDisposition: 'ENFORCED', brokerDeliveryClassification: 'NOT_DISPATCHED', brokerTimeTreatment: 'QUARANTINED_AT_BROKER_TIME_WHILE_ROLLOUT_ACTIVE', clientOrderId: 'lqa-1', status: 'pending' });
    expect(byIntent.get(queuedNever.intentId)).toMatchObject({ obligationPresent: false, brokerTimeTreatment: 'QUARANTINED_AT_BROKER_TIME_WHILE_ROLLOUT_ACTIVE' });
    expect(byIntent.get(obligatedIntentId)).toMatchObject({ obligationPresent: true, brokerTimeTreatment: 'FROZEN_OBLIGATION_REVALIDATED_BEFORE_POST' });
    expect(report.activationGuard).toMatchObject({ reviewRequired: true, reasons: expect.arrayContaining(['QUEUED_UNOBLIGATED_ENTRIES_WILL_BE_QUARANTINED']), liquidationRequired: false });
    expect(report.mode).toBe('READ_ONLY');

    await dispatch();
    expect(posts('lqa-1') + posts('lqb-1')).toBe(0);
    expect(posts('lqc-1')).toBe(1);
    for (const intentId of [queuedInactive.intentId, queuedNever.intentId]) {
      const [decision] = await decisionsFor(intentId);
      expect(decision).toMatchObject({ outcome: 'LEGACY_UNOBLIGATED_QUARANTINED', obligationId: null, dispatchDisposition: 'DEFINITELY_NOT_SENT', rolloutEnabled: true });
      expect(await intentState(intentId)).toMatchObject({ status: 'blocked', claimReleased: true, brokerOrders: 0 });
      // No ALLOWED admission was invented for it.
      expect(await count(`"MarketPolicyEnforcementAdmissionAttempt" WHERE "orderIntentId"=$1`, [intentId])).toBe(0);
    }
    expect(await count(`"SystemEvent" WHERE type='MARKET_POLICY_LEGACY_ENTRY_QUARANTINED'`)).toBeGreaterThanOrEqual(2);
    const after = await readiness.assessMarketPolicyBrokerEnforcementReadiness({ tradingAccountIds: [paperId] });
    expect(after.inventory.filter(item => item.brokerTimeTreatment === 'QUARANTINED_AT_BROKER_TIME_WHILE_ROLLOUT_ACTIVE')).toHaveLength(0);
  });

  it('keeps existing broker behavior for never-authorized and owner-revoked assignments and for LIVE accounts', async () => {
    await composition({ trend: 'DOWN' });
    const never = await instrument('NVR');
    const revoked = await enforced('OPT');
    await revoke(revoked, 'Explicit return to non-enforced behavior');
    const live = await instrument('LIVX', mainStrategyId, liveId);
    const neverIntent = await submit(never.assignmentId, 'nvr-1');
    const optIntent = await submit(revoked.assignmentId, 'opt-1');
    const liveIntent = await submit(live.assignmentId, 'livx-1');
    await dispatch();
    await dispatch(liveId);
    expect([posts('nvr-1'), posts('opt-1'), posts('livx-1')]).toEqual([1, 1, 1]);
    for (const intent of [neverIntent, optIntent, liveIntent]) expect(await decisionsFor(intent.intentId)).toHaveLength(0);
    expect(await count(`"MarketPolicyBrokerDispatchDecision" WHERE "tradingAccountId"=$1`, [liveId])).toBe(0);
    await expect(db.query(`INSERT INTO "MarketPolicyBrokerDispatchDecision" ("decisionKey","decisionVersion","orderIntentId","dispatchSequence","clientOrderId",environment,"tradingAccountId","accountSubscriptionId","rolloutEnabled","rolloutVersion","evaluatedAt",outcome,"reasonCode","dispatchDisposition","technicalDiagnostic","evidenceJson") VALUES ('live-forge','MARKET_POLICY_BROKER_TIME_ENFORCEMENT_V1',$1,1,'livx-1','PAPER',$2,$3,true,1,now(),'TECHNICAL_FAILURE','X','NOT_SENT_TECHNICAL_FAILURE','x','{}')`, [liveIntent.intentId, liveId, live.assignmentId])).rejects.toThrow(/PAPER-only/);
  });

  // 14 / L3: protective exits are never entry-gated.
  it('never gates protective SELL or short-cover BUY intents, while every entry BUY still requires an obligation', async () => {
    const fixture = await enforced('PROT');
    const position = (await db.query(`INSERT INTO "TrackedPosition" (broker,symbol,side,qty,"avgEntryPrice","currentPrice","marketValue","costBasis","unrealizedPnL","unrealizedPnLPct",status,"rawPositionJson","securityId","subscriptionId","tradingAccountId","updatedAt") VALUES ('alpaca','PROT','short',1,10,10,10,10,0,0,'open','{}',$1,$2,$3,now()) RETURNING id`, [fixture.securityId, fixture.subscriptionId, paperId])).rows[0].id;
    const intent = (side: string, raw: object, trackedPositionId: number | null, cid: string) => db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",qty,"clientOrderId",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","trackedPositionId","createdAt","updatedAt") VALUES ('exit-evaluator','PROT',$1,'trailing_stop','gtc',1,$2,'submitted',$3,$4,$5,$6,now(),now()) RETURNING id`, [side, cid, JSON.stringify(raw), paperId, fixture.assignmentId, trackedPositionId]);
    await expect(intent('buy', { source: 'exit-evaluator', orderKind: 'target_unlock_trailing_stop', trackedPositionId: position }, position, 'prot-cover-1')).resolves.toBeDefined();
    await expect(intent('buy', { signalType: 'exit', source: 'exit-evaluator', trackedPositionId: position }, position, 'prot-cover-2')).resolves.toBeDefined();
    await expect(intent('sell', { signalType: 'exit', source: 'close-position' }, position, 'prot-sell-1')).resolves.toBeDefined();
    await expect(intent('buy', { signalType: 'entry' }, position, 'prot-entry-1')).rejects.toThrow(/requires an ALLOWED frozen enforcement obligation/);
    await expect(intent('buy', { signalType: 'entry' }, null, 'prot-entry-2')).rejects.toThrow(/requires an ALLOWED frozen enforcement obligation/);
    const cover = (await one(`SELECT id FROM "OrderIntent" WHERE "clientOrderId"='prot-cover-1'`)).id;
    // A protective BUY can never acquire a broker-time entry decision either.
    await expect(db.query(`INSERT INTO "MarketPolicyBrokerDispatchDecision" ("decisionKey","decisionVersion","orderIntentId","dispatchSequence","clientOrderId",environment,"tradingAccountId","accountSubscriptionId","rolloutEnabled","rolloutVersion","evaluatedAt",outcome,"reasonCode","dispatchDisposition","technicalDiagnostic","evidenceJson") VALUES ('cover-forge','MARKET_POLICY_BROKER_TIME_ENFORCEMENT_V1',$1,1,'prot-cover-1','PAPER',$2,$3,true,1,now(),'TECHNICAL_FAILURE','X','NOT_SENT_TECHNICAL_FAILURE','x','{}')`, [cover, paperId, fixture.assignmentId])).rejects.toThrow(/entry BUY OrderIntent/);
  });

  // 15: technical failures fail closed, never falling back to the admission ALLOWED.
  it.each([
    ['throw', 'TECHNICAL_FAILURE_MARKET_EVALUATION'],
    ['forge', 'TECHNICAL_FAILURE_DECISION_COMMIT'],
  ] as const)('sends no POST on a %s evaluator or persistence failure and records it best-effort', async (mode, reasonCode) => {
    const fixture = await enforced(`TF${mode.toUpperCase()}`);
    const intentId = await admitted(fixture, `tf-${mode}`);
    harness.evaluatorMode = mode;
    expect(await dispatch()).toMatchObject({ failed: 1, submitted: 0 });
    harness.evaluatorMode = 'real';
    expect(posts(`tf-${mode}`)).toBe(0);
    const decisions = await decisionsFor(intentId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome: 'TECHNICAL_FAILURE', reasonCode, dispatchDisposition: 'NOT_SENT_TECHNICAL_FAILURE', consumed: 0 });
    expect(decisions[0].technicalDiagnostic).toEqual(expect.any(String));
    expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringMatching(/^MARKET_POLICY_BROKER_TIME:TECHNICAL_FAILURE:DEFINITELY_NOT_SENT:/), claimReleased: true, consumptions: 0 });
    expect(await count(`"SystemEvent" WHERE type='MARKET_POLICY_BROKER_DISPATCH_TECHNICAL_FAILURE' AND "entityId"=$1`, [String(intentId)])).toBe(1);
  });

  // 16: the dispatch window closes before consumption and fresh evidence is no longer valid.
  it('sends no POST when the broker-time decision expires before dispatch', async () => {
    const fixture = await enforced('DEXP');
    const validUntil = new Date(Date.now() + 2_500);
    const intentId = await admitted(fixture, 'dexp-1', validUntil);
    harness.beforeConsume = async () => { await sleep(Math.max(0, validUntil.getTime() - Date.now()) + 250); };
    await dispatch();
    expect(posts('dexp-1')).toBe(0);
    const decisions = await decisionsFor(intentId);
    expect(decisions.map(row => [row.outcome, row.consumed])).toEqual([['ALLOWED', 0], ['INSUFFICIENT_EVIDENCE', 0]]);
    expect(decisions[0].dispatchExpiresAt.getTime()).toBe(validUntil.getTime());
    expect(await intentState(intentId)).toMatchObject({ status: 'blocked', claimReleased: true, consumptions: 0 });
  });

  // 20: a refused consumption is a definite non-send, followed by exactly one fresh decision.
  it('re-evaluates with fresh evidence after a refused consumption and then sends exactly one POST', async () => {
    const fixture = await enforced('FRSH');
    const validUntil = new Date(Date.now() + 2_500);
    const intentId = await admitted(fixture, 'frsh-1', validUntil);
    let freshCompositionId = 0;
    harness.beforeConsume = async () => {
      await sleep(Math.max(0, validUntil.getTime() - Date.now()) + 250);
      freshCompositionId = await composition({ trend: 'UP' });
    };
    await dispatch();
    expect(posts('frsh-1')).toBe(1);
    const decisions = await decisionsFor(intentId);
    expect(decisions.map(row => [row.outcome, row.consumed])).toEqual([['ALLOWED', 0], ['ALLOWED', 1]]);
    expect(decisions[1].marketRegimeAssessmentId).toBe(freshCompositionId);
    expect(decisions[0].marketRegimeAssessmentId).not.toBe(freshCompositionId);
    // The refused decision is closed: superseded decisions can never be consumed.
    await expect(db.query(`INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,'frsh-1','{}')`, [decisions[0].id, intentId])).rejects.toThrow(/BROKER_DISPATCH_DECISION_SUPERSEDED|duplicate key/);
    expect(await intentState(intentId)).toMatchObject({ status: 'submitted', claimStatus: 'BROKER_ORDER_ACTIVE' });
  });

  // 17: revoke versus dispatch preparation, at every linearization point.
  it('serializes revocation against preparation and refuses consumption after a revocation commits first', async () => {
    const fixture = await enforced('CRVK');
    const intentId = await admitted(fixture, 'crvk-1');
    const holder = await client();
    await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${fixture.securityId}`]);
    const worker = dispatch();
    await waitForLockWaiters(1); // preparation holds the authorization FOR SHARE and waits at the advisory lock
    let revokeSettled = false;
    const revocation = revoke(fixture, 'Revoke during preparation').finally(() => { revokeSettled = true; });
    await waitForLockWaiters(2);
    await sleep(200);
    expect(revokeSettled).toBe(false);
    harness.beforeConsume = async () => { await revocation; };
    await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${fixture.securityId}`]);
    await worker;
    expect(posts('crvk-1')).toBe(0);
    expect((await decisionsFor(intentId)).map(row => [row.outcome, row.consumed])).toEqual([['ALLOWED', 0], ['AUTHORIZATION_REVOKED', 0]]);
    expect(await intentState(intentId)).toMatchObject({ status: 'blocked', claimReleased: true, consumptions: 0 });
  });

  it('cannot recall a dispatch already authorized when a revocation commits after consumption; the order stays managed', async () => {
    const fixture = await enforced('LATE');
    const intentId = await admitted(fixture, 'late-1');
    harness.onSubmit = async () => { await revoke(fixture, 'Revoke while the POST is in flight'); };
    await dispatch();
    expect(posts('late-1')).toBe(1);
    expect(await one(`SELECT status FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [fixture.authorizationId])).toEqual({ status: 'REVOKED' });
    expect((await decisionsFor(intentId)).map(row => [row.outcome, row.consumed])).toEqual([['ALLOWED', 1]]);
    expect(await intentState(intentId)).toMatchObject({ status: 'submitted', claimStatus: 'BROKER_ORDER_ACTIVE', brokerOrders: 1 });
  });

  // 18: rollout deactivation never bypasses or erases a frozen obligation.
  it('keeps validating frozen obligations across a concurrent runtime deactivation', async () => {
    const first = await enforced('DEA');
    const second = await enforced('DEB');
    const firstIntent = await admitted(first, 'dea-1');
    const secondIntent = await admitted(second, 'deb-1');
    await db.query(`UPDATE "OrderIntent" SET status='blocked', "blockReason"='TEST_HOLD' WHERE id=$1`, [secondIntent]);
    const holder = await client();
    await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${first.securityId}`]);
    const worker = dispatch();
    await waitForLockWaiters(1);
    const deactivation = setRollout(false, 'Deactivate during dispatch preparation');
    await waitForLockWaiters(2);
    harness.beforeConsume = async () => { await deactivation; };
    await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${first.securityId}`]);
    await worker;
    expect(posts('dea-1')).toBe(1);
    expect((await decisionsFor(firstIntent))[0]).toMatchObject({ outcome: 'ALLOWED', rolloutEnabled: true, consumed: 1 });
    // After deactivation the second frozen obligation is still revalidated, and a BLOCKED market sends nothing.
    harness.beforeConsume = null;
    await db.query(`UPDATE "OrderIntent" SET status='pending', "blockReason"=NULL WHERE id=$1`, [secondIntent]);
    await composition({ trend: 'DOWN' });
    await dispatch();
    expect(posts('deb-1')).toBe(0);
    expect((await decisionsFor(secondIntent))[0]).toMatchObject({ outcome: 'BLOCKED', rolloutEnabled: false });
    expect(await count(`"OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId" IN ($1,$2)`, [firstIntent, secondIntent])).toBe(2);
    await setRollout(true, 'Reactivate enforcement');
  });

  // 19: an abandoned preparation never becomes a reusable permission.
  it('never lets a crashed preparation become a reusable dispatch permission', async () => {
    const fixture = await enforced('CRSH');
    const intentId = await admitted(fixture, 'crsh-1');
    const { guard, worker } = await services();
    await emulateWorkerClaim(intentId);
    const crashed = await guard.prepareEntryBrokerDispatch({ orderIntentId: intentId, tradingAccountId: paperId, symbol: 'CRSH', clientOrderId: 'crsh-1' });
    expect(crashed).toMatchObject({ enforcement: 'FROZEN_OBLIGATION', decisionId: expect.any(Number) });
    // A second process prepares again: the first decision is superseded and can never be consumed.
    const second = await guard.prepareEntryBrokerDispatch({ orderIntentId: intentId, tradingAccountId: paperId, symbol: 'CRSH', clientOrderId: 'crsh-1' });
    await expect(db.query(`INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,'crsh-1','{}')`, [crashed.decisionId, intentId])).rejects.toThrow(/BROKER_DISPATCH_DECISION_SUPERSEDED/);
    // Stale-submission recovery confirms absence and, because the adapter-invocation marker was never
    // written (the crash preceded the final authorization), proves non-dispatch and releases.
    await db.query(`UPDATE "OrderIntent" SET "updatedAt" = now() - interval '10 minutes' WHERE id=$1`, [intentId]);
    await worker.recoverStaleSubmittingIntentsForAccount(paperId);
    expect(await intentState(intentId)).toMatchObject({ status: 'failed', claimReleased: true, releaseReason: 'RECOVERY_CONFIRMED_NEVER_SUBMITTED' });
    await expect(db.query(`INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,'crsh-1','{}')`, [second.decisionId, intentId])).rejects.toThrow(/BROKER_DISPATCH_INTENT_NOT_EXECUTABLE/);
    expect(posts('crsh-1')).toBe(0);
    // ALLOWED decisions cannot be minted for a non-executable intent at all.
    await expect(guard.prepareEntryBrokerDispatch({ orderIntentId: intentId, tradingAccountId: paperId, symbol: 'CRSH', clientOrderId: 'crsh-1' })).rejects.toMatchObject({ outcome: 'ENTRY_IDENTITY_MISMATCH' });
  });

  // 21: worker-time risk rejection is a definite non-send before the broker boundary.
  it('releases the claim safely after a worker-time risk rejection without a broker-time decision', async () => {
    const fixture = await enforced('RISK');
    const intentId = await admitted(fixture, 'risk-1');
    harness.workerRiskBlocked.add(fixture.assignmentId);
    await dispatch();
    harness.workerRiskBlocked.delete(fixture.assignmentId);
    expect(posts('risk-1')).toBe(0);
    expect(await decisionsFor(intentId)).toHaveLength(0);
    expect(await intentState(intentId)).toMatchObject({ status: 'blocked', blockReason: 'Daily entry order limit reached.', claimReleased: true, releaseReason: 'WORKER_RISK_RECHECK_BLOCKED' });
  });

  // 22: once dispatch started, uncertainty never causes a duplicate POST or unsafe claim release.
  it('keeps a started dispatch uncertain, never releases its claim as unsubmitted, and never authorizes another POST', async () => {
    const fixture = await enforced('UNCR');
    const intentId = await admitted(fixture, 'uncr-1');
    const { errors, claims, guard } = await services();
    harness.submitError = async () => new errors.BrokerWriteDeliveryError({ classification: 'DELIVERY_UNCERTAIN', message: 'response timeout after possible acceptance' });
    await dispatch();
    harness.submitError = null;
    expect(posts('uncr-1')).toBe(1);
    expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringContaining('DELIVERY_UNCERTAIN'), claimStatus: 'UNRESOLVED', claimReleased: false, consumptions: 1 });
    await expect(claims.releaseUnsubmittedEntryExposureClaim({ orderIntentId: intentId, reason: 'UNSAFE' })).rejects.toMatchObject({ details: { code: 'ENTRY_EXPOSURE_UNRESOLVED' } });
    // Even if an operator requeued it, prior dispatch evidence keeps it out of a new POST.
    await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [intentId]);
    await dispatch();
    expect(posts('uncr-1')).toBe(1);
    await db.query(`UPDATE "OrderIntent" SET status='submitting' WHERE id=$1`, [intentId]);
    await expect(guard.prepareEntryBrokerDispatch({ orderIntentId: intentId, tradingAccountId: paperId, symbol: 'UNCR', clientOrderId: 'uncr-1' })).rejects.toMatchObject({ outcome: expect.stringMatching(/TECHNICAL_FAILURE|ENTRY_IDENTITY_MISMATCH/) });
    expect(await count(`"MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1`, [intentId])).toBe(1);
  });

  // 24: decisions are isolated by account, assignment and Security.
  it('isolates broker-time decisions across PAPER accounts, assignments and Securities', async () => {
    const shared = await enforced('ISO');
    const otherAccount = await grant({ ...shared, accountId: secondPaperId, assignmentId: await assign(secondPaperId, shared.subscriptionId) });
    const neighbor = await enforced('ISN');
    const paperIntent = await admitted(shared, 'iso-paper');
    const otherIntent = await admitted(otherAccount, 'iso-other');
    const neighborIntent = await admitted(neighbor, 'isn-1');
    await revoke(otherAccount, 'Revoke only the second account');
    await revoke(neighbor, 'Revoke only the neighbor Security');
    await dispatch();
    await dispatch(secondPaperId);
    expect([posts('iso-paper'), posts('iso-other'), posts('isn-1')]).toEqual([1, 0, 0]);
    expect((await decisionsFor(paperIntent))[0]).toMatchObject({ outcome: 'ALLOWED', tradingAccountId: paperId, authorizationId: shared.authorizationId });
    expect((await decisionsFor(otherIntent))[0]).toMatchObject({ outcome: 'AUTHORIZATION_REVOKED', tradingAccountId: secondPaperId, authorizationId: otherAccount.authorizationId });
    expect((await decisionsFor(neighborIntent))[0]).toMatchObject({ outcome: 'AUTHORIZATION_REVOKED', securitySymbol: 'ISN' });
  });

  it('enforces identity, bounded single use and the five-gate contract in PostgreSQL', async () => {
    const fixture = await enforced('DBC');
    const intentId = await admitted(fixture, 'dbc-1');
    const { guard } = await services();
    await emulateWorkerClaim(intentId);
    const prepared = await guard.prepareEntryBrokerDispatch({ orderIntentId: intentId, tradingAccountId: paperId, symbol: 'DBC', clientOrderId: 'dbc-1' });
    const decision = await one(`SELECT * FROM "MarketPolicyBrokerDispatchDecision" WHERE id=$1`, [prepared.decisionId]);
    const columns = Object.keys(decision).filter(key => key !== 'id' && key !== 'createdAt');
    const forge = (overrides: Record<string, unknown>) => {
      const values = columns.map(key => key in overrides ? overrides[key] : key === 'decisionKey' ? randomUUID() : key === 'dispatchSequence' ? decision.dispatchSequence + 1 : key === 'evidenceJson' ? JSON.stringify(decision.evidenceJson) : decision[key]);
      return db.query(`INSERT INTO "MarketPolicyBrokerDispatchDecision" (${columns.map(key => `"${key}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, values);
    };
    // A forged ALLOWED from outside the evaluation transaction, with substituted identity, or without gates.
    await expect(forge({})).rejects.toThrow(/evaluated at current PostgreSQL time/);
    await db.query('BEGIN');
    await expect(forge({ evaluatedAt: (await one(`SELECT date_trunc('milliseconds', clock_timestamp()) AS at`)).at, policyRevisionId: fixture.generation!.policyRevisionId + 1000 })).rejects.toThrow(/mirror the exact frozen obligation/);
    await db.query('ROLLBACK');
    await db.query('BEGIN');
    try {
      const at = (await one(`SELECT date_trunc('milliseconds', clock_timestamp()) AS at`)).at as Date;
      await forge({ evaluatedAt: at, dispatchExpiresAt: new Date(Math.min(decision.validUntil.getTime(), at.getTime() + 30_000)) });
      await expect(db.query('COMMIT')).rejects.toThrow(/exactly five dimension gates/);
    } finally {
      await db.query('ROLLBACK').catch(() => undefined);
    }
    // L2: commit-compatible precision for in-transaction evaluation.
    await db.query('BEGIN');
    expect(await one(`SELECT "market_policy_evaluated_in_current_transaction"(date_trunc('milliseconds', transaction_timestamp())) AS same, "market_policy_evaluated_in_current_transaction"(date_trunc('milliseconds', transaction_timestamp()) - interval '1 millisecond') AS before, "market_policy_evaluated_in_current_transaction"(clock_timestamp() + interval '1 second') AS future`)).toEqual({ same: true, before: false, future: false });
    await db.query('COMMIT');
    // A consumption for another intent's decision, and a second consumption per intent, are rejected.
    await prepared.authorizeDispatch(null);
    // The committed consumption is detected (as after a lost acknowledgement): nothing more is sent.
    await expect(prepared.authorizeDispatch(null)).rejects.toMatchObject({ code: 'ENTRY_DISPATCH_RECORD_EXISTS', record: 'CONSUMPTION' });
    expect(await count(`"MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1`, [intentId])).toBe(1);
    expect(posts('dbc-1')).toBe(0);
  });

  describe('Phase 3C.2 follow-up corrections (Hermes L1, L4, L5, L6)', () => {
    it('L1: rejects an admitted ALLOWED attempt whose evidence expires before its transaction commits', async () => {
      const fixture = await enforced('LONE');
      await composition({ trend: 'UP', trendValidUntil: new Date(Date.now() + 1_200) });
      // A test-only deferred trigger delays commit after every row was inserted with valid evidence.
      await db.query(`CREATE FUNCTION test_delay_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."clientOrderId" = 'lone-1' THEN PERFORM pg_sleep(1.6); END IF; RETURN NULL; END $$`);
      await db.query(`CREATE CONSTRAINT TRIGGER "aaa_test_delay_commit" AFTER INSERT ON "OrderIntent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_delay_commit()`);
      try {
        await expect(submit(fixture.assignmentId, 'lone-1')).rejects.toMatchObject({ statusCode: 503, details: { code: 'MARKET_POLICY_ENFORCEMENT_TECHNICAL_FAILURE' } });
      } finally {
        await db.query(`DROP TRIGGER "aaa_test_delay_commit" ON "OrderIntent"`);
        await db.query(`DROP FUNCTION test_delay_commit()`);
      }
      expect(await count(`"OrderIntent" WHERE "clientOrderId"='lone-1'`)).toBe(0);
      expect(await count(`"MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId"='lone-1' AND "orderIntentCreated"`)).toBe(0);
      expect(await one(`SELECT "technicalDiagnostic" FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId"='lone-1' AND outcome='TECHNICAL_FAILURE'`)).toMatchObject({ technicalDiagnostic: expect.stringContaining('expired before its OrderIntent committed') });
    });

    it('L4: an ALLOWED attempt that created no OrderIntent can never become an executable broker authorization', async () => {
      const first = await enforced('LFOUR');
      const altStrategyId = await strategy('phase3c3-alt');
      const altSubscriptionId = await subscription('sub-lfour-alt', altStrategyId, first.securityId, 'LFOUR');
      const alt = await grant({ ...first, subscriptionId: altSubscriptionId, assignmentId: await assign(paperId, altSubscriptionId) });
      await composition({ trend: 'UP' });
      const results = await Promise.allSettled([submit(first.assignmentId, 'lfour-a'), submit(alt.assignmentId, 'lfour-b')]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const orphan = await one(`SELECT * FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId" IN ('lfour-a','lfour-b') AND outcome='ALLOWED' AND NOT "orderIntentCreated"`);
      const winner = await one(`SELECT id FROM "OrderIntent" WHERE "clientOrderId" IN ('lfour-a','lfour-b')`);
      await expect(db.query(`INSERT INTO "OrderIntentMarketPolicyEnforcementObligation" ("orderIntentId","admissionAttemptId","obligationVersion",environment,"tradingAccountId","accountSubscriptionId","subscriptionId","securityId","securitySymbol","strategyId","policyRevisionId","enrollmentGenerationId","authorizationId","authorizationFingerprint","authorityVersion","admissionVersion","evaluatorVersion","marketRegimeAssessmentId","compositionSourceSetFingerprint","evaluatedAt","validUntil","rolloutVersion","frozenContextJson") VALUES ($1,$2,'MARKET_POLICY_ENTRY_OBLIGATION_V1','PAPER',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'{}')`,
        [winner.id, orphan.id, orphan.tradingAccountId, orphan.accountSubscriptionId, orphan.subscriptionId, orphan.securityId, orphan.securitySymbol, orphan.strategyId, orphan.policyRevisionId, orphan.enrollmentGenerationId, orphan.authorizationId, orphan.authorizationFingerprint, orphan.authorityVersion, orphan.admissionVersion, orphan.evaluatorVersion, orphan.marketRegimeAssessmentId, orphan.compositionSourceSetFingerprint, orphan.evaluatedAt, orphan.validUntil, orphan.rolloutVersion])).rejects.toThrow(/duplicate key|must mirror its exact ALLOWED admission attempt/);
      expect(await count(`"MarketPolicyBrokerDispatchDecision" d JOIN "OrderIntentMarketPolicyEnforcementObligation" o ON o.id=d."obligationId" WHERE o."admissionAttemptId"=$1`, [orphan.id])).toBe(0);
      await dispatch();
      expect(posts('lfour-a') + posts('lfour-b')).toBe(1);
    });

    it('L5: reports unresolved lapses, including V1 grants invalidated for Security-binding reapproval', async () => {
      const { readiness } = await services();
      const report = await readiness.assessMarketPolicyBrokerEnforcementReadiness();
      expect(report.unresolvedLapses).toEqual(expect.arrayContaining([expect.objectContaining({
        authorizationId: legacyAuthorizationId, authorityVersion: 'PAPER_MARKET_POLICY_ENFORCEMENT_V1', invalidationReasonCode: 'AUTHORITY_BINDING_REAPPROVAL_REQUIRED',
        invalidationSource: 'MIGRATION', securityBindingReapprovalRequired: true, entryBehaviorWhileRolloutActive: 'FAIL_CLOSED',
      })]));
      expect(report.activationGuard.reasons).toContain('UNRESOLVED_AUTHORIZATION_LAPSES_FAIL_CLOSED');
      // Owner-resolved lapses are no longer reported.
      expect(report.unresolvedLapses.every(lapse => lapse.authorizationId !== undefined)).toBe(true);
    });

    it('L6: an invalidation that commits before authorization locking fails the admission closed', async () => {
      const fixture = await enforced('LSIX');
      await composition({ trend: 'UP' });
      const invalidator = await client();
      await invalidator.query('BEGIN');
      await invalidator.query(`UPDATE "AssignmentMarketPolicyEnforcementAuthorization" SET status='INVALIDATED', "invalidationReasonCode"='ENROLLMENT_DISABLED', "invalidationSource"='ENROLLMENT_GENERATION_TRIGGER' WHERE id=$1`, [fixture.authorizationId]);
      const admission = submit(fixture.assignmentId, 'lsix-1').catch(error => error);
      await waitForLockWaiters(1);
      await invalidator.query('COMMIT');
      expect(await admission).toMatchObject({ statusCode: 403, details: { code: 'MARKET_POLICY_ENFORCEMENT_LAPSED' } });
      expect(await count(`"OrderIntent" WHERE "clientOrderId"='lsix-1'`)).toBe(0);
    });

    it('L6: a grant racing a NEVER_AUTHORIZED legacy admission never makes that ungated intent executable', async () => {
      const fixture = await instrument('LGRT');
      const generation = await enroll(paperId, fixture.assignmentId);
      await composition({ trend: 'DOWN' });
      const holder = await client();
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${fixture.securityId}`]);
      const admission = submit(fixture.assignmentId, 'lgrt-1');
      await waitForLockWaiters(1);
      const { authz } = await services();
      const granting = authz.grantAssignmentMarketPolicyEnforcementAuthorization(paperId, fixture.assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'Grant during legacy admission' }, ownerId).catch(error => error);
      await waitForLockWaiters(2);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${fixture.securityId}`]);
      const admitted = await admission;
      expect(admitted).not.toHaveProperty('marketPolicyEnforcement');
      const granted = await granting;
      if (granted instanceof Error) await authz.grantAssignmentMarketPolicyEnforcementAuthorization(paperId, fixture.assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'Grant after legacy admission' }, ownerId);
      expect(await count(`"AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId"=$1 AND status='AUTHORIZED'`, [fixture.assignmentId])).toBe(1);
      await dispatch();
      expect(posts('lgrt-1')).toBe(0);
      expect((await decisionsFor(admitted.intentId))[0]).toMatchObject({ outcome: 'LEGACY_UNOBLIGATED_QUARANTINED' });
    });

    it('L6: activation racing admission yields an un-obligated intent that is quarantined; deactivation racing admission keeps its obligation', async () => {
      const activationFixture = await enforced('LACT');
      await setRollout(false, 'Inactive before racing activation');
      await composition({ trend: 'UP' });
      const holder = await client();
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${activationFixture.securityId}`]);
      const legacyAdmission = submit(activationFixture.assignmentId, 'lact-1');
      await waitForLockWaiters(1);
      const activation = setRollout(true, 'Activate during admission');
      await waitForLockWaiters(2);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${activationFixture.securityId}`]);
      const legacyIntent = await legacyAdmission;
      await activation;
      expect(legacyIntent).not.toHaveProperty('marketPolicyEnforcement');
      await dispatch();
      expect(posts('lact-1')).toBe(0);
      expect((await decisionsFor(legacyIntent.intentId))[0]).toMatchObject({ outcome: 'LEGACY_UNOBLIGATED_QUARANTINED' });

      const deactivationFixture = await enforced('LDEA');
      await composition({ trend: 'UP' });
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${deactivationFixture.securityId}`]);
      const enforcedAdmission = submit(deactivationFixture.assignmentId, 'ldea-1');
      await waitForLockWaiters(1);
      const deactivation = setRollout(false, 'Deactivate during admission');
      await waitForLockWaiters(2);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`entry-exposure:${paperId}:${deactivationFixture.securityId}`]);
      const enforcedIntent = await enforcedAdmission;
      await deactivation;
      expect(enforcedIntent.marketPolicyEnforcement).toBeDefined();
      await dispatch();
      expect(posts('ldea-1')).toBe(1);
      expect((await decisionsFor(enforcedIntent.intentId))[0]).toMatchObject({ outcome: 'ALLOWED', rolloutEnabled: false, consumed: 1 });
      await setRollout(true, 'Reactivate after racing deactivation');
    });

    it('L6: AUTHORIZATION_INEFFECTIVE fails closed at admission and at the broker boundary', async () => {
      const fixture = await enforced('LINE');
      const intentId = await admitted(fixture, 'line-1');
      // Simulate an out-of-band identity drift that bypassed the invalidation trigger.
      await db.query(`ALTER TABLE "Subscription" DISABLE TRIGGER "Subscription_invalidate_enforcement_authorization"`);
      try {
        await db.query(`UPDATE "Subscription" SET symbol='LINX' WHERE id=$1`, [fixture.subscriptionId]);
        expect(await one(`SELECT status FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [fixture.authorizationId])).toEqual({ status: 'AUTHORIZED' });
        await dispatch();
        expect(posts('line-1')).toBe(0);
        expect((await decisionsFor(intentId))[0]).toMatchObject({ outcome: 'AUTHORIZATION_INEFFECTIVE', reasonCode: 'SECURITY_IDENTITY_INCONSISTENT', authorizationStatus: 'AUTHORIZED' });
        await composition({ trend: 'UP' });
        await expect(submit(fixture.assignmentId, 'line-2')).rejects.toMatchObject({ statusCode: 403, details: { code: 'MARKET_POLICY_AUTHORIZATION_INEFFECTIVE' } });
      } finally {
        await db.query(`UPDATE "Subscription" SET symbol='LINE' WHERE id=$1`, [fixture.subscriptionId]);
        await db.query(`ALTER TABLE "Subscription" ENABLE TRIGGER "Subscription_invalidate_enforcement_authorization"`);
      }
    });

    it('L6: a BLOCKED n8n signal entry is a terminal domain outcome with no intent, retry or broker order', async () => {
      const fixture = await enforced('LSIG');
      await composition({ trend: 'DOWN' });
      const { signals } = await services();
      const signal = { source: 'n8n', decisionKey: `lsig-${randomUUID()}`, reason: 'test' };
      const first = await signals.processTargetedEntrySignal({ tradingAccountSubscriptionId: fixture.assignmentId, ...signal } as never);
      expect(first).toMatchObject({ outcome: 'BLOCKED', code: 'MARKET_POLICY_BLOCKED', orderIntentId: null });
      await dispatch();
      expect(await count(`"OrderIntent" WHERE "tradingAccountSubscriptionId"=$1`, [fixture.assignmentId])).toBe(0);
      expect(harness.submitCalls.filter(call => call.payload.symbol === 'LSIG')).toHaveLength(0);
      expect(await count(`"SystemEvent" WHERE type='signal_entry_assignment_outcome' AND "payloadJson"->>'code'='MARKET_POLICY_BLOCKED' AND "tradingAccountId"=$1`, [paperId])).toBeGreaterThanOrEqual(1);
    });

    it('L6: never selects FAILED or wrong-version compositions and always uses the newest committed one', async () => {
      const fixture = await enforced('LCMP');
      await composition({ trend: 'DOWN' });
      await composition({ trend: 'UP', failed: true });
      await composition({ trend: 'UP', compositionVersion: 'MARKET_REGIME_COMPOSITION_V0' });
      await expect(submit(fixture.assignmentId, 'lcmp-1')).rejects.toMatchObject({ details: { code: 'MARKET_POLICY_BLOCKED' } });
      // A wrong-algorithm source cannot even be published: the composition identity CHECK rejects it.
      await expect(composition({ trend: 'UP', trendAlgorithm: 'TREND_V0' })).rejects.toThrow(/identity_check/);
      await db.query('ROLLBACK').catch(() => undefined);
      // Superseded composition: an ALLOWED admission is re-gated against the newer committed vector.
      const intentId = await admitted(fixture, 'lcmp-3');
      await composition({ trend: 'DOWN' });
      await dispatch();
      expect(posts('lcmp-3')).toBe(0);
      expect((await decisionsFor(intentId))[0]).toMatchObject({ outcome: 'BLOCKED' });
    });
  });

  describe('Phase 3C.3 corrections (Hermes MEDIUM-1 final un-obligated authorization, HIGH-1 dispatched claim recovery)', () => {
    const later = (ms: number) => new Date(Date.now() + ms);
    // One PAPER account per holder: each scenario gets its own holder, so account-scoped sweeps are isolated.
    const freshAccount = async (name: string) => account(`Recovery ${name}`, 'PAPER', await user(`holder-${name.toLowerCase()}-${randomUUID()}@phase3c3.test`, 'SYSTEM_OWNER'));
    const claimIdOf = async (orderIntentId: number) => (await one(`SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [orderIntentId])).id as number;
    const claimEvents = async (orderIntentId: number, eventType: string) => (await db.query(`SELECT e."evidenceJson", e."createdAt" FROM "EntryExposureClaimEvent" e JOIN "EntryExposureClaim" c ON c.id=e."claimId" WHERE c."orderIntentId"=$1 AND e."eventType"=$2 ORDER BY e.id`, [orderIntentId, eventType])).rows;
    const unenforcedFor = async (orderIntentId: number) => (await db.query(`SELECT * FROM "MarketPolicyBrokerUnenforcedDispatch" WHERE "orderIntentId"=$1`, [orderIntentId])).rows;
    async function regrant(fixture: Fixture) {
      const { authz } = await services();
      const authorization = await authz.grantAssignmentMarketPolicyEnforcementAuthorization(fixture.accountId, fixture.assignmentId, { generationId: fixture.generation!.id, expectedConfigurationFingerprint: fixture.generation!.configurationFingerprint, expectedPolicyRevisionId: fixture.generation!.policyRevisionId, reason: 'Re-grant during dispatch' }, ownerId);
      fixture.authorizationId = authorization!.id;
      return fixture;
    }
    async function localBlocked(symbol: string, clientOrderId: string, acct: number, verifyAtWorkerTime = true) {
      const { errors } = await services();
      const fixture = await enforced(symbol, mainStrategyId, acct);
      const intentId = await admitted(fixture, clientOrderId);
      harness.adapterLocalError = async () => new errors.BrokerWriteDeliveryError({ classification: 'NOT_SENT_BLOCKED', message: `Broker write blocked because TradingAccount ${acct} credentials are unavailable.` });
      if (!verifyAtWorkerTime) harness.openBuyFailures.add(symbol);
      await dispatch(acct);
      harness.adapterLocalError = null;
      harness.openBuyFailures.delete(symbol);
      return { fixture, intentId };
    }

    // MEDIUM-1 (1): a grant committed before the final authorization quarantines the queued entry.
    it('quarantines a NEVER_AUTHORIZED queued entry when the owner grants authority before final dispatch authorization', async () => {
      const acct = await freshAccount('M1');
      const fixture = await instrument('MNA', mainStrategyId, acct);
      await composition({ trend: 'DOWN' });
      const queued = await submit(fixture.assignmentId, 'mna-1');
      expect(queued).not.toHaveProperty('marketPolicyEnforcement');
      harness.beforeConsume = async () => { await grant(fixture); };
      expect(await dispatch(acct)).toMatchObject({ blocked: 1, submitted: 0 });
      expect(posts('mna-1')).toBe(0);
      const decisions = await decisionsFor(queued.intentId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ outcome: 'LEGACY_UNOBLIGATED_QUARANTINED', reasonCode: 'UNOBLIGATED_ENTRY_UNDER_ENFORCED_AT_FINAL_AUTHORIZATION', authorizationId: fixture.authorizationId, dispatchDisposition: 'DEFINITELY_NOT_SENT', consumed: 0 });
      expect(decisions[0].evidenceJson).toMatchObject({ stage: 'FINAL_DISPATCH_AUTHORIZATION' });
      expect(await unenforcedFor(queued.intentId)).toHaveLength(0);
      expect(await intentState(queued.intentId)).toMatchObject({ status: 'blocked', claimReleased: true, brokerOrders: 0 });
    });

    // MEDIUM-1 (2): activation with an effective authorization committed before final authorization.
    it('quarantines an entry queued under an inactive rollout when the rollout activates before final dispatch authorization', async () => {
      const acct = await freshAccount('M2');
      const fixture = await enforced('MNB', mainStrategyId, acct);
      await setRollout(false, 'Pause enforcement for M2');
      try {
        await composition({ trend: 'DOWN' });
        const queued = await submit(fixture.assignmentId, 'mnb-1');
        expect(queued).not.toHaveProperty('marketPolicyEnforcement');
        harness.beforeConsume = async () => { await setRollout(true, 'Activate during M2 dispatch'); };
        await dispatch(acct);
        expect(posts('mnb-1')).toBe(0);
        expect(await decisionsFor(queued.intentId)).toEqual([expect.objectContaining({ outcome: 'LEGACY_UNOBLIGATED_QUARANTINED', reasonCode: 'UNOBLIGATED_ENTRY_UNDER_ENFORCED_AT_FINAL_AUTHORIZATION', rolloutEnabled: true })]);
        expect(await unenforcedFor(queued.intentId)).toHaveLength(0);
        expect(await intentState(queued.intentId)).toMatchObject({ status: 'blocked', claimReleased: true });
      } finally {
        if (!(await one(`SELECT enabled FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id=1`)).enabled) await setRollout(true, 'Restore enforcement after M2');
      }
    });

    // MEDIUM-1 (3): a new grant after deliberate owner revocation or opt-out.
    it.each(['OWNER_REVOKED', 'OWNER_OPTED_OUT'] as const)('quarantines a %s queued entry when a new grant commits before final dispatch authorization', async (disposition) => {
      const acct = await freshAccount(`M3-${disposition}`);
      const symbol = disposition === 'OWNER_REVOKED' ? 'MNC' : 'MNO';
      const fixture = await enforced(symbol, mainStrategyId, acct);
      const { enrollment, authz } = await services();
      if (disposition === 'OWNER_REVOKED') {
        await revoke(fixture, 'Deliberate return to non-enforced behavior');
      } else {
        await enrollment.disableAssignmentMarketPolicyEnrollment(acct, fixture.assignmentId, fixture.generation!.id, ownerId, 'Disable before opt-out');
        await authz.resolveAssignmentMarketPolicyEnforcementLapse(acct, fixture.assignmentId, { authorizationId: fixture.authorizationId!, reason: 'Opt out for future entries', confirmNonEnforced: true }, ownerId);
      }
      await composition({ trend: 'DOWN' });
      const queued = await submit(fixture.assignmentId, `${symbol.toLowerCase()}-1`);
      expect(queued).not.toHaveProperty('marketPolicyEnforcement');
      harness.beforeConsume = async () => { if (disposition === 'OWNER_REVOKED') await regrant(fixture); else await grant(fixture); };
      await dispatch(acct);
      expect(posts(`${symbol.toLowerCase()}-1`)).toBe(0);
      expect(await decisionsFor(queued.intentId)).toEqual([expect.objectContaining({ outcome: 'LEGACY_UNOBLIGATED_QUARANTINED', reasonCode: 'UNOBLIGATED_ENTRY_UNDER_ENFORCED_AT_FINAL_AUTHORIZATION', authorizationId: fixture.authorizationId })]);
      expect(await intentState(queued.intentId)).toMatchObject({ status: 'blocked', claimReleased: true });
    });

    // MEDIUM-1 (4): the documented residual boundary. Authority committed after the final
    // authorization cannot recall the in-flight POST; it serializes behind it instead.
    it('serializes a grant behind the final non-enforced authorization and cannot recall the subsequent POST', async () => {
      const acct = await freshAccount('M4');
      const fixture = await instrument('MND', mainStrategyId, acct);
      const generation = await enroll(acct, fixture.assignmentId);
      await composition({ trend: 'DOWN' });
      const queued = await submit(fixture.assignmentId, 'mnd-1');
      const holder = await client();
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`entry-exposure:${acct}:${fixture.securityId}`]);
      const worker = dispatch(acct);
      // The final authorization holds the rollout, assignment (KEY SHARE) and authorization locks and waits at the advisory lock.
      await waitForLockWaiters(1);
      const { authz } = await services();
      let granted = false;
      const grantAttempt = authz.grantAssignmentMarketPolicyEnforcementAuthorization(acct, fixture.assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'Grant racing the final authorization' }, ownerId).then((row) => { granted = true; return row; });
      await waitForLockWaiters(2);
      await sleep(200);
      expect(granted).toBe(false);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`entry-exposure:${acct}:${fixture.securityId}`]);
      await worker;
      const authorization = await grantAttempt;
      expect(posts('mnd-1')).toBe(1);
      const [record] = await unenforcedFor(queued.intentId);
      expect(record).toMatchObject({ basis: 'NEVER_AUTHORIZED', latestAuthorizationId: null, rolloutEnabled: true, clientOrderId: 'mnd-1', environment: 'PAPER' });
      const committed = await one(`SELECT "authorizedAt" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [authorization!.id]);
      expect(committed.authorizedAt.getTime()).toBeGreaterThanOrEqual(record.authorizedAt.getTime());
      expect(await decisionsFor(queued.intentId)).toHaveLength(0);
      expect(await intentState(queued.intentId)).toMatchObject({ status: 'submitted', claimStatus: 'BROKER_ORDER_ACTIVE', brokerOrders: 1 });
      // A grant inside the in-flight POST (after the final commit) is the same residual race.
      const second = await instrument('MNE', mainStrategyId, acct);
      const queuedSecond = await submit(second.assignmentId, 'mne-1');
      harness.onSubmit = async () => { await grant(second); };
      await dispatch(acct);
      expect(posts('mne-1')).toBe(1);
      expect(await unenforcedFor(queuedSecond.intentId)).toEqual([expect.objectContaining({ basis: 'NEVER_AUTHORIZED' })]);
    });

    it('records one immutable final non-enforced authorization per un-obligated PAPER entry, never for LIVE, and PostgreSQL refuses it when enforcement applies', async () => {
      const acct = await freshAccount('MREC');
      await composition({ trend: 'DOWN' });
      const never = await instrument('MRN', mainStrategyId, acct);
      const revoked = await enforced('MRR', mainStrategyId, acct);
      await revoke(revoked);
      const live = await instrument('MRL', mainStrategyId, liveId);
      const neverIntent = await submit(never.assignmentId, 'mrn-1');
      const revokedIntent = await submit(revoked.assignmentId, 'mrr-1');
      const liveIntent = await submit(live.assignmentId, 'mrl-1');
      await dispatch(acct);
      await dispatch(liveId);
      expect([posts('mrn-1'), posts('mrr-1'), posts('mrl-1')]).toEqual([1, 1, 1]);
      expect(await unenforcedFor(neverIntent.intentId)).toEqual([expect.objectContaining({ basis: 'NEVER_AUTHORIZED', latestAuthorizationId: null })]);
      expect(await unenforcedFor(revokedIntent.intentId)).toEqual([expect.objectContaining({ basis: 'OWNER_REVOKED', latestAuthorizationId: revoked.authorizationId, latestAuthorizationStatus: 'REVOKED' })]);
      expect(await unenforcedFor(liveIntent.intentId)).toHaveLength(0);
      const [record] = await unenforcedFor(neverIntent.intentId);
      await expect(db.query(`UPDATE "MarketPolicyBrokerUnenforcedDispatch" SET basis='OWNER_REVOKED' WHERE id=$1`, [record.id])).rejects.toThrow(/immutable/);
      await expect(db.query(`DELETE FROM "MarketPolicyBrokerUnenforcedDispatch" WHERE id=$1`, [record.id])).rejects.toThrow(/immutable/);
      // A forged non-enforced authorization for an assignment that now requires enforcement.
      const forged = await enforced('MRF', mainStrategyId, acct);
      await setRollout(false, 'Queue MRF without an obligation');
      let forgedIntentId: number;
      try {
        forgedIntentId = (await submit(forged.assignmentId, 'mrf-1')).intentId;
      } finally {
        await setRollout(true, 'Resume enforcement after MRF');
      }
      await emulateWorkerClaim(forgedIntentId);
      const rollout = await one(`SELECT enabled, version FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id=1`);
      await expect(db.query(`INSERT INTO "MarketPolicyBrokerUnenforcedDispatch" ("orderIntentId","clientOrderId",environment,"tradingAccountId","accountSubscriptionId","securityId","securitySymbol",basis,"latestAuthorizationId","latestAuthorizationStatus","rolloutEnabled","rolloutVersion","evidenceJson") VALUES ($1,'mrf-1','PAPER',$2,$3,$4,'MRF','NEVER_AUTHORIZED',$5,'AUTHORIZED',true,$6,'{}')`,
        [forgedIntentId, acct, forged.assignmentId, forged.securityId, forged.authorizationId, rollout.version])).rejects.toThrow(/UNENFORCED_DISPATCH_ENFORCEMENT_REQUIRED|UnenforcedDispatch_basis_check/);
      await expect(db.query(`INSERT INTO "MarketPolicyBrokerUnenforcedDispatch" ("orderIntentId","clientOrderId",environment,"tradingAccountId","accountSubscriptionId","securityId","securitySymbol",basis,"latestAuthorizationId","latestAuthorizationStatus","rolloutEnabled","rolloutVersion","evidenceJson") VALUES ($1,'mrf-1','PAPER',$2,$3,$4,'MRF','OWNER_REVOKED',$5,'REVOKED',true,$6,'{}')`,
        [forgedIntentId, acct, forged.assignmentId, forged.securityId, forged.authorizationId, rollout.version])).rejects.toThrow(/UNENFORCED_DISPATCH_AUTHORIZATION_CHANGED/);
      await db.query(`UPDATE "OrderIntent" SET status='blocked', "blockReason"='TEST_HOLD' WHERE id=$1 AND status='submitting'`, [forgedIntentId]);
      expect(posts('mrf-1')).toBe(0);
      expect(rollout.enabled).toBe(true);
    });

    // HIGH-1 (5): a definitive 4xx after consumption.
    it('records a definitive 4xx after consumption, never resends, and releases only after the settle window and fresh broker verification', async () => {
      const acct = await freshAccount('H5');
      const { errors, recovery } = await services();
      const fixture = await enforced('REJ', mainStrategyId, acct);
      const intentId = await admitted(fixture, 'rej-1');
      harness.submitError = async () => new errors.BrokerWriteDeliveryError({ classification: 'BROKER_REJECTED', message: 'Alpaca explicitly rejected broker write with status 422.', statusCode: 422 });
      expect(await dispatch(acct)).toMatchObject({ failed: 1, submitted: 0 });
      harness.submitError = null;
      expect(posts('rej-1')).toBe(1);
      expect((await decisionsFor(intentId)).map(row => [row.outcome, row.consumed])).toEqual([['ALLOWED', 1]]);
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringContaining('BROKER_WRITE_DELIVERY:BROKER_REJECTED'), claimStatus: 'UNRESOLVED', claimReleased: false, consumptions: 1 });
      const [recorded] = await claimEvents(intentId, 'DISPATCH_OUTCOME_RECORDED');
      expect(recorded.evidenceJson).toMatchObject({ classification: 'BROKER_REJECTED', statusCode: 422, source: 'WORKER', consumptionId: expect.any(Number), dispatchDecisionId: expect.any(Number), deliveryProof: 'HTTP_REJECTION_RESPONSE_REQUIRES_BROKER_VERIFICATION', originalIntentResubmission: 'PROHIBITED' });
      // Inside the settle window a lookup miss never releases ownership.
      expect(await recovery.recoverDispatchedEntryClaimsForAccount(acct)).toMatchObject({ examined: 1, released: 0 });
      expect((await claimEvents(intentId, 'DISPATCH_RECOVERY_RELEASE_BLOCKED')).at(-1)!.evidenceJson).toMatchObject({ blockers: ['BROKER_REJECTION_SETTLING'] });
      expect(await intentState(intentId)).toMatchObject({ claimReleased: false });
      // After settling, fresh exact lookup, complete open-BUY inventory and position verification release it.
      expect(await recovery.recoverDispatchedEntryClaimsForAccount(acct, later(120_000))).toMatchObject({ examined: 1, released: 1 });
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', claimStatus: 'RELEASED', claimReleased: true, releaseReason: 'VERIFIED_DISPATCH_NO_EXPOSURE:CONFIRMED_BROKER_REJECTION', consumptions: 1 });
      const [release] = await claimEvents(intentId, 'RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE');
      expect(release.evidenceJson).toMatchObject({ mode: 'SYSTEM', basis: 'CONFIRMED_BROKER_REJECTION', executionAuthority: 'NONE', dispatchRecord: 'RETAINED_IMMUTABLE', evidence: { conclusiveness: 'CONCLUSIVE', broker: { order: null, openBuyOrders: [], position: null } } });
      expect(await count(`"SystemEvent" WHERE type='entry_exposure.dispatch_claim_released' AND "entityId"=$1`, [String(await claimIdOf(intentId))])).toBe(1);
      // Never resent, even if an operator requeues the intent; claim history is append-only.
      await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [intentId]);
      await dispatch(acct);
      expect(posts('rej-1')).toBe(1);
      expect(await count(`"MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1`, [intentId])).toBe(1);
      await expect(db.query(`UPDATE "EntryExposureClaimEvent" SET "eventType"='REWRITE' WHERE "claimId"=$1`, [await claimIdOf(intentId)])).rejects.toThrow(/immutable/);
      await expect(db.query(`DELETE FROM "EntryExposureClaimEvent" WHERE "claimId"=$1`, [await claimIdOf(intentId)])).rejects.toThrow(/immutable/);
    });

    // HIGH-1 (6): a local adapter guard after consumption (no network request).
    it('releases a consumed claim after a local NOT_SENT_BLOCKED only through recorded evidence and fresh verification, with zero POSTs', async () => {
      const acct = await freshAccount('H6');
      const { intentId } = await localBlocked('NSB', 'nsb-1', acct);
      expect(posts('nsb-1')).toBe(0);
      expect((await decisionsFor(intentId)).map(row => [row.outcome, row.consumed])).toEqual([['ALLOWED', 1]]);
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringContaining('BROKER_WRITE_DELIVERY:NOT_SENT_BLOCKED'), claimReleased: true, releaseReason: 'VERIFIED_DISPATCH_NO_EXPOSURE:DEFINITE_LOCAL_NON_SEND', consumptions: 1 });
      expect((await claimEvents(intentId, 'DISPATCH_OUTCOME_RECORDED'))[0].evidenceJson).toMatchObject({ classification: 'NOT_SENT_LOCAL_BLOCKED', deliveryProof: 'ADAPTER_FAILED_BEFORE_NETWORK_REQUEST' });
      expect((await claimEvents(intentId, 'RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE'))[0].evidenceJson).toMatchObject({ mode: 'SYSTEM', basis: 'DEFINITE_LOCAL_NON_SEND' });
      // Never released as "unsubmitted".
      expect(await claimEvents(intentId, 'RELEASED_NO_BROKER_EXPOSURE')).toHaveLength(0);
    });

    // HIGH-1 (7): delivery uncertainty after consumption.
    it('retains a claim after uncertain delivery, refuses release on lookup absence, and still recovers a later-discovered broker order', async () => {
      const acct = await freshAccount('H7');
      const { errors, recovery, remediation } = await services();
      const fixture = await enforced('UNC', mainStrategyId, acct);
      const intentId = await admitted(fixture, 'unc-1');
      harness.submitError = async () => new errors.BrokerWriteDeliveryError({ classification: 'DELIVERY_UNCERTAIN', message: 'Broker write delivery is uncertain after a network or response failure.' });
      await dispatch(acct);
      harness.submitError = null;
      expect(posts('unc-1')).toBe(1);
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', claimStatus: 'UNRESOLVED', claimReleased: false, consumptions: 1 });
      // Uncertain delivery is operator-only: the sweep never selects or retries it.
      expect(await recovery.recoverDispatchedEntryClaimsForAccount(acct, later(3_600_000))).toMatchObject({ examined: 0, released: 0 });
      const claimId = await claimIdOf(intentId);
      const preview = await remediation.previewEntryExposureRemediation(claimId);
      expect(preview).toMatchObject({ disposition: 'DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE', eligible: false, blockers: ['DELIVERY_OUTCOME_UNCERTAIN'], investigation: { conclusiveness: 'AMBIGUOUS_ABSENCE', claimRetained: true, releaseRequires: 'POSITIVE_BROKER_ORDER_EVIDENCE' } });
      expect(await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: preview.confirmationFingerprint })).toMatchObject({ released: false, reason: expect.stringContaining('DELIVERY_OUTCOME_UNCERTAIN') });
      await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [intentId]);
      await dispatch(acct);
      expect(posts('unc-1')).toBe(1);
      expect(await intentState(intentId)).toMatchObject({ claimStatus: 'UNRESOLVED', claimReleased: false });
      // The order surfaces later as broker-rejected: the existing terminal broker-order remediation recovers it.
      harness.orders.set('unc-1', { id: 'alpaca-late-unc', client_order_id: 'unc-1', symbol: 'UNC', side: 'buy', status: 'rejected', qty: '1', filled_qty: '0' });
      const terminal = await remediation.previewEntryExposureRemediation(claimId);
      expect(terminal).toMatchObject({ disposition: 'TERMINAL_BROKER_ORDER_NO_EXPOSURE', eligible: true });
      expect(await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: terminal.confirmationFingerprint })).toMatchObject({ released: true, releaseReason: 'BROKER_REJECTED_NO_EXPOSURE' });
      expect(posts('unc-1')).toBe(1);
    });

    it.each([408, 409])('treats HTTP %i after consumption as delivery-uncertain', async (statusCode) => {
      const acct = await freshAccount('H7B');
      const { errors, recovery } = await services();
      const symbol = statusCode === 408 ? 'N48' : 'N49';
      const clientOrderId = `ndf-${statusCode}`;
      const fixture = await enforced(symbol, mainStrategyId, acct);
      const intentId = await admitted(fixture, clientOrderId);
      harness.submitError = async () => new errors.BrokerWriteDeliveryError({ classification: 'BROKER_REJECTED', message: `Alpaca explicitly rejected broker write with status ${statusCode}.`, statusCode });
      await dispatch(acct);
      harness.submitError = null;
      expect(await recovery.recoverDispatchedEntryClaimsForAccount(acct, later(3_600_000))).toMatchObject({ examined: 0, released: 0 });
      const { remediation } = await services();
      expect(await remediation.previewEntryExposureRemediation(await claimIdOf(intentId))).toMatchObject({ eligible: false, blockers: ['BROKER_REJECTION_NOT_DEFINITIVE'], evidence: { conclusiveness: 'AMBIGUOUS_ABSENCE' } });
      expect(await intentState(intentId)).toMatchObject({ claimStatus: 'UNRESOLVED', claimReleased: false });
      expect(posts(clientOrderId)).toBe(1);
    });

    it('enumerates an idle account for terminal-claim recovery and retries a PostgreSQL-injected transient release failure after its bounded interval', async () => {
      const acct = await freshAccount('IDLE');
      await db.query(`INSERT INTO "TradingAccountCredential" ("tradingAccountId","authType",status,"createdAt","updatedAt") VALUES ($1,'API_KEY','ACTIVE',now(),now())`, [acct]);
      const fixture = await enforced('IDL', mainStrategyId, acct);
      const intentId = await admitted(fixture, 'idle-recovery-1');
      await db.query(`UPDATE "OrderIntent" SET status='failed', "blockReason"='BROKER_WRITE_DELIVERY:NOT_SENT_BLOCKED:adapter rejected before fetch' WHERE id=$1`, [intentId]);
      const claimId = await claimIdOf(intentId);
      await db.query(`CREATE FUNCTION test_fail_idle_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'RELEASED' AND NEW.id = ${claimId} THEN RAISE EXCEPTION 'injected transient pool timeout'; END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER test_fail_idle_release BEFORE UPDATE ON "EntryExposureClaim" FOR EACH ROW EXECUTE FUNCTION test_fail_idle_release()`);
      const { worker } = await services();
      try {
        const first = await worker.recoverStaleSubmittingIntents();
        expect(first.results).toEqual(expect.arrayContaining([expect.objectContaining({
          account: expect.objectContaining({ tradingAccountId: acct, exposureSummary: expect.objectContaining({ terminalEntryClaimsDue: 1 }) }),
          outcome: 'PROCESSED',
        })]));
        expect(await intentState(intentId)).toMatchObject({ claimStatus: 'ENTRY_PENDING', claimReleased: false });
        expect((await claimEvents(intentId, 'RECOVERY_ATTEMPT_FAILED'))[0].evidenceJson).toMatchObject({ source: 'TERMINAL_CLAIM_SWEEP', failureClass: 'TECHNICAL', automaticRetry: 'SCHEDULED' });
      } finally {
        await db.query(`DROP TRIGGER test_fail_idle_release ON "EntryExposureClaim"`);
        await db.query(`DROP FUNCTION test_fail_idle_release()`);
      }
      // The attempt was recorded, so an immediate tick neither enumerates nor retries it.
      const second = await worker.recoverStaleSubmittingIntents();
      expect(second.results.find((item) => item.account.tradingAccountId === acct)).toMatchObject({ outcome: 'SKIPPED', account: { exposureSummary: { terminalEntryClaimsDue: 0, terminalEntryClaimsHeld: 1 } } });
      expect(await intentState(intentId)).toMatchObject({ claimStatus: 'ENTRY_PENDING', claimReleased: false });
      // Once the retry interval has elapsed, the proven never-submitted claim recovers.
      await db.query(`UPDATE "EntryExposureClaim" SET "lastDiagnosedAt" = now() - interval '2 minutes' WHERE id=$1`, [claimId]);
      const third = await worker.recoverStaleSubmittingIntents();
      expect(third.results).toEqual(expect.arrayContaining([expect.objectContaining({ account: expect.objectContaining({ tradingAccountId: acct }), outcome: 'PROCESSED' })]));
      expect(await intentState(intentId)).toMatchObject({ claimStatus: 'RELEASED', claimReleased: true, releaseReason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED' });
      expect(posts('idle-recovery-1')).toBe(0);
    });

    // HIGH-1 (8, 10): crash between consumption and the adapter call.
    it('identifies a consumption stranded by a crash before the adapter, retains the claim, and exposes it to readiness and remediation', async () => {
      const acct = await freshAccount('H8');
      const { guard, worker, recovery, remediation, readiness, entryReadiness } = await services();
      const fixture = await enforced('CRC', mainStrategyId, acct);
      const intentId = await admitted(fixture, 'crc-1');
      await emulateWorkerClaim(intentId);
      const prepared = await guard.prepareEntryBrokerDispatch({ orderIntentId: intentId, tradingAccountId: acct, symbol: 'CRC', clientOrderId: 'crc-1' });
      await prepared.authorizeDispatch(null);
      // The process crashes here: consumption committed, adapter never invoked, no outcome recorded.
      await db.query(`UPDATE "OrderIntent" SET "updatedAt" = now() - interval '10 minutes' WHERE id=$1`, [intentId]);
      expect(await worker.recoverStaleSubmittingIntentsForAccount(acct)).toMatchObject({ found: 1, retained: 1, retryable: 0 });
      expect(posts('crc-1')).toBe(0);
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringMatching(/^DISPATCH_STARTED_OUTCOME_UNKNOWN/), claimStatus: 'UNRESOLVED', claimReleased: false, consumptions: 1 });
      expect((await claimEvents(intentId, 'DISPATCH_OUTCOME_RECORDED'))[0].evidenceJson).toMatchObject({ classification: 'DISPATCH_OUTCOME_UNKNOWN', source: 'STALE_RECOVERY', deliveryProof: 'NONE_DELIVERY_UNCERTAIN' });
      // The terminal intent stays visible although stale recovery only selects 'submitting'.
      const report = await entryReadiness.assessEntryExposureReadiness({ tradingAccountIds: [acct] });
      expect(report.databaseReady).toBe(false);
      const consumption = await one(`SELECT id, "decisionId" FROM "MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1`, [intentId]);
      expect(report.terminalIntentsWithUnreleasedClaims).toEqual([expect.objectContaining({
        tradingAccountId: acct, securityId: fixture.securityId, symbol: 'CRC', orderIntentId: intentId, intentStatus: 'failed', clientOrderId: 'crc-1',
        claimId: await claimIdOf(intentId), claimStatus: 'UNRESOLVED', consumptionId: consumption.id, dispatchDecisionId: consumption.decisionId, dispatchDecisionOutcome: 'ALLOWED',
        recordedDeliveryClassification: 'DISPATCH_OUTCOME_UNKNOWN', evidenceConclusiveness: 'AMBIGUOUS_ABSENCE', operatorRemediation: 'INVESTIGATION_REQUIRED', blockerReason: 'DELIVERY_OUTCOME_UNCERTAIN',
        recoveryState: 'OPERATOR_INVESTIGATION', automaticRecoveryPossible: false, systemRecovery: 'OPERATOR_INVESTIGATION_REQUIRED', nextAttemptDueAt: null,
        lastRecoveryResult: null,
      })]);
      const brokerReport = await readiness.assessMarketPolicyBrokerEnforcementReadiness({ tradingAccountIds: [acct] });
      expect(brokerReport.inventory).toEqual([expect.objectContaining({ orderIntentId: intentId, claimStatus: 'UNRESOLVED', dispatchConsumptionId: consumption.id, dispatchDecisionId: consumption.decisionId, terminalWithUnreleasedClaim: true, brokerTimeTreatment: 'EXISTING_RECOVERY_PATHWAY' })]);
      expect(brokerReport.activationGuard.reasons).toContain('TERMINAL_ENTRIES_WITH_UNRELEASED_CLAIMS');
      const preview = await remediation.previewEntryExposureRemediation(await claimIdOf(intentId));
      expect(preview).toMatchObject({ disposition: 'DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE', eligible: false, blockers: ['DELIVERY_OUTCOME_UNCERTAIN'], evidence: { dispatch: { consumptionId: consumption.id, dispatchDecisionId: consumption.decisionId }, orderIntent: { clientOrderId: 'crc-1' } } });
      // Repeated sweeps never select an operator-only claim, so they append nothing.
      expect(await recovery.recoverDispatchedEntryClaimsForAccount(acct, later(120_000))).toMatchObject({ examined: 0 });
      expect(await recovery.recoverDispatchedEntryClaimsForAccount(acct, later(240_000))).toMatchObject({ examined: 0 });
      expect(await claimEvents(intentId, 'DISPATCH_RECOVERY_RELEASE_BLOCKED')).toHaveLength(0);
      expect(await claimEvents(intentId, 'DISPATCH_OUTCOME_RECORDED')).toHaveLength(1);
      expect(await count(`"SystemEvent" WHERE type='entry_exposure.dispatch_outcome_recorded' AND "entityId"=$1`, [String(await claimIdOf(intentId))])).toBe(1);
      expect(posts('crc-1')).toBe(0);
    });

    // HIGH-1 (9): the consumption committed but its acknowledgement was lost.
    it('never sends after a consumption whose acknowledgement was lost, and recovers the claim from evidence', async () => {
      const acct = await freshAccount('H9');
      const fixture = await enforced('ACK', mainStrategyId, acct);
      const intentId = await admitted(fixture, 'ack-1');
      // Fault injection: the consumption commits on another connection just before the worker's own
      // insert, which therefore fails exactly as a commit whose acknowledgement never arrived.
      harness.beforeConsume = async () => {
        const decision = await one(`SELECT id, "clientOrderId" FROM "MarketPolicyBrokerDispatchDecision" WHERE "orderIntentId"=$1 ORDER BY "dispatchSequence" DESC LIMIT 1`, [intentId]);
        await db.query(`INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,$3,'{}')`, [decision.id, intentId, decision.clientOrderId]);
      };
      expect(await dispatch(acct)).toMatchObject({ failed: 1, submitted: 0 });
      harness.beforeConsume = null;
      expect(posts('ack-1')).toBe(0);
      const consumption = await one(`SELECT id FROM "MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1`, [intentId]);
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: `ENTRY_DISPATCH_RECORDED_NOT_SENT:CONSUMPTION:${consumption.id}`, consumptions: 1, claimReleased: true, releaseReason: 'VERIFIED_DISPATCH_NO_EXPOSURE:DEFINITE_LOCAL_NON_SEND' });
      expect((await claimEvents(intentId, 'DISPATCH_OUTCOME_RECORDED'))[0].evidenceJson).toMatchObject({ classification: 'NOT_SENT_DISPATCH_RECORD_ACK_LOST', consumptionId: consumption.id, deliveryProof: 'ADAPTER_NOT_INVOKED_BY_THIS_ATTEMPT' });
      // A retry never authorizes another POST.
      await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [intentId]);
      await dispatch(acct);
      expect(posts('ack-1')).toBe(0);
      expect((await decisionsFor(intentId)).filter(row => row.consumed)).toHaveLength(1);
    });

    // HIGH-1 (11): fingerprinted owner remediation of a conclusively verified claim.
    it('lets a SYSTEM_OWNER release a conclusively verified consumed claim with the exact evidence fingerprint', async () => {
      const acct = await freshAccount('H11');
      const { remediation } = await services();
      const { intentId } = await localBlocked('OPR', 'opr-1', acct, false);
      // The worker could not complete verification (incomplete open-order evidence): ownership retained.
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', claimStatus: 'UNRESOLVED', claimReleased: false, consumptions: 1 });
      expect((await claimEvents(intentId, 'DISPATCH_RECOVERY_RELEASE_BLOCKED'))[0].evidenceJson).toMatchObject({ blockers: ['BROKER_LOOKUP_FAILED'], lookupFailed: true });
      const claimId = await claimIdOf(intentId);
      const preview = await remediation.previewEntryExposureRemediation(claimId);
      expect(preview).toMatchObject({ disposition: 'DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE', eligible: true, blockers: [], investigation: null,
        evidence: { basis: 'DEFINITE_LOCAL_NON_SEND', conclusiveness: 'CONCLUSIVE', orderIntent: { id: intentId, clientOrderId: 'opr-1' }, dispatch: { consumptionId: expect.any(Number), dispatchDecisionId: expect.any(Number), dispatchDecisionOutcome: 'ALLOWED' } } });
      const accountUser = await user(`account-user-${randomUUID()}@phase3c3.test`, 'ACCOUNT_USER');
      await expect(remediation.applyEntryExposureRemediation({ claimId, actorUserId: accountUser, confirmationFingerprint: preview.confirmationFingerprint })).rejects.toMatchObject({ statusCode: 403 });
      expect(await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: 'f'.repeat(64) })).toMatchObject({ released: false, reason: 'CONFIRMATION_FINGERPRINT_MISMATCH' });
      const applied = await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: preview.confirmationFingerprint });
      expect(applied).toMatchObject({ released: true, releaseReason: 'VERIFIED_DISPATCH_NO_EXPOSURE:DEFINITE_LOCAL_NON_SEND' });
      expect((await claimEvents(intentId, 'OPERATOR_REMEDIATION_AUTHORIZED'))[0].evidenceJson).toMatchObject({ actorUserId: ownerId, confirmationFingerprint: preview.confirmationFingerprint, disposition: 'DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE' });
      expect((await claimEvents(intentId, 'RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE'))[0].evidenceJson).toMatchObject({ mode: 'OPERATOR', actorUserId: ownerId, basis: 'DEFINITE_LOCAL_NON_SEND' });
      // Remediation never places, cancels or requeues anything.
      expect(posts('opr-1')).toBe(0);
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', consumptions: 1 });
    });

    // HIGH-1 (12): remediation refuses every contradiction and every ambiguity.
    it('refuses remediation on broker position, executable BUY, unaccounted fill, incomplete pagination or mismatched identity', async () => {
      const acct = await freshAccount('H12');
      const { remediation } = await services();
      const { intentId } = await localBlocked('RFS', 'rfs-1', acct, false);
      const claimId = await claimIdOf(intentId);
      const refused = async (blocker: string) => {
        const preview = await remediation.previewEntryExposureRemediation(claimId);
        expect(preview.eligible).toBe(false);
        expect(preview.blockers).toContain(blocker);
        expect(await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: preview.confirmationFingerprint })).toMatchObject({ released: false });
        expect(await intentState(intentId)).toMatchObject({ claimStatus: 'UNRESOLVED', claimReleased: false });
        return preview;
      };
      harness.positions.set('RFS', { symbol: 'RFS', side: 'long', qty: '1' });
      expect((await refused('BROKER_POSITION_PRESENT')).evidence).toMatchObject({ conclusiveness: 'CONTRADICTED' });
      harness.positions.clear();
      harness.openBuys.set('RFS', [{ id: 'alpaca-foreign-rfs', client_order_id: 'foreign-rfs', symbol: 'RFS', side: 'buy', status: 'new', qty: '1', filled_qty: '0' }]);
      await refused('BROKER_BUY_ORDER_PRESENT');
      harness.openBuys.clear();
      const fill = await one(`INSERT INTO "BrokerActivity" (broker,mode,"activityId","activityType",symbol,side,qty,"orderId","rawBrokerJson","tradingAccountId","transactionTime","createdAt","updatedAt") VALUES ('alpaca','paper',$1,'FILL','RFS','buy',1,'alpaca-unknown-rfs','{}',$2,now(),now(),now()) RETURNING id`, [`fill-${randomUUID()}`, acct]);
      await refused('UNATTRIBUTED_BUY_FILL_PRESENT');
      await db.query(`DELETE FROM "BrokerActivity" WHERE id=$1`, [fill.id]);
      harness.openBuyFailures.add('RFS');
      expect((await refused('BROKER_LOOKUP_FAILED')).evidence).toMatchObject({ conclusiveness: 'PENDING' });
      harness.openBuyFailures.clear();
      harness.orders.set('rfs-1', { id: 'alpaca-wrong-rfs', client_order_id: 'rfs-1', symbol: 'OTHER', side: 'buy', status: 'rejected', qty: '1', filled_qty: '0' });
      await refused('BROKER_ORDER_IDENTITY_CONFLICT');
      harness.orders.delete('rfs-1');
      // A stale fingerprint is refused even once the evidence is conclusive.
      const stale = await remediation.previewEntryExposureRemediation(claimId);
      expect(stale.eligible).toBe(true);
      harness.positions.set('RFS', { symbol: 'RFS', side: 'long', qty: '1' });
      expect(await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: stale.confirmationFingerprint })).toMatchObject({ released: false, reason: 'CONFIRMATION_FINGERPRINT_MISMATCH' });
      harness.positions.clear();
      expect(posts('rfs-1')).toBe(0);
    });

    // HIGH-1 (13): a released claim admits only a genuinely new entry; the consumed intent never returns.
    it('admits a genuinely new entry with a new client-order ID after a verified release, while the consumed intent is never resubmitted', async () => {
      const acct = await freshAccount('H13');
      const { fixture, intentId } = await localBlocked('NEW', 'new-1', acct);
      expect(await intentState(intentId)).toMatchObject({ claimReleased: true });
      // The stable key recovers the consumed lifecycle; it is never re-admitted or resent.
      expect(await submit(fixture.assignmentId, 'new-1')).toMatchObject({ intentId, duplicate: true });
      await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [intentId]);
      await dispatch(acct);
      expect(posts('new-1')).toBe(0);
      const fresh = await admitted(fixture, 'new-2');
      expect(fresh).not.toBe(intentId);
      await dispatch(acct);
      expect(posts('new-2')).toBe(1);
      expect(posts('new-1')).toBe(0);
      expect(await intentState(fresh)).toMatchObject({ status: 'submitted', claimStatus: 'BROKER_ORDER_ACTIVE', consumptions: 1 });
      expect(await count(`"MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1`, [intentId])).toBe(1);
    });
  });

  describe('Phase 3C.3 final safety and recovery closure (Hermes HIGH-1, MEDIUM-1, LOW-2 to LOW-5)', () => {
    const later = (ms: number) => new Date(Date.now() + ms);
    const holder = (name: string) => user(`closure-${name.toLowerCase()}-${randomUUID()}@phase3c3.test`, 'SYSTEM_OWNER');
    const liveAccount = async (name: string) => account(`Closure LIVE ${name}`, 'LIVE', await holder(name));
    const paperAccount = async (name: string) => account(`Closure PAPER ${name}`, 'PAPER', await holder(name));
    const credential = (acct: number) => db.query(`INSERT INTO "TradingAccountCredential" ("tradingAccountId","authType",status,"createdAt","updatedAt") VALUES ($1,'API_KEY','ACTIVE',now(),now())`, [acct]);
    const claimIdOf = async (orderIntentId: number) => (await one(`SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [orderIntentId])).id as number;
    const events = async (orderIntentId: number, eventType: string) => (await db.query(`SELECT e."evidenceJson" FROM "EntryExposureClaimEvent" e JOIN "EntryExposureClaim" c ON c.id=e."claimId" WHERE c."orderIntentId"=$1 AND e."eventType"=$2 ORDER BY e.id`, [orderIntentId, eventType])).rows as Array<{ evidenceJson: Record<string, unknown> }>;
    const eventTypes = async (orderIntentId: number) => (await db.query(`SELECT e."eventType" FROM "EntryExposureClaimEvent" e JOIN "EntryExposureClaim" c ON c.id=e."claimId" WHERE c."orderIntentId"=$1 ORDER BY e.id`, [orderIntentId])).rows.map((row) => row.eventType as string);
    const postsForSymbol = (symbol: string) => harness.submitCalls.filter((call) => call.payload.symbol === symbol).length;
    const rejection = async (statusCode: number) => {
      const { errors } = await services();
      return new errors.BrokerWriteDeliveryError({ classification: 'BROKER_REJECTED', message: `Alpaca explicitly rejected broker write with status ${statusCode}.`, statusCode });
    };
    async function entry(symbol: string, clientOrderId: string, acct: number) {
      const fixture = await instrument(symbol, mainStrategyId, acct);
      const { intentId } = await submit(fixture.assignmentId, clientOrderId);
      return { fixture, intentId };
    }
    let triggerSeq = 0;
    /** Real PostgreSQL fault injection: refuses the RELEASED compare-and-set for the given claims. */
    async function failReleaseOf(where: string) {
      const name = `test_fail_release_${++triggerSeq}`;
      await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'RELEASED' AND (${where}) THEN RAISE EXCEPTION 'injected transient connection failure'; END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON "EntryExposureClaim" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      return async () => {
        await db.query(`DROP TRIGGER IF EXISTS ${name} ON "EntryExposureClaim"`);
        await db.query(`DROP FUNCTION IF EXISTS ${name}()`);
      };
    }
    async function readinessOf(acct: number, orderIntentId: number) {
      const { entryReadiness } = await services();
      const report = await entryReadiness.assessEntryExposureReadiness({ tradingAccountIds: [acct] });
      return report.terminalIntentsWithUnreleasedClaims.find((item) => item.orderIntentId === orderIntentId);
    }

    // HIGH-1 (1-5): LIVE 408/409 through the real worker, with no durable dispatch record.
    it.each([408, 409])('LIVE HTTP %i without a dispatch record: one POST, claim retained with an accurate classification, a second entry refused, no second POST', async (statusCode) => {
      const acct = await liveAccount(`H1-${statusCode}`);
      const { recovery } = await services();
      const symbol = `LV${statusCode}`;
      const clientOrderId = `live-${statusCode}-1`;
      const { fixture, intentId } = await entry(symbol, clientOrderId, acct);
      const error = await rejection(statusCode);
      harness.submitError = async () => error;
      expect(await dispatch(acct)).toMatchObject({ failed: 1, submitted: 0 });
      harness.submitError = null;
      expect(posts(clientOrderId)).toBe(1);
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: `BROKER_WRITE_DELIVERY:BROKER_REJECTED:Alpaca explicitly rejected broker write with status ${statusCode}.`, claimStatus: 'UNRESOLVED', claimReleased: false, consumptions: 0 });
      expect(await count(`"MarketPolicyBrokerUnenforcedDispatch" WHERE "orderIntentId"=$1`, [intentId])).toBe(0);
      expect((await events(intentId, 'DISPATCH_OUTCOME_RECORDED'))[0]!.evidenceJson).toMatchObject({
        classification: 'BROKER_REJECTED', statusCode, source: 'WORKER', observation: 'OBSERVED', adapterInvocation: 'HTTP_RESPONSE_RECEIVED',
        dispatchRecordPresent: false, deliveryProof: 'HTTP_REJECTION_RESPONSE_REQUIRES_BROKER_VERIFICATION', originalIntentResubmission: 'PROHIBITED',
      });
      // The outcome closed the boundary entry; nothing ever claimed a non-send or released it as unsubmitted.
      expect(await eventTypes(intentId)).toEqual(['ACQUIRED', 'WORKER_CLAIMED_FOR_SUBMISSION', 'ADAPTER_INVOCATION_STARTED', 'DISPATCH_OUTCOME_RECORDED']);
      await expect(submit(fixture.assignmentId, `${clientOrderId}-second`)).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: 'ENTRY_EXPOSURE_UNRESOLVED' }) });
      await dispatch(acct);
      expect([posts(clientOrderId), posts(`${clientOrderId}-second`), postsForSymbol(symbol)]).toEqual([1, 0, 1]);
      // Neither elapsed time nor lookup absence releases it; it is visible as operator-only.
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(86_400_000))).toMatchObject({ examined: 0, released: 0 });
      expect(await readinessOf(acct, intentId)).toMatchObject({
        recoveryState: 'OPERATOR_INVESTIGATION', automaticRecoveryPossible: false, systemRecovery: 'OPERATOR_INVESTIGATION_REQUIRED',
        operatorRemediation: 'INVESTIGATION_REQUIRED', blockerReason: 'BROKER_REJECTION_NOT_DEFINITIVE', deliveryEvidence: 'OUTCOME_WITHOUT_DISPATCH_RECORD',
        dispatchStarted: false, nextAttemptDueAt: null,
      });
      expect(await intentState(intentId)).toMatchObject({ claimStatus: 'UNRESOLVED', claimReleased: false });
    });

    // HIGH-1: a failed classification persistence fails closed.
    it.each([408, 409])('LIVE HTTP %i whose classification cannot be persisted keeps ownership, refuses a second entry, and stale recovery never releases it', async (statusCode) => {
      const acct = await liveAccount(`H1P-${statusCode}`);
      const { worker } = await services();
      const symbol = `LP${statusCode}`;
      const clientOrderId = `live-persist-${statusCode}`;
      const { fixture, intentId } = await entry(symbol, clientOrderId, acct);
      const claimId = await claimIdOf(intentId);
      const name = `test_fail_classification_${statusCode}`;
      await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."claimId" = ${claimId} AND NEW."eventType" IN ('DISPATCH_OUTCOME_RECORDED','NOT_SENT_EVIDENCE_RECORDED') THEN RAISE EXCEPTION 'injected classification persistence failure'; END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER ${name} BEFORE INSERT ON "EntryExposureClaimEvent" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      const error = await rejection(statusCode);
      harness.submitError = async () => error;
      try {
        expect(await dispatch(acct)).toMatchObject({ failed: 1, submitted: 0 });
      } finally {
        harness.submitError = null;
        await db.query(`DROP TRIGGER ${name} ON "EntryExposureClaimEvent"`);
        await db.query(`DROP FUNCTION ${name}()`);
      }
      expect(posts(clientOrderId)).toBe(1);
      // The terminal intent update rolled back with the classification: ownership is untouched.
      expect(await intentState(intentId)).toMatchObject({ status: 'submitting', blockReason: null, claimStatus: 'ENTRY_SUBMITTING', claimReleased: false });
      expect(await count(`"SystemEvent" WHERE type='entry_exposure.delivery_evidence_unpersisted' AND "tradingAccountId"=$1`, [acct])).toBe(1);
      await expect(submit(fixture.assignmentId, `${clientOrderId}-second`)).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: 'ENTRY_ALREADY_PENDING' }) });
      await dispatch(acct);
      expect([posts(clientOrderId), posts(`${clientOrderId}-second`)]).toEqual([1, 0]);
      // The entered boundary marker survived; a later lookup miss is not release evidence.
      await db.query(`UPDATE "OrderIntent" SET "updatedAt" = now() - interval '10 minutes' WHERE id=$1`, [intentId]);
      expect(await worker.recoverStaleSubmittingIntentsForAccount(acct)).toMatchObject({ found: 1, retained: 1, retryable: 0 });
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringMatching(/^STALE_SUBMISSION_OUTCOME_UNKNOWN/), claimStatus: 'UNRESOLVED', claimReleased: false });
      expect((await events(intentId, 'DISPATCH_OUTCOME_RECORDED'))[0]!.evidenceJson).toMatchObject({ classification: 'DISPATCH_OUTCOME_UNKNOWN', source: 'STALE_RECOVERY', observation: 'INFERRED', dispatchRecordPresent: false });
      const recorded = await one(`SELECT message FROM "SystemEvent" WHERE type='entry_exposure.dispatch_outcome_recorded' AND "tradingAccountId"=$1`, [acct]);
      expect(recorded.message).toContain('no durable dispatch record');
      expect(recorded.message).not.toContain('after its durable dispatch record committed');
      expect(posts(clientOrderId)).toBe(1);
    });

    // HIGH-1: definitive 4xx after a POST go through evidence-based recovery, never status-code release.
    it.each([400, 401, 403, 404, 422, 429])('LIVE definitive HTTP %i without a dispatch record is released only after the settle window and fresh verification', async (statusCode) => {
      const acct = await liveAccount(`H1D-${statusCode}`);
      const { recovery } = await services();
      const symbol = `LD${statusCode}`;
      const { fixture, intentId } = await entry(symbol, `live-def-${statusCode}`, acct);
      const error = await rejection(statusCode);
      harness.submitError = async () => error;
      await dispatch(acct);
      harness.submitError = null;
      expect(await intentState(intentId)).toMatchObject({ claimStatus: 'UNRESOLVED', claimReleased: false });
      // Inside the settle window the attempt is recorded and nothing is released.
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct)).toMatchObject({ examined: 1, released: 0 });
      expect((await events(intentId, 'DISPATCH_RECOVERY_RELEASE_BLOCKED')).at(-1)!.evidenceJson).toMatchObject({ blockers: ['BROKER_REJECTION_SETTLING'] });
      // A broker position for the Security contradicts the rejection.
      harness.positions.set(symbol, { symbol, side: 'long', qty: '1' });
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(120_000))).toMatchObject({ examined: 1, released: 0 });
      expect((await events(intentId, 'DISPATCH_RECOVERY_RELEASE_BLOCKED')).at(-1)!.evidenceJson).toMatchObject({ blockers: ['BROKER_POSITION_PRESENT'] });
      harness.positions.delete(symbol);
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(240_000))).toMatchObject({ examined: 1, released: 1 });
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', claimReleased: true, releaseReason: 'VERIFIED_NO_DISPATCH_RECORD_NO_EXPOSURE:CONFIRMED_BROKER_REJECTION' });
      expect((await events(intentId, 'RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE'))[0]!.evidenceJson).toMatchObject({ mode: 'SYSTEM', basis: 'CONFIRMED_BROKER_REJECTION', dispatchRecord: 'NONE', executionAuthority: 'NONE' });
      // Only a genuinely new entry (new client order ID) follows; the rejected intent is never resent.
      const fresh = await submit(fixture.assignmentId, `live-def-${statusCode}-2`);
      await dispatch(acct);
      expect([posts(`live-def-${statusCode}`), posts(`live-def-${statusCode}-2`)]).toEqual([1, 1]);
      expect(await intentState(fresh.intentId)).toMatchObject({ status: 'submitted', claimStatus: 'BROKER_ORDER_ACTIVE' });
    });

    // HIGH-1: an unknown adapter error is delivery-uncertain and only positive broker evidence releases it.
    it('keeps a LIVE unknown adapter error without a dispatch record protected, and releases it only on positive broker order evidence', async () => {
      const acct = await liveAccount('H1U');
      const { recovery, remediation } = await services();
      const { intentId } = await entry('LUNK', 'live-unknown-1', acct);
      harness.submitError = async () => new Error('socket hang up after the request body was written');
      await dispatch(acct);
      harness.submitError = null;
      expect(posts('live-unknown-1')).toBe(1);
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringMatching(/^BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:/), claimStatus: 'UNRESOLVED', claimReleased: false });
      expect((await events(intentId, 'DISPATCH_OUTCOME_RECORDED'))[0]!.evidenceJson).toMatchObject({ classification: 'DELIVERY_UNCERTAIN', observation: 'OBSERVED', adapterInvocation: 'UNKNOWN', dispatchRecordPresent: false });
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(86_400_000))).toMatchObject({ examined: 0 });
      const claimId = await claimIdOf(intentId);
      const preview = await remediation.previewEntryExposureRemediation(claimId);
      expect(preview).toMatchObject({ disposition: 'NO_DISPATCH_RECORD_VERIFIED_NO_EXPOSURE', eligible: false, blockers: ['DELIVERY_OUTCOME_UNCERTAIN'],
        investigation: { conclusiveness: 'AMBIGUOUS_ABSENCE', claimRetained: true, releaseRequires: 'POSITIVE_BROKER_ORDER_EVIDENCE' } });
      expect(await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: preview.confirmationFingerprint })).toMatchObject({ released: false });
      expect(await intentState(intentId)).toMatchObject({ claimStatus: 'UNRESOLVED', claimReleased: false });
      harness.orders.set('live-unknown-1', { id: 'alpaca-late-lunk', client_order_id: 'live-unknown-1', symbol: 'LUNK', side: 'buy', status: 'rejected', qty: '1', filled_qty: '0' });
      const terminal = await remediation.previewEntryExposureRemediation(claimId);
      expect(terminal).toMatchObject({ disposition: 'TERMINAL_BROKER_ORDER_NO_EXPOSURE', eligible: true });
      expect(await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: terminal.confirmationFingerprint })).toMatchObject({ released: true, releaseReason: 'BROKER_REJECTED_NO_EXPOSURE' });
      expect(posts('live-unknown-1')).toBe(1);
    });

    // HIGH-1: genuine pre-dispatch failures still release, but only after their evidence is durable.
    it('releases genuine LIVE pre-dispatch failures only after structured not-sent evidence is durable, with zero POSTs', async () => {
      const acct = await liveAccount('H1N');
      const { errors } = await services();
      const guard = await entry('LGRD', 'live-guard-1', acct);
      harness.adapterLocalError = async () => new errors.BrokerWriteDeliveryError({ classification: 'NOT_SENT_BLOCKED', message: 'LIVE NEW_POSITION_ENTRY blocked: arming is not valid.' });
      await dispatch(acct);
      harness.adapterLocalError = null;
      expect(await intentState(guard.intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringContaining('BROKER_WRITE_DELIVERY:NOT_SENT_BLOCKED'), claimReleased: true, releaseReason: 'NOT_SENT_BLOCKED' });
      expect(await eventTypes(guard.intentId)).toEqual(['ACQUIRED', 'WORKER_CLAIMED_FOR_SUBMISSION', 'ADAPTER_INVOCATION_STARTED', 'NOT_SENT_EVIDENCE_RECORDED', 'RELEASED_NO_BROKER_EXPOSURE']);
      expect((await events(guard.intentId, 'NOT_SENT_EVIDENCE_RECORDED'))[0]!.evidenceJson).toMatchObject({ classification: 'NOT_SENT_LOCAL_BLOCKED', producer: 'ADAPTER_LOCAL_GUARD', networkRequestIssued: false });
      const risk = await entry('LRSK', 'live-risk-1', acct);
      harness.workerRiskBlocked.add(risk.fixture.assignmentId);
      await dispatch(acct);
      harness.workerRiskBlocked.delete(risk.fixture.assignmentId);
      expect(await intentState(risk.intentId)).toMatchObject({ status: 'blocked', blockReason: 'Daily entry order limit reached.', claimReleased: true, releaseReason: 'WORKER_RISK_RECHECK_BLOCKED' });
      expect(await eventTypes(risk.intentId)).toEqual(['ACQUIRED', 'WORKER_CLAIMED_FOR_SUBMISSION', 'NOT_SENT_EVIDENCE_RECORDED', 'RELEASED_NO_BROKER_EXPOSURE']);
      expect((await events(risk.intentId, 'NOT_SENT_EVIDENCE_RECORDED'))[0]!.evidenceJson).toMatchObject({ producer: 'WORKER_RISK_RECHECK', classification: 'NOT_SENT_PRE_DISPATCH' });
      expect([posts('live-guard-1'), posts('live-risk-1')]).toEqual([0, 0]);
    });

    // MEDIUM-1 (A) + LOW-4: risk rejection with an injected transient failure stays recoverable and visible.
    it('MEDIUM-1: a worker risk rejection whose release hits a transient PostgreSQL failure stays recoverable and is released on a bounded retry', async () => {
      const acct = await paperAccount('M1R');
      const { recovery } = await services();
      const { fixture, intentId } = await entry('MRSK', 'm1-risk-1', acct);
      const claimId = await claimIdOf(intentId);
      const restore = await failReleaseOf(`NEW.id = ${claimId}`);
      try {
        harness.workerRiskBlocked.add(fixture.assignmentId);
        await dispatch(acct);
        harness.workerRiskBlocked.delete(fixture.assignmentId);
        expect(await intentState(intentId)).toMatchObject({ status: 'blocked', claimStatus: 'ENTRY_SUBMITTING', claimReleased: false });
        expect((await events(intentId, 'NOT_SENT_EVIDENCE_RECORDED'))[0]!.evidenceJson).toMatchObject({ producer: 'WORKER_RISK_RECHECK' });
        expect((await events(intentId, 'RECOVERY_ATTEMPT_FAILED'))[0]!.evidenceJson).toMatchObject({ source: 'WORKER', failureClass: 'TECHNICAL', automaticRetry: 'SCHEDULED' });
        // Never fabricated as an uncertain or dispatched outcome.
        expect(await events(intentId, 'DISPATCH_OUTCOME_RECORDED')).toHaveLength(0);
        const visible = await readinessOf(acct, intentId);
        expect(visible).toMatchObject({ recoveryState: 'AUTOMATIC_NEVER_SUBMITTED_RELEASE', automaticRecoveryPossible: true, recoveryAttempted: true,
          systemRecovery: 'TECHNICAL_FAILURE_RETRY_SCHEDULED', deliveryEvidence: 'STRUCTURED_NOT_SENT', operatorRemediation: 'PENDING',
          lastRecoveryResult: expect.objectContaining({ eventType: 'RECOVERY_ATTEMPT_FAILED', result: 'TECHNICAL_FAILURE' }) });
        expect(visible!.nextAttemptDueAt!.getTime()).toBeGreaterThan(Date.now());
        // Not due yet; after the interval it is retried, still failing, without a diagnostic flood.
        expect(await recovery.recoverTerminalEntryClaimsForAccount(acct)).toMatchObject({ examined: 0 });
        expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(120_000))).toMatchObject({ examined: 1, released: 0 });
        expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(240_000))).toMatchObject({ examined: 1, released: 0 });
        expect(await events(intentId, 'RECOVERY_ATTEMPT_FAILED')).toHaveLength(2);
      } finally {
        await restore();
      }
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(360_000))).toMatchObject({ examined: 1, released: 1 });
      expect(await intentState(intentId)).toMatchObject({ status: 'blocked', claimReleased: true, releaseReason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED' });
      expect(posts('m1-risk-1')).toBe(0);
    });

    // MEDIUM-1 (A): admission failure.
    it('MEDIUM-1: an admission risk block whose release failed is proven pre-dispatch by its claim state and recovered', async () => {
      const acct = await paperAccount('M1A');
      const { recovery } = await services();
      const fixture = await instrument('MADM', mainStrategyId, acct);
      const restore = await failReleaseOf(`NEW."securityId" = ${fixture.securityId}`);
      harness.admissionRiskBlocked.add(fixture.assignmentId);
      try {
        await expect(submit(fixture.assignmentId, 'm1-admission-1')).rejects.toThrow();
      } finally {
        harness.admissionRiskBlocked.delete(fixture.assignmentId);
        await restore();
      }
      const intent = await one(`SELECT id FROM "OrderIntent" WHERE "clientOrderId"='m1-admission-1'`);
      expect(await intentState(intent.id)).toMatchObject({ status: 'blocked', claimStatus: 'ENTRY_PENDING', claimReleased: false });
      expect(await readinessOf(acct, intent.id)).toMatchObject({ recoveryState: 'AUTOMATIC_NEVER_SUBMITTED_RELEASE', systemRecovery: 'AWAITING_FIRST_ATTEMPT', recoveryAttempted: false });
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct)).toMatchObject({ examined: 1, released: 1 });
      expect(await intentState(intent.id)).toMatchObject({ claimReleased: true, releaseReason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED' });
      expect(posts('m1-admission-1')).toBe(0);
    });

    // MEDIUM-1 (A): stale recovery after a crash before the broker boundary.
    it('MEDIUM-1: stale recovery proves a crash before the adapter from the claim protocol and survives a transient release failure', async () => {
      const acct = await paperAccount('M1S');
      const { worker, claims, recovery } = await services();
      const { intentId } = await entry('MSTL', 'm1-stale-1', acct);
      // The worker claimed the intent under the adapter-marker protocol, then the process crashed.
      await db.query(`UPDATE "OrderIntent" SET status='submitting' WHERE id=$1`, [intentId]);
      await claims.transitionEntryExposureClaim({ orderIntentId: intentId, status: 'ENTRY_SUBMITTING', eventType: 'WORKER_CLAIMED_FOR_SUBMISSION', evidence: { markerProtocol: 'ADAPTER_MARKER_V1' } });
      await db.query(`UPDATE "OrderIntent" SET "updatedAt" = now() - interval '10 minutes' WHERE id=$1`, [intentId]);
      const restore = await failReleaseOf(`NEW.id = ${await claimIdOf(intentId)}`);
      try {
        expect(await worker.recoverStaleSubmittingIntentsForAccount(acct)).toMatchObject({ found: 1, retained: 1, retryable: 0 });
      } finally {
        await restore();
      }
      expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringMatching(/broker adapter was never invoked/), claimStatus: 'ENTRY_SUBMITTING', claimReleased: false });
      expect((await events(intentId, 'NOT_SENT_EVIDENCE_RECORDED'))[0]!.evidenceJson).toMatchObject({ producer: 'STALE_RECOVERY_ADAPTER_NOT_INVOKED', source: 'STALE_RECOVERY' });
      expect(await events(intentId, 'DISPATCH_OUTCOME_RECORDED')).toHaveLength(0);
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(120_000))).toMatchObject({ examined: 1, released: 1 });
      expect(await intentState(intentId)).toMatchObject({ claimReleased: true, releaseReason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED' });
      expect(posts('m1-stale-1')).toBe(0);
    });

    // MEDIUM-1: legacy no-record claims. Structured risk evidence proves non-dispatch; free text never does.
    it('MEDIUM-1: a legacy free-text block is never inferred either way, while the structured risk evaluation proves non-dispatch', async () => {
      const acct = await paperAccount('M1L');
      const { claims, orderAudit, recovery } = await services();
      const legacy = async (symbol: string, clientOrderId: string, blockReason: string, riskReason: string | null) => {
        const { intentId } = await entry(symbol, clientOrderId, acct);
        await db.query(`UPDATE "OrderIntent" SET status='submitting' WHERE id=$1`, [intentId]);
        await claims.transitionEntryExposureClaim({ orderIntentId: intentId, status: 'ENTRY_SUBMITTING', eventType: 'WORKER_CLAIMED_FOR_SUBMISSION' });
        if (riskReason) await orderAudit.recordOrderIntentRiskEvaluation({ orderIntentId: intentId, allowed: false, reason: riskReason, details: {} });
        await db.query(`UPDATE "OrderIntent" SET status='blocked', "blockReason"=$2 WHERE id=$1`, [intentId, blockReason]);
        return intentId;
      };
      const proven = await legacy('MLRK', 'm1-legacy-risk', 'Daily entry order limit reached.', 'Daily entry order limit reached.');
      const unknown = await legacy('MLUN', 'm1-legacy-unknown', 'connection reset by peer', null);
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct)).toMatchObject({ examined: 2, released: 1, recorded: 2 });
      expect(await intentState(proven)).toMatchObject({ claimReleased: true, releaseReason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED' });
      expect((await events(proven, 'NOT_SENT_EVIDENCE_RECORDED'))[0]!.evidenceJson).toMatchObject({ producer: 'TERMINAL_SWEEP_RISK_EVALUATION_BLOCKED' });
      expect(await intentState(unknown)).toMatchObject({ claimStatus: 'UNRESOLVED', claimReleased: false });
      expect((await events(unknown, 'DISPATCH_OUTCOME_RECORDED'))[0]!.evidenceJson).toMatchObject({ classification: 'DISPATCH_OUTCOME_UNKNOWN', observation: 'INFERRED', source: 'TERMINAL_CLAIM_SWEEP', dispatchRecordPresent: false, deliveryProof: 'NONE_DELIVERY_UNCERTAIN' });
      expect(await readinessOf(acct, unknown)).toMatchObject({ recoveryState: 'OPERATOR_INVESTIGATION', blockerReason: 'DELIVERY_OUTCOME_UNKNOWN_NO_DISPATCH_RECORD', operatorRemediation: 'INVESTIGATION_REQUIRED' });
      const recorded = await one(`SELECT message FROM "SystemEvent" WHERE type='entry_exposure.dispatch_outcome_recorded' AND "tradingAccountId"=$1`, [acct]);
      expect(recorded.message).not.toContain('after its durable dispatch record committed');
      // Operator-only: never selected again by the sweep.
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(3_600_000))).toMatchObject({ examined: 0 });
    });

    // MEDIUM-1: a resolvable no-record UNRESOLVED claim has a working fingerprinted operator route.
    it('MEDIUM-1: a no-record UNRESOLVED claim with structured not-sent evidence is remediable by a SYSTEM_OWNER after fresh verification', async () => {
      const acct = await paperAccount('M1O');
      const { claims, recovery, remediation } = await services();
      const { fixture, intentId } = await entry('MNRU', 'm1-unresolved-1', acct);
      const claimId = await claimIdOf(intentId);
      const restore = await failReleaseOf(`NEW.id = ${claimId}`);
      try {
        harness.workerRiskBlocked.add(fixture.assignmentId);
        await dispatch(acct);
        harness.workerRiskBlocked.delete(fixture.assignmentId);
      } finally {
        await restore();
      }
      // A prior release path (before this closure) moved such a claim to UNRESOLVED without a record.
      await claims.transitionEntryExposureClaim({ orderIntentId: intentId, status: 'UNRESOLVED', eventType: 'UNSUBMITTED_RELEASE_REFUSED', evidence: { reason: 'legacy refusal' } });
      harness.openBuyFailures.add('MNRU');
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(120_000))).toMatchObject({ examined: 1, released: 0 });
      expect((await events(intentId, 'DISPATCH_RECOVERY_RELEASE_BLOCKED')).at(-1)!.evidenceJson).toMatchObject({ blockers: ['BROKER_LOOKUP_FAILED'] });
      const blocked = await remediation.previewEntryExposureRemediation(claimId);
      expect(blocked).toMatchObject({ disposition: 'NO_DISPATCH_RECORD_VERIFIED_NO_EXPOSURE', eligible: false, blockers: ['BROKER_LOOKUP_FAILED'] });
      harness.openBuyFailures.delete('MNRU');
      const preview = await remediation.previewEntryExposureRemediation(claimId);
      expect(preview).toMatchObject({ disposition: 'NO_DISPATCH_RECORD_VERIFIED_NO_EXPOSURE', eligible: true, blockers: [], investigation: null,
        evidence: { basis: 'DEFINITE_LOCAL_NON_SEND', conclusiveness: 'CONCLUSIVE', dispatchRecordPresent: false, orderIntent: { id: intentId, clientOrderId: 'm1-unresolved-1' } } });
      const accountUser = await user(`closure-account-user-${randomUUID()}@phase3c3.test`, 'ACCOUNT_USER');
      await expect(remediation.applyEntryExposureRemediation({ claimId, actorUserId: accountUser, confirmationFingerprint: preview.confirmationFingerprint })).rejects.toMatchObject({ statusCode: 403 });
      expect(await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: 'f'.repeat(64) })).toMatchObject({ released: false, reason: 'CONFIRMATION_FINGERPRINT_MISMATCH' });
      expect(await remediation.applyEntryExposureRemediation({ claimId, actorUserId: ownerId, confirmationFingerprint: preview.confirmationFingerprint }))
        .toMatchObject({ released: true, releaseReason: 'VERIFIED_NO_DISPATCH_RECORD_NO_EXPOSURE:DEFINITE_LOCAL_NON_SEND' });
      expect((await events(intentId, 'OPERATOR_REMEDIATION_AUTHORIZED'))[0]!.evidenceJson).toMatchObject({ actorUserId: ownerId, disposition: 'NO_DISPATCH_RECORD_VERIFIED_NO_EXPOSURE' });
      // Remediation never fabricates provenance, places, requeues or resubmits anything.
      expect(await events(intentId, 'DISPATCH_OUTCOME_RECORDED')).toHaveLength(0);
      expect(await intentState(intentId)).toMatchObject({ status: 'blocked', brokerOrders: 0, consumptions: 0 });
      expect(posts('m1-unresolved-1')).toBe(0);
    });

    // LOW-2: bounded retries and starvation resistance under a controlled clock.
    it('LOW-2: immediate ticks never retry the same failing claims, and a fourth claim is served despite three persistent failures', async () => {
      const acct = await paperAccount('L2');
      await credential(acct);
      const { worker } = await services();
      const intentIds: number[] = [];
      for (const index of [1, 2, 3, 4]) intentIds.push((await entry(`STV${index}`, `stv-${index}`, acct)).intentId);
      await db.query(`UPDATE "OrderIntent" SET status='failed', "blockReason"='ADMISSION_FAILED_BEFORE_BROKER_SUBMISSION' WHERE id = ANY($1)`, [intentIds]);
      const claimIds: number[] = [];
      for (const intentId of intentIds) claimIds.push(await claimIdOf(intentId));
      const restore = await failReleaseOf(`NEW.id IN (${claimIds.slice(0, 3).join(',')})`);
      const base = Date.now();
      type Tick = { outcome: string; account: { exposureSummary: Record<string, number> }; result?: { dispatchRecovery?: { attempted: number[]; released: number } } };
      const tick = async (offsetMs: number) => {
        vi.setSystemTime(base + offsetMs);
        const run = await worker.recoverStaleSubmittingIntents();
        return run.results.find((item) => item.account.tradingAccountId === acct) as unknown as Tick;
      };
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const first = await tick(0);
        expect(first).toMatchObject({ outcome: 'PROCESSED', account: { exposureSummary: { terminalEntryClaimsDue: 4, terminalEntryClaimsHeld: 4 } } });
        expect(first.result!.dispatchRecovery).toMatchObject({ attempted: claimIds.slice(0, 3), released: 0 });
        const second = await tick(1_000);
        expect(second).toMatchObject({ outcome: 'PROCESSED', account: { exposureSummary: { terminalEntryClaimsDue: 1 } } });
        expect(second.result!.dispatchRecovery).toMatchObject({ attempted: [claimIds[3]], released: 1 });
        const third = await tick(2_000);
        expect(third).toMatchObject({ outcome: 'SKIPPED', account: { exposureSummary: { terminalEntryClaimsDue: 0, terminalEntryClaimsHeld: 3 } } });
        const fourth = await tick(61_000);
        expect(fourth.result!.dispatchRecovery).toMatchObject({ attempted: claimIds.slice(0, 3), released: 0 });
      } finally {
        vi.useRealTimers();
        await restore();
      }
      for (const intentId of intentIds.slice(0, 3)) {
        // One deduplicated diagnostic per persistently failing claim, never a flood.
        expect(await events(intentId, 'RECOVERY_ATTEMPT_FAILED')).toHaveLength(1);
        expect(await intentState(intentId)).toMatchObject({ claimStatus: 'ENTRY_PENDING', claimReleased: false });
      }
      // lastDiagnosedAt is a UTC timestamp without time zone; compare its epoch milliseconds.
      const stamped = await db.query(`SELECT (extract(epoch FROM "lastDiagnosedAt") * 1000)::bigint AS ms FROM "EntryExposureClaim" WHERE id = ANY($1) ORDER BY id`, [claimIds.slice(0, 3)]);
      expect(stamped.rows.map((row) => Number(row.ms))).toEqual([base + 61_000, base + 61_000, base + 61_000]);
      expect(await intentState(intentIds[3]!)).toMatchObject({ claimReleased: true, releaseReason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED' });
      expect(intentIds.map((_id, index) => posts(`stv-${index + 1}`))).toEqual([0, 0, 0, 0]);
    });

    // LOW-3 + LOW-4: one definition of actionable recovery work for enumeration, the sweep and readiness.
    it('LOW-3: account enumeration, the sweep and readiness agree on actionable, operator-only and credential-unavailable claims', async () => {
      const acct = await liveAccount('L3');
      await credential(acct);
      const credentialless = await liveAccount('L3N');
      const { eligibility, recovery } = await services();
      const operatorOnly = async (target: number, symbol: string) => {
        const { intentId } = await entry(symbol, `${symbol.toLowerCase()}-1`, target);
        const error = await rejection(409);
        harness.submitError = async () => error;
        await dispatch(target);
        harness.submitError = null;
        return intentId;
      };
      await operatorOnly(acct, 'L3A');
      await operatorOnly(credentialless, 'L3B');
      const enumerated = async () => {
        const accounts = await eligibility.enumerateLifecycleAccounts('submitted_orders', { persistWorkerHealth: false });
        return [accounts.find((item) => item.tradingAccountId === acct)!, accounts.find((item) => item.tradingAccountId === credentialless)!];
      };
      let [credentialed, missing] = await enumerated();
      expect(credentialed).toMatchObject({ eligible: false, reason: 'no_work_for_workflow', exposureSummary: { terminalEntryClaimsDue: 0, terminalEntryClaimsHeld: 1 } });
      expect(missing).toMatchObject({ eligible: false, reason: 'credentials_unavailable_with_exposure', exposureSummary: { terminalEntryClaimsHeld: 1 } });
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(3_600_000))).toMatchObject({ examined: 0 });
      // An actionable claim (a definitive rejection awaiting verification) is counted and swept exactly.
      const { intentId: actionable } = await entry('L3C', 'l3c-1', acct);
      const error = await rejection(422);
      harness.submitError = async () => error;
      await dispatch(acct);
      harness.submitError = null;
      expect(await readinessOf(acct, actionable)).toMatchObject({ recoveryState: 'AUTOMATIC_VERIFIED_RELEASE', systemRecovery: 'AWAITING_FIRST_ATTEMPT', recoveryAttempted: false, lastRecoveryResult: null });
      [credentialed] = await enumerated();
      expect(credentialed).toMatchObject({ eligible: true, exposureSummary: { terminalEntryClaimsDue: 1, terminalEntryClaimsHeld: 2 } });
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct)).toMatchObject({ examined: 1, attempted: [await claimIdOf(actionable)], released: 0 });
      // Attempted: readiness says so (not "processed"), with its next due time and real result.
      const attempted = await readinessOf(acct, actionable);
      expect(attempted).toMatchObject({ systemRecovery: 'RETRY_SCHEDULED', recoveryAttempted: true, operatorRemediation: 'PENDING',
        lastRecoveryResult: expect.objectContaining({ eventType: 'DISPATCH_RECOVERY_RELEASE_BLOCKED', result: 'BLOCKED_BY_EVIDENCE' }) });
      expect(attempted!.nextAttemptDueAt!.getTime()).toBeGreaterThan(Date.now());
      [credentialed] = await enumerated();
      expect(credentialed).toMatchObject({ eligible: false, exposureSummary: { terminalEntryClaimsDue: 0, terminalEntryClaimsHeld: 2 } });
      expect(await recovery.recoverTerminalEntryClaimsForAccount(acct)).toMatchObject({ examined: 0 });
    });

    // Hermes Phase 3C.3 final pre-dispatch recovery correction (MEDIUM) and LOW follow-ups.
    describe('Phase 3C.3 final pre-dispatch recovery correction (Hermes MEDIUM, LOW-1 stale admission, LOW-2 diagnostics)', () => {
      const alpacaError = async (statusCode: number) => {
        const { AlpacaApiError } = await import('../../errors/alpaca-api-error.js');
        return new AlpacaApiError(statusCode, statusCode === 429 ? 'rate limit exceeded' : 'service unavailable');
      };
      const secondEntryRefused = async (assignmentId: number, clientOrderId: string, code: string) =>
        expect(submit(assignmentId, clientOrderId)).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code }) });
      async function failInsertOf(claimId: number, eventTypes: string[]) {
        const name = `test_fail_event_${++triggerSeq}`;
        await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."claimId" = ${claimId} AND NEW."eventType" IN (${eventTypes.map((type) => `'${type}'`).join(',')}) THEN RAISE EXCEPTION 'injected transient evidence persistence failure'; END IF; RETURN NEW; END $$`);
        await db.query(`CREATE TRIGGER ${name} BEFORE INSERT ON "EntryExposureClaimEvent" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
        return async () => {
          await db.query(`DROP TRIGGER IF EXISTS ${name} ON "EntryExposureClaimEvent"`);
          await db.query(`DROP FUNCTION IF EXISTS ${name}()`);
        };
      }
      const ageIntent = (orderIntentId: number, minutes: number) => db.query(`UPDATE "OrderIntent" SET "updatedAt" = now() - make_interval(mins => $2) WHERE id=$1`, [orderIntentId, minutes]);

      // MEDIUM: idempotency GET 429 / 5xx / network failure through the real worker, PAPER and LIVE.
      it.each([
        ['PAPER', 'GET 429', () => alpacaError(429)],
        ['PAPER', 'GET 503', () => alpacaError(503)],
        ['PAPER', 'network failure', async () => new TypeError('fetch failed')],
        ['LIVE', 'GET 503', () => alpacaError(503)],
      ] as const)('%s %s before the broker POST commits structured pre-dispatch evidence and releases the claim, with zero POSTs', async (environment, label, makeError) => {
        const tag = `PD${environment[0]}${label.replace(/[^0-9A-Z]/gi, '').slice(0, 4).toUpperCase()}`;
        const acct = environment === 'LIVE' ? await liveAccount(tag) : await paperAccount(tag);
        const clientOrderId = `${tag.toLowerCase()}-1`;
        const { fixture, intentId } = await entry(tag, clientOrderId, acct);
        const error = await makeError();
        harness.lookupErrors.set(clientOrderId, () => error);
        try {
          expect(await dispatch(acct)).toMatchObject({ failed: 1, submitted: 0, blocked: 0 });
        } finally {
          harness.lookupErrors.delete(clientOrderId);
        }
        expect(posts(clientOrderId)).toBe(0);
        expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: `LOCAL_PRE_DISPATCH_FAILURE:${error.message}`, claimReleased: true,
          releaseReason: 'WORKER_PROVEN_PRE_DISPATCH_BOUNDARY_FAILURE', brokerOrders: 0, consumptions: 0 });
        // Evidence commits before the release; no uncertain outcome, marker or dispatch record exists.
        expect(await eventTypes(intentId)).toEqual(['ACQUIRED', 'WORKER_CLAIMED_FOR_SUBMISSION', 'NOT_SENT_EVIDENCE_RECORDED', 'RELEASED_NO_BROKER_EXPOSURE']);
        expect((await events(intentId, 'NOT_SENT_EVIDENCE_RECORDED'))[0]!.evidenceJson).toMatchObject({
          classification: 'NOT_SENT_PRE_DISPATCH', producer: 'WORKER_PRE_BOUNDARY_FAILURE', source: 'WORKER', adapterInvocation: 'NOT_INVOKED', networkRequestIssued: false,
          proof: { basis: 'ADAPTER_MARKER_V1_NO_INVOCATION_MARKER', submissionPhase: 'UNCLASSIFIED', adapterMarkers: 0, recordedOutcomes: 0, unenforcedDispatchId: null, consumptionId: null, brokerOrders: 0 },
        });
        expect((await events(intentId, 'RELEASED_NO_BROKER_EXPOSURE'))[0]!.evidenceJson).toMatchObject({ notSentBasis: 'RECORDED_NOT_SENT_EVIDENCE' });
        expect(await count(`"MarketPolicyBrokerUnenforcedDispatch" WHERE "orderIntentId"=$1`, [intentId])).toBe(0);
        // The failed intent is never requeued; only a genuinely new entry dispatches.
        const fresh = await submit(fixture.assignmentId, `${clientOrderId}-new`);
        await dispatch(acct);
        expect([posts(clientOrderId), posts(`${clientOrderId}-new`)]).toEqual([0, 1]);
        expect(await intentState(fresh.intentId)).toMatchObject({ status: 'submitted', claimStatus: 'BROKER_ORDER_ACTIVE' });
        expect(await intentState(intentId)).toMatchObject({ status: 'failed' });
      });

      it('proven pre-dispatch evidence survives a transient release failure and is released by the bounded sweep', async () => {
        const acct = await paperAccount('PDREL');
        const { recovery } = await services();
        const { fixture, intentId } = await entry('PDREL', 'pdrel-1', acct);
        const restore = await failReleaseOf(`NEW.id = ${await claimIdOf(intentId)}`);
        harness.lookupErrors.set('pdrel-1', () => new TypeError('fetch failed'));
        try {
          await dispatch(acct);
        } finally {
          harness.lookupErrors.delete('pdrel-1');
          await restore();
        }
        expect(await intentState(intentId)).toMatchObject({ status: 'failed', claimStatus: 'ENTRY_SUBMITTING', claimReleased: false });
        expect((await events(intentId, 'NOT_SENT_EVIDENCE_RECORDED'))[0]!.evidenceJson).toMatchObject({ producer: 'WORKER_PRE_BOUNDARY_FAILURE' });
        expect((await events(intentId, 'RECOVERY_ATTEMPT_FAILED'))[0]!.evidenceJson).toMatchObject({ source: 'WORKER', failureClass: 'TECHNICAL' });
        expect(await events(intentId, 'DISPATCH_OUTCOME_RECORDED')).toHaveLength(0);
        // Ownership is held until the release commits: a second same-account/Security BUY is refused.
        await secondEntryRefused(fixture.assignmentId, 'pdrel-2', 'ENTRY_ALREADY_PENDING');
        expect(await readinessOf(acct, intentId)).toMatchObject({ recoveryState: 'AUTOMATIC_NEVER_SUBMITTED_RELEASE', deliveryEvidence: 'STRUCTURED_NOT_SENT', systemRecovery: 'TECHNICAL_FAILURE_RETRY_SCHEDULED' });
        expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(120_000))).toMatchObject({ examined: 1, released: 1 });
        expect(await intentState(intentId)).toMatchObject({ claimReleased: true, releaseReason: 'TERMINAL_INTENT_VERIFIED_NEVER_SUBMITTED' });
        expect(posts('pdrel-1')).toBe(0);
      });

      it('a transient database failure verifying the executable claim, before the marker, is proven pre-dispatch once the database recovers', async () => {
        const acct = await paperAccount('PDDB');
        const { intentId } = await entry('PDDB', 'pddb-1', acct);
        harness.executableClaimFailures.add(intentId);
        await dispatch(acct);
        expect(harness.executableClaimFailures.has(intentId)).toBe(false);
        expect(posts('pddb-1')).toBe(0);
        expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringMatching(/^LOCAL_PRE_DISPATCH_FAILURE:.*injected transient database failure/), claimReleased: true, releaseReason: 'WORKER_PROVEN_PRE_DISPATCH_BOUNDARY_FAILURE' });
        expect(await eventTypes(intentId)).toEqual(['ACQUIRED', 'WORKER_CLAIMED_FOR_SUBMISSION', 'NOT_SENT_EVIDENCE_RECORDED', 'RELEASED_NO_BROKER_EXPOSURE']);
      });

      it('a database failure that also defeats the evidence inspection retains ownership and defers to stale recovery', async () => {
        const acct = await paperAccount('PDINS');
        const { worker } = await services();
        const { fixture, intentId } = await entry('PDINS', 'pdins-1', acct);
        // Real PostgreSQL fault: the dispatch-record relation is unavailable to the local dispatch check
        // and to the evidence inspection alike.
        await db.query(`ALTER TABLE "MarketPolicyBrokerUnenforcedDispatch" RENAME TO "MarketPolicyBrokerUnenforcedDispatch_unavailable"`);
        try {
          expect(await dispatch(acct)).toMatchObject({ failed: 1 });
        } finally {
          await db.query(`ALTER TABLE "MarketPolicyBrokerUnenforcedDispatch_unavailable" RENAME TO "MarketPolicyBrokerUnenforcedDispatch"`);
        }
        expect(posts('pdins-1')).toBe(0);
        expect(await intentState(intentId)).toMatchObject({ status: 'submitting', blockReason: null, claimStatus: 'ENTRY_SUBMITTING', claimReleased: false });
        expect(await eventTypes(intentId)).toEqual(['ACQUIRED', 'WORKER_CLAIMED_FOR_SUBMISSION']);
        expect(await one(`SELECT "payloadJson" FROM "SystemEvent" WHERE type='entry_exposure.delivery_evidence_unpersisted' AND "tradingAccountId"=$1`, [acct])).toMatchObject({ payloadJson: expect.objectContaining({ preDispatchProofCandidate: true }) });
        await secondEntryRefused(fixture.assignmentId, 'pdins-2', 'ENTRY_ALREADY_PENDING');
        await ageIntent(intentId, 10);
        expect(await worker.recoverStaleSubmittingIntentsForAccount(acct)).toMatchObject({ found: 1, retryable: 1 });
        expect(await intentState(intentId)).toMatchObject({ status: 'failed', claimReleased: true, releaseReason: 'RECOVERY_CONFIRMED_NEVER_SUBMITTED' });
        expect((await events(intentId, 'NOT_SENT_EVIDENCE_RECORDED'))[0]!.evidenceJson).toMatchObject({ producer: 'STALE_RECOVERY_ADAPTER_NOT_INVOKED' });
        expect(posts('pdins-1')).toBe(0);
      });

      it('a failed persistence of the corrective not-sent classification retains ownership; stale recovery later proves it', async () => {
        const acct = await paperAccount('PDPER');
        const { worker } = await services();
        const { fixture, intentId } = await entry('PDPER', 'pdper-1', acct);
        const restore = await failInsertOf(await claimIdOf(intentId), ['NOT_SENT_EVIDENCE_RECORDED']);
        harness.lookupErrors.set('pdper-1', () => new TypeError('fetch failed'));
        try {
          expect(await dispatch(acct)).toMatchObject({ failed: 1 });
        } finally {
          harness.lookupErrors.delete('pdper-1');
          await restore();
        }
        // The terminal state rolled back with the evidence: nothing released, nothing classified.
        expect(await intentState(intentId)).toMatchObject({ status: 'submitting', blockReason: null, claimStatus: 'ENTRY_SUBMITTING', claimReleased: false });
        expect(await eventTypes(intentId)).toEqual(['ACQUIRED', 'WORKER_CLAIMED_FOR_SUBMISSION']);
        await secondEntryRefused(fixture.assignmentId, 'pdper-2', 'ENTRY_ALREADY_PENDING');
        await dispatch(acct);
        expect([posts('pdper-1'), posts('pdper-2')]).toEqual([0, 0]);
        await ageIntent(intentId, 10);
        expect(await worker.recoverStaleSubmittingIntentsForAccount(acct)).toMatchObject({ found: 1, retryable: 1 });
        expect(await intentState(intentId)).toMatchObject({ claimReleased: true, releaseReason: 'RECOVERY_CONFIRMED_NEVER_SUBMITTED' });
      });

      it('a committed dispatch authorization without an adapter marker never takes the never-submitted path, in either phase', async () => {
        const acct = await paperAccount('PDAUT');
        const { guard, claims } = await services();
        // (a) This attempt's final authorization commits, then the marker write fails (NOT_DISPATCHED).
        const first = await entry('PDAUA', 'pdaua-1', acct);
        const restore = await failInsertOf(await claimIdOf(first.intentId), ['ADAPTER_INVOCATION_STARTED']);
        harness.positions.set('PDAUA', { symbol: 'PDAUA', side: 'long', qty: '1' });
        try {
          await dispatch(acct);
        } finally {
          await restore();
        }
        expect(posts('pdaua-1')).toBe(0);
        expect(await count(`"MarketPolicyBrokerUnenforcedDispatch" WHERE "orderIntentId"=$1`, [first.intentId])).toBe(1);
        expect(await intentState(first.intentId)).toMatchObject({ status: 'failed', claimStatus: 'UNRESOLVED', claimReleased: false });
        expect((await events(first.intentId, 'DISPATCH_OUTCOME_RECORDED'))[0]!.evidenceJson).toMatchObject({ classification: 'NOT_SENT_DISPATCH_RECORD_ACK_LOST', dispatchRecordPresent: true });
        expect((await events(first.intentId, 'NOT_SENT_EVIDENCE_RECORDED')).map((event) => event.evidenceJson.producer)).not.toContain('WORKER_PRE_BOUNDARY_FAILURE');
        // The broker position contradicts release; ownership stays held.
        await secondEntryRefused(first.fixture.assignmentId, 'pdaua-2', 'ENTRY_EXPOSURE_UNRESOLVED');
        harness.positions.delete('PDAUA');

        // (b) An earlier attempt's committed authorization, then an UNCLASSIFIED lookup failure.
        const second = await entry('PDAUB', 'pdaub-1', acct);
        await emulateWorkerClaim(second.intentId);
        const prepared = await guard.prepareEntryBrokerDispatch({ orderIntentId: second.intentId, tradingAccountId: acct, symbol: 'PDAUB', clientOrderId: 'pdaub-1' });
        await prepared.authorizeDispatch(null);
        await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [second.intentId]);
        expect((await claims.requireEntryExposureClaim(second.intentId)).status).toBe('ENTRY_SUBMITTING');
        harness.lookupErrors.set('pdaub-1', () => new TypeError('fetch failed'));
        try {
          await dispatch(acct);
        } finally {
          harness.lookupErrors.delete('pdaub-1');
        }
        expect(posts('pdaub-1')).toBe(0);
        expect(await intentState(second.intentId)).toMatchObject({ status: 'failed', blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:fetch failed', claimStatus: 'UNRESOLVED', claimReleased: false });
        expect((await events(second.intentId, 'DISPATCH_OUTCOME_RECORDED'))[0]!.evidenceJson).toMatchObject({ classification: 'DELIVERY_UNCERTAIN', observation: 'OBSERVED', dispatchRecordPresent: true,
          message: expect.stringContaining('DISPATCH_RECORD_PRESENT') });
        expect(await events(second.intentId, 'NOT_SENT_EVIDENCE_RECORDED')).toHaveLength(0);
        await secondEntryRefused(second.fixture.assignmentId, 'pdaub-2', 'ENTRY_EXPOSURE_UNRESOLVED');
      });

      it('an existing broker order with mismatched identity keeps ownership held and sends nothing', async () => {
        const acct = await paperAccount('PDIDM');
        const { fixture, intentId } = await entry('PDIDM', 'pdidm-1', acct);
        harness.orders.set('pdidm-1', { id: 'alpaca-foreign-pdidm', client_order_id: 'pdidm-1', symbol: 'OTHER', side: 'buy', status: 'accepted', qty: '1', filled_qty: '0' });
        try {
          await dispatch(acct);
        } finally {
          harness.orders.delete('pdidm-1');
        }
        expect(posts('pdidm-1')).toBe(0);
        expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringMatching(/^BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:Broker order found by stable client order ID does not match/), claimStatus: 'UNRESOLVED', claimReleased: false, brokerOrders: 0 });
        expect(await events(intentId, 'NOT_SENT_EVIDENCE_RECORDED')).toHaveLength(0);
        await secondEntryRefused(fixture.assignmentId, 'pdidm-2', 'ENTRY_EXPOSURE_UNRESOLVED');
      });

      it('a previously recorded ambiguous outcome keeps a later lookup failure delivery-uncertain', async () => {
        const acct = await paperAccount('PDAMB');
        const { fixture, intentId } = await entry('PDAMB', 'pdamb-1', acct);
        // An earlier attempt's observed uncertain outcome on the still-pending lifecycle.
        await db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'DISPATCH_OUTCOME_RECORDED',$2)`,
          [await claimIdOf(intentId), JSON.stringify({ classification: 'DELIVERY_UNCERTAIN', source: 'WORKER', observation: 'OBSERVED', adapterInvocation: 'UNKNOWN' })]);
        harness.lookupErrors.set('pdamb-1', () => new TypeError('fetch failed'));
        try {
          await dispatch(acct);
        } finally {
          harness.lookupErrors.delete('pdamb-1');
        }
        expect(posts('pdamb-1')).toBe(0);
        expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:fetch failed', claimStatus: 'UNRESOLVED', claimReleased: false });
        expect((await events(intentId, 'DISPATCH_OUTCOME_RECORDED')).at(-1)!.evidenceJson).toMatchObject({ message: expect.stringContaining('PRIOR_DELIVERY_OUTCOME_RECORDED') });
        expect(await events(intentId, 'NOT_SENT_EVIDENCE_RECORDED')).toHaveLength(0);
        await secondEntryRefused(fixture.assignmentId, 'pdamb-2', 'ENTRY_EXPOSURE_UNRESOLVED');
      });

      it('a legacy claim without marker-protocol evidence is never inferred non-delivered from a missing marker', async () => {
        const acct = await paperAccount('PDLEG');
        const { claims, recovery } = await services();
        const { prisma } = await import('../prisma.js');
        const { fixture, intentId } = await entry('PDLEG', 'pdleg-1', acct);
        // A pre-protocol worker claimed the intent (no markerProtocol) before it returned to the queue.
        await claims.transitionEntryExposureClaim({ orderIntentId: intentId, status: 'ENTRY_SUBMITTING', eventType: 'WORKER_CLAIMED_FOR_SUBMISSION', evidence: { worker: 'legacy' } });
        await db.query(`UPDATE "OrderIntent" SET status='submitting' WHERE id=$1`, [intentId]);
        expect(await recovery.proveWorkerPreDispatchNonDelivery(prisma, { orderIntentId: intentId, tradingAccountId: acct })).toMatchObject({ proven: false, blockers: ['MARKER_PROTOCOL_NOT_ESTABLISHED'] });
        await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [intentId]);
        harness.lookupErrors.set('pdleg-1', () => new TypeError('fetch failed'));
        try {
          await dispatch(acct);
        } finally {
          harness.lookupErrors.delete('pdleg-1');
        }
        expect(posts('pdleg-1')).toBe(0);
        expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:fetch failed', claimStatus: 'UNRESOLVED', claimReleased: false });
        expect((await events(intentId, 'DISPATCH_OUTCOME_RECORDED'))[0]!.evidenceJson).toMatchObject({ message: expect.stringContaining('MULTIPLE_SUBMISSION_CLAIMS') });
        expect(await events(intentId, 'NOT_SENT_EVIDENCE_RECORDED')).toHaveLength(0);
        await secondEntryRefused(fixture.assignmentId, 'pdleg-2', 'ENTRY_EXPOSURE_UNRESOLVED');
      });

      // LOW-1: abandoned admissions.
      it('LOW-1: recovers an abandoned admission whose cleanup also failed, only after the stale threshold and only from proof', async () => {
        const acct = await paperAccount('SADM');
        await credential(acct);
        const { worker, eligibility, orderAudit } = await services();
        const fixture = await instrument('SADM', mainStrategyId, acct);
        // Real PostgreSQL faults: the admission's pending transition and its cleanup both fail.
        const name = `test_fail_admission_${++triggerSeq}`;
        await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."clientOrderId" = 'sadm-1' AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'injected transient connection failure'; END IF; RETURN NEW; END $$`);
        await db.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON "OrderIntent" FOR EACH ROW EXECUTE FUNCTION ${name}()`);
        try {
          await expect(submit(fixture.assignmentId, 'sadm-1')).rejects.toThrow(/injected transient connection failure/);
        } finally {
          await db.query(`DROP TRIGGER ${name} ON "OrderIntent"`);
          await db.query(`DROP FUNCTION ${name}()`);
        }
        const intentId = (await one(`SELECT id FROM "OrderIntent" WHERE "clientOrderId"='sadm-1'`)).id as number;
        expect(await intentState(intentId)).toMatchObject({ status: 'received', claimStatus: 'ENTRY_PENDING', claimReleased: false });
        await secondEntryRefused(fixture.assignmentId, 'sadm-2', 'ENTRY_ALREADY_PENDING');
        // Before the threshold nothing selects it.
        expect((await worker.recoverStaleSubmittingIntentsForAccount(acct)).admissionRecovery).toMatchObject({ examined: 0 });
        expect(await intentState(intentId)).toMatchObject({ status: 'received', claimReleased: false });
        await ageIntent(intentId, 20);
        const [enumerated] = (await eligibility.enumerateLifecycleAccounts('submitted_orders', { persistWorkerHealth: false })).filter((item) => item.tradingAccountId === acct);
        expect(enumerated).toMatchObject({ eligible: true, exposureSummary: { staleAdmissionClaimsDue: 1, staleAdmissionClaimsHeld: 1 } });
        expect((await worker.recoverStaleSubmittingIntentsForAccount(acct)).admissionRecovery).toMatchObject({ examined: 1, released: 1, retained: 0 });
        expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringMatching(/^STALE_ADMISSION_NEVER_DISPATCHED/), claimReleased: true, releaseReason: 'STALE_ADMISSION_NEVER_SUBMITTED', brokerOrders: 0 });
        expect((await events(intentId, 'NOT_SENT_EVIDENCE_RECORDED'))[0]!.evidenceJson).toMatchObject({ producer: 'STALE_ADMISSION_NEVER_EXECUTABLE', source: 'STALE_ADMISSION_RECOVERY', proof: { basis: 'CLAIM_NEVER_LEFT_ENTRY_PENDING' } });
        expect(await count(`"SystemEvent" WHERE type='entry_exposure.stale_admission_recovered' AND "tradingAccountId"=$1`, [acct])).toBe(1);
        // A hung admission resuming afterwards can never make the failed intent executable.
        expect(await orderAudit.transitionOrderIntentStatusFrom(intentId, 'received', 'pending')).toBe(false);
        expect(await intentState(intentId)).toMatchObject({ status: 'failed' });
        const fresh = await submit(fixture.assignmentId, 'sadm-3');
        await dispatch(acct);
        expect([posts('sadm-1'), posts('sadm-3')]).toEqual([0, 1]);
        expect(await intentState(fresh.intentId)).toMatchObject({ status: 'submitted' });
      });

      it('LOW-1: never touches an old pending submission, and retains an abandoned admission with contradictory evidence for investigation', async () => {
        const acct = await paperAccount('SADN');
        await credential(acct);
        const { worker, entryReadiness } = await services();
        const pending = await entry('SADP', 'sadp-1', acct);
        await ageIntent(pending.intentId, 60);
        const contradicted = await entry('SADC', 'sadc-1', acct);
        await db.query(`UPDATE "OrderIntent" SET status='received' WHERE id=$1`, [contradicted.intentId]);
        // Contradictory evidence: an adapter-invocation marker on a claim that never left ENTRY_PENDING.
        await db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'ADAPTER_INVOCATION_STARTED','{"protocol":"ADAPTER_MARKER_V1"}')`, [await claimIdOf(contradicted.intentId)]);
        await ageIntent(contradicted.intentId, 20);
        expect((await worker.recoverStaleSubmittingIntentsForAccount(acct)).admissionRecovery).toMatchObject({ examined: 1, released: 0, retained: 1 });
        expect(await intentState(pending.intentId)).toMatchObject({ status: 'pending', claimStatus: 'ENTRY_PENDING', claimReleased: false });
        expect(await intentState(contradicted.intentId)).toMatchObject({ status: 'received', claimStatus: 'ENTRY_PENDING', claimReleased: false });
        expect((await events(contradicted.intentId, 'STALE_ADMISSION_RECOVERY_BLOCKED'))[0]!.evidenceJson).toMatchObject({ blockers: expect.arrayContaining(['ADAPTER_INVOCATION_MARKER_PRESENT']) });
        const report = await entryReadiness.assessEntryExposureReadiness({ tradingAccountIds: [acct] });
        expect(report.databaseReady).toBe(false);
        expect(report.staleAdmissionClaims).toEqual([expect.objectContaining({ orderIntentId: contradicted.intentId, clientOrderId: 'sadc-1', intentStatus: 'received',
          claimStatus: 'ENTRY_PENDING', recoveryState: 'OPERATOR_INVESTIGATION', blockers: expect.arrayContaining(['ADAPTER_INVOCATION_MARKER_PRESENT']) })]);
        // Leased: an immediate repeat attempts nothing and appends nothing.
        expect((await worker.recoverStaleSubmittingIntentsForAccount(acct)).admissionRecovery).toMatchObject({ examined: 0 });
        expect(await events(contradicted.intentId, 'STALE_ADMISSION_RECOVERY_BLOCKED')).toHaveLength(1);
        await secondEntryRefused(contradicted.fixture.assignmentId, 'sadc-2', 'ENTRY_ALREADY_PENDING');
        await dispatch(acct);
        expect([posts('sadp-1'), posts('sadc-1')]).toEqual([1, 0]);
      });

      // LOW-2: readiness reflects the newest attempt, including a repeat separated by another result.
      it('LOW-2: TECHNICAL_FAILURE -> EVIDENCE_BLOCKED -> TECHNICAL_FAILURE is reported as it happened, without an event per attempt', async () => {
        const acct = await liveAccount('L2SEQ');
        const { recovery } = await services();
        const { intentId } = await entry('LSEQ', 'lseq-1', acct);
        const error = await rejection(422);
        harness.submitError = async () => error;
        await dispatch(acct);
        harness.submitError = null;
        const claimId = await claimIdOf(intentId);
        harness.positions.set('LSEQ', { symbol: 'LSEQ', side: 'long', qty: '1' });
        // Real PostgreSQL fault: the local exposure verification cannot read broker activities.
        const attempt = async (offsetMs: number, technicalFailure: boolean) => {
          if (technicalFailure) await db.query(`ALTER TABLE "BrokerActivity" RENAME TO "BrokerActivity_unavailable"`);
          try {
            expect(await recovery.recoverTerminalEntryClaimsForAccount(acct, later(offsetMs))).toMatchObject({ examined: 1, attempted: [claimId], released: 0 });
          } finally {
            if (technicalFailure) await db.query(`ALTER TABLE "BrokerActivity_unavailable" RENAME TO "BrokerActivity"`);
          }
          return readinessOf(acct, intentId);
        };
        try {
          expect(await attempt(120_000, true)).toMatchObject({ systemRecovery: 'TECHNICAL_FAILURE_RETRY_SCHEDULED', lastRecoveryResult: expect.objectContaining({ eventType: 'DISPATCH_RECOVERY_ERROR', result: 'TECHNICAL_FAILURE' }) });
          expect(await attempt(240_000, false)).toMatchObject({ systemRecovery: 'RETRY_SCHEDULED', lastRecoveryResult: expect.objectContaining({ eventType: 'DISPATCH_RECOVERY_RELEASE_BLOCKED', result: 'BLOCKED_BY_EVIDENCE', blockers: ['BROKER_POSITION_PRESENT'] }) });
          const third = await attempt(360_000, true);
          expect(third).toMatchObject({ systemRecovery: 'TECHNICAL_FAILURE_RETRY_SCHEDULED', lastRecoveryResult: expect.objectContaining({ eventType: 'DISPATCH_RECOVERY_ERROR', result: 'TECHNICAL_FAILURE' }) });
          expect(third!.lastAttemptAt!.getTime()).toBeGreaterThanOrEqual(later(360_000).getTime() - 5_000);
          // A persistent repeat of the newest result appends nothing further.
          await attempt(480_000, true);
          expect(await events(intentId, 'DISPATCH_RECOVERY_ERROR')).toHaveLength(2);
          expect(await events(intentId, 'DISPATCH_RECOVERY_RELEASE_BLOCKED')).toHaveLength(1);
          expect(await events(intentId, 'DISPATCH_RECOVERY_ATTEMPT_RESULT')).toHaveLength(0);
        } finally {
          harness.positions.delete('LSEQ');
        }
        expect(posts('lseq-1')).toBe(1);
        expect(await intentState(intentId)).toMatchObject({ claimStatus: 'UNRESOLVED', claimReleased: false });
      });
    });
  });
});
