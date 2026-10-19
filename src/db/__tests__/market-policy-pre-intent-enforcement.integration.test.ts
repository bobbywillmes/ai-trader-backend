import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Phase 3C.2 authoritative pre-intent market-policy enforcement against real PostgreSQL.
const ENFORCEMENT_MIGRATION = '20261018150000_market_policy_pre_intent_enforcement';
const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

const harness = vi.hoisted(() => ({ riskBlockedAssignments: new Set<number>(), brokerCalls: [] as unknown[] }));

vi.mock('../../integrations/alpaca/orders.adapter.js', () => {
  const prohibited = vi.fn(async (...args: unknown[]) => {
    harness.brokerCalls.push(args);
    throw new Error('Broker calls are prohibited in Phase 3C.2 admission tests.');
  });
  return {
    getAlpacaOrderById: prohibited, getAlpacaOrderByClientOrderId: prohibited, getCompleteOpenAlpacaBuyOrders: prohibited,
    getCompleteOpenAlpacaBuyOrdersForSymbol: prohibited, getOpenAlpacaOrders: prohibited, submitAlpacaEntryOrder: prohibited,
    submitVerifiedAlpacaExitOrder: prohibited, cancelAlpacaOrder: prohibited, cancelAllAlpacaOrders: prohibited,
  };
});
vi.mock('../../integrations/alpaca/positions.adapter.js', () => {
  const prohibited = vi.fn(async (...args: unknown[]) => { harness.brokerCalls.push(args); throw new Error('Broker calls are prohibited.'); });
  return { getAlpacaPositions: prohibited, getAlpacaPositionBySymbol: prohibited };
});
vi.mock('../../services/risk-gate.service.js', () => ({ evaluateOrderRisk: vi.fn(), logRiskGateBlockedOrder: vi.fn(async () => undefined) }));
// The pre-claim entry evaluation (sizing, reference price, live policy) is exercised elsewhere; here it
// resolves the exact assignment from PostgreSQL so admission, claims and intents are fully real.
vi.mock('../../services/assignment-entry-evaluation.service.js', () => ({
  evaluateAssignmentEntry: vi.fn(async ({ input }: { input: { tradingAccountSubscriptionId: number } }) => {
    const { prisma } = await import('../prisma.js');
    const assignment = await prisma.tradingAccountSubscription.findUniqueOrThrow({ where: { id: input.tradingAccountSubscriptionId }, include: { subscription: true } });
    const resolved = {
      tradingAccountId: assignment.tradingAccountId, tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId,
      subscriptionKey: assignment.subscription.key, symbol: assignment.subscription.symbol, side: 'buy' as const, orderType: 'market' as const,
      timeInForce: 'day' as const, extendedHours: false, signalType: 'entry' as const, qty: 1,
    };
    const blocked = harness.riskBlockedAssignments.has(assignment.id);
    return {
      input: resolved,
      sizing: { tradingAccountSubscriptionId: assignment.id, qty: 1, estimatedNotional: 100, snapshot: { tradingAccountSubscriptionId: assignment.id, sizingType: 'FIXED_QTY', calculatedQty: 1 } },
      risk: blocked ? { allowed: false, statusCode: 409, reason: 'Daily entry order limit reached.', details: { rule: 'daily_entry_order_limit' } } : { allowed: true, statusCode: 200, reason: 'allowed', details: {} },
      blockers: [], outcomeCode: blocked ? 'ENTRY_RISK_BLOCKED' : 'ENTRY_ELIGIBLE',
    };
  }),
}));

type Generation = { id: number; configurationFingerprint: string; policyRevisionId: number };

