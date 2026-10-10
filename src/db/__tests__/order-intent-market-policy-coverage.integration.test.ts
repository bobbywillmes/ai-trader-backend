import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

(enabled ? describe : describe.skip)('OrderIntent market-policy coverage PostgreSQL integrity', () => {
  const database = `order_intent_policy_coverage_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, databaseUrl: string;
  let ownerId: number, paperAccountId: number, liveAccountId: number, strategyId: number;
  let paperAssignmentId: number, liveAssignmentId: number, subscriptionId: number;
  let enrollmentGenerationId: number, boundRevisionId: number, replacementRevisionId: number;

  async function connection() {
    const result = new Client({ connectionString: databaseUrl });
    await result.connect();
    return result;
  }

  async function insertIntent(args: { assignmentId?: number; accountId?: number; clientOrderId: string; createdAt?: Date }) {
    return (await db.query(`
      INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",qty,"clientOrderId",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","createdAt","updatedAt")
      VALUES ('phase3b1-test','P3B','buy','market','day',1,$1,'received','{}',$2,$3,COALESCE($4,now()),now()) RETURNING *
    `, [args.clientOrderId, args.accountId ?? paperAccountId, args.assignmentId ?? paperAssignmentId, args.createdAt ?? null])).rows[0];
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = await connection();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    ownerId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('owner@phase3b1.test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id;
    paperAccountId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,'Paper','PAPER','PAUSED',false,true,now(),now()) RETURNING id`, [ownerId])).rows[0].id;
    liveAccountId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,'Live','LIVE','PAUSED',false,true,now(),now()) RETURNING id`, [ownerId])).rows[0].id;
    strategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('phase3b1','Phase 3B.1',true,now(),now()) RETURNING id`)).rows[0].id;
    const securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ('P3B','Phase 3B.1',true,'STOCK',now(),now()) RETURNING id`)).rows[0].id;
    const exitId = (await db.query(`INSERT INTO "ExitProfile" (key,name,"exitMode","takeProfitBehavior",enabled,"createdAt","updatedAt") VALUES ('phase3b1','Phase 3B.1','fixed','limit',true,now(),now()) RETURNING id`)).rows[0].id;
    subscriptionId = (await db.query(`INSERT INTO "Subscription" (key,name,symbol,enabled,"strategyId","exitProfileId","securityId","createdAt","updatedAt") VALUES ('phase3b1','Phase 3B.1','P3B',true,$1,$2,$3,now(),now()) RETURNING id`, [strategyId, exitId, securityId])).rows[0].id;
    paperAssignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [paperAccountId, subscriptionId])).rows[0].id;
    liveAssignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [liveAccountId, subscriptionId])).rows[0].id;
    process.env.DATABASE_URL = databaseUrl;
    const policy = await import('../../services/strategy-market-policy.service.js');
    const created = await policy.createStrategyMarketPolicy(strategyId, ownerId, 'Phase 3B.1 fixture');
    const initial = created.revisions[0]!;
    const saved = await policy.saveStrategyMarketPolicyRevision(strategyId, initial.id, { expectedConfigurationFingerprint: initial.configurationFingerprint, rules: initial.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })) }, ownerId);
    boundRevisionId = saved.id;
    await policy.activateStrategyMarketPolicyRevision(strategyId, boundRevisionId, saved.configurationFingerprint, ownerId);
    const enrollment = await import('../../services/assignment-market-policy-enrollment.service.js');
    const prepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(paperAccountId, paperAssignmentId, ownerId);
    const active = await enrollment.activateAssignmentMarketPolicyEnrollment(paperAccountId, paperAssignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
    enrollmentGenerationId = active.id;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  it('replays migrations without schema drift', () => {
    const output = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000 });
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
    expect(coverage).toMatchObject({ tradingAccountId: paperAccountId, accountSubscriptionId: paperAssignmentId, enrollmentGenerationId, boundPolicyRevisionId: boundRevisionId, activePolicyRevisionId: boundRevisionId, provenance: 'ACTIVE_EXACT', comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE' });
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

  it('enforces immutability and permanent compare-only/no-effect constraints', async () => {
    const row = (await db.query(`SELECT id FROM "OrderIntentMarketPolicyCoverage" ORDER BY id LIMIT 1`)).rows[0];
    await expect(db.query(`UPDATE "OrderIntentMarketPolicyCoverage" SET "tradingEffect"='BLOCK' WHERE id=$1`, [row.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM "OrderIntentMarketPolicyCoverage" WHERE id=$1`, [row.id])).rejects.toThrow(/immutable/);
  });
});
