import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client, Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

(enabled ? describe : describe.skip)('OrderIntent market-policy coverage PostgreSQL integrity', () => {
  const database = `order_intent_policy_coverage_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, databaseUrl: string;
  let ownerId: number, paperAccountId: number, unenrolledPaperAccountId: number, liveAccountId: number, strategyId: number;
  let paperAssignmentId: number, unenrolledPaperAssignmentId: number, liveAssignmentId: number, subscriptionId: number;
  let enrollmentGenerationId: number, boundRevisionId: number, replacementRevisionId: number;

  async function connection() {
    const result = new Client({ connectionString: databaseUrl });
    await result.connect();
    return result;
  }

  async function insertIntent(args: { assignmentId?: number; accountId?: number; clientOrderId: string; createdAt?: Date }) {
    return (await db.query(`
      INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",qty,"clientOrderId",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","createdAt","updatedAt")
      VALUES ('phase3b3b-acceptance','AAPL','buy','market','day',1,$1,'received','{}',$2,$3,COALESCE($4,now()),now()) RETURNING *
    `, [args.clientOrderId, args.accountId ?? paperAccountId, args.assignmentId ?? paperAssignmentId, args.createdAt ?? null])).rows[0];
  }

  async function insertComposition(client: Client, observedAt: Date, fingerprint = randomUUID().replaceAll('-', '').repeat(2), health: 'COMPLETE' | 'DEGRADED' = 'DEGRADED') {
    const row = (await client.query(`INSERT INTO "MarketRegimeAssessment"
      ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","publicationStatus","evidenceHealth","evidenceReasonCode","sourceSetFingerprint","startedAt","completedAt","evidenceJson")
      VALUES ('MARKET_REGIME_COMPOSITION_V1',1,$1,$1,'SUCCEEDED',$2,$3,$4,$1,$1,'{}') RETURNING id`,
      [observedAt, health, health === 'DEGRADED' ? 'SOURCE_VECTOR_DEGRADED' : null, fingerprint])).rows[0];
    const definitions = [['TREND','TREND_V1'],['VOLATILITY','VOLATILITY_V1'],['BREADTH','BREADTH_V1'],['PARTICIPATION','PARTICIPATION_V1'],['INTRADAY_STRESS','INTRADAY_STRESS_V1']];
    for (let index = 0; index < definitions.length; index += 1) {
      const [dimension, version] = definitions[index]!;
      await client.query(`INSERT INTO "MarketRegimeAssessmentSource"
        ("marketRegimeAssessmentId",dimension,"requiredAlgorithmVersion","expectedTargetAt",health,"reasonCode",ordinal,"evidenceJson")
        VALUES ($1,$2,$3,$4,'MISSING','SOURCE_NOT_PUBLISHED',$5,'{}')`, [row.id, dimension, version, observedAt, index + 1]);
    }
    return row.id as number;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = await connection();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) {
      try { await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8')); }
      catch (error) { throw new Error(`Migration replay failed at ${migration}`, { cause: error }); }
    }
    ownerId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('owner@phase3b1.test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id;
    paperAccountId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,'Paper','PAPER','PAUSED',false,true,now(),now()) RETURNING id`, [ownerId])).rows[0].id;
    liveAccountId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,'Live','LIVE','PAUSED',false,true,now(),now()) RETURNING id`, [ownerId])).rows[0].id;
    const unenrolledOwnerId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('unenrolled@phase3b3b.test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id;
    unenrolledPaperAccountId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,'Unenrolled Paper','PAPER','PAUSED',false,true,now(),now()) RETURNING id`, [unenrolledOwnerId])).rows[0].id;
    strategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('momentum_stock','Momentum Stock',true,now(),now()) RETURNING id`)).rows[0].id;
    const securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ('AAPL','Apple',true,'STOCK',now(),now()) RETURNING id`)).rows[0].id;
    const exitId = (await db.query(`INSERT INTO "ExitProfile" (key,name,"exitMode","takeProfitBehavior",enabled,"createdAt","updatedAt") VALUES ('momentum-stock-test','Momentum Stock Test','fixed','limit',true,now(),now()) RETURNING id`)).rows[0].id;
    subscriptionId = (await db.query(`INSERT INTO "Subscription" (key,name,symbol,enabled,"strategyId","exitProfileId","securityId","createdAt","updatedAt") VALUES ('momentum-stock-aapl','Momentum Stock AAPL','AAPL',true,$1,$2,$3,now(),now()) RETURNING id`, [strategyId, exitId, securityId])).rows[0].id;
    paperAssignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [paperAccountId, subscriptionId])).rows[0].id;
    unenrolledPaperAssignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [unenrolledPaperAccountId, subscriptionId])).rows[0].id;
    liveAssignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [liveAccountId, subscriptionId])).rows[0].id;
    process.env.DATABASE_URL = databaseUrl;
    const policy = await import('../../services/strategy-market-policy.service.js');
    const created = await policy.createStrategyMarketPolicy(strategyId, ownerId, 'Phase 3B.1 fixture');
    const initial = created.revisions[0]!;
    expect(initial.revision).toBe(1);
    const saved = await policy.saveStrategyMarketPolicyRevision(strategyId, initial.id, { expectedConfigurationFingerprint: initial.configurationFingerprint, rules: initial.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' || rule.dimension === 'BREADTH' ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: rule.dimension === 'TREND' ? ['UP'] : rule.dimension === 'BREADTH' ? ['POSITIVE'] : [] })) }, ownerId);
    boundRevisionId = saved.id;
    await policy.activateStrategyMarketPolicyRevision(strategyId, boundRevisionId, saved.configurationFingerprint, ownerId);
    const enrollment = await import('../../services/assignment-market-policy-enrollment.service.js');
    const prepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(paperAccountId, paperAssignmentId, ownerId);
    const active = await enrollment.activateAssignmentMarketPolicyEnrollment(paperAccountId, paperAssignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
    enrollmentGenerationId = active.id;
  }, 120_000);

  afterAll(async () => {
    const observation = await import('../../db/broker-observation-prisma.js'); await observation.closeBrokerObservationPrisma();
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  it('replays migrations without schema drift', () => {
    let output: string;
    try { output = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000 }); }
    catch (error) { throw new Error(`Schema drift detected: ${String((error as { stdout?: string }).stdout)}`, { cause: error }); }
    expect(output).toContain('No difference detected');
  }, 70_000);

  it('is disabled by default and records the database-owned effective epoch when enabled', async () => {
    const historical = await insertIntent({ clientOrderId: 'before-rollout' });
    expect((await db.query(`SELECT count(*)::int count FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [historical.id])).rows[0].count).toBe(0);
    const rollout = (await db.query(`UPDATE "OrderIntentMarketPolicyCaptureRollout" SET enabled=true WHERE id=1 RETURNING *`)).rows[0];
    expect(rollout).toMatchObject({ enabled: true, disabledAt: null });
    expect(new Date(rollout.effectiveEpoch).getTime()).toBeGreaterThanOrEqual(new Date(rollout.deployedAt).getTime());
    await expect(db.query(`UPDATE "OrderIntentMarketPolicyCaptureRollout" SET "effectiveEpoch"=now() - interval '1 day' WHERE id=1`)).rejects.toThrow(/database-managed/);
  });

  it('captures exact identity without changing OrderIntent status, risk payload, or client-order ID', async () => {
    const intent = await insertIntent({ clientOrderId: 'exact-current' });
    expect(intent).toMatchObject({ status: 'received', clientOrderId: 'exact-current', rawRequestJson: {} });
    const coverage = (await db.query(`SELECT * FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [intent.id])).rows[0];
    expect(coverage).toMatchObject({ tradingAccountId: paperAccountId, accountSubscriptionId: paperAssignmentId, enrollmentGenerationId, boundPolicyRevisionId: boundRevisionId, activePolicyRevisionId: boundRevisionId, provenance: 'ACTIVE_EXACT', compositionCapture: 'NONE_VISIBLE', captureSchemaVersion: 2, marketRegimeAssessmentId: null, comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE' });
  });

  it('captures committed degraded evidence and never retrospectively replaces its exact identity with a backfill', async () => {
    await db.query('BEGIN');
    const compositionId = await insertComposition(db, new Date(Date.now() - 60_000));
    await db.query('COMMIT');
    const intent = await insertIntent({ clientOrderId: 'committed-composition' });
    const coverage = (await db.query(`SELECT "marketRegimeAssessmentId","compositionCapture","captureSchemaVersion" FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [intent.id])).rows[0];
    expect(coverage).toEqual({ marketRegimeAssessmentId: compositionId, compositionCapture: 'EXACT', captureSchemaVersion: 2 });

    await db.query('BEGIN');
    await insertComposition(db, new Date(Date.now() - 120_000));
    await db.query('COMMIT');
    expect((await db.query(`SELECT "marketRegimeAssessmentId" FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [intent.id])).rows[0].marketRegimeAssessmentId).toBe(compositionId);
    const afterBackfill = await insertIntent({ clientOrderId: 'after-older-backfill' });
    expect((await db.query(`SELECT "marketRegimeAssessmentId" FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [afterBackfill.id])).rows[0].marketRegimeAssessmentId).toBe(compositionId);
  });

  it('does not select an uncommitted or rolled-back composition under READ COMMITTED', async () => {
    const writer = await connection(); const reader = await connection();
    try {
      await writer.query('BEGIN');
      const uncommittedId = await insertComposition(writer, new Date(Date.now() + 60_000));
      const beforeCommit = (await reader.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",qty,"clientOrderId",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","createdAt","updatedAt") VALUES ('phase3b2-test','P3B','buy','market','day',1,'uncommitted-composition','received','{}',$1,$2,now(),now()) RETURNING id`, [paperAccountId, paperAssignmentId])).rows[0];
      expect((await reader.query(`SELECT "marketRegimeAssessmentId" FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [beforeCommit.id])).rows[0].marketRegimeAssessmentId).not.toBe(uncommittedId);
      await writer.query('ROLLBACK');
      expect((await db.query(`SELECT count(*)::int count FROM "MarketRegimeAssessment" WHERE id=$1`, [uncommittedId])).rows[0].count).toBe(0);
    } finally { await writer.end(); await reader.end(); }
  });

  it('uses the established REPEATABLE READ snapshot even when a composition commits before the intent statement', async () => {
    const writer = await connection(); const reader = await connection();
    try {
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await reader.query('SELECT 1 FROM "MarketRegimeAssessment" LIMIT 1');
      await writer.query('BEGIN');
      const laterId = await insertComposition(writer, new Date(Date.now() + 120_000));
      await writer.query('COMMIT');
      const intent = (await reader.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",qty,"clientOrderId",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","createdAt","updatedAt") VALUES ('phase3b2-test','P3B','buy','market','day',1,'repeatable-read-snapshot','received','{}',$1,$2,now(),now()) RETURNING id`, [paperAccountId, paperAssignmentId])).rows[0];
      const frozen = (await reader.query(`SELECT "marketRegimeAssessmentId" FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [intent.id])).rows[0].marketRegimeAssessmentId;
      expect(frozen).not.toBe(laterId);
      await reader.query('COMMIT');
      expect((await db.query(`SELECT "marketRegimeAssessmentId" FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [intent.id])).rows[0].marketRegimeAssessmentId).toBe(frozen);
    } finally { await writer.end(); await reader.end(); }
  });

  it('keeps schema-v1 rows explicitly LEGACY_UNKNOWN and enforces capture shape', async () => {
    const legacyIntent = await insertIntent({ clientOrderId: 'legacy-shape-source' });
    const coverageId = (await db.query(`SELECT id FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [legacyIntent.id])).rows[0].id;
    await expect(db.query(`UPDATE "OrderIntentMarketPolicyCoverage" SET "compositionCapture"='LEGACY_UNKNOWN' WHERE id=$1`, [coverageId])).rejects.toThrow(/immutable/);
    await expect(db.query(`INSERT INTO "OrderIntentMarketPolicyCoverage" ("orderIntentId","tradingAccountId","accountSubscriptionId",provenance,"compositionCapture","captureSchemaVersion") VALUES ($1,$2,$3,'CAPTURE_UNKNOWN','EXACT',2)`, [legacyIntent.id, paperAccountId, paperAssignmentId])).rejects.toThrow();
  });

  it('contains capture failures in standalone and interactive LIVE-style transactions', async () => {
    await db.query(`CREATE FUNCTION fail_phase3b1_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'comparison storage unavailable'; END $$`);
    await db.query(`CREATE TRIGGER phase3b1_injected_failure BEFORE INSERT ON "OrderIntentMarketPolicyCoverage" FOR EACH ROW EXECUTE FUNCTION fail_phase3b1_capture()`);
    const standalone = await insertIntent({ clientOrderId: 'contained-failure' });
    expect(standalone).toMatchObject({ status: 'received', clientOrderId: 'contained-failure' });
    expect((await db.query(`SELECT count(*)::int count FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [standalone.id])).rows[0].count).toBe(0);

    await db.query('BEGIN');
    const live = await insertIntent({ assignmentId: liveAssignmentId, accountId: liveAccountId, clientOrderId: 'live-interactive' });
    await db.query(`UPDATE "OrderIntent" SET status='pending', "rawRequestJson"='{"riskDecision":"ALLOW"}' WHERE id=$1`, [live.id]);
    await db.query('COMMIT');
    expect((await db.query(`SELECT status,"clientOrderId","rawRequestJson" FROM "OrderIntent" WHERE id=$1`, [live.id])).rows[0]).toEqual({ status: 'pending', clientOrderId: 'live-interactive', rawRequestJson: { riskDecision: 'ALLOW' } });
    await db.query(`DROP TRIGGER phase3b1_injected_failure ON "OrderIntentMarketPolicyCoverage"`);
    await db.query(`DROP FUNCTION fail_phase3b1_capture()`);
  });

  it('captures a coherent committed identity during concurrent revision replacement and preserves superseded identity', async () => {
    const policyId = (await db.query(`SELECT id FROM "StrategyMarketPolicy" WHERE "strategyId"=$1`, [strategyId])).rows[0].id;
    replacementRevisionId = (await db.query(`INSERT INTO "StrategyMarketPolicyRevision" ("policyId",revision,status,"changeNote","createdAt") VALUES ($1,2,'PREPARED','replacement',now()) RETURNING id`, [policyId])).rows[0].id;
    const writer = await connection(); const inserter = await connection();
    try {
      await writer.query('BEGIN');
      await writer.query(`UPDATE "StrategyMarketPolicyRevision" SET status='RETIRED', "retiredAt"=now() WHERE id=$1`, [boundRevisionId]);
      await writer.query(`UPDATE "StrategyMarketPolicyRevision" SET status='ACTIVE', "activatedAt"=now() WHERE id=$1`, [replacementRevisionId]);
      await inserter.query(`SET statement_timeout='750ms'`);
      const started = performance.now();
      const during = (await inserter.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",qty,"clientOrderId",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","createdAt","updatedAt") VALUES ('phase3b1-test','P3B','buy','market','day',1,'during-uncommitted-replacement','received','{}',$1,$2,now(),now()) RETURNING id`, [paperAccountId, paperAssignmentId])).rows[0];
      expect(performance.now() - started).toBeLessThan(700);
      expect((await inserter.query(`SELECT provenance,"activePolicyRevisionId" FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [during.id])).rows[0]).toEqual({ provenance: 'ACTIVE_EXACT', activePolicyRevisionId: boundRevisionId });
      await writer.query('ROLLBACK');

      await writer.query('BEGIN');
      await writer.query(`UPDATE "StrategyMarketPolicyRevision" SET status='RETIRED', "retiredAt"=now() WHERE id=$1`, [boundRevisionId]);
      await writer.query(`UPDATE "StrategyMarketPolicyRevision" SET status='ACTIVE', "activatedAt"=now() WHERE id=$1`, [replacementRevisionId]);
      await writer.query('COMMIT');
      const after = await insertIntent({ clientOrderId: 'after-replacement' });
      expect((await db.query(`SELECT "enrollmentGenerationId","boundPolicyRevisionId","activePolicyRevisionId",provenance FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [after.id])).rows[0]).toEqual({ enrollmentGenerationId, boundPolicyRevisionId: boundRevisionId, activePolicyRevisionId: replacementRevisionId, provenance: 'SUPERSEDED_COMPARE_ONLY' });
    } finally { await writer.end(); await inserter.end(); }
  });

  it('creates bounded idempotent CAPTURE_UNKNOWN evidence without reconstructing current configuration', async () => {
    const service = await import('../../services/order-intent-market-policy-coverage.service.js');
    let unknown = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await service.detectOrderIntentMarketPolicyCoverageGaps(1);
      unknown += result.captureUnknown;
      if (result.scanned === 0) break;
    }
    expect(unknown).toBe(2);
    const rows = (await db.query(`SELECT provenance,"enrollmentGenerationId","boundPolicyRevisionId","activePolicyRevisionId","comparisonMode","tradingEffect" FROM "OrderIntentMarketPolicyCoverage" WHERE provenance='CAPTURE_UNKNOWN' ORDER BY id`)).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.enrollmentGenerationId === null && row.boundPolicyRevisionId === null && row.activePolicyRevisionId === null && row.comparisonMode === 'COMPARE_ONLY' && row.tradingEffect === 'NONE')).toBe(true);
    expect((await service.detectOrderIntentMarketPolicyCoverageGaps(100)).captureUnknown).toBe(0);
  });

  it('processes only exact applicable coverage asynchronously and idempotently across worker instances', async () => {
    await db.query(`UPDATE "OrderIntentMarketPolicyComparisonRollout" SET enabled=true WHERE id=1`);
    const service = await import('../../services/order-intent-market-policy-comparison.service.js');
    const before = (await db.query(`SELECT id,status,"clientOrderId" FROM "OrderIntent" ORDER BY id`)).rows;
    const [first, second] = await Promise.all([
      service.processOrderIntentMarketPolicyComparisons({ limit: 25, workerId: 'instance-a' }),
      service.processOrderIntentMarketPolicyComparisons({ limit: 25, workerId: 'instance-b' }),
    ]);
    expect(first.completed + second.completed).toBeGreaterThan(0);
    const attempts = (await db.query(`SELECT a.*,count(g.id)::int AS gates FROM "OrderIntentMarketPolicyComparisonAttempt" a LEFT JOIN "OrderIntentMarketPolicyComparisonGate" g ON g."comparisonAttemptId"=a.id WHERE a.outcome<>'TECHNICAL_FAILURE' GROUP BY a.id ORDER BY a.id`)).rows;
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every(row => row.gates === 5 && row.authority === 'COMPARE_ONLY' && row.tradingEffect === 'NONE' && row.evaluationVersion === 'ORDER_INTENT_MARKET_POLICY_COMPARISON_V1')).toBe(true);
    expect(attempts.some(row => row.enrollmentDisposition === 'SUPERSEDED_DIAGNOSTIC')).toBe(true);
    expect(attempts.every(row => row.outcome === 'INSUFFICIENT_EVIDENCE')).toBe(true);
    const intentGates=(await db.query(`SELECT dimension,requirement,"allowedStatesJson" FROM "OrderIntentMarketPolicyComparisonGate" WHERE "comparisonAttemptId"=$1 ORDER BY ordinal`,[attempts[0].id])).rows;
    expect(intentGates.find(gate=>gate.dimension==='TREND')).toMatchObject({requirement:'REQUIRED',allowedStatesJson:['UP']});
    expect(intentGates.find(gate=>gate.dimension==='BREADTH')).toMatchObject({requirement:'REQUIRED',allowedStatesJson:['POSITIVE']});
    expect((await db.query(`SELECT count(*)::int count FROM "OrderIntentMarketPolicyComparisonDelivery" d JOIN "OrderIntentMarketPolicyCoverage" c ON c.id=d."coverageId" WHERE c."captureSchemaVersion"<>2 OR c."compositionCapture"<>'EXACT' OR c.provenance NOT IN ('ACTIVE_EXACT','SUPERSEDED_COMPARE_ONLY')`)).rows[0].count).toBe(0);
    expect((await db.query(`SELECT id,status,"clientOrderId" FROM "OrderIntent" ORDER BY id`)).rows).toEqual(before);

    await service.processOrderIntentMarketPolicyComparisons({ limit: 25, workerId: 'instance-c' });
    expect((await db.query(`SELECT "coverageId",count(*)::int count FROM "OrderIntentMarketPolicyComparisonAttempt" WHERE outcome<>'TECHNICAL_FAILURE' GROUP BY "coverageId" HAVING count(*)>1`)).rows).toHaveLength(0);
  });

  it('records bounded technical failures separately and recovers without changing the intent', async () => {
    const service = await import('../../services/order-intent-market-policy-comparison.service.js');
    const intent = await insertIntent({ clientOrderId: 'evaluation-recovery' });
    const original = { status: intent.status, clientOrderId: intent.clientOrderId, rawRequestJson: intent.rawRequestJson };
    const failing = () => { throw new Error('INJECTED_COMPARISON_FAILURE'); };
    const failed = await service.processOrderIntentMarketPolicyComparisons({ limit: 1, workerId: 'failure-worker', evaluator: failing as any });
    expect(failed.retrying).toBe(1);
    const coverage = (await db.query(`SELECT id FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [intent.id])).rows[0];
    expect((await db.query(`SELECT outcome,"reasonCode",authority,"tradingEffect" FROM "OrderIntentMarketPolicyComparisonAttempt" WHERE "coverageId"=$1`, [coverage.id])).rows[0]).toEqual({ outcome: 'TECHNICAL_FAILURE', reasonCode: 'EVALUATION_TECHNICAL_FAILURE', authority: 'COMPARE_ONLY', tradingEffect: 'NONE' });
    await db.query(`UPDATE "OrderIntentMarketPolicyComparisonDelivery" SET "nextAttemptAt"=statement_timestamp() WHERE "coverageId"=$1`, [coverage.id]);
    const recovered = await service.processOrderIntentMarketPolicyComparisons({ limit: 1, workerId: 'recovery-worker' });
    expect(recovered.completed).toBe(1);
    expect((await db.query(`SELECT status,"clientOrderId","rawRequestJson" FROM "OrderIntent" WHERE id=$1`, [intent.id])).rows[0]).toEqual(original);
    expect((await db.query(`SELECT count(*)::int count FROM "OrderIntentMarketPolicyComparisonAttempt" WHERE "coverageId"=$1`, [coverage.id])).rows[0].count).toBe(2);
  });

  it('recovers expired leases and makes the third technical failure terminal', async () => {
    const service = await import('../../services/order-intent-market-policy-comparison.service.js');
    const intent = await insertIntent({ clientOrderId: 'terminal-evaluation-failure' });
    await service.seedOrderIntentMarketPolicyComparisonDeliveries(25);
    const coverage = (await db.query(`SELECT id FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [intent.id])).rows[0];
    await db.query(`UPDATE "OrderIntentMarketPolicyComparisonDelivery" SET status='CLAIMED',"leaseOwner"='dead-instance',"leaseExpiresAt"=statement_timestamp()-interval '1 second' WHERE "coverageId"=$1`, [coverage.id]);
    const failing = () => { throw new Error('PERSISTENT_INJECTED_FAILURE'); };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await service.processOrderIntentMarketPolicyComparisons({ limit: 1, workerId: `terminal-${attempt}`, evaluator: failing as any });
      expect(attempt < 3 ? result.retrying : result.terminalFailures).toBe(1);
      if (attempt < 3) await db.query(`UPDATE "OrderIntentMarketPolicyComparisonDelivery" SET "nextAttemptAt"=statement_timestamp() WHERE "coverageId"=$1`, [coverage.id]);
    }
    expect((await db.query(`SELECT status,"attemptCount","lastErrorCode" FROM "OrderIntentMarketPolicyComparisonDelivery" WHERE "coverageId"=$1`, [coverage.id])).rows[0]).toEqual({ status: 'TERMINAL_FAILURE', attemptCount: 3, lastErrorCode: 'PERSISTENT_INJECTED_FAILURE' });
    expect((await db.query(`SELECT count(*)::int count FROM "OrderIntentMarketPolicyComparisonAttempt" WHERE "coverageId"=$1 AND outcome='TECHNICAL_FAILURE'`, [coverage.id])).rows[0].count).toBe(3);
  });

  it('rejects incomplete immutable decision evidence and authority escalation', async () => {
    const template = (await db.query(`SELECT * FROM "OrderIntentMarketPolicyComparisonAttempt" WHERE outcome<>'TECHNICAL_FAILURE' LIMIT 1`)).rows[0];
    await expect(db.query(`UPDATE "OrderIntentMarketPolicyComparisonAttempt" SET "tradingEffect"='BLOCK' WHERE id=$1`, [template.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`INSERT INTO "OrderIntentMarketPolicyComparisonAttempt" ("coverageId",attempt,"strategyId","enrollmentGenerationId","policyRevisionId","marketRegimeAssessmentId","evidenceAsOf","evaluationVersion","enrollmentDisposition",outcome,"reasonCode",authority,"tradingEffect","evidenceJson") VALUES ($1,3,$2,$3,$4,$5,$6,'TEST','ACTIVE','ALLOWED','TEST','COMPARE_ONLY','NONE','{}')`, [template.coverageId, template.strategyId, template.enrollmentGenerationId, template.policyRevisionId, template.marketRegimeAssessmentId, template.evidenceAsOf])).rejects.toThrow();
  });

  it('enforces immutability and permanent compare-only/no-effect constraints', async () => {
    const row = (await db.query(`SELECT id FROM "OrderIntentMarketPolicyCoverage" ORDER BY id LIMIT 1`)).rows[0];
    await expect(db.query(`UPDATE "OrderIntentMarketPolicyCoverage" SET "tradingEffect"='BLOCK' WHERE id=$1`, [row.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM "OrderIntentMarketPolicyCoverage" WHERE id=$1`, [row.id])).rejects.toThrow(/immutable/);
  });

  it('captures immutable broker opportunities from frozen coverage without consulting current enrollment', async () => {
    const service = await import('../../services/order-intent-broker-opportunity.service.js');
    expect((await db.query(`SELECT enabled FROM "OrderIntentBrokerOpportunityCaptureRollout" WHERE id=1`)).rows[0].enabled).toBe(false);
    for(let index=0;index<20;index+=1)expect(await service.bestEffortCaptureOrderIntentBrokerPostOpportunity(1)).toBeNull();
    await db.query(`UPDATE "OrderIntentBrokerOpportunityCaptureRollout" SET enabled=true WHERE id=1`);
    expect((await db.query(`SELECT enabled FROM "OrderIntentBrokerComparisonRollout" WHERE id=1`)).rows[0].enabled).toBe(false);
    await db.query(`UPDATE "OrderIntentBrokerComparisonRollout" SET enabled=true WHERE id=1`);
    const intent = await insertIntent({ clientOrderId: 'broker-opportunity-frozen' });
    const coverage = (await db.query(`SELECT * FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId"=$1`, [intent.id])).rows[0];
    const opportunity = await service.captureOrderIntentBrokerPostOpportunity({ orderIntentId: intent.id, opportunitySequence: 1, idempotencyKey: 'broker-opportunity-frozen:1' });
    if(!opportunity) throw new Error('Expected enabled broker opportunity capture.');
    expect(opportunity).toMatchObject({ orderIntentId: intent.id, intentCoverageId: coverage.id, opportunitySequence: 1, clientOrderId: 'broker-opportunity-frozen', enrollmentGenerationId, policyRevisionId: boundRevisionId, applicability: 'APPLICABLE_SUPERSEDED', comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE' });
    expect(opportunity.marketRegimeAssessmentId).not.toBeNull();
    expect((await db.query(`SELECT "eventType",sequence FROM "OrderIntentBrokerOpportunityEvent" WHERE "opportunityId"=$1`, [opportunity.id])).rows).toEqual([{ eventType: 'OPPORTUNITY_CAPTURED', sequence: 1 }]);
    await Promise.all([service.appendOrderIntentBrokerOpportunityEvent(opportunity.id,'ADAPTER_DISPATCH_REACHED',{test:true}),service.appendOrderIntentBrokerOpportunityEvent(opportunity.id,'BROKER_ORDER_MATERIALIZED',{test:true})]);
    expect((await db.query(`SELECT sequence FROM "OrderIntentBrokerOpportunityEvent" WHERE "opportunityId"=$1 ORDER BY sequence`,[opportunity.id])).rows.map(row=>row.sequence)).toEqual([1,2,3]);
    expect((await service.captureOrderIntentBrokerPostOpportunity({ orderIntentId: intent.id, opportunitySequence: 1, idempotencyKey: 'broker-opportunity-frozen:1' }))?.id).toBe(opportunity.id);
    await expect(db.query(`UPDATE "OrderIntentBrokerPostOpportunity" SET "tradingEffect"='BLOCK' WHERE id=$1`, [opportunity.id])).rejects.toThrow(/immutable/);
    await expect(service.captureOrderIntentBrokerPostOpportunity({ orderIntentId: intent.id, opportunitySequence: 1, idempotencyKey: 'different-key' })).rejects.toThrow();
    expect((await db.query(`SELECT "marketRegimeAssessmentId","sourceSetFingerprint" FROM "OrderIntentBrokerPostOpportunity" WHERE id=$1`, [opportunity.id])).rows[0]).toEqual({ marketRegimeAssessmentId: opportunity.marketRegimeAssessmentId, sourceSetFingerprint: opportunity.sourceSetFingerprint });
    for(let index=0;index<20;index+=1){const latencyIntent=await insertIntent({clientOrderId:`broker-latency-${index}`});expect(await service.bestEffortCaptureOrderIntentBrokerPostOpportunity(latencyIntent.id)).not.toBeNull();}
    const latency=service.getBrokerOpportunityLatencySnapshot(); console.info('BROKER_OPPORTUNITY_LATENCY',JSON.stringify(latency));
    const disabledLatency=latency.disabled!;const enabledLatency=latency.enabled!;expect(disabledLatency.count).toBe(20); expect(enabledLatency.count).toBe(20); expect(disabledLatency.p95Ms).toBeLessThan(1500); expect(enabledLatency.p95Ms).toBeLessThan(1500);

    const writer=await connection();
    try {
      await writer.query('BEGIN'); const uncommitted=await insertComposition(writer,new Date(Date.now()+300_000));
      const concurrentIntent=await insertIntent({clientOrderId:'broker-uncommitted-composition'});
      const concurrent=await service.captureOrderIntentBrokerPostOpportunity({orderIntentId:concurrentIntent.id,opportunitySequence:1,idempotencyKey:'broker-uncommitted-composition:1'});
      if(!concurrent) throw new Error('Expected concurrent broker opportunity capture.');
      expect(concurrent.marketRegimeAssessmentId).not.toBe(uncommitted);
      await writer.query('ROLLBACK');
    } finally { await writer.end(); }
    const crashIntent=await insertIntent({clientOrderId:'broker-crash-after-anchor'});const abandoned=await service.captureOrderIntentBrokerPostOpportunity({orderIntentId:crashIntent.id});const laterAttempt=await service.captureOrderIntentBrokerPostOpportunity({orderIntentId:crashIntent.id});expect([abandoned?.opportunitySequence,laterAttempt?.opportunitySequence]).toEqual([1,2]);expect(abandoned?.id).not.toBe(laterAttempt?.id);
    await db.query(`CREATE FUNCTION fail_broker_anchor_coverage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'coverage unavailable'; END $$`);await db.query(`CREATE TRIGGER broker_anchor_coverage_failure BEFORE INSERT ON "OrderIntentMarketPolicyCoverage" FOR EACH ROW EXECUTE FUNCTION fail_broker_anchor_coverage()`);const missingIntent=await insertIntent({clientOrderId:'broker-missing-observation'});await db.query(`DROP TRIGGER broker_anchor_coverage_failure ON "OrderIntentMarketPolicyCoverage"`);await db.query(`DROP FUNCTION fail_broker_anchor_coverage()`);expect(await service.bestEffortCaptureOrderIntentBrokerPostOpportunity(missingIntent.id)).toBeNull();expect((await db.query(`SELECT "opportunityId","eventType" FROM "OrderIntentBrokerOpportunityEvent" WHERE "orderIntentId"=$1`,[missingIntent.id])).rows).toEqual([{opportunityId:null,eventType:'MISSING_OBSERVATION'}]);
  });

  it('bounds pool exhaustion, delayed establishment, statement waits, lock waits and cumulative pre-POST work', async () => {
    const service = await import('../../services/order-intent-broker-opportunity.service.js');
    const exhaustedIntent = await insertIntent({ clientOrderId: 'broker-pool-exhausted' });
    const exhaustedPool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 50 });
    const held = await exhaustedPool.connect();
    const exhaustedPrisma = new PrismaClient({ adapter: new PrismaPg(exhaustedPool, { disposeExternalPool: true }) });
    let started = performance.now();
    expect(await service.bestEffortCaptureOrderIntentBrokerPostOpportunity(exhaustedIntent.id, exhaustedPrisma, service.createBrokerObservationBudget())).toBeNull();
    const poolExhaustedMs = performance.now() - started;
    expect(poolExhaustedMs).toBeLessThan(250);
    held.release();
    await exhaustedPrisma.$disconnect();

    const stalledSockets = new Set<import('node:net').Socket>();
    const stalledServer = createServer(socket => { stalledSockets.add(socket); socket.once('close',()=>stalledSockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { stalledServer.once('error', reject); stalledServer.listen(0, '127.0.0.1', resolve); });
    const address = stalledServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test port.');
    const stalledUrl = new URL(databaseUrl); stalledUrl.hostname = '127.0.0.1'; stalledUrl.port = String(address.port);
    const stalledPool = new Pool({ connectionString: stalledUrl.toString(), max: 1, connectionTimeoutMillis: 50 });
    const stalledPrisma = new PrismaClient({ adapter: new PrismaPg(stalledPool, { disposeExternalPool: true }) });
    started = performance.now();
    expect(await service.bestEffortCaptureOrderIntentBrokerPostOpportunity(exhaustedIntent.id, stalledPrisma, service.createBrokerObservationBudget())).toBeNull();
    const delayedConnectionMs = performance.now() - started;
    expect(delayedConnectionMs).toBeLessThan(250);
    expect(stalledPool.waitingCount).toBe(0);
    expect(stalledPool.totalCount).toBe(0);
    await stalledPrisma.$disconnect();
    for (const socket of stalledSockets) socket.destroy();
    await new Promise<void>((resolve, reject) => stalledServer.close(error => error ? reject(error) : resolve()));
    const refusedPool = new Pool({ connectionString: stalledUrl.toString(), max: 1, connectionTimeoutMillis: 50 });
    const refusedPrisma = new PrismaClient({ adapter: new PrismaPg(refusedPool, { disposeExternalPool: true }) });
    started = performance.now();
    expect(await service.bestEffortCaptureOrderIntentBrokerPostOpportunity(exhaustedIntent.id, refusedPrisma, service.createBrokerObservationBudget())).toBeNull();
    const connectionRefusedMs = performance.now() - started;
    expect(connectionRefusedMs).toBeLessThan(250);
    await refusedPrisma.$disconnect();

    const statementIntent = await insertIntent({ clientOrderId: 'broker-statement-timeout' });
    await db.query(`CREATE FUNCTION delay_broker_opportunity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER broker_opportunity_delay BEFORE INSERT ON "OrderIntentBrokerPostOpportunity" FOR EACH ROW EXECUTE FUNCTION delay_broker_opportunity()`);
    started = performance.now();
    expect(await service.bestEffortCaptureOrderIntentBrokerPostOpportunity(statementIntent.id, undefined, service.createBrokerObservationBudget())).toBeNull();
    const statementTimeoutMs = performance.now() - started;
    expect(statementTimeoutMs).toBeLessThan(250);
    await db.query(`DROP TRIGGER broker_opportunity_delay ON "OrderIntentBrokerPostOpportunity"`);
    await db.query(`DROP FUNCTION delay_broker_opportunity()`);

    const lockIntent = await insertIntent({ clientOrderId: 'broker-lock-timeout' });
    const locker = await connection();
    await locker.query('BEGIN');
    await locker.query(`SELECT id FROM "OrderIntent" WHERE id=$1 FOR UPDATE`, [lockIntent.id]);
    started = performance.now();
    expect(await service.bestEffortCaptureOrderIntentBrokerPostOpportunity(lockIntent.id, undefined, service.createBrokerObservationBudget())).toBeNull();
    const lockTimeoutMs = performance.now() - started;
    expect(lockTimeoutMs).toBeLessThan(250);
    await locker.query('ROLLBACK');
    await locker.end();

    const cumulativeIntent = await insertIntent({ clientOrderId: 'broker-cumulative-budget' });
    const budget = service.createBrokerObservationBudget();
    const opportunity = await service.captureOrderIntentBrokerPostOpportunity({ orderIntentId: cumulativeIntent.id }, undefined, budget);
    expect(opportunity).not.toBeNull();
    const eventLocker = await connection();
    await eventLocker.query('BEGIN');
    await eventLocker.query(`SELECT id FROM "OrderIntentBrokerPostOpportunity" WHERE id=$1 FOR UPDATE`, [opportunity!.id]);
    started = budget.startedAtMs;
    expect(await service.bestEffortAppendBrokerOpportunityEvent({ opportunityId: opportunity!.id, eventType: 'ADAPTER_DISPATCH_REACHED' }, undefined, budget)).toBe(false);
    const cumulativeMs = performance.now() - started;
    expect(cumulativeMs).toBeLessThan(250);
    await eventLocker.query('ROLLBACK');
    await eventLocker.end();

    console.info('BROKER_OBSERVATION_TIMEOUTS', JSON.stringify({ poolExhaustedMs, delayedConnectionMs, connectionRefusedMs, statementTimeoutMs, lockTimeoutMs, cumulativeMs }));
  }, 10_000);

  it('classifies LIVE and unenrolled broker opportunities as non-applicable', async () => {
    const service = await import('../../services/order-intent-broker-opportunity.service.js');
    const live = await insertIntent({ assignmentId: liveAssignmentId, accountId: liveAccountId, clientOrderId: 'broker-live' });
    const liveOpportunity = await service.captureOrderIntentBrokerPostOpportunity({ orderIntentId: live.id, opportunitySequence: 1, idempotencyKey: 'broker-live:1' });
    expect(liveOpportunity).toMatchObject({ applicability: 'NOT_APPLICABLE_LIVE', enrollmentGenerationId: null, policyRevisionId: null });
    const unenrolled = await insertIntent({ assignmentId: unenrolledPaperAssignmentId, accountId: unenrolledPaperAccountId, clientOrderId: 'broker-unenrolled' });
    const unenrolledOpportunity = await service.captureOrderIntentBrokerPostOpportunity({ orderIntentId: unenrolled.id, opportunitySequence: 1, idempotencyKey: 'broker-unenrolled:1' });
    expect(unenrolledOpportunity).toMatchObject({ applicability: 'NOT_APPLICABLE_UNENROLLED', enrollmentGenerationId: null, policyRevisionId: null });
  });

  it('processes exact and NONE_VISIBLE broker comparisons with isolated leases and gate contracts', async () => {
    expect((await db.query(`SELECT enabled FROM "OrderIntentBrokerComparisonRollout" WHERE id=1`)).rows[0].enabled).toBe(true);
    const exact = (await db.query(`SELECT * FROM "OrderIntentBrokerPostOpportunity" WHERE applicability='APPLICABLE_SUPERSEDED' ORDER BY id LIMIT 1`)).rows[0];
    const noneVisible = (await db.query(`INSERT INTO "OrderIntentBrokerPostOpportunity" ("orderIntentId","intentCoverageId","tradingAccountId","accountSubscriptionId","enrollmentGenerationId","policyRevisionId","clientOrderId","opportunitySequence","idempotencyKey","compositionCapture",applicability,"comparisonMode","tradingEffect") VALUES ($1,$2,$3,$4,$5,$6,$7,2,'broker-opportunity-frozen:2','NONE_VISIBLE','APPLICABLE_SUPERSEDED','COMPARE_ONLY','NONE') RETURNING *`, [exact.orderIntentId,exact.intentCoverageId,exact.tradingAccountId,exact.accountSubscriptionId,exact.enrollmentGenerationId,exact.policyRevisionId,exact.clientOrderId])).rows[0];
    const service = await import('../../services/order-intent-broker-comparison.service.js');
    await db.query(`INSERT INTO "OrderIntentBrokerComparisonDelivery" ("opportunityId",status,"nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING','2000-01-01',now(),now()) ON CONFLICT ("opportunityId") DO UPDATE SET "nextAttemptAt"='2000-01-01'`,[noneVisible.id]);
    const [a,b] = await Promise.all([service.processOrderIntentBrokerComparisons({limit:25,workerId:'broker-a'}),service.processOrderIntentBrokerComparisons({limit:25,workerId:'broker-b'})]);
    expect(a.completed+b.completed).toBeGreaterThanOrEqual(3);
    const attempts=(await db.query(`SELECT a.*,count(g.id)::int gates FROM "OrderIntentBrokerComparisonAttempt" a LEFT JOIN "OrderIntentBrokerComparisonGate" g ON g."comparisonAttemptId"=a.id GROUP BY a.id ORDER BY a.id`)).rows;
    expect(attempts.find(row=>row.opportunityId===exact.id)).toMatchObject({gates:5,authority:'COMPARE_ONLY',tradingEffect:'NONE'});
    const exactGates=(await db.query(`SELECT dimension,requirement,"allowedStatesJson" FROM "OrderIntentBrokerComparisonGate" WHERE "comparisonAttemptId"=$1 ORDER BY ordinal`,[attempts.find(row=>row.opportunityId===exact.id).id])).rows;
    expect(exactGates.find(gate=>gate.dimension==='TREND')).toMatchObject({requirement:'REQUIRED',allowedStatesJson:['UP']});
    expect(exactGates.find(gate=>gate.dimension==='BREADTH')).toMatchObject({requirement:'REQUIRED',allowedStatesJson:['POSITIVE']});
    expect(exactGates.filter(gate=>!['TREND','BREADTH'].includes(gate.dimension)).every(gate=>gate.requirement==='IGNORED')).toBe(true);
    expect(attempts.find(row=>row.opportunityId===noneVisible.id)).toMatchObject({gates:0,outcome:'INSUFFICIENT_EVIDENCE',reasonCode:'NO_COMPOSITION_VISIBLE'});
    expect((await db.query(`SELECT "opportunityId",count(*)::int count FROM "OrderIntentBrokerComparisonAttempt" WHERE outcome<>'TECHNICAL_FAILURE' GROUP BY "opportunityId" HAVING count(*)>1`)).rows).toHaveLength(0);
    await expect(db.query(`UPDATE "OrderIntentBrokerComparisonAttempt" SET authority='ENFORCE' WHERE id=$1`, [attempts[0].id])).rejects.toThrow(/immutable/);
  });

  it('bounds broker comparison retries and recovers an expired lease', async () => {
    const exact=(await db.query(`SELECT * FROM "OrderIntentBrokerPostOpportunity" WHERE applicability='APPLICABLE_SUPERSEDED' AND "compositionCapture"='EXACT' ORDER BY id LIMIT 1`)).rows[0];
    const retry=(await db.query(`INSERT INTO "OrderIntentBrokerPostOpportunity" ("orderIntentId","intentCoverageId","tradingAccountId","accountSubscriptionId","enrollmentGenerationId","policyRevisionId","clientOrderId","opportunitySequence","idempotencyKey","marketRegimeAssessmentId","sourceSetFingerprint","compositionCapture",applicability,"comparisonMode","tradingEffect") VALUES ($1,$2,$3,$4,$5,$6,$7,3,'broker-opportunity-frozen:3',$8,$9,'EXACT','APPLICABLE_SUPERSEDED','COMPARE_ONLY','NONE') RETURNING *`,[exact.orderIntentId,exact.intentCoverageId,exact.tradingAccountId,exact.accountSubscriptionId,exact.enrollmentGenerationId,exact.policyRevisionId,exact.clientOrderId,exact.marketRegimeAssessmentId,exact.sourceSetFingerprint])).rows[0];
    const service=await import('../../services/order-intent-broker-comparison.service.js'); await db.query(`INSERT INTO "OrderIntentBrokerComparisonDelivery" ("opportunityId",status,"nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING','2000-01-01',now(),now()) ON CONFLICT ("opportunityId") DO UPDATE SET status='PENDING',"nextAttemptAt"='2000-01-01',"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"completedAt"=NULL`,[retry.id]);
    await db.query(`UPDATE "OrderIntentBrokerComparisonDelivery" SET status='CLAIMED',"leaseOwner"='dead-broker-worker',"leaseExpiresAt"=statement_timestamp()-interval '1 second' WHERE "opportunityId"=$1`,[retry.id]);
    const failed=await service.processOrderIntentBrokerComparisons({limit:1,workerId:'broker-retry',evaluator:(()=>{throw new Error('BROKER_COMPARE_FAILURE')}) as any});
    expect(failed.retrying).toBe(1); await db.query(`UPDATE "OrderIntentBrokerComparisonDelivery" SET "nextAttemptAt"=statement_timestamp() WHERE "opportunityId"=$1`,[retry.id]);
    const recovered=await service.processOrderIntentBrokerComparisons({limit:1,workerId:'broker-recovered'}); expect(recovered.completed).toBe(1);
    expect((await db.query(`SELECT outcome FROM "OrderIntentBrokerComparisonAttempt" WHERE "opportunityId"=$1 ORDER BY attempt`,[retry.id])).rows.map(row=>row.outcome)).toEqual(['TECHNICAL_FAILURE','INSUFFICIENT_EVIDENCE']);
  });

  it.each(['ALLOWED','BLOCKED'] as const)('records compare-only %s without changing broker authorization',async outcome=>{const exact=(await db.query(`SELECT * FROM "OrderIntentBrokerPostOpportunity" WHERE applicability='APPLICABLE_SUPERSEDED' AND "compositionCapture"='EXACT' ORDER BY id LIMIT 1`)).rows[0];const sequence=outcome==='ALLOWED'?4:5;const opportunity=(await db.query(`INSERT INTO "OrderIntentBrokerPostOpportunity" ("orderIntentId","intentCoverageId","tradingAccountId","accountSubscriptionId","enrollmentGenerationId","policyRevisionId","clientOrderId","opportunitySequence","idempotencyKey","marketRegimeAssessmentId","sourceSetFingerprint","compositionCapture",applicability,"comparisonMode","tradingEffect") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'EXACT','APPLICABLE_SUPERSEDED','COMPARE_ONLY','NONE') RETURNING *`,[exact.orderIntentId,exact.intentCoverageId,exact.tradingAccountId,exact.accountSubscriptionId,exact.enrollmentGenerationId,exact.policyRevisionId,exact.clientOrderId,sequence,`broker-outcome-${outcome}`,exact.marketRegimeAssessmentId,exact.sourceSetFingerprint])).rows[0];await db.query(`INSERT INTO "OrderIntentBrokerComparisonDelivery" ("opportunityId",status,"nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING','2000-01-01',now(),now())`,[opportunity.id]);const dimensions=[['TREND','TREND_V1'],['VOLATILITY','VOLATILITY_V1'],['BREADTH','BREADTH_V1'],['PARTICIPATION','PARTICIPATION_V1'],['INTRADAY_STRESS','INTRADAY_STRESS_V1']] as const;const evaluator=(()=>({outcome,reasonCode:`TEST_${outcome}`,gates:dimensions.map(([dimension,algorithmVersion],index)=>({dimension,algorithmVersion,requirement:'IGNORED' as const,outcome:index===0&&outcome==='BLOCKED'?'BLOCKED' as const:'IGNORED' as const,observedState:null,sourceHealth:'MISSING' as const,sourceAssessmentId:null,allowedStates:[],reasonCode:`TEST_${outcome}`,ordinal:index+1}))})) as any;const service=await import('../../services/order-intent-broker-comparison.service.js');const result=await service.processOrderIntentBrokerComparisons({limit:1,workerId:`outcome-${outcome}`,evaluator});expect(result.completed).toBe(1);expect((await db.query(`SELECT outcome,authority,"tradingEffect" FROM "OrderIntentBrokerComparisonAttempt" WHERE "opportunityId"=$1`,[opportunity.id])).rows[0]).toEqual({outcome,authority:'COMPARE_ONLY',tradingEffect:'NONE'});});
});
