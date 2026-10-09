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
});
