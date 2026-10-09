import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Strategy market eligibility PostgreSQL integrity', () => {
  const database = `strategy_market_eligibility_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, databaseUrl: string;
  let strategyId: number, activeRevisionId: number;
  const dimensions = [
    ['TREND', 'TREND_V1', 'DOWN'], ['VOLATILITY', 'VOLATILITY_V1', 'NORMAL'],
    ['BREADTH', 'BREADTH_V1', 'MIXED'], ['PARTICIPATION', 'PARTICIPATION_V1', 'NORMAL'],
    ['INTRADAY_STRESS', 'INTRADAY_STRESS_V1', 'NORMAL'],
  ] as const;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    strategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('eligibility-test','Eligibility Test',false,now(),now()) RETURNING id`)).rows[0].id;
    process.env.DATABASE_URL = databaseUrl;
    const policyService = await import('../../services/strategy-market-policy.service.js');
    const policy = await policyService.createStrategyMarketPolicy(strategyId, 0, 'Eligibility integration');
    const prepared = policy.revisions[0]!;
    const saved = await policyService.saveStrategyMarketPolicyRevision(strategyId, prepared.id, {
      expectedConfigurationFingerprint: prepared.configurationFingerprint,
      rules: prepared.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' : 'IGNORED', allowedStates: rule.dimension === 'TREND' ? ['DOWN'] : [] })),
    }, 0);
    const active = await policyService.activateStrategyMarketPolicyRevision(strategyId, saved.id, saved.configurationFingerprint, 0);
    activeRevisionId = active.id;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  async function composition(at: string, trendState: string | null, trendHealth = 'AVAILABLE', degradedIgnored = false, trendValidUntil = '2026-10-10T20:00:00Z') {
    const sourceIds = new Map<string, number>();
    for (const [dimension, version, defaultState] of dimensions) {
      const state = dimension === 'TREND' ? trendState : defaultState;
      const unhealthy = dimension === 'TREND' ? trendHealth !== 'AVAILABLE' : degradedIgnored && dimension === 'VOLATILITY';
      if (!unhealthy) {
        const id = (await db.query(`INSERT INTO "MarketRegimeDimensionAssessment" (dimension,"algorithmVersion","evidenceSchemaVersion","targetAt","sessionDate",attempt,status,"rawState","effectiveState","dataThroughAt","validUntil","startedAt","completedAt","evidenceJson") VALUES ($1,$2,1,$3,DATE '2026-10-09',1,'VALID',$4,$4,$3,$5,$3,$3,'{}') RETURNING id`, [dimension, version, at, state, dimension === 'TREND' ? trendValidUntil : '2026-10-10T20:00:00Z'])).rows[0].id;
        sourceIds.set(dimension, id);
      }
    }
    const degraded = degradedIgnored || trendHealth !== 'AVAILABLE';
    const fingerprint = randomUUID().replaceAll('-', '').repeat(2);
    await db.query('BEGIN');
    const row = (await db.query(`INSERT INTO "MarketRegimeAssessment" ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","dataThroughAt","validUntil","publicationStatus","evidenceHealth","evidenceReasonCode","sourceSetFingerprint","startedAt","completedAt","evidenceJson") VALUES ('MARKET_REGIME_COMPOSITION_V1',1,$1,$1,$2,$3,'SUCCEEDED',$4,$5,$6,$1,$1,'{}') RETURNING id`, [at, degraded ? null : at, degraded ? null : trendValidUntil, degraded ? 'DEGRADED' : 'COMPLETE', degraded ? 'SOURCE_VECTOR_DEGRADED' : null, fingerprint])).rows[0];
    for (const [ordinal, [dimension, version, defaultState]] of dimensions.entries()) {
      const unhealthy = dimension === 'TREND' ? trendHealth !== 'AVAILABLE' : degradedIgnored && dimension === 'VOLATILITY';
      const state = dimension === 'TREND' ? trendState : defaultState;
      await db.query(`INSERT INTO "MarketRegimeAssessmentSource" ("marketRegimeAssessmentId",dimension,"requiredAlgorithmVersion","expectedTargetAt","sourceAssessmentId","sourceEvidenceSchemaVersion","sourceAttempt","sourceStatus","sourceTargetAt","sourceCompletedAt","sourceDataThroughAt","sourceValidUntil","sourceRawState","sourceEffectiveState",health,"reasonCode",ordinal,"evidenceJson") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16,'{}')`, [row.id, dimension, version, at, sourceIds.get(dimension) ?? null, unhealthy ? null : 1, unhealthy ? null : 1, unhealthy ? null : 'VALID', unhealthy ? null : at, unhealthy ? null : at, unhealthy ? null : at, unhealthy ? null : (dimension === 'TREND' ? trendValidUntil : '2026-10-10T20:00:00Z'), unhealthy ? null : state, unhealthy ? 'MISSING' : 'AVAILABLE', unhealthy ? 'TEST_UNHEALTHY' : null, ordinal + 1]);
    }
    await db.query('COMMIT');
    return row.id as number;
  }

  async function signalRoute(event: 'ENTRY_LONG' | 'EXIT_LONG') {
    const { prisma } = await import('../prisma.js');
    const user = await prisma.user.upsert({ where: { email: 'eligibility-route@example.test' }, update: {}, create: { email: 'eligibility-route@example.test', platformRole: 'SYSTEM_OWNER', enabled: true } });
    const security = await prisma.security.upsert({ where: { symbol: 'ZZZE' }, update: {}, create: { symbol: 'ZZZE', name: 'Eligibility Route Fixture', enabled: true, assetType: 'STOCK' } });
    const exitProfile = await prisma.exitProfile.upsert({ where: { key: 'eligibility-route' }, update: {}, create: { key: 'eligibility-route', name: 'Eligibility Route', exitMode: 'manual', takeProfitBehavior: 'manual' } });
    const account = await prisma.tradingAccount.findFirst({ where: { displayName: 'Eligibility Route Account' } }) ?? await prisma.tradingAccount.create({ data: { accountHolderUserId: user.id, displayName: 'Eligibility Route Account' } });
    const subscription = await prisma.subscription.upsert({ where: { key: 'eligibility-route' }, update: {}, create: { key: 'eligibility-route', name: 'Eligibility Route', symbol: security.symbol, strategyId, securityId: security.id, exitProfileId: exitProfile.id, enabled: true, exitManagementMode: 'BACKEND_MANAGED' } });
    const assignment = await prisma.tradingAccountSubscription.upsert({ where: { tradingAccountId_subscriptionId: { tradingAccountId: account.id, subscriptionId: subscription.id } }, update: { enabled: true, entriesEnabled: true, exitsEnabled: true }, create: { tradingAccountId: account.id, subscriptionId: subscription.id, enabled: true, entriesEnabled: true, exitsEnabled: true, sizingType: 'FIXED_QTY', fixedQty: 1 } });
    const source = await prisma.externalSignalSource.upsert({ where: { webhookKeyHash: 'e'.repeat(64) }, update: {}, create: { name: 'Eligibility Route Source', provider: 'GENERIC_WEBHOOK', webhookKeyHash: 'e'.repeat(64) } });
    const binding = await prisma.strategySignalBinding.upsert({ where: { signalSourceId_externalStrategyKey: { signalSourceId: source.id, externalStrategyKey: 'eligibility-route' } }, update: {}, create: { signalSourceId: source.id, strategyId, externalStrategyKey: 'eligibility-route', enabled: true } });
    const revision = await prisma.strategySignalRevision.findFirst({ where: { strategySignalBindingId: binding.id, status: 'ACTIVE' } }) ?? await prisma.strategySignalRevision.create({ data: { strategySignalBindingId: binding.id, revision: 1, status: 'ACTIVE', authorityMode: 'EVALUATION_ONLY', activatedAt: new Date('2026-10-09T18:00:00Z') } });
    const signal = await prisma.signal.create({ data: { signalSourceId: source.id, strategySignalBindingId: binding.id, strategyId, securityId: security.id, schemaVersion: 1, eventFingerprint: randomUUID().replaceAll('-', '').repeat(2), strategyRevision: revision.revision, strategySignalRevisionId: revision.id, event, symbol: security.symbol, timeframe: '15m', signalTime: new Date('2026-10-09T18:51:00Z'), canonicalPayloadHash: randomUUID().replaceAll('-', '').repeat(2) } });
    const run = await prisma.signalRoutingRun.create({ data: { signalId: signal.id, authorityMode: 'EVALUATION_ONLY', status: 'COMPLETED', startedAt: new Date('2026-10-09T18:51:00Z'), completedAt: new Date('2026-10-09T18:51:00Z'), routeCount: 1, routes: { create: { tradingAccountId: account.id, tradingAccountSubscriptionId: assignment.id, subscriptionId: subscription.id, targetSnapshot: { strategyId, securityId: security.id }, evaluationVersion: 1 } } }, include: { routes: true } });
    return run.routes[0]!;
  }

  it('replays the complete migration chain without Prisma schema drift', () => {
    const output = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000 });
    expect(output).toContain('No difference detected');
  }, 70_000);

  it('persists five exact gates, permits a DEGRADED vector with an ignored unhealthy source, and reuses concurrent duplicates', async () => {
    const compositionId = await composition('2026-10-09T18:00:00Z', 'DOWN', 'AVAILABLE', true);
    const service = await import('../../services/strategy-market-eligibility.service.js');
    const results = await Promise.all(Array.from({ length: 4 }, () => service.evaluateStrategyEligibility(strategyId, { evaluatedAt: new Date('2026-10-09T18:01:00Z') })));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(results[0]).toMatchObject({ outcome: 'ALLOWED', reasonCode: 'ALL_REQUIRED_DIMENSIONS_ALLOWED', strategyEnabled: false, policyRevisionId: activeRevisionId, marketRegimeAssessmentId: compositionId });
    expect(results[0]!.gates).toHaveLength(5);
    expect(results[0]!.gates.find(gate => gate.dimension === 'VOLATILITY')).toMatchObject({ requirement: 'IGNORED', outcome: 'IGNORED', sourceHealth: 'MISSING', sourceAssessmentId: null });
    expect((await db.query(`SELECT count(*)::int count FROM "StrategyMarketEligibilityDecision" WHERE "decisionFingerprint"=$1`, [results[0]!.decisionFingerprint])).rows[0].count).toBe(1);
    await expect(db.query(`UPDATE "StrategyMarketEligibilityDecision" SET "reasonCode"='REWRITE' WHERE id=$1`, [results[0]!.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM "StrategyMarketEligibilityDecisionGate" WHERE "decisionId"=$1`, [results[0]!.id])).rejects.toThrow(/immutable/);
  });

  it('records BLOCKED and INSUFFICIENT_EVIDENCE without rewriting history', async () => {
    const service = await import('../../services/strategy-market-eligibility.service.js');
    await composition('2026-10-09T18:10:00Z', 'UP');
    const blocked = await service.evaluateStrategyEligibility(strategyId, { evaluatedAt: new Date('2026-10-09T18:11:00Z') });
    expect(blocked).toMatchObject({ outcome: 'BLOCKED', reasonCode: 'REQUIRED_STATE_BLOCKED' });
    await composition('2026-10-09T18:20:00Z', null, 'MISSING');
    const insufficient = await service.evaluateStrategyEligibility(strategyId, { evaluatedAt: new Date('2026-10-09T18:21:00Z') });
    expect(insufficient).toMatchObject({ outcome: 'INSUFFICIENT_EVIDENCE', reasonCode: 'REQUIRED_EVIDENCE_INSUFFICIENT' });
    expect((await db.query(`SELECT outcome FROM "StrategyMarketEligibilityDecision" WHERE id=$1`, [blocked.id])).rows[0].outcome).toBe('BLOCKED');
  });

  it('recomputes expiration and creates a new decision after policy activation while preserving old rows', async () => {
    const service = await import('../../services/strategy-market-eligibility.service.js');
    const policyService = await import('../../services/strategy-market-policy.service.js');
    await composition('2026-10-09T18:30:00Z', 'DOWN', 'AVAILABLE', false, '2026-10-09T18:35:00Z');
    const expired = await service.evaluateStrategyEligibility(strategyId, { evaluatedAt: new Date('2026-10-09T18:36:00Z') });
    expect(expired.outcome).toBe('INSUFFICIENT_EVIDENCE');
    expect(expired.gates.find(gate => gate.dimension === 'TREND')).toMatchObject({ sourceHealth: 'EXPIRED', reasonCode: 'SOURCE_EXPIRED_AT_EVALUATION' });
    const prepared = await policyService.prepareStrategyMarketPolicyRevision(strategyId, 0, 'Allow UP');
    const saved = await policyService.saveStrategyMarketPolicyRevision(strategyId, prepared.id, { expectedConfigurationFingerprint: prepared.configurationFingerprint, rules: prepared.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' : 'IGNORED', allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })) }, 0);
    const next = await policyService.activateStrategyMarketPolicyRevision(strategyId, saved.id, saved.configurationFingerprint, 0);
    await composition('2026-10-09T18:40:00Z', 'UP');
    const allowed = await service.evaluateStrategyEligibility(strategyId, { evaluatedAt: new Date('2026-10-09T18:41:00Z') });
    expect(allowed).toMatchObject({ outcome: 'ALLOWED', policyRevisionId: next.id });
    expect((await db.query(`SELECT "policyRevisionId",outcome FROM "StrategyMarketEligibilityDecision" WHERE id=$1`, [expired.id])).rows[0]).toMatchObject({ policyRevisionId: activeRevisionId, outcome: 'INSUFFICIENT_EVIDENCE' });
  });

  it('enforces exact foreign keys, fingerprint uniqueness, and transaction rollback', async () => {
    const existing = (await db.query(`SELECT * FROM "StrategyMarketEligibilityDecision" ORDER BY id LIMIT 1`)).rows[0];
    await expect(db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","policyRevisionId","marketRegimeAssessmentId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","decisionFingerprint","strategyEnabled","evidenceJson") VALUES ($1,999999,$2,'TEST','FK','V1','ALLOWED','TEST',now(),$3,false,'{}')`, [strategyId, existing.marketRegimeAssessmentId, randomUUID()])).rejects.toThrow(/foreign key/);
    await expect(db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","policyRevisionId","marketRegimeAssessmentId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","decisionFingerprint","strategyEnabled","evidenceJson") VALUES ($1,$2,$3,'TEST','DUP','V1','ALLOWED','TEST',now(),$4,false,'{}')`, [strategyId, existing.policyRevisionId, existing.marketRegimeAssessmentId, existing.decisionFingerprint])).rejects.toThrow(/duplicate key/);
    const before = Number((await db.query(`SELECT count(*) count FROM "StrategyMarketEligibilityDecision"`)).rows[0].count);
    await db.query('BEGIN');
    try {
      const inserted = (await db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","policyRevisionId","marketRegimeAssessmentId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","decisionFingerprint","strategyEnabled","evidenceJson") VALUES ($1,$2,$3,'TEST','ROLLBACK','V1','ALLOWED','TEST',now(),$4,false,'{}') RETURNING id`, [strategyId, existing.policyRevisionId, existing.marketRegimeAssessmentId, randomUUID()])).rows[0];
      await db.query(`INSERT INTO "StrategyMarketEligibilityDecisionGate" ("decisionId",dimension,"algorithmVersion",requirement,outcome,"allowedStatesJson","reasonCode","evidenceJson",ordinal) VALUES ($1,'TREND','TREND_V1','IGNORED','PASS','[]','INVALID','{}',1)`, [inserted.id]);
      throw new Error('Expected gate constraint failure');
    } catch { await db.query('ROLLBACK'); }
    expect(Number((await db.query(`SELECT count(*) count FROM "StrategyMarketEligibilityDecision"`)).rows[0].count)).toBe(before);
  });

  it('rejects missing, duplicate, misordered, mismatched and incomplete gate sets', async () => {
    const template = (await db.query(`SELECT * FROM "StrategyMarketEligibilityDecision" WHERE "policyRevisionId" IS NOT NULL AND "marketRegimeAssessmentId" IS NOT NULL ORDER BY id LIMIT 1`)).rows[0];
    const attempt = async (gateSql?: string) => {
      await db.query('BEGIN');
      let rejected = false;
      try {
        const decisionId = (await db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","policyRevisionId","marketRegimeAssessmentId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","validUntil","decisionFingerprint","strategyEnabled","evidenceJson") SELECT "strategyId","policyRevisionId","marketRegimeAssessmentId",'TEST',$2,"evaluationVersion",outcome,"reasonCode","evaluatedAt","validUntil",$3,"strategyEnabled","evidenceJson" FROM "StrategyMarketEligibilityDecision" WHERE id=$1 RETURNING id`, [template.id, randomUUID(), randomUUID().replaceAll('-', '').repeat(2)])).rows[0].id;
        if (gateSql) await db.query(gateSql, [decisionId, template.id]);
        await db.query('COMMIT');
      } catch {
        rejected = true;
      } finally {
        await db.query('ROLLBACK').catch(() => undefined);
      }
      expect(rejected).toBe(true);
    };
    await attempt();
    await attempt(`INSERT INTO "StrategyMarketEligibilityDecisionGate" ("decisionId",dimension,"algorithmVersion",requirement,outcome,"observedState","sourceHealth","sourceAssessmentId","allowedStatesJson","reasonCode","evidenceJson",ordinal) SELECT $1,dimension,"algorithmVersion",requirement,outcome,"observedState","sourceHealth","sourceAssessmentId","allowedStatesJson","reasonCode","evidenceJson",ordinal FROM "StrategyMarketEligibilityDecisionGate" WHERE "decisionId"=$2 AND ordinal < 5`);
    await attempt(`INSERT INTO "StrategyMarketEligibilityDecisionGate" ("decisionId",dimension,"algorithmVersion",requirement,outcome,"observedState","sourceHealth","sourceAssessmentId","allowedStatesJson","reasonCode","evidenceJson",ordinal) SELECT $1,dimension,"algorithmVersion",requirement,outcome,"observedState","sourceHealth","sourceAssessmentId","allowedStatesJson","reasonCode","evidenceJson",CASE WHEN ordinal=1 THEN 2 WHEN ordinal=2 THEN 1 ELSE ordinal END FROM "StrategyMarketEligibilityDecisionGate" WHERE "decisionId"=$2`);
    await attempt(`INSERT INTO "StrategyMarketEligibilityDecisionGate" ("decisionId",dimension,"algorithmVersion",requirement,outcome,"observedState","sourceHealth","sourceAssessmentId","allowedStatesJson","reasonCode","evidenceJson",ordinal) SELECT $1,dimension,"algorithmVersion",CASE WHEN ordinal=1 THEN 'IGNORED'::"StrategyMarketPolicyDimensionRequirement" ELSE requirement END,CASE WHEN ordinal=1 THEN 'IGNORED'::"StrategyMarketEligibilityGateOutcome" ELSE outcome END,"observedState","sourceHealth","sourceAssessmentId",CASE WHEN ordinal=1 THEN '[]'::jsonb ELSE "allowedStatesJson" END,"reasonCode","evidenceJson",ordinal FROM "StrategyMarketEligibilityDecisionGate" WHERE "decisionId"=$2`);
    await db.query('BEGIN');
    try {
      const decisionId = (await db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","policyRevisionId","marketRegimeAssessmentId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","validUntil","decisionFingerprint","strategyEnabled","evidenceJson") SELECT "strategyId","policyRevisionId","marketRegimeAssessmentId",'TEST',$2,"evaluationVersion",outcome,"reasonCode","evaluatedAt","validUntil",$3,"strategyEnabled","evidenceJson" FROM "StrategyMarketEligibilityDecision" WHERE id=$1 RETURNING id`, [template.id, randomUUID(), randomUUID().replaceAll('-', '').repeat(2)])).rows[0].id;
      await db.query(`INSERT INTO "StrategyMarketEligibilityDecisionGate" ("decisionId",dimension,"algorithmVersion",requirement,outcome,"observedState","sourceHealth","sourceAssessmentId","allowedStatesJson","reasonCode","evidenceJson",ordinal) SELECT $1,dimension,"algorithmVersion",requirement,outcome,"observedState","sourceHealth","sourceAssessmentId","allowedStatesJson","reasonCode","evidenceJson",ordinal FROM "StrategyMarketEligibilityDecisionGate" WHERE "decisionId"=$2`, [decisionId, template.id]);
      await expect(db.query(`INSERT INTO "StrategyMarketEligibilityDecisionGate" ("decisionId",dimension,"algorithmVersion",requirement,outcome,"allowedStatesJson","reasonCode","evidenceJson",ordinal) VALUES ($1,'TREND','TREND_V1','REQUIRED','PASS','[]','DUPLICATE','{}',1)`, [decisionId])).rejects.toThrow(/duplicate key/);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('rejects cross-strategy policy identities and scopes decision detail to its URL strategy', async () => {
    const template = (await db.query(`SELECT * FROM "StrategyMarketEligibilityDecision" WHERE "policyRevisionId" IS NOT NULL ORDER BY id LIMIT 1`)).rows[0];
    const otherStrategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ($1,'Other Eligibility',true,now(),now()) RETURNING id`, [`eligibility-other-${randomUUID()}`])).rows[0].id;
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","policyRevisionId","marketRegimeAssessmentId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","validUntil","decisionFingerprint","strategyEnabled","evidenceJson") SELECT $2,"policyRevisionId","marketRegimeAssessmentId",'TEST',$3,"evaluationVersion",outcome,"reasonCode","evaluatedAt","validUntil",$4,true,"evidenceJson" FROM "StrategyMarketEligibilityDecision" WHERE id=$1`, [template.id, otherStrategyId, randomUUID(), randomUUID().replaceAll('-', '').repeat(2)]);
      await expect(db.query('COMMIT')).rejects.toThrow(/another strategy policy|exactly five/);
    } finally { await db.query('ROLLBACK').catch(() => undefined); }
    const service = await import('../../services/strategy-market-eligibility.service.js');
    await expect(service.getStrategyEligibilityDecision(template.id, otherStrategyId)).rejects.toThrow(/not found/i);
    await expect(service.getStrategyEligibilityDecision(template.id, strategyId)).resolves.toMatchObject({ id: template.id, strategyId });
  });

  it('runs the real shadow worker without trading, signal, order, risk, sizing, broker, or position writes', async () => {
    const tables = ['Signal', 'EntryDecision', 'OrderIntent', 'BrokerOrder', 'BrokerActivity', 'TrackedPosition'] as const;
    const counts = async () => {
      const result: Record<string, number> = {};
      for (const table of tables) result[table] = Number((await db.query(`SELECT count(*) count FROM "${table}"`)).rows[0].count);
      return result;
    };
    const before = await counts();
    const { runStrategyMarketEligibilityWorker } = await import('../../workers/strategy-market-eligibility.worker.js');
    await expect(runStrategyMarketEligibilityWorker()).resolves.toMatchObject({ outcome: 'success' });
    expect(await counts()).toEqual(before);
  });

  it('keeps ENTRY applicability independent from route-specific BLOCKED shadow evidence and makes EXIT not applicable', async () => {
    const { prisma } = await import('../prisma.js');
    await composition('2026-10-09T18:50:00Z', 'DOWN');
    const entryRoute = await signalRoute('ENTRY_LONG');
    const { evaluateSignalRoute } = await import('../../services/signal-evaluation.service.js');
    const existing = await evaluateSignalRoute(entryRoute.id, prisma);
    expect(existing).toMatchObject({ status: 'COMPLETED', outcome: 'ELIGIBLE', evaluationVersion: 1 });
    const shadowService = await import('../../services/signal-route-market-eligibility.service.js');
    const shadow = await shadowService.processSignalRouteMarketEligibility(entryRoute.id, prisma, () => new Date('2026-10-09T18:51:00Z'));
    expect(shadow).toMatchObject({ status: 'COMPLETED', attempt: 1, reasonCode: 'SHADOW_EVALUATION_COMPLETED', eligibilityDecision: { outcome: 'BLOCKED', contextType: 'SIGNAL_ROUTE', contextIdentity: `SIGNAL_ROUTE:${entryRoute.id}` } });
    expect((await shadowService.processSignalRouteMarketEligibility(entryRoute.id, prisma, () => new Date('2026-10-09T18:52:00Z')))?.id).toBe(shadow?.id);
    expect(await prisma.signalEvaluation.findUnique({ where: { signalRouteId: entryRoute.id } })).toMatchObject({ outcome: 'ELIGIBLE', evaluationVersion: 1 });
    const exitRoute = await signalRoute('EXIT_LONG');
    const exit = await evaluateSignalRoute(exitRoute.id, prisma);
    expect(exit).toMatchObject({ outcome: 'NO_ACTION', reasonCode: 'NO_MATCHING_OPEN_POSITION' });
    await expect(shadowService.processSignalRouteMarketEligibility(exitRoute.id, prisma, () => new Date('2026-10-09T18:51:00Z'))).resolves.toMatchObject({ status: 'NOT_APPLICABLE', reasonCode: 'ENTRY_POLICY_NOT_APPLICABLE_TO_EXIT', eligibilityDecisionId: null });
  });

  it('records a nonblocking technical failure and recovers idempotently without replacing SignalEvaluation', async () => {
    const { prisma } = await import('../prisma.js');
    const route = await signalRoute('ENTRY_LONG');
    const { evaluateSignalRoute } = await import('../../services/signal-evaluation.service.js');
    expect(await evaluateSignalRoute(route.id, prisma)).toMatchObject({ outcome: 'ELIGIBLE' });
    const shadowService = await import('../../services/signal-route-market-eligibility.service.js');
    const failed = await shadowService.processSignalRouteMarketEligibility(route.id, prisma, () => new Date('2026-10-09T18:51:00Z'), async () => { throw new Error('deliberate shadow failure'); });
    expect(failed).toMatchObject({ status: 'FAILED', attempt: 1, eligibilityDecisionId: null, reasonCode: 'SHADOW_PROCESSING_FAILED' });
    const recovered = await shadowService.processSignalRouteMarketEligibility(route.id, prisma, () => new Date('2026-10-09T18:52:00Z'));
    expect(recovered).toMatchObject({ status: 'COMPLETED', attempt: 2 });
    expect((await prisma.signalRouteMarketEligibilityAttempt.findMany({ where: { signalRouteId: route.id }, orderBy: { attempt: 'asc' } })).map(row => row.status)).toEqual(['FAILED', 'COMPLETED']);
    expect(await prisma.signalEvaluation.findUnique({ where: { signalRouteId: route.id } })).toMatchObject({ outcome: 'ELIGIBLE', evaluationVersion: 1 });
  });

  it('rejects route attempts linked to another route decision or strategy', async () => {
    const { prisma } = await import('../prisma.js');
    const firstRoute = await signalRoute('ENTRY_LONG');
    const shadowService = await import('../../services/signal-route-market-eligibility.service.js');
    const decision = await shadowService.processSignalRouteMarketEligibility(firstRoute.id, prisma, () => new Date('2026-10-09T19:01:00Z'));
    const secondRoute = await signalRoute('ENTRY_LONG');
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO "SignalRouteMarketEligibilityAttempt" ("signalRouteId",attempt,"integrationVersion",status,"strategyId","eligibilityDecisionId","reasonCode","startedAt","completedAt","evidenceJson") VALUES ($1,1,'SIGNAL_ROUTE_MARKET_ELIGIBILITY_V1','COMPLETED',$2,$3,'MISMATCH',now(),now(),'{}')`, [secondRoute.id, strategyId, decision!.eligibilityDecisionId]);
      await expect(db.query('COMMIT')).rejects.toThrow(/decision identity conflicts/);
    } finally { await db.query('ROLLBACK').catch(() => undefined); }
    const thirdRoute = await signalRoute('ENTRY_LONG');
    const otherStrategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ($1,'Route Other',true,now(),now()) RETURNING id`, [`route-other-${randomUUID()}`])).rows[0].id;
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO "SignalRouteMarketEligibilityAttempt" ("signalRouteId",attempt,"integrationVersion",status,"strategyId","reasonCode","startedAt","completedAt","evidenceJson") VALUES ($1,1,'SIGNAL_ROUTE_MARKET_ELIGIBILITY_V1','FAILED',$2,'MISMATCH',now(),now(),'{}')`, [thirdRoute.id, otherStrategyId]);
      await expect(db.query('COMMIT')).rejects.toThrow(/strategy conflicts/);
    } finally { await db.query('ROLLBACK').catch(() => undefined); }
  });
});
