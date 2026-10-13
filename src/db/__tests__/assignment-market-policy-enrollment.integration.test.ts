import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Assignment market-policy enrollment PostgreSQL integrity', () => {
  const database = `assignment_enrollment_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, databaseUrl: string;
  let ownerId: number, otherOwnerId: number, accountId: number, liveAccountId: number, strategyId: number, assignmentId: number, revisionId: number;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    ownerId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('owner@phase3a.test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id;
    otherOwnerId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('other@phase3a.test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id;
    const operatorId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('operator@phase3a.test','OPERATOR',true,now(),now()) RETURNING id`)).rows[0].id;
    accountId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,'Paper','PAPER','PAUSED',false,true,now(),now()) RETURNING id`, [ownerId])).rows[0].id;
    liveAccountId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,'Live','LIVE','PAUSED',false,true,now(),now()) RETURNING id`, [ownerId])).rows[0].id;
    strategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('phase3a-disabled','Phase 3A Disabled',false,now(),now()) RETURNING id`)).rows[0].id;
    const securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ('P3A','Phase 3A',true,'STOCK',now(),now()) RETURNING id`)).rows[0].id;
    const exitId = (await db.query(`INSERT INTO "ExitProfile" (key,name,"exitMode","takeProfitBehavior",enabled,"createdAt","updatedAt") VALUES ('phase3a','Phase 3A','fixed','limit',true,now(),now()) RETURNING id`)).rows[0].id;
    const subscriptionId = (await db.query(`INSERT INTO "Subscription" (key,name,symbol,enabled,"strategyId","exitProfileId","securityId","createdAt","updatedAt") VALUES ('phase3a','Phase 3A','P3A',true,$1,$2,$3,now(),now()) RETURNING id`, [strategyId, exitId, securityId])).rows[0].id;
    assignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,false,false,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [accountId, subscriptionId])).rows[0].id;
    process.env.DATABASE_URL = databaseUrl;
    const policy = await import('../../services/strategy-market-policy.service.js');
    const created = await policy.createStrategyMarketPolicy(strategyId, ownerId, 'Phase 3A fixture');
    const initial = created.revisions[0]!;
    const saved = await policy.saveStrategyMarketPolicyRevision(strategyId, initial.id, { expectedConfigurationFingerprint: initial.configurationFingerprint, rules: initial.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' : 'IGNORED', allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })) }, ownerId);
    revisionId = saved.id;
    await policy.activateStrategyMarketPolicyRevision(strategyId, revisionId, saved.configurationFingerprint, ownerId);
    expect(operatorId).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  it('replays migrations without schema drift', () => {
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000 });
    expect(result.stdout, result.stderr).toContain('No difference detected');
  }, 70_000);

  it('enforces owner authorization, serial generation identity, and permits disabled operational posture', async () => {
    const service = await import('../../services/assignment-market-policy-enrollment.service.js');
    await expect(service.prepareAssignmentMarketPolicyEnrollment(accountId, assignmentId, otherOwnerId + 1)).rejects.toThrow(/SYSTEM_OWNER/);
    const concurrent = await Promise.allSettled([service.prepareAssignmentMarketPolicyEnrollment(accountId, assignmentId, ownerId), service.prepareAssignmentMarketPolicyEnrollment(accountId, assignmentId, ownerId)]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const prepared = concurrent.find(result => result.status === 'fulfilled')!;
    if (prepared.status !== 'fulfilled') throw new Error('Expected one prepared generation.');
    expect(prepared.value).toMatchObject({ generation: 1, status: 'PREPARED', authority: 'CONFIGURATION_ONLY', enforcementEnabled: false });
    const preview = await service.previewAssignmentMarketPolicyEnrollment(accountId, assignmentId);
    expect(preview).toMatchObject({ readyToActivate: true, operationalPosture: { strategyEnabled: false, assignmentEnabled: false, entriesEnabled: false } });
  });

  it('keeps INSUFFICIENT_EVIDENCE informational during activation', async () => {
    const service = await import('../../services/assignment-market-policy-enrollment.service.js');
    const prepared = (await service.getAssignmentMarketPolicyEnrollment(accountId, assignmentId))!.enrollment!.generations[0]!;
    await db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","policyRevisionId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","decisionFingerprint","strategyEnabled","evidenceJson","createdAt") VALUES ($1,$2,'TEST','insufficient','STRATEGY_MARKET_ELIGIBILITY_V1','INSUFFICIENT_EVIDENCE','NO_COMPOSITION',now(),'phase3a-insufficient-1',false,'{}',now())`, [strategyId, revisionId]);
    expect((await service.previewAssignmentMarketPolicyEnrollment(accountId, assignmentId))!.currentMarketEligibility.outcome).toBe('INSUFFICIENT_EVIDENCE');
    const active = await service.activateAssignmentMarketPolicyEnrollment(accountId, assignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
    expect(active.status).toBe('ACTIVE');
    await service.disableAssignmentMarketPolicyEnrollment(accountId, assignmentId, active.id, ownerId, 'Re-enroll test');
    const second = await service.prepareAssignmentMarketPolicyEnrollment(accountId, assignmentId, ownerId);
    await db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","policyRevisionId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","decisionFingerprint","strategyEnabled","evidenceJson","createdAt") VALUES ($1,$2,'TEST','insufficient-2','STRATEGY_MARKET_ELIGIBILITY_V1','INSUFFICIENT_EVIDENCE','NO_COMPOSITION',now() + interval '1 second','phase3a-insufficient-2',false,'{}',now())`, [strategyId, revisionId]);
    expect((await service.previewAssignmentMarketPolicyEnrollment(accountId, assignmentId))!.currentMarketEligibility.outcome).toBe('INSUFFICIENT_EVIDENCE');
    await expect(service.activateAssignmentMarketPolicyEnrollment(accountId, assignmentId, second.id, ownerId, second.configurationFingerprint)).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('invalidates readiness on policy or ownership changes and preserves immutable history', async () => {
    const service = await import('../../services/assignment-market-policy-enrollment.service.js');
    await db.query(`UPDATE "TradingAccount" SET "accountHolderUserId"=$1 WHERE id=$2`, [otherOwnerId, accountId]);
    expect((await service.previewAssignmentMarketPolicyEnrollment(accountId, assignmentId))!).toMatchObject({ ownershipValid: false, configurationValid: false });
    const transition = (await db.query(`SELECT id FROM "AssignmentMarketPolicyEnrollmentTransition" ORDER BY id LIMIT 1`)).rows[0];
    await expect(db.query(`UPDATE "AssignmentMarketPolicyEnrollmentTransition" SET reason='rewrite' WHERE id=$1`, [transition.id])).rejects.toThrow(/immutable/);
    const active = (await db.query(`SELECT id FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE status='ACTIVE' ORDER BY generation DESC LIMIT 1`)).rows[0];
    await service.disableAssignmentMarketPolicyEnrollment(accountId, assignmentId, active.id, ownerId, 'Ownership changed');
    expect((await db.query(`SELECT count(*)::int count FROM "AssignmentMarketPolicyEnrollmentTransition"`)).rows[0].count).toBe(6);
  });

  it('rejects LIVE/direct-SQL enrollment and PAPER-to-LIVE transitions', async () => {
    const enrollmentId = (await db.query(`SELECT id FROM "AssignmentMarketPolicyEnrollment" WHERE "accountSubscriptionId"=$1`, [assignmentId])).rows[0].id;
    await expect(db.query(`INSERT INTO "AssignmentMarketPolicyEnrollmentGeneration" ("enrollmentId",generation,status,"tradingAccountId","accountSubscriptionId","strategyId","policyRevisionId","accountHolderUserId","configurationFingerprint","preparedByUserId","preparedAt","createdAt") VALUES ($1,99,'PREPARED',$2,$3,$4,$5,$6,'bad',$6,now(),now())`, [enrollmentId, liveAccountId, assignmentId, strategyId, revisionId, ownerId])).rejects.toThrow(/identity|PAPER/);
    await db.query(`UPDATE "TradingAccount" SET "accountHolderUserId"=$1 WHERE id=$2`, [ownerId, accountId]);
    const service = await import('../../services/assignment-market-policy-enrollment.service.js');
    await service.prepareAssignmentMarketPolicyEnrollment(accountId, assignmentId, ownerId);
    await expect(db.query(`UPDATE "TradingAccount" SET environment='LIVE' WHERE id=$1`, [accountId])).rejects.toThrow(/requires disabling/);
  });

  it('keeps preview reads free of enrollment, decision, audit, and SystemEvent writes', async () => {
    const service = await import('../../services/assignment-market-policy-enrollment.service.js');
    const before = (await db.query(`SELECT (SELECT count(*) FROM "AssignmentMarketPolicyEnrollmentTransition") transitions, (SELECT count(*) FROM "StrategyMarketEligibilityDecision") decisions, (SELECT count(*) FROM "SystemEvent") events`)).rows[0];
    await service.previewAssignmentMarketPolicyEnrollment(accountId, assignmentId);
    const after = (await db.query(`SELECT (SELECT count(*) FROM "AssignmentMarketPolicyEnrollmentTransition") transitions, (SELECT count(*) FROM "StrategyMarketEligibilityDecision") decisions, (SELECT count(*) FROM "SystemEvent") events`)).rows[0];
    expect(after).toEqual(before);
  });
});
