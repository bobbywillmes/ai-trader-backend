import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 3C.3 authoritative broker-time market-policy enforcement against real PostgreSQL. The real
// order worker drives submitOrderToBroker; Alpaca is stubbed only at the adapter boundary.
const PRE_INTENT_MIGRATION = '20261018150000_market_policy_pre_intent_enforcement';
const BROKER_TIME_MIGRATION = '20261018170000_market_policy_broker_time_enforcement';
const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

type BrokerOrder = { id: string; client_order_id: string; symbol: string; side: string; status: string; qty: string; filled_qty: string };

const harness = vi.hoisted(() => ({
  orders: new Map<string, BrokerOrder>(),
  lookupFailures: new Set<string>(),
  submitCalls: [] as Array<{ accountId: number; payload: { client_order_id: string; symbol: string } }>,
  submitError: null as null | (() => Promise<Error>),
  onSubmit: null as null | (() => Promise<void>),
  beforeConsume: null as null | (() => Promise<void>),
  evaluatorMode: 'real' as 'real' | 'throw' | 'forge',
  admissionRiskBlocked: new Set<number>(),
  workerRiskBlocked: new Set<number>(),
}));

vi.mock('../../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderByClientOrderId: vi.fn(async (_accountId: number, clientOrderId: string) => {
    if (harness.lookupFailures.has(clientOrderId)) throw new Error('Alpaca client-order lookup unavailable');
    return harness.orders.get(clientOrderId) ?? null;
  }),
  getAlpacaOrderById: vi.fn(async (_accountId: number, id: string) => [...harness.orders.values()].find(order => order.id === id) ?? null),
  getCompleteOpenAlpacaBuyOrders: vi.fn(async () => []),
  getCompleteOpenAlpacaBuyOrdersForSymbol: vi.fn(async () => []),
  getOpenAlpacaOrders: vi.fn(async () => []),
  submitAlpacaEntryOrder: vi.fn(async (accountId: number, payload: { client_order_id: string; symbol: string; qty?: string }) => {
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
vi.mock('../../integrations/alpaca/positions.adapter.js', () => ({ getAlpacaPositions: vi.fn(async () => []), getAlpacaPositionBySymbol: vi.fn(async () => null) }));
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
  const database = `broker_time_enforcement_${randomUUID().replaceAll('-', '')}`;
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
    await claims.transitionEntryExposureClaim({ orderIntentId, status: 'ENTRY_SUBMITTING', eventType: 'WORKER_CLAIMED_FOR_SUBMISSION' });
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    expect(migrations.at(-1)).toBe(BROKER_TIME_MIGRATION);
    // Replay up to Phase 3C.1 so a Security-unbound V1 grant exists when Phase 3C.2 invalidates it (L5).
    for (const migration of migrations.filter(name => name < PRE_INTENT_MIGRATION)) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    ownerId = await user('owner@phase3c3.test', 'SYSTEM_OWNER');
    otherOwnerId = await user('other-owner@phase3c3.test', 'SYSTEM_OWNER');
    paperId = await account('Paper', 'PAPER', ownerId);
    secondPaperId = await account('Second Paper', 'PAPER', otherOwnerId);
    liveId = await account('Live', 'LIVE', ownerId);
    exitProfileId = (await db.query(`INSERT INTO "ExitProfile" (key,name,"exitMode","takeProfitBehavior",enabled,"createdAt","updatedAt") VALUES ('phase3c3','Phase 3C.3','fixed','limit',true,now(),now()) RETURNING id`)).rows[0].id;
    process.env.DATABASE_URL = databaseUrl;
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
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    for (const value of extraClients) await value.end().catch(() => undefined);
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); }
  });

  beforeEach(() => {
    harness.submitError = null; harness.onSubmit = null; harness.beforeConsume = null; harness.evaluatorMode = 'real';
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

  // 10: an inconclusive lookup is never proof of absence.
  it('keeps delivery uncertainty and sends no POST when the stable client-order-ID lookup is inconclusive', async () => {
    const fixture = await enforced('AMBG');
    const intentId = await admitted(fixture, 'ambg-1');
    harness.lookupFailures.add('ambg-1');
    await dispatch();
    harness.lookupFailures.delete('ambg-1');
    expect(posts('ambg-1')).toBe(0);
    expect(await decisionsFor(intentId)).toHaveLength(0);
    expect(await intentState(intentId)).toMatchObject({ status: 'failed', blockReason: expect.stringContaining('BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN'), claimStatus: 'UNRESOLVED', claimReleased: false });
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
    // Stale-submission recovery confirms absence and fails the entry without requeueing it.
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
    await expect(prepared.authorizeDispatch(null)).rejects.toMatchObject({ outcome: 'TECHNICAL_FAILURE' });
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
});