(enabled ? describe : describe.skip)('Phase 3C.2 pre-intent market-policy enforcement PostgreSQL integrity', () => {
  const database = `pre_intent_enforcement_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, databaseUrl: string;
  let ownerId: number, otherOwnerId: number, operatorId: number, transferHolderId: number;
  let paperId: number, secondPaperId: number, liveId: number, exitProfileId: number;
  let mainStrategyId: number, legacyAssignmentId: number, legacyAuthorizationId: number;
  const extraClients: Client[] = [];
  let compositionSeq = 0;
  const T0 = Date.now() - 2 * 3_600_000;

  const services = async () => ({
    authz: await import('../../services/assignment-market-policy-enforcement-authorization.service.js'),
    enrollment: await import('../../services/assignment-market-policy-enrollment.service.js'),
    policy: await import('../../services/strategy-market-policy.service.js'),
    rollout: await import('../../services/market-policy-enforcement-rollout.service.js'),
    admission: await import('../../services/market-policy-entry-admission.service.js'),
    placeOrder: await import('../../services/place-order.service.js'),
    orderAudit: await import('../../services/order-audit.service.js'),
    eligibility: await import('../../services/strategy-market-eligibility.service.js'),
  });
  const count = async (sql: string, params: unknown[] = []) => (await db.query(`SELECT count(*)::int AS count FROM ${sql}`, params)).rows[0].count as number;
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];
  const user = async (email: string, role: string) => (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ($1,$2,true,now(),now()) RETURNING id`, [email, role])).rows[0].id as number;
  const account = async (name: string, environment: string, holder: number) => (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,'PAUSED',false,true,now(),now()) RETURNING id`, [holder, name, environment])).rows[0].id as number;
  const security = async (symbol: string) => (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ($1,$1,true,'STOCK',now(),now()) RETURNING id`, [symbol])).rows[0].id as number;
  const subscription = async (key: string, strategyId: number, securityId: number, symbol: string) => (await db.query(`INSERT INTO "Subscription" (key,name,symbol,enabled,"strategyId","exitProfileId","securityId","createdAt","updatedAt") VALUES ($1,$1,$2,true,$3,$4,$5,now(),now()) RETURNING id`, [key, symbol, strategyId, exitProfileId, securityId])).rows[0].id as number;
  const assign = async (accountId: number, subscriptionId: number) => (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [accountId, subscriptionId])).rows[0].id as number;
  const releaseClaims = () => db.query(`UPDATE "EntryExposureClaim" SET status='RELEASED', "releasedAt"=now(), "releaseReason"='TEST_RELEASED_BETWEEN_SCENARIOS', "updatedAt"=now() WHERE "releasedAt" IS NULL`);
  const client = async () => { const value = new Client({ connectionString: databaseUrl }); await value.connect(); extraClients.push(value); return value; };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  async function strategy(key: string, trendStates: string[] = ['UP']) {
    const { policy } = await services();
    const id = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ($1,$1,true,now(),now()) RETURNING id`, [key])).rows[0].id as number;
    const created = await policy.createStrategyMarketPolicy(id, ownerId, `${key} fixture`);
    const initial = created.revisions[0]!;
    const saved = await policy.saveStrategyMarketPolicyRevision(id, initial.id, { expectedConfigurationFingerprint: initial.configurationFingerprint, rules: initial.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: rule.dimension === 'TREND' ? trendStates : [] })) }, ownerId);
    await policy.activateStrategyMarketPolicyRevision(id, saved.id, saved.configurationFingerprint, ownerId);
    return id;
  }

  async function instrument(symbol: string, strategyId: number, accountId = paperId) {
    const securityId = await security(symbol);
    const subscriptionId = await subscription(`sub-${symbol.toLowerCase()}-${strategyId}`, strategyId, securityId, symbol);
    const assignmentId = await assign(accountId, subscriptionId);
    return { securityId, subscriptionId, assignmentId, symbol };
  }

  async function enroll(accountId: number, assignmentId: number): Promise<Generation> {
    const { enrollment } = await services();
    const prepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(accountId, assignmentId, ownerId);
    return enrollment.activateAssignmentMarketPolicyEnrollment(accountId, assignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
  }

  async function grant(accountId: number, assignmentId: number, generation: Generation, actor = ownerId) {
    const { authz } = await services();
    return authz.grantAssignmentMarketPolicyEnforcementAuthorization(accountId, assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'Authorize PAPER enforcement' }, actor);
  }

  async function enforced(symbol: string, strategyId = mainStrategyId, accountId = paperId) {
    const fixture = await instrument(symbol, strategyId, accountId);
    const generation = await enroll(accountId, fixture.assignmentId);
    const authorization = await grant(accountId, fixture.assignmentId, generation);
    return { ...fixture, generation, authorizationId: authorization!.id };
  }

  // Five immutable V1 sources; TREND is the only REQUIRED dimension in the fixture policies.
  async function composition(options: { trend?: string | null; trendValidUntil?: Date; missingIgnored?: boolean } = {}) {
    const trend = options.trend === undefined ? 'UP' : options.trend;
    const at = new Date(T0 + (++compositionSeq) * 1_000).toISOString();
    const defaultValid = new Date(Date.now() + 3_600_000);
    const trendValid = options.trendValidUntil ?? defaultValid;
    const dimensions = [['TREND', 'TREND_V1', trend], ['VOLATILITY', 'VOLATILITY_V1', 'NORMAL'], ['BREADTH', 'BREADTH_V1', 'MIXED'], ['PARTICIPATION', 'PARTICIPATION_V1', 'NORMAL'], ['INTRADAY_STRESS', 'INTRADAY_STRESS_V1', 'NORMAL']] as const;
    const unhealthy = (dimension: string) => dimension === 'TREND' ? trend === null : Boolean(options.missingIgnored) && dimension === 'VOLATILITY';
    const validUntil = (dimension: string) => (dimension === 'TREND' ? trendValid : defaultValid).toISOString();
    const sourceIds = new Map<string, number>();
    for (const [dimension, version, state] of dimensions) {
      if (unhealthy(dimension)) continue;
      sourceIds.set(dimension, (await db.query(`INSERT INTO "MarketRegimeDimensionAssessment" (dimension,"algorithmVersion","evidenceSchemaVersion","targetAt","sessionDate",attempt,status,"rawState","effectiveState","dataThroughAt","validUntil","startedAt","completedAt","evidenceJson") VALUES ($1,$2,1,$3,DATE '2026-10-16',1,'VALID',$4,$4,$3,$5,$3,$3,'{}') RETURNING id`, [dimension, version, at, state, validUntil(dimension)])).rows[0].id);
    }
    const degraded = dimensions.some(([dimension]) => unhealthy(dimension));
    const aggregateValid = new Date(Math.min(trendValid.getTime(), defaultValid.getTime())).toISOString();
    await db.query('BEGIN');
    const row = (await db.query(`INSERT INTO "MarketRegimeAssessment" ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","dataThroughAt","validUntil","publicationStatus","evidenceHealth","evidenceReasonCode","sourceSetFingerprint","startedAt","completedAt","evidenceJson") VALUES ('MARKET_REGIME_COMPOSITION_V1',1,$1,$1,$2,$3,'SUCCEEDED',$4,$5,$6,$1,$1,'{}') RETURNING id`, [at, degraded ? null : at, degraded ? null : aggregateValid, degraded ? 'DEGRADED' : 'COMPLETE', degraded ? 'SOURCE_VECTOR_DEGRADED' : null, randomUUID().replaceAll('-', '').repeat(2)])).rows[0];
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
    return placeOrder.submitOrder({ tradingAccountSubscriptionId: assignmentId, signalType: 'entry', orderType: 'market', timeInForce: 'day', extendedHours: false }, { clientOrderId });
  }

  async function rejected(promise: Promise<unknown>) {
    try { await promise; } catch (error) { return error as { statusCode: number; message: string; details: Record<string, any> }; }
    throw new Error('Expected the entry to be rejected.');
  }

  const attemptsFor = (assignmentId: number) => db.query(`SELECT * FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE "accountSubscriptionId"=$1 ORDER BY id`, [assignmentId]).then(result => result.rows);
  const intentsFor = (clientOrderId: string) => count(`"OrderIntent" WHERE "clientOrderId"=$1`, [clientOrderId]);
  const claimsFor = (clientOrderId: string) => count(`"EntryExposureClaim" c JOIN "OrderIntent" o ON o.id=c."orderIntentId" WHERE o."clientOrderId"=$1`, [clientOrderId]);

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    expect(migrations).toContain(ENFORCEMENT_MIGRATION);
    // Replay everything before Phase 3C.2 so a pre-existing V1 grant exists when the migration runs.
    for (const migration of migrations.filter(name => name < ENFORCEMENT_MIGRATION)) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    ownerId = await user('owner@phase3c2.test', 'SYSTEM_OWNER');
    otherOwnerId = await user('other-owner@phase3c2.test', 'SYSTEM_OWNER');
    operatorId = await user('operator@phase3c2.test', 'OPERATOR');
    transferHolderId = await user('transfer@phase3c2.test', 'ACCOUNT_USER');
    paperId = await account('Paper', 'PAPER', ownerId);
    secondPaperId = await account('Second Paper', 'PAPER', otherOwnerId);
    liveId = await account('Live', 'LIVE', ownerId);
    exitProfileId = (await db.query(`INSERT INTO "ExitProfile" (key,name,"exitMode","takeProfitBehavior",enabled,"createdAt","updatedAt") VALUES ('phase3c2','Phase 3C.2','fixed','limit',true,now(),now()) RETURNING id`)).rows[0].id;
    process.env.DATABASE_URL = databaseUrl;
    mainStrategyId = await strategy('phase3c2-main');
    // A Phase 3C.1 grant created before this migration, without Security binding.
    const legacy = await instrument('LGCY', mainStrategyId);
    legacyAssignmentId = legacy.assignmentId;
    const generation = await enroll(paperId, legacy.assignmentId);
    legacyAuthorizationId = (await db.query(`INSERT INTO "AssignmentMarketPolicyEnforcementAuthorization" ("enrollmentId","enrollmentGenerationId","authorizationSequence","authorityVersion",status,environment,"tradingAccountId","accountSubscriptionId","strategyId","policyRevisionId","accountHolderUserId","configurationFingerprint","authorizationFingerprint","authorizedByUserId","grantReason")
      SELECT g."enrollmentId", g.id, 1, 'PAPER_MARKET_POLICY_ENFORCEMENT_V1', 'AUTHORIZED', 'PAPER', g."tradingAccountId", g."accountSubscriptionId", g."strategyId", g."policyRevisionId", g."accountHolderUserId", g."configurationFingerprint", $2, $3, 'Phase 3C.1 grant'
      FROM "AssignmentMarketPolicyEnrollmentGeneration" g WHERE g.id=$1 RETURNING id`, [generation.id, 'e'.repeat(64), ownerId])).rows[0].id;
    // Apply Phase 3C.2 and every later migration (Phase 3C.3 broker-time enforcement).
    for (const migration of migrations.filter(name => name >= ENFORCEMENT_MIGRATION)) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
  }, 180_000);

  afterAll(async () => {
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    for (const value of extraClients) await value.end().catch(() => undefined);
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.end(); }
  });

  it('replays the complete migration chain without Prisma schema drift', () => {
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000 });
    expect(result.stdout, result.stderr).toContain('No difference detected');
  }, 70_000);

  it('invalidates Security-unbound V1 grants for explicit reapproval and installs the rollout disabled', async () => {
    expect(await one(`SELECT status, "invalidationReasonCode", "invalidationSource" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [legacyAuthorizationId]))
      .toEqual({ status: 'INVALIDATED', invalidationReasonCode: 'AUTHORITY_BINDING_REAPPROVAL_REQUIRED', invalidationSource: 'MIGRATION' });
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorizationEvent" WHERE "authorizationId"=$1 AND action='INVALIDATE'`, [legacyAuthorizationId])).toBe(1);
    expect(await count(`"SystemEvent" WHERE type='MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_INVALIDATED' AND "entityId"=$1`, [String(legacyAuthorizationId)])).toBe(1);
    expect(await one(`SELECT enabled, version, environment::text FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id=1`)).toEqual({ enabled: false, version: 0, environment: 'PAPER' });
    expect(await count(`"MarketPolicyEnforcementRuntimeRolloutEvent"`)).toBe(0);
    expect(await count(`"MarketPolicyEnforcementAdmissionAttempt"`)).toBe(0);
    expect(await count(`"OrderIntentMarketPolicyEnforcementObligation"`)).toBe(0);
    const { authz } = await services();
    const state = await authz.getAssignmentMarketPolicyEnforcementAuthorization(paperId, legacyAssignmentId, 'SYSTEM_OWNER');
    expect(state).toMatchObject({ state: 'INVALIDATED', runtimeEnforcement: { active: false, status: 'NOT_ACTIVATED' }, enforcement: { disposition: 'LAPSED', behaviorWhenRuntimeActive: 'FAIL_CLOSED', currentEntryBehavior: 'EXISTING_ENTRY_BEHAVIOR', ownerResolutionAvailable: true } });
    // New V1 grants are rejected outright.
    const legacyRow = await one(`SELECT * FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [legacyAuthorizationId]);
    await expect(db.query(`INSERT INTO "AssignmentMarketPolicyEnforcementAuthorization" ("enrollmentId","enrollmentGenerationId","authorizationSequence","authorityVersion",status,environment,"tradingAccountId","accountSubscriptionId","strategyId","policyRevisionId","accountHolderUserId","configurationFingerprint","authorizationFingerprint","authorizedByUserId","grantReason") VALUES ($1,$2,2,'PAPER_MARKET_POLICY_ENFORCEMENT_V1','AUTHORIZED','PAPER',$3,$4,$5,$6,$7,$8,$9,$10,'v1 again')`,
      [legacyRow.enrollmentId, legacyRow.enrollmentGenerationId, legacyRow.tradingAccountId, legacyRow.accountSubscriptionId, legacyRow.strategyId, legacyRow.policyRevisionId, legacyRow.accountHolderUserId, legacyRow.configurationFingerprint, 'd'.repeat(64), ownerId])).rejects.toThrow(/PAPER_MARKET_POLICY_ENFORCEMENT_V2/);
  });

  let main: Awaited<ReturnType<typeof enforced>>;

  it('preserves existing entry behavior while the default-disabled rollout is inactive, even for AUTHORIZED and lapsed assignments', async () => {
    main = await enforced('AAA');
    // No composition exists yet: while inactive, missing evidence is irrelevant to existing behavior.
    const result = await submit(main.assignmentId, 'inactive-authorized');
    expect(result).toMatchObject({ ok: true, status: 'pending' });
    expect(result).not.toHaveProperty('marketPolicyEnforcement');
    expect(await submit(legacyAssignmentId, 'inactive-lapsed')).toMatchObject({ ok: true, status: 'pending' });
    expect(await count(`"MarketPolicyEnforcementAdmissionAttempt"`)).toBe(0);
    expect(await count(`"OrderIntentMarketPolicyEnforcementObligation"`)).toBe(0);
    await releaseClaims();
  });

  it('activates the PAPER rollout only by an explicit, versioned, audited SYSTEM_OWNER action', async () => {
    const { rollout } = await services();
    await expect(rollout.setMarketPolicyEnforcementRuntimeRollout(true, { expectedVersion: 0, reason: 'operator' }, operatorId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(rollout.setMarketPolicyEnforcementRuntimeRollout(true, { expectedVersion: 7, reason: 'stale' }, ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'STALE_ROLLOUT_VERSION' } });
    await expect(rollout.setMarketPolicyEnforcementRuntimeRollout(false, { expectedVersion: 0, reason: 'already off' }, ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'ROLLOUT_ALREADY_INACTIVE' } });
    await expect(db.query(`UPDATE "MarketPolicyEnforcementRuntimeRollout" SET enabled=true, version=1, "changedByUserId"=$1, "changeReason"='direct operator' WHERE id=1`, [operatorId])).rejects.toThrow(/enabled SYSTEM_OWNER/);
    await expect(db.query(`UPDATE "MarketPolicyEnforcementRuntimeRollout" SET enabled=true, version=5, "changedByUserId"=$1, "changeReason"='skip' WHERE id=1`, [ownerId])).rejects.toThrow(/advance the version by one/);
    const status = await rollout.setMarketPolicyEnforcementRuntimeRollout(true, { expectedVersion: 0, reason: 'Begin PAPER enforcement' }, ownerId);
    expect(status).toMatchObject({ active: true, status: 'ACTIVE', version: 1, environment: 'PAPER', liveAuthority: 'NONE', brokerTimeEnforcement: 'FROZEN_OBLIGATIONS_ALWAYS_REVALIDATED', changedBy: { id: ownerId } });
    expect(await one(`SELECT version, action::text, enabled, "actorUserId", reason FROM "MarketPolicyEnforcementRuntimeRolloutEvent"`)).toEqual({ version: 1, action: 'ACTIVATE', enabled: true, actorUserId: ownerId, reason: 'Begin PAPER enforcement' });
    await expect(db.query(`DELETE FROM "MarketPolicyEnforcementRuntimeRollout"`)).rejects.toThrow(/cannot be deleted/);
    await expect(db.query(`UPDATE "MarketPolicyEnforcementRuntimeRolloutEvent" SET reason='rewrite'`)).rejects.toThrow(/immutable/);
    await expect(db.query(`INSERT INTO "MarketPolicyEnforcementRuntimeRollout" (id) VALUES (2)`)).rejects.toThrow(/singleton|duplicate/);
    expect(await count(`"SystemEvent" WHERE type='MARKET_POLICY_ENFORCEMENT_RUNTIME_ACTIVATED'`)).toBe(1);
  });

  it('fails closed with durable INSUFFICIENT_EVIDENCE when no committed composition exists', async () => {
    expect(await count(`"MarketRegimeAssessment"`)).toBe(0);
    const error = await rejected(submit(main.assignmentId, 'missing-composition'));
    expect(error).toMatchObject({ statusCode: 403, details: { code: 'MARKET_POLICY_INSUFFICIENT_EVIDENCE', outcome: 'INSUFFICIENT_EVIDENCE', reasonCode: 'NO_COMPOSITION', orderIntentCreated: false } });
    const [attempt] = await attemptsFor(main.assignmentId);
    expect(attempt).toMatchObject({ outcome: 'INSUFFICIENT_EVIDENCE', reasonCode: 'NO_COMPOSITION', marketRegimeAssessmentId: null, orderIntentCreated: false, enforcementDisposition: 'ENFORCED', authorizationId: main.authorizationId });
    expect(await count(`"MarketPolicyEnforcementAdmissionGate" WHERE "attemptId"=$1`, [attempt.id])).toBe(0);
    expect(await intentsFor('missing-composition')).toBe(0);
    expect(await claimsFor('missing-composition')).toBe(0);
  });

  it('BLOCKED records committed evidence with five gates and creates no OrderIntent, claim, BrokerOrder or broker call', async () => {
    const compositionId = await composition({ trend: 'DOWN' });
    const error = await rejected(submit(main.assignmentId, 'blocked-1'));
    expect(error).toMatchObject({ statusCode: 403, details: { code: 'MARKET_POLICY_BLOCKED', outcome: 'BLOCKED', reasonCode: 'REQUIRED_STATE_BLOCKED', marketRegimeAssessmentId: compositionId, orderIntentCreated: false } });
    // Evidence committed before the caller received the rejection: a separate connection sees it.
    const observer = await client();
    const attempt = (await observer.query(`SELECT * FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE id=$1`, [error.details.attemptId])).rows[0];
    expect(attempt).toMatchObject({ outcome: 'BLOCKED', clientOrderId: 'blocked-1', authorizationId: main.authorizationId, policyRevisionId: main.generation.policyRevisionId, enrollmentGenerationId: main.generation.id, securityId: main.securityId, securitySymbol: 'AAA', authority: 'AUTHORITATIVE', rolloutVersion: 1, evaluatorVersion: 'STRATEGY_MARKET_ELIGIBILITY_V1', authorityVersion: 'PAPER_MARKET_POLICY_ENFORCEMENT_V2', admissionResultCode: 'MARKET_POLICY_BLOCKED' });
    const gates = (await observer.query(`SELECT dimension::text, requirement::text, outcome::text, "observedState", "reasonCode" FROM "MarketPolicyEnforcementAdmissionGate" WHERE "attemptId"=$1 ORDER BY ordinal`, [attempt.id])).rows;
    expect(gates).toHaveLength(5);
    expect(gates[0]).toEqual({ dimension: 'TREND', requirement: 'REQUIRED', outcome: 'BLOCKED', observedState: 'DOWN', reasonCode: 'STATE_NOT_ALLOWED' });
    expect(gates.slice(1).every(gate => gate.outcome === 'IGNORED')).toBe(true);
    expect(await intentsFor('blocked-1')).toBe(0);
    expect(await claimsFor('blocked-1')).toBe(0);
    expect(await count(`"BrokerOrder"`)).toBe(0);
    expect(harness.brokerCalls).toEqual([]);
    expect(await count(`"SystemEvent" WHERE type='MARKET_POLICY_ENTRY_REJECTED' AND "entityId"=$1`, [String(attempt.id)])).toBe(1);
    await expect(db.query(`UPDATE "MarketPolicyEnforcementAdmissionAttempt" SET "reasonCode"='REWRITE' WHERE id=$1`, [attempt.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM "MarketPolicyEnforcementAdmissionGate" WHERE "attemptId"=$1`, [attempt.id])).rejects.toThrow(/immutable/);
  });

  it('ALLOWED atomically freezes the exact authorization, policy, composition and claim with the OrderIntent', async () => {
    const compositionId = await composition({ trend: 'UP' });
    const result = await submit(main.assignmentId, 'allowed-1') as { intentId: number; marketPolicyEnforcement?: { attemptId: number; obligationId: number } };
    expect(result).toMatchObject({ ok: true, status: 'pending', marketPolicyEnforcement: { disposition: 'ENFORCED' } });
    const obligation = await one(`SELECT * FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=$1`, [result.intentId]);
    const authorization = await one(`SELECT * FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [main.authorizationId]);
    expect(obligation).toMatchObject({
      obligationVersion: 'MARKET_POLICY_ENTRY_OBLIGATION_V1', environment: 'PAPER', authorizationId: authorization.id, authorizationFingerprint: authorization.authorizationFingerprint,
      enrollmentGenerationId: main.generation.id, policyRevisionId: main.generation.policyRevisionId, subscriptionId: main.subscriptionId, securityId: main.securityId,
      securitySymbol: 'AAA', marketRegimeAssessmentId: compositionId, authorityVersion: 'PAPER_MARKET_POLICY_ENFORCEMENT_V2', admissionVersion: 'MARKET_POLICY_PRE_INTENT_ENFORCEMENT_V1',
      evaluatorVersion: 'STRATEGY_MARKET_ELIGIBILITY_V1', rolloutVersion: 1, admissionAttemptId: result.marketPolicyEnforcement!.attemptId,
    });
    expect(obligation.validUntil.getTime()).toBeGreaterThan(obligation.evaluatedAt.getTime());
    expect(obligation.frozenContextJson).toMatchObject({ semantics: expect.stringContaining('DURABLE_PER_INTENT_OBLIGATION'), gates: expect.arrayContaining([expect.objectContaining({ dimension: 'TREND', outcome: 'PASS', observedState: 'UP' })]) });
    expect(await one(`SELECT outcome::text, "orderIntentCreated", "admissionResultCode" FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE id=$1`, [obligation.admissionAttemptId])).toEqual({ outcome: 'ALLOWED', orderIntentCreated: true, admissionResultCode: 'ORDER_INTENT_CREATED' });
    expect(await claimsFor('allowed-1')).toBe(1);
    // PostgreSQL recomputes the same V2 fingerprint the application persisted.
    expect((await one(`SELECT "enforcement_authorization_fingerprint_v2"(a, g.generation) = a."authorizationFingerprint" AS ok FROM "AssignmentMarketPolicyEnforcementAuthorization" a JOIN "AssignmentMarketPolicyEnrollmentGeneration" g ON g.id=a."enrollmentGenerationId" WHERE a.id=$1`, [main.authorizationId])).ok).toBe(true);
    // Database backstop: no enforced BUY intent can commit without its frozen obligation.
    await releaseClaims();
    await expect(db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",qty,"clientOrderId",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","createdAt","updatedAt") VALUES ('bypass','AAA','buy','market','day',1,'bypass-1','received','{}',$1,$2,now(),now())`, [paperId, main.assignmentId])).rejects.toThrow(/requires an ALLOWED frozen enforcement obligation/);
    await expect(db.query(`UPDATE "OrderIntentMarketPolicyEnforcementObligation" SET "policyRevisionId"="policyRevisionId" WHERE id=$1`, [obligation.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE id=$1`, [obligation.id])).rejects.toThrow(/immutable/);
  });

  it('recovers stable client-order-ID retries without a second decision or entry', async () => {
    await composition({ trend: 'UP' });
    const first = await submit(main.assignmentId, 'retry-1') as { intentId: number };
    const second = await submit(main.assignmentId, 'retry-1') as { intentId: number; duplicate?: boolean };
    expect(second).toMatchObject({ intentId: first.intentId, duplicate: true });
    await releaseClaims();
    const concurrent = await Promise.allSettled([1, 2, 3].map(() => submit(main.assignmentId, 'retry-2')));
    const ids = new Set(concurrent.filter(result => result.status === 'fulfilled').map(result => (result as PromiseFulfilledResult<{ intentId: number }>).value.intentId));
    expect(ids.size).toBe(1);
    expect(await intentsFor('retry-2')).toBe(1);
    expect(await count(`"MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId"='retry-2' AND "orderIntentCreated"`)).toBe(1);
    expect(await count(`"MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId"='retry-1'`)).toBe(1);
    await releaseClaims();
  });

  it('fails closed when a REQUIRED source is missing (INSUFFICIENT_EVIDENCE)', async () => {
    await composition({ trend: null });
    const error = await rejected(submit(main.assignmentId, 'missing-trend'));
    expect(error).toMatchObject({ statusCode: 403, details: { code: 'MARKET_POLICY_INSUFFICIENT_EVIDENCE', reasonCode: 'REQUIRED_EVIDENCE_INSUFFICIENT' } });
    expect(error.details.gates[0]).toMatchObject({ dimension: 'TREND', outcome: 'INSUFFICIENT_EVIDENCE' });
    expect(await intentsFor('missing-trend')).toBe(0);
  });

  it('fails closed on an expired REQUIRED source even when every IGNORED dimension is healthy', async () => {
    await composition({ trend: 'UP', trendValidUntil: new Date(Date.now() - 5_000) });
    const error = await rejected(submit(main.assignmentId, 'expired-trend'));
    expect(error).toMatchObject({ statusCode: 403, details: { code: 'MARKET_POLICY_INSUFFICIENT_EVIDENCE' } });
    const gates = (await db.query(`SELECT dimension::text, outcome::text, "sourceHealth"::text, "reasonCode" FROM "MarketPolicyEnforcementAdmissionGate" WHERE "attemptId"=$1 ORDER BY ordinal`, [error.details.attemptId])).rows;
    expect(gates[0]).toEqual({ dimension: 'TREND', outcome: 'INSUFFICIENT_EVIDENCE', sourceHealth: 'EXPIRED', reasonCode: 'SOURCE_EXPIRED_AT_EVALUATION' });
    expect(gates.slice(1).every(gate => gate.outcome === 'IGNORED' && gate.sourceHealth === 'AVAILABLE')).toBe(true);
    expect(await intentsFor('expired-trend')).toBe(0);
  });

  it('ALLOWs a DEGRADED composition when every REQUIRED gate passes on healthy evidence', async () => {
    const compositionId = await composition({ trend: 'UP', missingIgnored: true });
    const result = await submit(main.assignmentId, 'degraded-allowed') as { intentId: number; marketPolicyEnforcement: { attemptId: number } };
    expect(result).toMatchObject({ ok: true });
    const attempt = await one(`SELECT outcome::text, "compositionEvidenceHealth"::text, "marketRegimeAssessmentId" FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE id=$1`, [result.marketPolicyEnforcement.attemptId]);
    expect(attempt).toEqual({ outcome: 'ALLOWED', compositionEvidenceHealth: 'DEGRADED', marketRegimeAssessmentId: compositionId });
    expect(await one(`SELECT outcome::text, "sourceHealth"::text FROM "MarketPolicyEnforcementAdmissionGate" WHERE "attemptId"=$1 AND dimension='VOLATILITY'`, [result.marketPolicyEnforcement.attemptId])).toEqual({ outcome: 'IGNORED', sourceHealth: 'MISSING' });
    await releaseClaims();
  });

  it('fails closed on technical evaluation failure and when a forged ALLOWED violates the PostgreSQL gate contract', async () => {
    const { admission, orderAudit, eligibility } = await services();
    const request = (clientOrderId: string) => ({
      tradingAccountId: paperId, tradingAccountSubscriptionId: main.assignmentId, symbol: 'AAA', clientOrderId, ownerKey: `entry:${paperId}:${clientOrderId}`, requestSource: 'api' as const,
      createIntent: (tx: Parameters<typeof orderAudit.createOrderIntent>[5]) => orderAudit.createOrderIntent({ symbol: 'AAA', side: 'buy', orderType: 'market', timeInForce: 'day', extendedHours: false, qty: 1, subscriptionId: main.subscriptionId, signalType: 'entry' } as never, 'api', clientOrderId, paperId, { tradingAccountSubscriptionId: main.assignmentId }, tx),
    });
    await composition({ trend: 'UP' });
    const failure = await rejected(admission.admitEntryOrderIntent(request('technical-1'), { evaluator: () => { throw new Error('evaluator exploded'); } }));
    expect(failure).toMatchObject({ statusCode: 503, details: { code: 'MARKET_POLICY_ENFORCEMENT_TECHNICAL_FAILURE', stage: 'MARKET_EVALUATION', orderIntentCreated: false } });
    expect(await one(`SELECT outcome::text, "reasonCode", "technicalDiagnostic", "orderIntentCreated" FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE id=$1`, [failure.details.attemptId]))
      .toEqual({ outcome: 'TECHNICAL_FAILURE', reasonCode: 'TECHNICAL_FAILURE_MARKET_EVALUATION', technicalDiagnostic: expect.stringContaining('evaluator exploded'), orderIntentCreated: false });
    expect(await intentsFor('technical-1')).toBe(0);
    await composition({ trend: 'DOWN' });
    const forged = await rejected(admission.admitEntryOrderIntent(request('forged-1'), {
      evaluator: (rules, sources, at) => {
        const real = eligibility.evaluateStrategyMarketEligibility(rules, sources, at);
        return { ...real, outcome: 'ALLOWED', reasonCode: 'FORGED', validUntil: new Date(Date.now() + 600_000), gates: real.gates.map(gate => (gate.dimension === 'TREND' ? { ...gate, outcome: 'PASS', reasonCode: 'FORGED' } : gate) as typeof gate) };
      },
    }));
    expect(forged).toMatchObject({ statusCode: 503, details: { code: 'MARKET_POLICY_ENFORCEMENT_TECHNICAL_FAILURE', diagnostic: expect.stringContaining('five-dimension REQUIRED/IGNORED contract') } });
    expect(await intentsFor('forged-1')).toBe(0);
    expect(await claimsFor('forged-1')).toBe(0);
    expect(await count(`"MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId"='forged-1' AND outcome='ALLOWED'`)).toBe(0);
  });

  it('keeps the ordinary risk gate after ALLOWED and preserves the immutable obligation of a risk-blocked intent', async () => {
    await composition({ trend: 'UP' });
    harness.riskBlockedAssignments.add(main.assignmentId);
    try {
      const error = await rejected(submit(main.assignmentId, 'risk-blocked'));
      expect(error).toMatchObject({ statusCode: 409, message: 'Daily entry order limit reached.' });
    } finally { harness.riskBlockedAssignments.delete(main.assignmentId); }
    const intent = await one(`SELECT id, status FROM "OrderIntent" WHERE "clientOrderId"='risk-blocked'`);
    expect(intent.status).toBe('blocked');
    expect(await one(`SELECT status, "releaseReason" FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [intent.id])).toEqual({ status: 'RELEASED', releaseReason: 'ADMISSION_RISK_BLOCKED' });
    expect(await count(`"OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=$1`, [intent.id])).toBe(1);
  });

  it('keeps never-authorized assignments on existing behavior under the active rollout and never gates SELL intents', async () => {
    await composition({ trend: 'DOWN' });
    const never = await instrument('NEVR', mainStrategyId);
    expect(await submit(never.assignmentId, 'never-1')).toMatchObject({ ok: true, status: 'pending' });
    expect(await attemptsFor(never.assignmentId)).toEqual([]);
    const { placeOrder } = await services();
    await expect(placeOrder.submitOrder({ tradingAccountSubscriptionId: main.assignmentId, side: 'sell', signalType: 'entry', orderType: 'market', timeInForce: 'day', extendedHours: false }, { clientOrderId: 'sell-1' })).rejects.toMatchObject({ statusCode: 400 });
    // Protective and lifecycle SELL intents for an enforced assignment are never market-policy gated.
    await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",qty,"clientOrderId",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","createdAt","updatedAt") VALUES ('protective_exit','AAA','sell','market','day',1,'protective-sell-1','received','{}',$1,$2,now(),now())`, [paperId, main.assignmentId]);
    expect(await intentsFor('protective-sell-1')).toBe(1);
    await releaseClaims();
  });

  it('admits at most one entry when two enforced Strategies compete for the same account and Security', async () => {
    const altStrategyId = await strategy('phase3c2-alt');
    const altSubscriptionId = await subscription('sub-aaa-alt', altStrategyId, main.securityId, 'AAA');
    const altAssignmentId = await assign(paperId, altSubscriptionId);
    await grant(paperId, altAssignmentId, await enroll(paperId, altAssignmentId));
    await composition({ trend: 'UP' });
    const results = await Promise.allSettled([submit(main.assignmentId, 'race-main'), submit(altAssignmentId, 'race-alt')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ statusCode: 409, details: { code: 'ENTRY_ALREADY_PENDING' } });
    expect(await count(`"EntryExposureClaim" WHERE "tradingAccountId"=$1 AND "securityId"=$2 AND "releasedAt" IS NULL`, [paperId, main.securityId])).toBe(1);
    expect(await count(`"OrderIntent" WHERE "clientOrderId" IN ('race-main','race-alt')`)).toBe(1);
    expect(await count(`"MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId" IN ('race-main','race-alt') AND outcome='ALLOWED' AND NOT "orderIntentCreated" AND "admissionResultCode"='ENTRY_ALREADY_PENDING'`)).toBe(1);
    await releaseClaims();
  });

  it('serializes revocation and invalidation behind an in-flight admission until its obligation is frozen', async () => {
    const paused = await enforced('PAUS');
    await composition({ trend: 'UP' });
    const { admission, orderAudit, authz } = await services();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void; const insideAdmission = new Promise<void>(resolve => { reached = resolve; });
    const admitted = admission.admitEntryOrderIntent({
      tradingAccountId: paperId, tradingAccountSubscriptionId: paused.assignmentId, symbol: 'PAUS', clientOrderId: 'paused-1', ownerKey: `entry:${paperId}:paused-1`, requestSource: 'api',
      createIntent: async tx => {
        reached(); await gate;
        return orderAudit.createOrderIntent({ symbol: 'PAUS', side: 'buy', orderType: 'market', timeInForce: 'day', extendedHours: false, qty: 1, subscriptionId: paused.subscriptionId, signalType: 'entry' } as never, 'api', 'paused-1', paperId, { tradingAccountSubscriptionId: paused.assignmentId }, tx);
      },
    });
    await insideAdmission;
    let revokeSettled = false;
    const revoke = authz.revokeAssignmentMarketPolicyEnforcementAuthorization(paperId, paused.assignmentId, { authorizationId: paused.authorizationId, reason: 'Revoke during admission' }, ownerId).finally(() => { revokeSettled = true; });
    const blocker = await client();
    await blocker.query(`SET lock_timeout = '400ms'`);
    // Automatic invalidation paths cannot commit while the admission holds its locks.
    await expect(blocker.query(`UPDATE "StrategyMarketPolicyRevision" SET status='RETIRED', "retiredAt"=now() WHERE id=$1`, [paused.generation.policyRevisionId])).rejects.toThrow(/lock timeout/);
    await expect(blocker.query(`UPDATE "Security" SET symbol='PAUX' WHERE id=$1`, [paused.securityId])).rejects.toThrow(/lock timeout/);
    await sleep(300);
    expect(revokeSettled).toBe(false);
    release();
    const result = await admitted;
    expect(result.marketPolicy).toMatchObject({ enforced: true, disposition: 'ENFORCED' });
    const outcome = await revoke.catch(error => error);
    if (outcome?.details?.code === 'CONCURRENT_AUTHORIZATION_CHANGE') await authz.revokeAssignmentMarketPolicyEnforcementAuthorization(paperId, paused.assignmentId, { authorizationId: paused.authorizationId, reason: 'Revoke after admission' }, ownerId);
    expect(await one(`SELECT status FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [paused.authorizationId])).toEqual({ status: 'REVOKED' });
    expect(await one(`SELECT "authorizationId", "policyRevisionId" FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=$1`, [result.intent.id])).toEqual({ authorizationId: paused.authorizationId, policyRevisionId: paused.generation.policyRevisionId });
    // Explicit owner revocation is an explicit return to non-enforced behavior.
    await releaseClaims();
    await composition({ trend: 'DOWN' });
    expect(await submit(paused.assignmentId, 'after-revoke')).toMatchObject({ ok: true, status: 'pending' });
    expect(await count(`"MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId"='after-revoke'`)).toBe(0);
    expect((await authz.getAssignmentMarketPolicyEnforcementAuthorization(paperId, paused.assignmentId, 'SYSTEM_OWNER'))!.enforcement).toMatchObject({ disposition: 'OWNER_REVOKED', currentEntryBehavior: 'EXPLICITLY_NON_ENFORCED' });
    await releaseClaims();
  });

  it('fails closed after automatic invalidation until reauthorization or an explicit, audited owner opt-out', async () => {
    const lapsed = await enforced('LAPS');
    const { enrollment, authz } = await services();
    await enrollment.disableAssignmentMarketPolicyEnrollment(paperId, lapsed.assignmentId, lapsed.generation.id, ownerId, 'Disable enrollment');
    expect(await one(`SELECT status, "invalidationReasonCode", "invalidationSource", "invalidatedByUserId" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [lapsed.authorizationId]))
      .toEqual({ status: 'INVALIDATED', invalidationReasonCode: 'ENROLLMENT_DISABLED', invalidationSource: 'ENROLLMENT_GENERATION_TRIGGER', invalidatedByUserId: ownerId });
    expect(await one(`SELECT severity::text FROM "SystemEvent" WHERE type='MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_INVALIDATED' AND "entityId"=$1`, [String(lapsed.authorizationId)])).toEqual({ severity: 'WARNING' });
    await composition({ trend: 'UP' });
    const error = await rejected(submit(lapsed.assignmentId, 'lapsed-1'));
    expect(error).toMatchObject({ statusCode: 403, details: { code: 'MARKET_POLICY_ENFORCEMENT_LAPSED', outcome: 'AUTHORIZATION_LAPSED', reasonCode: 'AUTHORIZATION_INVALIDATED_ENROLLMENT_DISABLED' } });
    expect(await intentsFor('lapsed-1')).toBe(0);
    // The V1 grant invalidated by migration also fails closed under the active rollout.
    expect(await rejected(submit(legacyAssignmentId, 'legacy-lapsed'))).toMatchObject({ details: { code: 'MARKET_POLICY_ENFORCEMENT_LAPSED', reasonCode: 'AUTHORIZATION_INVALIDATED_AUTHORITY_BINDING_REAPPROVAL_REQUIRED' } });
    const input = { authorizationId: lapsed.authorizationId, reason: 'Owner intentionally restores non-enforced behavior', confirmNonEnforced: true as const };
    await expect(authz.resolveAssignmentMarketPolicyEnforcementLapse(paperId, lapsed.assignmentId, input, operatorId)).rejects.toMatchObject({ statusCode: 403 });
    const resolution = await authz.resolveAssignmentMarketPolicyEnforcementLapse(paperId, lapsed.assignmentId, input, ownerId);
    expect(resolution).toMatchObject({ resolution: 'RESTORE_NON_ENFORCED', consequence: 'EXPLICIT_RETURN_TO_NON_ENFORCED_BEHAVIOR', resolvedBy: { id: ownerId } });
    await expect(authz.resolveAssignmentMarketPolicyEnforcementLapse(paperId, lapsed.assignmentId, input, ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'LAPSE_ALREADY_RESOLVED' } });
    await expect(db.query(`UPDATE "AssignmentMarketPolicyEnforcementLapseResolution" SET reason='rewrite'`)).rejects.toThrow(/immutable/);
    expect(await count(`"SystemEvent" WHERE type='MARKET_POLICY_ENFORCEMENT_LAPSE_RESOLVED'`)).toBe(1);
    expect(await submit(lapsed.assignmentId, 'opted-out-1')).toMatchObject({ ok: true });
    expect(await count(`"MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId"='opted-out-1'`)).toBe(0);
    await releaseClaims();
    // Re-enrollment and reauthorization restore enforcement.
    const generation = await enroll(paperId, lapsed.assignmentId);
    await grant(paperId, lapsed.assignmentId, generation);
    await composition({ trend: 'DOWN' });
    expect(await rejected(submit(lapsed.assignmentId, 'reauthorized-blocked'))).toMatchObject({ details: { code: 'MARKET_POLICY_BLOCKED' } });
  });

  it('M1: a direct subscription redirect re-derived by the BEFORE trigger invalidates, and the new Security never inherits authority', async () => {
    const redirected = await enforced('MMM');
    const targetSecurityId = await security('MM2');
    const targetSubscriptionId = await subscription('sub-mm2', mainStrategyId, targetSecurityId, 'MM2');
    await db.query(`UPDATE "TradingAccountSubscription" SET "subscriptionId"=$1 WHERE id=$2`, [targetSubscriptionId, redirected.assignmentId]);
    const row = await one(`SELECT status, "invalidationReasonCode", "invalidationSource", "invalidationEvidenceJson" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [redirected.authorizationId]);
    expect(row).toMatchObject({ status: 'INVALIDATED', invalidationReasonCode: 'ASSIGNMENT_SUBSCRIPTION_CHANGED', invalidationSource: 'ASSIGNMENT_TRIGGER', invalidationEvidenceJson: { from: { routingSecurityId: redirected.securityId }, to: { routingSecurityId: targetSecurityId } } });
    await composition({ trend: 'UP' });
    expect(await rejected(submit(redirected.assignmentId, 'redirected-1'))).toMatchObject({ details: { code: 'MARKET_POLICY_ENFORCEMENT_LAPSED' } });
    const regrant = await grant(paperId, redirected.assignmentId, redirected.generation);
    expect(regrant).toMatchObject({ status: 'AUTHORIZED', authorityVersion: 'PAPER_MARKET_POLICY_ENFORCEMENT_V2', securityId: targetSecurityId, securitySymbol: 'MM2', subscriptionId: targetSubscriptionId, authorizationSequence: 2 });
  });

  it('M1: Subscription Security changes cascaded by the foreign key, and canonical Security symbol changes, invalidate', async () => {
    const cascaded = await enforced('KKK');
    const nextSecurityId = await security('KK2');
    await db.query(`UPDATE "Subscription" SET "securityId"=$1, symbol='KK2' WHERE id=$2`, [nextSecurityId, cascaded.subscriptionId]);
    expect(await one(`SELECT "routingSecurityId" FROM "TradingAccountSubscription" WHERE id=$1`, [cascaded.assignmentId])).toEqual({ routingSecurityId: nextSecurityId });
    const row = await one(`SELECT status, "invalidationReasonCode", "invalidationEvidenceJson" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [cascaded.authorizationId]);
    expect(row.status).toBe('INVALIDATED');
    expect(['ASSIGNMENT_SUBSCRIPTION_CHANGED', 'SUBSCRIPTION_IDENTITY_CHANGED']).toContain(row.invalidationReasonCode);
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorizationEvent" WHERE "authorizationId"=$1 AND action='INVALIDATE'`, [cascaded.authorizationId])).toBe(1);
    const renamed = await enforced('YYY');
    await db.query(`UPDATE "Security" SET symbol='YY2' WHERE id=$1`, [renamed.securityId]);
    expect(await one(`SELECT status, "invalidationReasonCode" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [renamed.authorizationId])).toEqual({ status: 'INVALIDATED', invalidationReasonCode: 'SECURITY_IDENTITY_CHANGED' });
    // The Subscription symbol no longer matches the canonical Security, so no new grant can bind it.
    await expect(grant(paperId, renamed.assignmentId, renamed.generation)).rejects.toMatchObject({ statusCode: 409, details: { code: 'SECURITY_IDENTITY_INCONSISTENT' } });
  });

  it('accepts only PostgreSQL-computed fingerprints and timestamps and keeps a grant valid after its granter is disabled', async () => {
    const fixture = await instrument('FPR', mainStrategyId);
    const generation = await enroll(paperId, fixture.assignmentId);
    const g = await one(`SELECT * FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id=$1`, [generation.id]);
    const { authz } = await services();
    const fingerprint = authz.enforcementAuthorizationFingerprint({ accountId: paperId, assignmentId: fixture.assignmentId, subscriptionId: fixture.subscriptionId, securityId: fixture.securityId, securitySymbol: 'FPR', strategyId: mainStrategyId, policyRevisionId: g.policyRevisionId, enrollmentId: g.enrollmentId, enrollmentGenerationId: g.id, generation: g.generation, configurationFingerprint: g.configurationFingerprint, accountHolderUserId: ownerId, authorizationSequence: 1 });
    const insert = (conn: Client, values: { fingerprint: string; actor: number }) => conn.query(`INSERT INTO "AssignmentMarketPolicyEnforcementAuthorization" ("enrollmentId","enrollmentGenerationId","authorizationSequence","authorityVersion",status,environment,"tradingAccountId","accountSubscriptionId","strategyId","policyRevisionId","accountHolderUserId","configurationFingerprint","authorizationFingerprint","authorizedByUserId","grantReason","subscriptionId","securityId","securitySymbol","authorizedAt","createdAt") VALUES ($1,$2,1,'PAPER_MARKET_POLICY_ENFORCEMENT_V2','AUTHORIZED','PAPER',$3,$4,$5,$6,$7,$8,$9,$10,'direct sql',$11,$12,'FPR','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z') RETURNING id`,
      [g.enrollmentId, g.id, paperId, fixture.assignmentId, mainStrategyId, g.policyRevisionId, ownerId, g.configurationFingerprint, values.fingerprint, values.actor, fixture.subscriptionId, fixture.securityId]);
    await expect(insert(db, { fingerprint: 'f'.repeat(64), actor: otherOwnerId })).rejects.toThrow(/canonical PostgreSQL-computed/);
    // Grant versus disable of the granting owner: the disable waits for the in-flight grant.
    const granting = await client();
    await granting.query('BEGIN');
    const inserted = (await insert(granting, { fingerprint, actor: otherOwnerId })).rows[0].id as number;
    const disabler = await client();
    await disabler.query(`SET lock_timeout = '400ms'`);
    await expect(disabler.query(`UPDATE "User" SET enabled=false WHERE id=$1`, [otherOwnerId])).rejects.toThrow(/lock timeout/);
    await granting.query('COMMIT');
    await disabler.query(`UPDATE "User" SET enabled=false WHERE id=$1`, [otherOwnerId]);
    const row = await one(`SELECT status, "authorizedAt" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [inserted]);
    expect(row.status).toBe('AUTHORIZED');
    expect(Date.now() - row.authorizedAt.getTime()).toBeLessThan(60_000);
    expect(await authz.resolveAssignmentMarketPolicyEnforcementAuthority(fixture.assignmentId)).toMatchObject({ authorized: true });
    await expect(authz.grantAssignmentMarketPolicyEnforcementAuthorization(paperId, fixture.assignmentId, { generationId: g.id, expectedConfigurationFingerprint: g.configurationFingerprint, expectedPolicyRevisionId: g.policyRevisionId, reason: 'disabled' }, otherOwnerId)).rejects.toMatchObject({ statusCode: 403 });
    await db.query(`UPDATE "User" SET enabled=true WHERE id=$1`, [otherOwnerId]);
    // Application-supplied revocation timestamps are overwritten by PostgreSQL.
    await db.query(`UPDATE "AssignmentMarketPolicyEnforcementAuthorization" SET status='REVOKED', "revokedByUserId"=$2, "revokedAt"='2000-01-01T00:00:00Z', "revocationReason"='direct revoke' WHERE id=$1`, [inserted, ownerId]);
    expect(Date.now() - (await one(`SELECT "revokedAt" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [inserted])).revokedAt.getTime()).toBeLessThan(60_000);
  });

  it('never leaves an effective grant bound to a superseded revision or a changed holder under concurrent changes', async () => {
    const { policy, enrollment, authz } = await services();
    const revStrategyId = await strategy('phase3c2-revision-race');
    const revFixture = await instrument('REVR', revStrategyId);
    const revGeneration = await enroll(paperId, revFixture.assignmentId);
    const next = await policy.prepareStrategyMarketPolicyRevision(revStrategyId, ownerId, 'Concurrent supersede');
    await Promise.allSettled([grant(paperId, revFixture.assignmentId, revGeneration), policy.activateStrategyMarketPolicyRevision(revStrategyId, next.id, next.configurationFingerprint, ownerId)]);
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorization" a JOIN "StrategyMarketPolicyRevision" r ON r.id=a."policyRevisionId" WHERE a.status='AUTHORIZED' AND r.status<>'ACTIVE'`)).toBe(0);

    const holderFixture = await instrument('OWNR', mainStrategyId, secondPaperId);
    const holderPrepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(secondPaperId, holderFixture.assignmentId, ownerId);
    const holderGeneration = await enrollment.activateAssignmentMarketPolicyEnrollment(secondPaperId, holderFixture.assignmentId, holderPrepared.id, ownerId, holderPrepared.configurationFingerprint);
    const transfer = await client();
    await Promise.allSettled([grant(secondPaperId, holderFixture.assignmentId, holderGeneration), transfer.query(`UPDATE "TradingAccount" SET "accountHolderUserId"=$1 WHERE id=$2`, [transferHolderId, secondPaperId])]);
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorization" a JOIN "TradingAccount" t ON t.id=a."tradingAccountId" WHERE a.status='AUTHORIZED' AND a."accountHolderUserId"<>t."accountHolderUserId"`)).toBe(0);

    const raced = await enforced('RVIN');
    await Promise.allSettled([
      authz.revokeAssignmentMarketPolicyEnforcementAuthorization(paperId, raced.assignmentId, { authorizationId: raced.authorizationId, reason: 'Concurrent revoke' }, ownerId),
      enrollment.disableAssignmentMarketPolicyEnrollment(paperId, raced.assignmentId, raced.generation.id, ownerId, 'Concurrent disable'),
    ]);
    const terminal = await one(`SELECT status FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [raced.authorizationId]);
    expect(['REVOKED', 'INVALIDATED']).toContain(terminal.status);
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorizationEvent" WHERE "authorizationId"=$1`, [raced.authorizationId])).toBe(2);
  });

  it('keeps a frozen obligation bound to its original revision after supersession, while new entries fail closed', async () => {
    const supStrategyId = await strategy('phase3c2-supersede');
    const sup = await enforced('SUPR', supStrategyId);
    await composition({ trend: 'UP' });
    const admitted = await submit(sup.assignmentId, 'before-supersede') as { intentId: number };
    const { policy } = await services();
    const next = await policy.prepareStrategyMarketPolicyRevision(supStrategyId, ownerId, 'Supersede');
    await policy.activateStrategyMarketPolicyRevision(supStrategyId, next.id, next.configurationFingerprint, ownerId);
    expect(await one(`SELECT status, "invalidationReasonCode" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [sup.authorizationId])).toEqual({ status: 'INVALIDATED', invalidationReasonCode: 'POLICY_REVISION_SUPERSEDED' });
    expect(await one(`SELECT "policyRevisionId", "authorizationId" FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=$1`, [admitted.intentId])).toEqual({ policyRevisionId: sup.generation.policyRevisionId, authorizationId: sup.authorizationId });
    await releaseClaims();
    expect(await rejected(submit(sup.assignmentId, 'after-supersede'))).toMatchObject({ details: { code: 'MARKET_POLICY_ENFORCEMENT_LAPSED', reasonCode: 'AUTHORIZATION_INVALIDATED_POLICY_REVISION_SUPERSEDED' } });
    await releaseClaims();
  });

  it('never gives a LIVE assignment market-policy authority or enforcement', async () => {
    const live = await instrument('LIVX', mainStrategyId, liveId);
    const { enrollment } = await services();
    await expect(enrollment.prepareAssignmentMarketPolicyEnrollment(liveId, live.assignmentId, ownerId)).rejects.toMatchObject({ statusCode: 409 });
    await composition({ trend: 'DOWN' });
    expect(await submit(live.assignmentId, 'live-1')).toMatchObject({ ok: true });
    expect(await attemptsFor(live.assignmentId)).toEqual([]);
    await expect(db.query(`INSERT INTO "MarketPolicyEnforcementAdmissionAttempt" ("attemptKey","admissionVersion","requestSource","ownerKey","clientOrderId",environment,"tradingAccountId","accountSubscriptionId","enforcementDisposition","evaluatedAt",outcome,"reasonCode","rolloutVersion","orderIntentCreated","admissionResultCode","technicalDiagnostic","evidenceJson") VALUES ('live-forged','MARKET_POLICY_PRE_INTENT_ENFORCEMENT_V1','api','k','c','PAPER',$1,$2,'UNKNOWN',now(),'TECHNICAL_FAILURE','X',1,false,'X','x','{}')`, [liveId, live.assignmentId])).rejects.toThrow(/PAPER-only/);
    await releaseClaims();
  });

  it('keeps compare-only evidence separate, immutable and non-authoritative', async () => {
    await db.query(`UPDATE "OrderIntentMarketPolicyCaptureRollout" SET enabled=true, "effectiveEpoch"=now() WHERE id=1`);
    const compare = await enforced('CMPR');
    await composition({ trend: 'UP' });
    const admitted = await submit(compare.assignmentId, 'compare-1') as { intentId: number };
    const coverage = await one(`SELECT id, provenance::text, "comparisonMode", "tradingEffect" FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [admitted.intentId]);
    expect(coverage).toMatchObject({ provenance: 'ACTIVE_EXACT', comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE' });
    await expect(db.query(`UPDATE "OrderIntentMarketPolicyCoverage" SET "tradingEffect"='ENFORCED' WHERE id=$1`, [coverage.id])).rejects.toThrow();
    expect(await count(`"OrderIntentMarketPolicyCoverage" WHERE "comparisonMode"<>'COMPARE_ONLY' OR "tradingEffect"<>'NONE'`)).toBe(0);
    // Authoritative admission never reuses or creates a persisted shadow decision.
    expect(await count(`"StrategyMarketEligibilityDecision"`)).toBe(0);
    await db.query(`UPDATE "OrderIntentMarketPolicyCaptureRollout" SET enabled=false WHERE id=1`);
    await releaseClaims();
  });

  it('deactivates without altering frozen obligations and restores existing entry behavior', async () => {
    const before = (await db.query(`SELECT * FROM "OrderIntentMarketPolicyEnforcementObligation" ORDER BY id`)).rows;
    expect(before.length).toBeGreaterThan(0);
    const { rollout, authz } = await services();
    const status = await rollout.setMarketPolicyEnforcementRuntimeRollout(false, { expectedVersion: 1, reason: 'Pause PAPER enforcement' }, ownerId);
    expect(status).toMatchObject({ active: false, status: 'DEACTIVATED', version: 2 });
    expect((await db.query(`SELECT * FROM "OrderIntentMarketPolicyEnforcementObligation" ORDER BY id`)).rows).toEqual(before);
    await composition({ trend: 'DOWN' });
    expect(await submit(main.assignmentId, 'after-deactivate')).toMatchObject({ ok: true });
    expect(await count(`"MarketPolicyEnforcementAdmissionAttempt" WHERE "clientOrderId"='after-deactivate'`)).toBe(0);
    expect((await authz.getAssignmentMarketPolicyEnforcementAuthorization(paperId, main.assignmentId, 'SYSTEM_OWNER'))!).toMatchObject({ runtimeEnforcement: { active: false, status: 'DEACTIVATED' }, enforcement: { disposition: 'ENFORCED', currentEntryBehavior: 'EXISTING_ENTRY_BEHAVIOR' } });
    expect(harness.brokerCalls).toEqual([]);
    expect(await count(`"BrokerOrder"`)).toBe(0);
  });
});
