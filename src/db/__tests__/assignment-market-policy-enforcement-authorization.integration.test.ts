import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const AUTHORIZATION_MIGRATION = '20261018130000_assignment_market_policy_enforcement_authorization';
const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

(enabled ? describe : describe.skip)('Assignment market-policy enforcement authorization PostgreSQL integrity', () => {
  const database = `enforcement_authorization_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, databaseUrl: string;
  let ownerId: number, otherOwnerId: number, transferHolderId: number, operatorId: number, disabledOwnerId: number, strategyId: number;
  let paperAccountId: number, secondAccountId: number, liveAccountId: number;
  let assignmentId: number, secondAssignmentId: number, liveAssignmentId: number;
  let revisionId: number, generationId: number, fingerprint: string, secondGenerationId: number, secondFingerprint: string;

  const service = () => import('../../services/assignment-market-policy-enforcement-authorization.service.js');
  const enrollment = () => import('../../services/assignment-market-policy-enrollment.service.js');
  const grantInput = (overrides: Record<string, unknown> = {}) => ({ generationId, expectedConfigurationFingerprint: fingerprint, expectedPolicyRevisionId: revisionId, reason: 'Owner authorizes PAPER enforcement', ...overrides });
  const count = async (sql: string, params: unknown[] = []) => (await db.query(`SELECT count(*)::int AS count FROM ${sql}`, params)).rows[0].count as number;
  const user = async (email: string, role: string, isEnabled = true) => (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ($1,$2,$3,now(),now()) RETURNING id`, [email, role, isEnabled])).rows[0].id as number;
  const account = async (name: string, environment: string, holder: number) => (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,$2,$3,'PAUSED',false,true,now(),now()) RETURNING id`, [holder, name, environment])).rows[0].id as number;
  const assign = async (accountId: number, subscriptionId: number) => (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [accountId, subscriptionId])).rows[0].id as number;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    expect(migrations).toContain(AUTHORIZATION_MIGRATION);
    // Replay everything before Phase 3C.1 so ACTIVE generations exist before the authorization migration.
    for (const migration of migrations.filter(name => name < AUTHORIZATION_MIGRATION)) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    ownerId = await user('owner@phase3c1.test', 'SYSTEM_OWNER');
    otherOwnerId = await user('other@phase3c1.test', 'SYSTEM_OWNER');
    operatorId = await user('operator@phase3c1.test', 'OPERATOR');
    disabledOwnerId = await user('disabled@phase3c1.test', 'SYSTEM_OWNER', false);
    transferHolderId = await user('transfer@phase3c1.test', 'ACCOUNT_USER');
    paperAccountId = await account('Paper', 'PAPER', ownerId);
    secondAccountId = await account('Second Paper', 'PAPER', otherOwnerId);
    liveAccountId = await account('Live', 'LIVE', ownerId);
    strategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('phase3c1','Phase 3C.1',true,now(),now()) RETURNING id`)).rows[0].id;
    const securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ('P3C','Phase 3C',true,'STOCK',now(),now()) RETURNING id`)).rows[0].id;
    const exitId = (await db.query(`INSERT INTO "ExitProfile" (key,name,"exitMode","takeProfitBehavior",enabled,"createdAt","updatedAt") VALUES ('phase3c1','Phase 3C.1','fixed','limit',true,now(),now()) RETURNING id`)).rows[0].id;
    const subscriptionId = (await db.query(`INSERT INTO "Subscription" (key,name,symbol,enabled,"strategyId","exitProfileId","securityId","createdAt","updatedAt") VALUES ('phase3c1','Phase 3C.1','P3C',true,$1,$2,$3,now(),now()) RETURNING id`, [strategyId, exitId, securityId])).rows[0].id;
    assignmentId = await assign(paperAccountId, subscriptionId);
    secondAssignmentId = await assign(secondAccountId, subscriptionId);
    liveAssignmentId = await assign(liveAccountId, subscriptionId);
    process.env.DATABASE_URL = databaseUrl;
    const policy = await import('../../services/strategy-market-policy.service.js');
    const created = await policy.createStrategyMarketPolicy(strategyId, ownerId, 'Phase 3C.1 fixture');
    const initial = created.revisions[0]!;
    const saved = await policy.saveStrategyMarketPolicyRevision(strategyId, initial.id, { expectedConfigurationFingerprint: initial.configurationFingerprint, rules: initial.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })) }, ownerId);
    revisionId = saved.id;
    await policy.activateStrategyMarketPolicyRevision(strategyId, revisionId, saved.configurationFingerprint, ownerId);
    const enroll = await enrollment();
    for (const [accountId, id] of [[paperAccountId, assignmentId], [secondAccountId, secondAssignmentId]] as const) {
      const prepared = await enroll.prepareAssignmentMarketPolicyEnrollment(accountId, id, ownerId);
      const active = await enroll.activateAssignmentMarketPolicyEnrollment(accountId, id, prepared.id, ownerId, prepared.configurationFingerprint);
      if (id === assignmentId) { generationId = active.id; fingerprint = active.configurationFingerprint; } else { secondGenerationId = active.id; secondFingerprint = active.configurationFingerprint; }
    }
    await db.query(await readFile(`prisma/migrations/${AUTHORIZATION_MIGRATION}/migration.sql`, 'utf8'));
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

  it('leaves pre-existing ACTIVE generations unauthorized after the migration', async () => {
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorization"`)).toBe(0);
    expect(await count(`"AssignmentMarketPolicyEnrollmentGeneration" WHERE status='ACTIVE' AND ("enforcementAuthorityVersion" IS NOT NULL OR "enforcementAuthorizedAt" IS NOT NULL)`)).toBe(0);
    await expect(db.query(`UPDATE "AssignmentMarketPolicyEnrollmentGeneration" SET "enforcementAuthorityVersion"='V1', "enforcementAuthorizedAt"=now() WHERE id=$1`, [generationId])).rejects.toThrow(/phase3a_no_enforcement|Illegal enrollment lifecycle/);
    const svc = await service();
    for (const id of [assignmentId, secondAssignmentId]) {
      expect(await svc.resolveAssignmentMarketPolicyEnforcementAuthority(id)).toMatchObject({ authorized: false, reasons: ['NOT_AUTHORIZED'] });
    }
    expect(await svc.getAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, 'SYSTEM_OWNER')).toMatchObject({ state: 'NOT_AUTHORIZED', effective: false, runtimeEnforcement: { active: false } });
  });

  it('previews without evaluator, decision, audit, authorization, or SystemEvent writes and ignores unfavorable market outcomes', async () => {
    await db.query(`INSERT INTO "StrategyMarketEligibilityDecision" ("strategyId","policyRevisionId","contextType","contextIdentity","evaluationVersion",outcome,"reasonCode","evaluatedAt","decisionFingerprint","strategyEnabled","evidenceJson","createdAt") VALUES ($1,$2,'TEST','insufficient','STRATEGY_MARKET_ELIGIBILITY_V1','INSUFFICIENT_EVIDENCE','NO_COMPOSITION',now(),'phase3c1-insufficient',true,'{}',now())`, [strategyId, revisionId]);
    const snapshot = async () => (await db.query(`SELECT (SELECT count(*) FROM "AssignmentMarketPolicyEnforcementAuthorization") a, (SELECT count(*) FROM "AssignmentMarketPolicyEnforcementAuthorizationEvent") e, (SELECT count(*) FROM "StrategyMarketEligibilityDecision") d, (SELECT count(*) FROM "SystemEvent") s, (SELECT count(*) FROM "AssignmentMarketPolicyEnrollmentTransition") t, (SELECT count(*) FROM "OrderIntent") o`)).rows[0];
    const before = await snapshot();
    const svc = await service();
    const preview = await svc.previewAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, generationId, 'SYSTEM_OWNER');
    expect(preview).toMatchObject({ eligibleToAuthorize: true, blockingReasons: [], configurationValidity: { valid: true }, currentMarketEligibility: { outcome: 'INSUFFICIENT_EVIDENCE', requiredForAuthorization: false }, identity: { configurationFingerprint: fingerprint, expectedConfigurationFingerprint: fingerprint, boundPolicyRevision: { id: revisionId } } });
    const operatorView = await svc.previewAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, generationId, 'OPERATOR');
    expect(operatorView!.viewerCanAuthorize).toBe(false);
    expect(operatorView!.identity).not.toHaveProperty('configurationFingerprint');
    const live = await svc.previewAssignmentMarketPolicyEnforcementAuthorization(liveAccountId, liveAssignmentId, null, 'SYSTEM_OWNER');
    expect(live!.blockingReasons.map(reason => reason.code)).toEqual(expect.arrayContaining(['ACCOUNT_NOT_PAPER', 'ENROLLMENT_GENERATION_REQUIRED']));
    expect(await snapshot()).toEqual(before);
  });

  it('rejects non-owner, disabled, missing, stale, and wrong-generation grants', async () => {
    const svc = await service();
    for (const actor of [operatorId, disabledOwnerId, 999_999]) await expect(svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput(), actor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput({ expectedConfigurationFingerprint: 'f'.repeat(64) }), ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'STALE_CONFIGURATION' } });
    await expect(svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput({ expectedPolicyRevisionId: revisionId + 1000 }), ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'STALE_POLICY_REVISION' } });
    await expect(svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput({ generationId: secondGenerationId }), ownerId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.grantAssignmentMarketPolicyEnforcementAuthorization(liveAccountId, liveAssignmentId, grantInput(), ownerId)).rejects.toMatchObject({ statusCode: 404 });
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorization"`)).toBe(0);
  });

  it('converges concurrent and duplicate grants to exactly one effective authorization', async () => {
    const svc = await service();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput(), ownerId)));
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ statusCode: 409 });
    await expect(svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput(), ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'AUTHORIZATION_ALREADY_EFFECTIVE' } });
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorization" WHERE status='AUTHORIZED'`)).toBe(1);
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorizationEvent" WHERE action='GRANT'`)).toBe(1);
    expect(await count(`"SystemEvent" WHERE type='MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_GRANTED'`)).toBe(1);
    const granted = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect(granted).toMatchObject({ status: 'AUTHORIZED', authorizationSequence: 1, environment: 'PAPER', authorityVersion: 'PAPER_MARKET_POLICY_ENFORCEMENT_V1', tradingAccountId: paperAccountId, accountSubscriptionId: assignmentId, strategyId, policyRevisionId: revisionId, enrollmentGenerationId: generationId, configurationFingerprint: fingerprint, accountHolderUserId: ownerId, authorizedBy: { id: ownerId } });
    expect(await svc.resolveAssignmentMarketPolicyEnforcementAuthority(assignmentId)).toMatchObject({ authorized: true, reasons: [], authorization: { id: granted.id } });
    // An authorization for one assignment never applies to another assignment of the same Strategy and Security.
    expect(await svc.resolveAssignmentMarketPolicyEnforcementAuthority(secondAssignmentId)).toMatchObject({ authorized: false });
    expect(await svc.getAssignmentMarketPolicyEnforcementAuthorization(secondAccountId, secondAssignmentId, 'SYSTEM_OWNER')).toMatchObject({ state: 'NOT_AUTHORIZED' });
    expect(await svc.getAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, 'ACCOUNT_USER')).toMatchObject({ state: 'AUTHORIZED', effective: true, authorization: { id: granted.id } });
    expect((await svc.getAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, 'ACCOUNT_USER'))!.authorization).not.toHaveProperty('authorizedBy');
  });

  it('enforces PostgreSQL integrity independently of the service', async () => {
    const row = (await db.query(`SELECT * FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE status='AUTHORIZED'`)).rows[0];
    const insert = (overrides: Record<string, unknown>) => {
      const values = { ...row, authorizationSequence: 2, authorizationFingerprint: 'c'.repeat(64), ...overrides };
      return db.query(`INSERT INTO "AssignmentMarketPolicyEnforcementAuthorization" ("enrollmentId","enrollmentGenerationId","authorizationSequence","authorityVersion",status,environment,"tradingAccountId","accountSubscriptionId","strategyId","policyRevisionId","accountHolderUserId","configurationFingerprint","authorizationFingerprint","authorizedByUserId","grantReason") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [values.enrollmentId, values.enrollmentGenerationId, values.authorizationSequence, values.authorityVersion, values.status, values.environment, values.tradingAccountId, values.accountSubscriptionId, values.strategyId, values.policyRevisionId, values.accountHolderUserId, values.configurationFingerprint, values.authorizationFingerprint, values.authorizedByUserId, 'direct sql']);
    };
    await expect(insert({})).rejects.toThrow(/one_authorized|duplicate key/);
    await expect(insert({ enrollmentGenerationId: secondGenerationId })).rejects.toThrow(/exact enrollment generation/);
    await expect(insert({ enrollmentGenerationId: secondGenerationId, enrollmentId: (await db.query(`SELECT "enrollmentId" FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id=$1`, [secondGenerationId])).rows[0].enrollmentId, tradingAccountId: secondAccountId, accountSubscriptionId: secondAssignmentId, configurationFingerprint: secondFingerprint, accountHolderUserId: otherOwnerId, authorizationSequence: 1, authorizedByUserId: operatorId })).rejects.toThrow(/enabled SYSTEM_OWNER/);
    await expect(insert({ environment: 'LIVE' })).rejects.toThrow(/paper_only|PAPER-only/);
    await expect(insert({ authorityVersion: 'V2' })).rejects.toThrow(/version_check/);
    await expect(insert({ status: 'REVOKED' })).rejects.toThrow(/lifecycle_check|inserted as AUTHORIZED/);
    await expect(db.query(`UPDATE "AssignmentMarketPolicyEnforcementAuthorization" SET "grantReason"='rewrite' WHERE id=$1`, [row.id])).rejects.toThrow(/Illegal|immutable/);
    await expect(db.query(`UPDATE "AssignmentMarketPolicyEnforcementAuthorization" SET status='REVOKED',"revokedByUserId"=$2,"revokedAt"=now(),"revocationReason"='x',"policyRevisionId"="policyRevisionId"+1 WHERE id=$1`, [row.id, ownerId])).rejects.toThrow(/immutable/);
    await expect(db.query(`UPDATE "AssignmentMarketPolicyEnforcementAuthorization" SET status='REVOKED',"revokedByUserId"=$2,"revokedAt"=now(),"revocationReason"='x' WHERE id=$1`, [row.id, operatorId])).rejects.toThrow(/enabled SYSTEM_OWNER/);
    await expect(db.query(`DELETE FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [row.id])).rejects.toThrow(/append-preserving/);
    await expect(db.query(`UPDATE "AssignmentMarketPolicyEnforcementAuthorizationEvent" SET reason='rewrite' WHERE "authorizationId"=$1`, [row.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`DELETE FROM "AssignmentMarketPolicyEnforcementAuthorizationEvent" WHERE "authorizationId"=$1`, [row.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`INSERT INTO "AssignmentMarketPolicyEnforcementAuthorizationEvent" ("authorizationId",sequence,action,"fromStatus","toStatus","actorUserId",reason,"authorityVersion","enrollmentGenerationId","tradingAccountId","accountSubscriptionId","strategyId","policyRevisionId","accountHolderUserId","configurationFingerprint","authorizationFingerprint") VALUES ($1,2,'REVOKE','AUTHORIZED','REVOKED',$2,'forged',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [row.id, ownerId, row.authorityVersion, row.enrollmentGenerationId, row.tradingAccountId, row.accountSubscriptionId, row.strategyId, row.policyRevisionId, row.accountHolderUserId, row.configurationFingerprint, row.authorizationFingerprint])).rejects.toThrow(/mirror the exact authorization/);
    await expect(db.query(`UPDATE "TradingAccount" SET environment='LIVE' WHERE id=$1`, [paperAccountId])).rejects.toThrow(/PAPER|requires disabling/);
    expect((await db.query(`SELECT environment FROM "TradingAccount" WHERE id=$1`, [paperAccountId])).rows[0].environment).toBe('PAPER');
  });

  it('keeps actual trading behavior and compare-only coverage identical for authorized and unauthorized assignments', async () => {
    await db.query(`UPDATE "OrderIntentMarketPolicyCaptureRollout" SET enabled=true WHERE id=1`);
    const intents = [];
    for (const [accountId, id, key] of [[paperAccountId, assignmentId, 'authorized'], [secondAccountId, secondAssignmentId, 'unauthorized']] as const) {
      intents.push((await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",qty,"clientOrderId",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","createdAt","updatedAt") VALUES ('phase3c1-test','P3C','buy','market','day',1,$1,'received','{}',$2,$3,now(),now()) RETURNING *`, [`phase3c1-${key}`, accountId, id])).rows[0]);
    }
    const coverage = (await db.query(`SELECT "orderIntentId",provenance,"comparisonMode","tradingEffect","compositionCapture" FROM "OrderIntentMarketPolicyCoverage" WHERE "orderIntentId" = ANY($1) ORDER BY "orderIntentId"`, [intents.map(intent => intent.id)])).rows;
    expect(intents.map(intent => [intent.status, intent.blockReason])).toEqual([['received', null], ['received', null]]);
    expect(coverage.map(({ orderIntentId: _id, ...rest }) => rest)).toEqual([
      { provenance: 'ACTIVE_EXACT', comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE', compositionCapture: 'NONE_VISIBLE' },
      { provenance: 'ACTIVE_EXACT', comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE', compositionCapture: 'NONE_VISIBLE' },
    ]);
    // Only authorization/enrollment/account/policy tables carry triggers that read authorization rows.
    const triggerTables = (await db.query(`SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE p.prosrc LIKE '%EnforcementAuthorization%' ORDER BY 1`)).rows.map(row => row.relname);
    expect(triggerTables).toEqual(['AssignmentMarketPolicyEnforcementAuthorization', 'AssignmentMarketPolicyEnforcementAuthorizationEvent', 'AssignmentMarketPolicyEnrollmentGeneration', 'StrategyMarketPolicyRevision', 'TradingAccount', 'TradingAccountSubscription']);
    expect(await count(`"OrderIntentMarketPolicyCoverage" WHERE "comparisonMode"<>'COMPARE_ONLY' OR "tradingEffect"<>'NONE'`)).toBe(0);
  });

  it('invalidates on account-holder change and never silently restores authority', async () => {
    const svc = await service();
    await db.query(`UPDATE "TradingAccount" SET "accountHolderUserId"=$1 WHERE id=$2`, [transferHolderId, paperAccountId]);
    const invalidated = (await db.query(`SELECT status,"invalidationReasonCode" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId"=$1 ORDER BY id DESC LIMIT 1`, [assignmentId])).rows[0];
    expect(invalidated).toEqual({ status: 'INVALIDATED', invalidationReasonCode: 'ACCOUNT_HOLDER_CHANGED' });
    expect(await svc.resolveAssignmentMarketPolicyEnforcementAuthority(assignmentId)).toMatchObject({ authorized: false });
    await expect(svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput(), ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'ACCOUNT_OWNERSHIP_CHANGED' } });
    await db.query(`UPDATE "TradingAccount" SET "accountHolderUserId"=$1 WHERE id=$2`, [ownerId, paperAccountId]);
    expect(await svc.getAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, 'SYSTEM_OWNER')).toMatchObject({ state: 'INVALIDATED', effective: false });
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorizationEvent" WHERE action='INVALIDATE'`)).toBe(1);
  });

  it('reauthorizes only by a new explicit grant and revokes deterministically', async () => {
    const svc = await service();
    const second = await svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput({ reason: 'Reauthorize after ownership restored' }), ownerId);
    expect(second).toMatchObject({ status: 'AUTHORIZED', authorizationSequence: 2 });
    await expect(svc.revokeAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, { authorizationId: second!.id, reason: 'x' }, operatorId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.revokeAssignmentMarketPolicyEnforcementAuthorization(secondAccountId, secondAssignmentId, { authorizationId: second!.id, reason: 'wrong assignment' }, ownerId)).rejects.toMatchObject({ statusCode: 404 });
    const revoked = await svc.revokeAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, { authorizationId: second!.id, reason: 'Pause enforcement eligibility' }, ownerId);
    expect(revoked).toMatchObject({ status: 'REVOKED', revocationReason: 'Pause enforcement eligibility', revokedBy: { id: ownerId } });
    expect(await svc.resolveAssignmentMarketPolicyEnforcementAuthority(assignmentId)).toMatchObject({ authorized: false, reasons: ['NOT_AUTHORIZED'] });
    const eventsBefore = await count(`"AssignmentMarketPolicyEnforcementAuthorizationEvent"`);
    await expect(svc.revokeAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, { authorizationId: second!.id, reason: 'again' }, ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'AUTHORIZATION_ALREADY_REVOKED' } });
    const firstId = (await db.query(`SELECT id FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId"=$1 AND "authorizationSequence"=1`, [assignmentId])).rows[0].id;
    await expect(svc.revokeAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, { authorizationId: firstId, reason: 'invalidated' }, ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'AUTHORIZATION_ALREADY_INVALIDATED' } });
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorizationEvent"`)).toBe(eventsBefore);
    const third = await svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput({ reason: 'Explicit reauthorization' }), ownerId);
    expect(third).toMatchObject({ authorizationSequence: 3 });
    expect(new Set([firstId, second!.id, third!.id]).size).toBe(3);
    const history = await svc.listAssignmentMarketPolicyEnforcementAuthorizationHistory(paperAccountId, assignmentId);
    expect(history!.authorizations.map(item => [item.authorizationSequence, item.status, item.events.map(event => event.action)])).toEqual([[3, 'AUTHORIZED', ['GRANT']], [2, 'REVOKED', ['GRANT', 'REVOKE']], [1, 'INVALIDATED', ['GRANT', 'INVALIDATE']]]);
    expect(new Set(history!.authorizations.map(item => item.authorizationFingerprint)).size).toBe(3);
  });

  it('invalidates on enrollment disable while retaining history', async () => {
    const svc = await service();
    const enroll = await enrollment();
    await enroll.disableAssignmentMarketPolicyEnrollment(paperAccountId, assignmentId, generationId, ownerId, 'Disable authorized enrollment');
    const latest = (await db.query(`SELECT status,"invalidationReasonCode","invalidatedByUserId" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId"=$1 ORDER BY id DESC LIMIT 1`, [assignmentId])).rows[0];
    expect(latest).toEqual({ status: 'INVALIDATED', invalidationReasonCode: 'ENROLLMENT_DISABLED', invalidatedByUserId: ownerId });
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId"=$1`, [assignmentId])).toBe(3);
    await expect(svc.grantAssignmentMarketPolicyEnforcementAuthorization(paperAccountId, assignmentId, grantInput(), ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'ENROLLMENT_NOT_ACTIVE' } });
    expect(await svc.resolveAssignmentMarketPolicyEnforcementAuthority(assignmentId)).toMatchObject({ authorized: false });
  });

  it('invalidates when the bound policy revision is superseded and refuses to inherit authority', async () => {
    const svc = await service();
    await svc.grantAssignmentMarketPolicyEnforcementAuthorization(secondAccountId, secondAssignmentId, { generationId: secondGenerationId, expectedConfigurationFingerprint: secondFingerprint, expectedPolicyRevisionId: revisionId, reason: 'Second assignment grant' }, ownerId);
    const policy = await import('../../services/strategy-market-policy.service.js');
    const next = await policy.prepareStrategyMarketPolicyRevision(strategyId, ownerId, 'Supersede');
    await policy.activateStrategyMarketPolicyRevision(strategyId, next.id, next.configurationFingerprint, ownerId);
    expect((await db.query(`SELECT status,"invalidationReasonCode" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId"=$1`, [secondAssignmentId])).rows).toEqual([{ status: 'INVALIDATED', invalidationReasonCode: 'POLICY_REVISION_SUPERSEDED' }]);
    await expect(svc.grantAssignmentMarketPolicyEnforcementAuthorization(secondAccountId, secondAssignmentId, { generationId: secondGenerationId, expectedConfigurationFingerprint: secondFingerprint, expectedPolicyRevisionId: revisionId, reason: 'Retry' }, ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'POLICY_REVISION_SUPERSEDED' } });
    expect(await count(`"AssignmentMarketPolicyEnforcementAuthorization" WHERE status='AUTHORIZED'`)).toBe(0);
  });
});
