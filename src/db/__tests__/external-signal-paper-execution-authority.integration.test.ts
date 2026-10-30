import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const admissionHarness = vi.hoisted(() => ({ riskAllowed: true }));
vi.mock('../../services/assignment-entry-evaluation.service.js', () => ({
  evaluateAssignmentEntry: vi.fn(async ({ input }: { input: { tradingAccountSubscriptionId: number } }) => {
    const { prisma } = await import('../prisma.js');
    const assignment = await prisma.tradingAccountSubscription.findUniqueOrThrow({ where: { id: input.tradingAccountSubscriptionId }, include: { subscription: true } });
    return {
      input: { tradingAccountId: assignment.tradingAccountId, tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId,
        subscriptionKey: assignment.subscription.key, symbol: assignment.subscription.symbol, side: 'buy', orderType: 'market', timeInForce: 'day', extendedHours: false, signalType: 'entry', qty: 1 },
      sizing: { tradingAccountSubscriptionId: assignment.id, qty: 1, estimatedNotional: 100, snapshot: {} },
      risk: admissionHarness.riskAllowed ? { allowed: true, statusCode: 200, reason: 'allowed', details: {} }
        : { allowed: false, statusCode: 409, reason: 'test risk refusal', details: { rule: 'test' } },
      blockers: [], outcomeCode: admissionHarness.riskAllowed ? 'ENTRY_ELIGIBLE' : 'ENTRY_RISK_BLOCKED',
    };
  }),
}));

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

(enabled ? describe : describe.skip)('External signal PAPER execution authority foundation', () => {
  const database = `external_exec_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, databaseUrl: string;
  let ownerId: number, paperId: number, liveId: number, assignmentId: number, liveAssignmentId: number;
  let sourceId: number, bindingId: number, revisionId: number, strategyId: number, securityId: number, subscriptionId: number;
  let executeGenerationId: number, authorizationId: number;
  let prospectiveCycleId: number;
  let provenance: { cycleId: number; signalId: number; routeId: number; accountCycleId: number; intentId: number; obligationId: number; clientOrderId: string };

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    db = new Client({ connectionString: databaseUrl }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    ownerId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('exec-owner@test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id;
    strategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('exec','Exec',true,now(),now()) RETURNING id`)).rows[0].id;
    securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ('EXE','Exec',true,'STOCK',now(),now()) RETURNING id`)).rows[0].id;
    const exitId = (await db.query(`INSERT INTO "ExitProfile" (key,name,"exitMode","takeProfitBehavior",enabled,"createdAt","updatedAt") VALUES ('exec','Exec','fixed','limit',true,now(),now()) RETURNING id`)).rows[0].id;
    subscriptionId = (await db.query(`INSERT INTO "Subscription" (key,name,symbol,enabled,"strategyId","exitProfileId","securityId","createdAt","updatedAt") VALUES ('exec','Exec','EXE',true,$1,$2,$3,now(),now()) RETURNING id`, [strategyId, exitId, securityId])).rows[0].id;
    paperId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,'Paper','PAPER','PAUSED',false,true,now(),now()) RETURNING id`, [ownerId])).rows[0].id;
    liveId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","createdAt","updatedAt") VALUES ($1,'Live','LIVE','PAUSED',false,true,now(),now()) RETURNING id`, [ownerId])).rows[0].id;
    assignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [paperId, subscriptionId])).rows[0].id;
    liveAssignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [liveId, subscriptionId])).rows[0].id;
    sourceId = (await db.query(`INSERT INTO "ExternalSignalSource" (name,provider,enabled,"authMethod","webhookKeyHash","createdAt","updatedAt") VALUES ('TV','TRADINGVIEW',true,'URL_TOKEN',$1,now(),now()) RETURNING id`, ['a'.repeat(64)])).rows[0].id;
    bindingId = (await db.query(`INSERT INTO "StrategySignalBinding" ("signalSourceId","strategyId","externalStrategyKey",enabled,"createdAt","updatedAt") VALUES ($1,$2,'exec',true,now(),now()) RETURNING id`, [sourceId, strategyId])).rows[0].id;
    revisionId = (await db.query(`INSERT INTO "StrategySignalRevision" ("strategySignalBindingId",revision,status,"authorityMode","createdAt","activatedAt") VALUES ($1,1,'ACTIVE','TRADE_ELIGIBLE',now(),now()) RETURNING id`, [bindingId])).rows[0].id;
    await db.query(`INSERT INTO "ExternalSignalExecutionRolloutGeneration" (direction,generation,enabled,"authorityMode","configurationJson","configurationFingerprint","effectiveAt") VALUES ('ENTRY',1,true,'SHADOW','{}',$1,now())`, ['b'.repeat(64)]);
    process.env.DATABASE_URL = databaseUrl;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = await import('../prisma.js'); await prisma.$disconnect();
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  async function createAdmissionFixture(label: string) {
    const cycleRef = `${label}:${randomUUID()}`;
    const cycleId = (await db.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"createdAt","updatedAt") VALUES ($1,$2,1,$3,$4,'ENTRY_RECEIVED',now(),now()) RETURNING id`, [bindingId, revisionId, securityId, cycleRef])).rows[0].id;
    await db.query('BEGIN');
    const signalId = (await db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","createdAt") VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,$9,'ENTRY_LONG','EXE','15m',now(),$10,now()) RETURNING id`, [sourceId, bindingId, strategyId, securityId, `entry:${randomUUID()}`, cycleRef, randomUUID(), revisionId, cycleId, 'a'.repeat(64)])).rows[0].id;
    await db.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING',0,now(),now(),now())`, [signalId]);
    await db.query('COMMIT');
    await db.query('BEGIN');
    const runId = (await db.query(`INSERT INTO "SignalRoutingRun" ("signalId","authorityMode",status,"startedAt","completedAt","routeCount","createdAt") VALUES ($1,'TRADE_ELIGIBLE','COMPLETED',now(),now(),1,now()) RETURNING id`, [signalId])).rows[0].id;
    const routeId = (await db.query(`INSERT INTO "SignalRoute" ("signalRoutingRunId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","targetSnapshot","createdAt") VALUES ($1,$2,$3,$4,'{}',now()) RETURNING id`, [runId, paperId, assignmentId, subscriptionId])).rows[0].id;
    await db.query('COMMIT');
    const accountCycleId = (await db.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'ENTRY_ROUTE_PENDING',now(),now()) RETURNING id`, [cycleId, routeId, paperId, assignmentId, subscriptionId, securityId])).rows[0].id;
    return { cycleId, cycleRef, signalId, routeId, accountCycleId };
  }

  async function insertExit(client: Client, fixture: Awaited<ReturnType<typeof createAdmissionFixture>>) {
    const signalId = (await client.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","createdAt") VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,$9,'EXIT_LONG','EXE','15m',now(),$10,now()) RETURNING id`, [sourceId, bindingId, strategyId, securityId, `exit:${randomUUID()}`, fixture.cycleRef, randomUUID(), revisionId, fixture.cycleId, 'b'.repeat(64)])).rows[0].id;
    await client.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING',0,now(),now(),now())`, [signalId]);
    return signalId;
  }

  async function insertUncorrelatedEntry(label: string) {
    const cycleRef = `${label}:${randomUUID()}`;
    const cycleId = (await db.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"createdAt","updatedAt") VALUES ($1,$2,1,$3,$4,'ENTRY_RECEIVED',now(),now()) RETURNING id`, [bindingId, revisionId, securityId, cycleRef])).rows[0].id;
    await db.query('BEGIN');
    const signalId = (await db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","createdAt") VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,$9,'ENTRY_LONG','EXE','15m',now(),$10,now()) RETURNING id`, [sourceId, bindingId, strategyId, securityId, `entry:${randomUUID()}`, cycleRef, randomUUID(), revisionId, cycleId, randomUUID().replaceAll('-', '').repeat(2)])).rows[0].id;
    await db.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING',0,now(),now(),now())`, [signalId]);
    await db.query('COMMIT');
    return { cycleId, signalId };
  }

  async function insertIntentAndObligation(client: Client, fixture: Awaited<ReturnType<typeof createAdmissionFixture>>, label: string) {
    const clientOrderId = `${label}-${randomUUID()}`;
    const intentId = (await client.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview','EXE','buy','market','day','received',$5,'{}',$1,$2,$3,$4,now(),now()) RETURNING id`, [paperId, assignmentId, subscriptionId, fixture.accountCycleId, clientOrderId])).rows[0].id;
    await client.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"acquiredAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'ENTRY_PENDING',now(),now(),now())`, [paperId, securityId, intentId, `tv-test:${fixture.accountCycleId}:${randomUUID()}`]);
    await client.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_EXECUTION_PROSPECTIVE',"entryRolloutGenerationId"=$2 WHERE id=$1`, [fixture.accountCycleId, executeGenerationId]);
    await client.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_INTENT_CREATED',"entryOrderIntentId"=$2 WHERE id=$1`, [fixture.accountCycleId, intentId]);
    return client.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, [intentId, fixture.accountCycleId, fixture.cycleId, fixture.signalId, fixture.routeId, authorizationId, executeGenerationId, '0'.repeat(64), clientOrderId]);
  }

  it('is default-off and SHADOW evidence cannot authorize execution', async () => {
    expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalExecutionRolloutActivation"`)).rows[0].n).toBe(0);
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionAuthorization" ("rolloutGenerationId","authorizationSequence",status,"tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId","signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","accountHolderUserId","assignmentFingerprint","sourceFingerprint","authorizationFingerprint","authorizedByUserId","grantReason") SELECT id,1,'AUTHORIZED',$1,$2,$3,$4,$5,$6,$7,1,$8,$9,$9,$9,$8,'forged shadow' FROM "ExternalSignalExecutionRolloutGeneration" WHERE "authorityMode"='SHADOW'`, [paperId, assignmentId, subscriptionId, securityId, sourceId, bindingId, revisionId, ownerId, '0'.repeat(64)])).rejects.toThrow(/rollout is not active/);
  });

  it('upgrades the accepted 4A.2A schema through 4A.2B without Prisma drift', () => {
    const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('No difference detected');
  }, 70_000);

  it('requires explicit activation and serializes rollout transitions', async () => {
    const svc = await import('../../services/external-signal-execution-authority.service.js');
    const generation = await svc.createExternalSignalExecuteGeneration({ configuration: { schemaVersion: 999, authority: 'LIVE', custom: true }, reason: 'Create isolated PAPER entry epoch' }, ownerId);
    executeGenerationId = generation.id;
    expect(generation.configurationJson).toMatchObject({ schemaVersion: 1, authority: 'PAPER_ENTRY', custom: true });
    expect((await svc.listExternalSignalExecutionRollouts()).activeExecutionGenerationId).toBeNull();
    const results = await Promise.allSettled([
      svc.changeExternalSignalExecutionRollout(generation.id, 'ACTIVATE', 'Activate exact PAPER entry epoch', ownerId),
      svc.changeExternalSignalExecutionRollout(generation.id, 'ACTIVATE', 'Concurrent duplicate activation', ownerId),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await svc.listExternalSignalExecutionRollouts()).activeExecutionGenerationId).toBe(generation.id);
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('ai_trader.external_signal_rollout_transition','1',true)`);
      await expect(db.query(`UPDATE "ExternalSignalExecutionRolloutState" SET version=version+1,"updatedAt"=statement_timestamp() WHERE id=1`)).rejects.toThrow(/database-owned/);
      await db.query('ROLLBACK');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  });

  it('rejects LIVE direct SQL and grants only the exact PAPER identity', async () => {
    const svc = await import('../../services/external-signal-execution-authority.service.js');
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionAuthorization" ("rolloutGenerationId","authorizationSequence",status,"tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId","signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","accountHolderUserId","assignmentFingerprint","sourceFingerprint","authorizationFingerprint","authorizedByUserId","grantReason") VALUES ($1,1,'AUTHORIZED',$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$10,$10,$9,'forged live')`, [executeGenerationId, liveId, liveAssignmentId, subscriptionId, securityId, sourceId, bindingId, revisionId, ownerId, '0'.repeat(64)])).rejects.toThrow(/PAPER-only/);
    const authorization = await svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, expectedStrategySignalRevisionId: revisionId, expectedSecurityId: securityId, reason: 'Authorize exact PAPER assignment identity' }, ownerId);
    authorizationId = authorization.id;
    expect(authorization).toMatchObject({ status: 'AUTHORIZED', tradingAccountId: paperId, tradingAccountSubscriptionId: assignmentId, strategySignalRevisionId: revisionId });
    expect(authorization.assignmentFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects stale revision/Security approval and cross-Strategy binding authority', async () => {
    const svc = await import('../../services/external-signal-execution-authority.service.js');
    await expect(svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, expectedStrategySignalRevisionId: revisionId + 999, expectedSecurityId: securityId, reason: 'Hostile stale revision approval' }, ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'STALE_STRATEGY_REVISION' } });
    await expect(svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, expectedStrategySignalRevisionId: revisionId, expectedSecurityId: securityId + 999, reason: 'Hostile stale Security approval' }, ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'STALE_SECURITY_IDENTITY' } });
    const otherStrategy = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ($1,'Other',true,now(),now()) RETURNING id`, [`other-${randomUUID()}`])).rows[0].id;
    const otherBinding = (await db.query(`INSERT INTO "StrategySignalBinding" ("signalSourceId","strategyId","externalStrategyKey",enabled,"createdAt","updatedAt") VALUES ($1,$2,$3,true,now(),now()) RETURNING id`, [sourceId, otherStrategy, `other-${randomUUID()}`])).rows[0].id;
    const otherRevision = (await db.query(`INSERT INTO "StrategySignalRevision" ("strategySignalBindingId",revision,status,"authorityMode","createdAt","activatedAt") VALUES ($1,1,'ACTIVE','TRADE_ELIGIBLE',now(),now()) RETURNING id`, [otherBinding])).rows[0].id;
    await expect(svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: otherBinding, expectedStrategySignalRevisionId: otherRevision, expectedSecurityId: securityId, reason: 'Hostile cross-Strategy binding approval' }, ownerId)).rejects.toMatchObject({ statusCode: 409, details: { code: 'AUTHORIZATION_REJECTED' } });
  });

  it('revocation is terminal and reauthorization establishes a later boundary', async () => {
    const svc = await import('../../services/external-signal-execution-authority.service.js');
    const revoked = await svc.revokeExternalSignalEntryExecutionAuthorization(paperId, assignmentId, authorizationId, 'Revoke before any admission exists', ownerId);
    expect(revoked.status).toBe('REVOKED');
    await expect(db.query(`UPDATE "ExternalSignalEntryExecutionAuthorization" SET status='AUTHORIZED' WHERE id=$1`, [authorizationId])).rejects.toThrow(/invalid authorization transition/);
    const later = await svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, expectedStrategySignalRevisionId: revisionId, expectedSecurityId: securityId, reason: 'Reauthorize only future accepted signals' }, ownerId);
    expect(later.authorizationSequence).toBe(2);
    authorizationId = later.id;
  });

  it('serializes concurrent grant and deactivation without deadlock or surviving stale authority', async () => {
    const svc = await import('../../services/external-signal-execution-authority.service.js');
    await svc.revokeExternalSignalEntryExecutionAuthorization(paperId, assignmentId, authorizationId, 'Prepare controlled concurrency probe', ownerId);
    const operations = Promise.allSettled([
      svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, expectedStrategySignalRevisionId: revisionId, expectedSecurityId: securityId, reason: 'Concurrent grant probe after exact reload' }, ownerId),
      svc.changeExternalSignalExecutionRollout(executeGenerationId, 'DEACTIVATE', 'Concurrent deactivation probe', ownerId),
    ]);
    const results = await Promise.race([operations, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('P7 deadlock timeout')), 5_000))]);
    expect(results).toHaveLength(2);
    if ((await db.query(`SELECT "activeRolloutGenerationId" FROM "ExternalSignalExecutionRolloutState" WHERE id=1`)).rows[0].activeRolloutGenerationId !== null) {
      await svc.changeExternalSignalExecutionRollout(executeGenerationId, 'DEACTIVATE', 'Complete deactivation after serialized race', ownerId);
    }
    expect((await db.query(`SELECT "activeRolloutGenerationId" FROM "ExternalSignalExecutionRolloutState" WHERE id=1`)).rows[0].activeRolloutGenerationId).toBeNull();
    expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalEntryExecutionAuthorization" WHERE status='AUTHORIZED'`)).rows[0].n).toBe(0);
    await svc.changeExternalSignalExecutionRollout(executeGenerationId, 'ACTIVATE', 'Reactivate after concurrency probe', ownerId);
    const restored = await svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, expectedStrategySignalRevisionId: revisionId, expectedSecurityId: securityId, reason: 'Restore authority after concurrency probe' }, ownerId);
    authorizationId = restored.id;
  });

  it('creates prospective EXECUTE correlation independently of the latest SHADOW generation enablement', async () => {
    const { processExternalSignalCorrelationWork } = await import('../../services/external-signal-correlation.service.js');
    const { prisma } = await import('../prisma.js');
    const first = await insertUncorrelatedEntry('execute-with-shadow-enabled');
    prospectiveCycleId = first.cycleId;
    expect(await processExternalSignalCorrelationWork({ db: prisma, limit: 1 })).toMatchObject({ completed: 1, failed: 0 });
    expect((await db.query(`SELECT ac.status::text,g."authorityMode"::text AS authority FROM "ExternalSignalTradeCycleAccount" ac JOIN "ExternalSignalExecutionRolloutGeneration" g ON g.id=ac."entryRolloutGenerationId" WHERE ac."externalSignalTradeCycleId"=$1`, [first.cycleId])).rows[0])
      .toEqual({ status: 'ENTRY_EXECUTION_PROSPECTIVE', authority: 'EXECUTE' });
    expect((await db.query(`SELECT "authorityMode"::text AS authority,"decisionType"::text AS type FROM "ExternalSignalCorrelationDecision" WHERE "signalId"=$1 AND "decisionType"='ENTRY_EXECUTION_PROSPECTIVE'`, [first.signalId])).rows[0])
      .toEqual({ authority: 'EXECUTE', type: 'ENTRY_EXECUTION_PROSPECTIVE' });

    await db.query(`INSERT INTO "ExternalSignalExecutionRolloutGeneration" (direction,generation,enabled,"authorityMode","supersedesGenerationId","configurationJson","configurationFingerprint","effectiveAt")
      SELECT 'ENTRY',g.generation+1,false,'SHADOW',g.id,'{}',$1,now() FROM "ExternalSignalExecutionRolloutGeneration" g WHERE g.direction='ENTRY' ORDER BY g.generation DESC LIMIT 1`, [randomUUID().replaceAll('-', '').repeat(2)]);
    const second = await insertUncorrelatedEntry('execute-with-shadow-disabled');
    expect(await processExternalSignalCorrelationWork({ db: prisma, limit: 1 })).toMatchObject({ completed: 1, failed: 0 });
    expect((await db.query(`SELECT ac.status::text,g."authorityMode"::text AS authority FROM "ExternalSignalTradeCycleAccount" ac JOIN "ExternalSignalExecutionRolloutGeneration" g ON g.id=ac."entryRolloutGenerationId" WHERE ac."externalSignalTradeCycleId"=$1`, [second.cycleId])).rows[0])
      .toEqual({ status: 'ENTRY_EXECUTION_PROSPECTIVE', authority: 'EXECUTE' });
  });

  it('runs the real coordinator through enforced admission and freezes every obligation without broker progress', async () => {
    const policy = await import('../../services/strategy-market-policy.service.js');
    const enrollment = await import('../../services/assignment-market-policy-enrollment.service.js');
    const enforcement = await import('../../services/assignment-market-policy-enforcement-authorization.service.js');
    const rollout = await import('../../services/market-policy-enforcement-rollout.service.js');
    const created = await policy.createStrategyMarketPolicy(strategyId, ownerId, 'TradingView admission acceptance');
    const draft = created.revisions[0]!;
    const saved = await policy.saveStrategyMarketPolicyRevision(strategyId, draft.id, {
      expectedConfigurationFingerprint: draft.configurationFingerprint,
      rules: draft.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion,
        requirement: rule.dimension === 'TREND' ? 'REQUIRED' as const : 'IGNORED' as const,
        allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })),
    }, ownerId);
    await policy.activateStrategyMarketPolicyRevision(strategyId, saved.id, saved.configurationFingerprint, ownerId);
    const prepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(paperId, assignmentId, ownerId);
    const generation = await enrollment.activateAssignmentMarketPolicyEnrollment(paperId, assignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
    await enforcement.grantAssignmentMarketPolicyEnforcementAuthorization(paperId, assignmentId, {
      generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint,
      expectedPolicyRevisionId: generation.policyRevisionId, reason: 'Authorize isolated TradingView acceptance',
    }, ownerId);
    await rollout.setMarketPolicyEnforcementRuntimeRollout(true, { expectedVersion: 0, reason: 'Isolated TradingView acceptance' }, ownerId);
    await db.query(`UPDATE "TradingAccount" SET status='ACTIVE',"tradingEnabled"=true,"killSwitchEnabled"=false WHERE id=$1`, [paperId]);

    const observedAt = new Date();
    const validUntil = new Date(observedAt.getTime() + 3_600_000);
    const dimensions = [['TREND','TREND_V1','UP'],['VOLATILITY','VOLATILITY_V1','NORMAL'],['BREADTH','BREADTH_V1','MIXED'],['PARTICIPATION','PARTICIPATION_V1','NORMAL'],['INTRADAY_STRESS','INTRADAY_STRESS_V1','NORMAL']] as const;
    const sources: Array<{ dimension: string; version: string; state: string; id: number }> = [];
    for (const [dimension, version, state] of dimensions) {
      const row = await db.query(`INSERT INTO "MarketRegimeDimensionAssessment" (dimension,"algorithmVersion","evidenceSchemaVersion","targetAt","sessionDate",attempt,status,"rawState","effectiveState","dataThroughAt","validUntil","startedAt","completedAt","evidenceJson") VALUES ($1,$2,1,$3,DATE '2026-10-28',1,'VALID',$4,$4,$3,$5,$3,$3,'{}') RETURNING id`, [dimension, version, observedAt, state, validUntil]);
      sources.push({ dimension, version, state, id: row.rows[0].id });
    }
    await db.query('BEGIN');
    const compositionId = (await db.query(`INSERT INTO "MarketRegimeAssessment" ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","dataThroughAt","validUntil","publicationStatus","evidenceHealth","sourceSetFingerprint","startedAt","completedAt","evidenceJson") VALUES ('MARKET_REGIME_COMPOSITION_V1',1,$1,$1,$1,$2,'SUCCEEDED','COMPLETE',$3,$1,$1,'{}') RETURNING id`, [observedAt, validUntil, randomUUID().replaceAll('-', '').repeat(2)])).rows[0].id;
    for (const [ordinal, source] of sources.entries()) await db.query(`INSERT INTO "MarketRegimeAssessmentSource" ("marketRegimeAssessmentId",dimension,"requiredAlgorithmVersion","expectedTargetAt","sourceAssessmentId","sourceEvidenceSchemaVersion","sourceAttempt","sourceStatus","sourceTargetAt","sourceCompletedAt","sourceDataThroughAt","sourceValidUntil","sourceRawState","sourceEffectiveState",health,"reasonCode",ordinal,"evidenceJson") VALUES ($1,$2,$3,$4,$5,1,1,'VALID',$4,$4,$4,$6,$7,$7,'AVAILABLE',NULL,$8,'{}')`, [compositionId, source.dimension, source.version, observedAt, source.id, validUntil, source.state, ordinal + 1]);
    await db.query('COMMIT');

    admissionHarness.riskAllowed = true;
    const { processProspectiveTradingViewEntries } = await import('../../services/external-signal-entry-admission.service.js');
    const result = await processProspectiveTradingViewEntries({ db: (await import('../prisma.js')).prisma, limit: 10 });
    expect(result.admitted).toBeGreaterThanOrEqual(1);
    const admitted = (await db.query(`SELECT ac.id,ac.status::text,ac."entryOrderIntentId" FROM "ExternalSignalTradeCycleAccount" ac WHERE ac."externalSignalTradeCycleId"=$1`, [prospectiveCycleId])).rows[0];
    expect(admitted.status).toBe('ENTRY_INTENT_CREATED');
    const intent = (await db.query(`SELECT id,status,"externalSignalAccountCycleId" FROM "OrderIntent" WHERE id=$1`, [admitted.entryOrderIntentId])).rows[0];
    expect(intent).toMatchObject({ status: 'pending', externalSignalAccountCycleId: admitted.id });
    expect((await db.query(`SELECT count(*)::int n FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [intent.id])).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalEntryExecutionObligation" WHERE "orderIntentId"=$1`, [intent.id])).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=$1`, [intent.id])).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM "BrokerOrder" WHERE "orderIntentId"=$1`, [intent.id])).rows[0].n).toBe(0);
    await expect(db.query(`UPDATE "OrderIntent" SET status='submitting' WHERE id=$1`, [intent.id])).rejects.toThrow(/dispatch is quarantined/);
    await db.query(`UPDATE "OrderIntent" SET status='blocked',"blockReason"='ACCEPTANCE_FIXTURE_COMPLETE' WHERE id=$1`, [intent.id]);
    const claimId = (await db.query(`SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [intent.id])).rows[0].id;
    await db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'NOT_SENT_EVIDENCE_RECORDED',$2)`, [claimId, JSON.stringify({ classification: 'NOT_SENT_PRE_DISPATCH', producer: 'TRADINGVIEW_ACCEPTANCE_FIXTURE' })]);
    await (await import('../../services/entry-exposure-claim.service.js')).releaseUnsubmittedEntryExposureClaim({ orderIntentId: intent.id, reason: 'TRADINGVIEW_ACCEPTANCE_FIXTURE_COMPLETE' });
    const recovery = await import('../../services/external-signal-entry-recovery.service.js');
    expect(await recovery.reconcileReleasedTradingViewAdmissionCyclesForAccount(paperId)).toMatchObject({ terminalized: 1, retained: 0 });
    expect(await recovery.reconcileReleasedTradingViewAdmissionCyclesForAccount(paperId)).toMatchObject({ terminalized: 0, retained: 0 });
    expect((await db.query(`SELECT status::text,"noExposureProof"::text FROM "ExternalSignalTradeCycleAccount" WHERE id=$1`, [admitted.id])).rows[0])
      .toEqual({ status: 'TERMINAL_NO_EXPOSURE', noExposureProof: 'INTENT_DEFINITELY_NOT_SENT_AND_CLAIM_RELEASED' });

    const expiringEntry = await insertUncorrelatedEntry('execute-expires-under-lock');
    expect(await (await import('../../services/external-signal-correlation.service.js')).processExternalSignalCorrelationWork({ db: (await import('../prisma.js')).prisma, limit: 1 }))
      .toMatchObject({ completed: 1, failed: 0 });
    const lock = new Client({ connectionString: databaseUrl }); await lock.connect();
    await lock.query('BEGIN');
    await lock.query(`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`);
    const expiresWhileWaiting = processProspectiveTradingViewEntries({ db: (await import('../prisma.js')).prisma, limit: 10, now: new Date(), maxAgeMs: 150 });
    await new Promise(resolve => setTimeout(resolve, 250));
    await lock.query('COMMIT'); await lock.end();
    expect(await expiresWhileWaiting).toMatchObject({ admitted: 0, refused: 1 });
    expect((await db.query(`SELECT ac.status::text,ac."entryOrderIntentId" FROM "ExternalSignalTradeCycleAccount" ac WHERE ac."externalSignalTradeCycleId"=$1`, [expiringEntry.cycleId])).rows[0])
      .toEqual({ status: 'BLOCKED', entryOrderIntentId: null });

    const rejectedEntry = await insertUncorrelatedEntry('execute-risk-refusal');
    expect(await (await import('../../services/external-signal-correlation.service.js')).processExternalSignalCorrelationWork({ db: (await import('../prisma.js')).prisma, limit: 1 }))
      .toMatchObject({ completed: 1, failed: 0 });
    admissionHarness.riskAllowed = false;
    const rejectedResult = await processProspectiveTradingViewEntries({ db: (await import('../prisma.js')).prisma, limit: 10 });
    expect(rejectedResult.refused).toBeGreaterThanOrEqual(1);
    const rejectedCycle = (await db.query(`SELECT ac.status::text,ac."noExposureProof"::text,oi.status AS intent_status,c."releasedAt" FROM "ExternalSignalTradeCycleAccount" ac LEFT JOIN "OrderIntent" oi ON oi.id=ac."entryOrderIntentId" LEFT JOIN "EntryExposureClaim" c ON c."orderIntentId"=oi.id WHERE ac."externalSignalTradeCycleId"=$1`, [rejectedEntry.cycleId])).rows[0];
    expect(rejectedCycle).toMatchObject({ status: 'TERMINAL_NO_EXPOSURE', noExposureProof: 'INTENT_DEFINITELY_NOT_SENT_AND_CLAIM_RELEASED', intent_status: 'blocked' });
    expect(rejectedCycle.releasedAt).not.toBeNull();
    admissionHarness.riskAllowed = true;
    await rollout.setMarketPolicyEnforcementRuntimeRollout(false, { expectedVersion: 1, reason: 'Complete isolated TradingView acceptance' }, ownerId);
  }, 30_000);

  it('fails a stale SERIALIZABLE obligation after READ COMMITTED deactivation', async () => {
    const stale = new Client({ connectionString: databaseUrl }); await stale.connect();
    const svc = await import('../../services/external-signal-execution-authority.service.js');
    try {
      await stale.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await stale.query(`SELECT * FROM "ExternalSignalExecutionRolloutState" WHERE id=1`);
      const cycleId = (await stale.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"createdAt","updatedAt") VALUES ($1,$2,1,$3,$4,'ENTRY_RECEIVED',now(),now()) RETURNING id`, [bindingId, revisionId, securityId, `stale:${randomUUID()}`])).rows[0].id;
      const cycleRef = (await stale.query(`SELECT "externalTradeCycleRef" FROM "ExternalSignalTradeCycle" WHERE id=$1`, [cycleId])).rows[0].externalTradeCycleRef;
      const signalId = (await stale.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","createdAt") VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,$9,'ENTRY_LONG','EXE','15m',now(),$10,now()) RETURNING id`, [sourceId, bindingId, strategyId, securityId, `stale-event:${randomUUID()}`, cycleRef, randomUUID(), revisionId, cycleId, 'e'.repeat(64)])).rows[0].id;
      await stale.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING',0,now(),now(),now())`, [signalId]);
      const runId = (await stale.query(`INSERT INTO "SignalRoutingRun" ("signalId","authorityMode",status,"startedAt","completedAt","routeCount","createdAt") VALUES ($1,'TRADE_ELIGIBLE','COMPLETED',now(),now(),1,now()) RETURNING id`, [signalId])).rows[0].id;
      const routeId = (await stale.query(`INSERT INTO "SignalRoute" ("signalRoutingRunId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","targetSnapshot","createdAt") VALUES ($1,$2,$3,$4,'{}',now()) RETURNING id`, [runId, paperId, assignmentId, subscriptionId])).rows[0].id;
      const accountCycleId = (await stale.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'ENTRY_ROUTE_PENDING',now(),now()) RETURNING id`, [cycleId, routeId, paperId, assignmentId, subscriptionId, securityId])).rows[0].id;
      const clientOrderId = `stale-${randomUUID()}`;
      const intentId = (await stale.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview','EXE','buy','market','day','received',$5,'{}',$1,$2,$3,$4,now(),now()) RETURNING id`, [paperId, assignmentId, subscriptionId, accountCycleId, clientOrderId])).rows[0].id;
      await stale.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"acquiredAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'ENTRY_PENDING',now(),now(),now())`, [paperId, securityId, intentId, `stale:${randomUUID()}`]);
      await svc.changeExternalSignalExecutionRollout(executeGenerationId, 'DEACTIVATE', 'READ COMMITTED P8 deactivation', ownerId);
      await stale.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_EXECUTION_PROSPECTIVE',"entryRolloutGenerationId"=$2 WHERE id=$1`, [accountCycleId, executeGenerationId]);
      await stale.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_INTENT_CREATED',"entryOrderIntentId"=$2 WHERE id=$1`, [accountCycleId, intentId]);
      await expect(stale.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, [intentId, accountCycleId, cycleId, signalId, routeId, authorizationId, executeGenerationId, '0'.repeat(64), clientOrderId])).rejects.toThrow(/serializ|40001|currently active/i);
      await stale.query('ROLLBACK');
    } finally { await stale.end(); }
    expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalEntryExecutionAuthorization" WHERE status='AUTHORIZED'`)).rows[0].n).toBe(0);
    await svc.changeExternalSignalExecutionRollout(executeGenerationId, 'ACTIVATE', 'Reactivate after P8 stale-snapshot probe', ownerId);
    const restored = await svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, expectedStrategySignalRevisionId: revisionId, expectedSecurityId: securityId, reason: 'Restore authority after P8 probe' }, ownerId);
    authorizationId = restored.id;
  });

  it('fails a stale SERIALIZABLE obligation when concurrent accepted EXIT touches the source cycle', async () => {
    const fixture = await createAdmissionFixture('serializable-exit-race');
    const stale = new Client({ connectionString: databaseUrl });
    const ingress = new Client({ connectionString: databaseUrl });
    await stale.connect(); await ingress.connect();
    try {
      await stale.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await stale.query(`SELECT c.id,(SELECT count(*) FROM "Signal" s WHERE s."externalSignalTradeCycleId"=c.id AND s.event='EXIT_LONG') AS exits FROM "ExternalSignalTradeCycle" c WHERE c.id=$1`, [fixture.cycleId]);
      const before = (await ingress.query(`SELECT xmin::text,"updatedAt" FROM "ExternalSignalTradeCycle" WHERE id=$1`, [fixture.cycleId])).rows[0];
      await ingress.query('BEGIN'); await insertExit(ingress, fixture); await ingress.query('COMMIT');
      const after = (await ingress.query(`SELECT xmin::text,"updatedAt" FROM "ExternalSignalTradeCycle" WHERE id=$1`, [fixture.cycleId])).rows[0];
      expect(after.xmin).not.toBe(before.xmin);
      await expect(insertIntentAndObligation(stale, fixture, 'serializable-exit')).rejects.toThrow(/serializ|40001/i);
      await stale.query('ROLLBACK');
    } finally { await stale.end(); await ingress.end(); }
  });

  it('observes a concurrent accepted EXIT at READ COMMITTED obligation admission', async () => {
    const fixture = await createAdmissionFixture('read-committed-exit-race');
    const admission = new Client({ connectionString: databaseUrl });
    const ingress = new Client({ connectionString: databaseUrl });
    await admission.connect(); await ingress.connect();
    try {
      await admission.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      expect((await admission.query(`SELECT count(*)::int n FROM "Signal" WHERE "externalSignalTradeCycleId"=$1 AND event='EXIT_LONG'`, [fixture.cycleId])).rows[0].n).toBe(0);
      await ingress.query('BEGIN'); await insertExit(ingress, fixture); await ingress.query('COMMIT');
      await expect(insertIntentAndObligation(admission, fixture, 'read-committed-exit')).rejects.toThrow(/accepted EXIT preempts/);
      await admission.query('ROLLBACK');
    } finally { await admission.end(); await ingress.end(); }
  });

  it('atomically requires and then freezes exact executable provenance', async () => {
    const cycleId = (await db.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"createdAt","updatedAt") VALUES ($1,$2,1,$3,$4,'ENTRY_RECEIVED',now(),now()) RETURNING id`, [bindingId, revisionId, securityId, `exec:${randomUUID()}`])).rows[0].id;
    const cycleRef = (await db.query(`SELECT "externalTradeCycleRef" FROM "ExternalSignalTradeCycle" WHERE id=$1`, [cycleId])).rows[0].externalTradeCycleRef;
    await db.query('BEGIN');
    const signalId = (await db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","createdAt") VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,$9,'ENTRY_LONG','EXE','15m',now(),$10,now()) RETURNING id`, [sourceId, bindingId, strategyId, securityId, `event:${randomUUID()}`, cycleRef, randomUUID(), revisionId, cycleId, 'c'.repeat(64)])).rows[0].id;
    await db.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING',0,now(),now(),now())`, [signalId]);
    await db.query('COMMIT');
    await db.query('BEGIN');
    const runId = (await db.query(`INSERT INTO "SignalRoutingRun" ("signalId","authorityMode",status,"startedAt","completedAt","routeCount","createdAt") VALUES ($1,'TRADE_ELIGIBLE','COMPLETED',now(),now(),1,now()) RETURNING id`, [signalId])).rows[0].id;
    const routeId = (await db.query(`INSERT INTO "SignalRoute" ("signalRoutingRunId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","targetSnapshot","createdAt") VALUES ($1,$2,$3,$4,'{}',now()) RETURNING id`, [runId, paperId, assignmentId, subscriptionId])).rows[0].id;
    await db.query('COMMIT');
    const accountCycleId = (await db.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'ENTRY_ROUTE_PENDING',now(),now()) RETURNING id`, [cycleId, routeId, paperId, assignmentId, subscriptionId, securityId])).rows[0].id;
    await db.query('BEGIN');
    try {
      const clientOrderId = `tv-${randomUUID()}`;
      const intentId = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview','EXE','buy','market','day','received',$5,'{}',$1,$2,$3,$4,now(),now()) RETURNING id`, [paperId, assignmentId, subscriptionId, accountCycleId, clientOrderId])).rows[0].id;
      await db.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"acquiredAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'ENTRY_PENDING',now(),now(),now())`, [paperId, securityId, intentId, `atomic:${randomUUID()}`]);
      await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_EXECUTION_PROSPECTIVE',"entryRolloutGenerationId"=$2 WHERE id=$1`, [accountCycleId, executeGenerationId]);
      await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_INTENT_CREATED',"entryOrderIntentId"=$2 WHERE id=$1`, [accountCycleId, intentId]);
      const obligationId = (await db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9) RETURNING id`, [intentId, accountCycleId, cycleId, signalId, routeId, authorizationId, executeGenerationId, '0'.repeat(64), clientOrderId])).rows[0].id;
      await db.query('COMMIT');
      provenance = { cycleId, signalId, routeId, accountCycleId, intentId, obligationId, clientOrderId };
      await expect(db.query(`UPDATE "ExternalSignalEntryExecutionObligation" SET "entrySignalId"=$2 WHERE id=$1`, [obligationId, signalId])).rejects.toThrow(/immutable/);
      await expect(db.query(`DELETE FROM "ExternalSignalEntryExecutionObligation" WHERE id=$1`, [obligationId])).rejects.toThrow(/immutable/);
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  });

  it('preserves the immutable OrderIntent and claim when a real accepted EXIT moves the linked cycle to EXIT_PENDING', async () => {
    await db.query(`UPDATE "ExternalSignalCorrelationWork" SET status='COMPLETED',"completedAt"=now(),"leaseOwner"=NULL,"leaseExpiresAt"=NULL WHERE status<>'COMPLETED'`);
    const fixture = { cycleId: provenance.cycleId, cycleRef: (await db.query(`SELECT "externalTradeCycleRef" FROM "ExternalSignalTradeCycle" WHERE id=$1`, [provenance.cycleId])).rows[0].externalTradeCycleRef,
      signalId: provenance.signalId, routeId: provenance.routeId, accountCycleId: provenance.accountCycleId };
    await db.query('BEGIN');
    const exitId = await insertExit(db, fixture);
    await db.query('COMMIT');
    const { processExternalSignalCorrelationWork } = await import('../../services/external-signal-correlation.service.js');
    const result = await processExternalSignalCorrelationWork({ db: (await import('../prisma.js')).prisma, limit: 1 });
    const work = (await db.query(`SELECT status::text,"lastErrorCode" FROM "ExternalSignalCorrelationWork" WHERE "signalId"=$1`, [exitId])).rows[0];
    expect(result, JSON.stringify(work)).toMatchObject({ completed: 1, failed: 0 });
    expect((await db.query(`SELECT status::text,"entryOrderIntentId","pendingExitAcceptedAt" IS NOT NULL AS accepted FROM "ExternalSignalTradeCycleAccount" WHERE id=$1`, [provenance.accountCycleId])).rows[0])
      .toEqual({ status: 'EXIT_PENDING', entryOrderIntentId: provenance.intentId, accepted: true });
    expect((await db.query(`SELECT status,"releasedAt" FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [provenance.intentId])).rows[0])
      .toMatchObject({ status: 'ENTRY_PENDING', releasedAt: null });
    expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalCorrelationDecision" WHERE "signalId"=$1 AND "decisionType"='EXIT_PENDING'`, [exitId])).rows[0].n).toBe(1);
  });

  it('rejects hostile committed lifecycle graphs and fabricated broker progress', async () => {
    const fixture = await createAdmissionFixture('hostile-graph');
    await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_EXECUTION_PROSPECTIVE',"entryRolloutGenerationId"=$2 WHERE id=$1`, [fixture.accountCycleId, executeGenerationId]);
    await expect(db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_INTENT_CREATED' WHERE id=$1`, [fixture.accountCycleId]))
      .rejects.toThrow(/requires an exact OrderIntent graph/);
    const ordinary = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","createdAt","updatedAt") VALUES ('api','EXE','buy','market','day','received',$1,'{}',$2,$3,$4,now(),now()) RETURNING id`, [`ordinary-${randomUUID()}`, paperId, assignmentId, subscriptionId])).rows[0].id;
    await expect(db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_INTENT_CREATED',"entryOrderIntentId"=$2 WHERE id=$1`, [fixture.accountCycleId, ordinary]))
      .rejects.toThrow(/entry intent graph is incomplete or inconsistent/);
    await expect(db.query(`UPDATE "OrderIntent" SET status='submitted' WHERE id=$1`, [provenance.intentId])).rejects.toThrow(/dispatch is quarantined/);
  });

  it('rejects NULL and mismatched origin markers and makes the marker write-once', async () => {
    const legacyIntent = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","createdAt","updatedAt") VALUES ('legacy','EXE','buy','market','day','received','legacy-null','{}',$1,$2,$3,now(),now()) RETURNING id`, [paperId, assignmentId, subscriptionId])).rows[0].id;
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,'legacy-null')`, [legacyIntent, provenance.accountCycleId, provenance.cycleId, provenance.signalId, provenance.routeId, authorizationId, executeGenerationId, '0'.repeat(64)])).rejects.toThrow(/marked OrderIntent identity mismatch/);
    await expect(db.query(`UPDATE "OrderIntent" SET "externalSignalAccountCycleId"=$2 WHERE id=$1`, [legacyIntent, provenance.accountCycleId])).rejects.toThrow(/insert-only and immutable/);
    await expect(db.query(`UPDATE "OrderIntent" SET "externalSignalAccountCycleId"=NULL WHERE id=$1`, [provenance.intentId])).rejects.toThrow(/insert-only and immutable/);
    await expect(db.query(`UPDATE "OrderIntent" SET "externalSignalAccountCycleId"=$2 WHERE id=$1`, [provenance.intentId, provenance.accountCycleId + 999])).rejects.toThrow(/insert-only and immutable/);
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, [provenance.intentId, provenance.accountCycleId + 999, provenance.cycleId, provenance.signalId, provenance.routeId, authorizationId, executeGenerationId, '0'.repeat(64), provenance.clientOrderId])).rejects.toThrow(/marked OrderIntent identity mismatch/);
  });

  it('rejects cross-cycle Signal, route, authorization, and client-order obligation identities', async () => {
    const base: unknown[] = [provenance.intentId, provenance.accountCycleId, provenance.cycleId, provenance.signalId, provenance.routeId, authorizationId, executeGenerationId, '0'.repeat(64), provenance.clientOrderId];
    for (const [index, value] of [[2, provenance.cycleId + 999], [3, provenance.signalId + 999], [4, provenance.routeId + 999], [5, authorizationId + 999]] as const) {
      const values = [...base]; values[index] = value;
      await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, values)).rejects.toThrow(/identity mismatch/);
    }
    const clientValues = [...base]; clientValues[8] = 'wrong-client-order-id';
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, clientValues)).rejects.toThrow(/OrderIntent initial execution identity is invalid/);
  });

  it('quarantines marked dispatch while preserving ordinary lifecycle failure updates', async () => {
    await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [provenance.intentId]);
    await expect(db.query(`UPDATE "OrderIntent" SET status='submitting' WHERE id=$1`, [provenance.intentId])).rejects.toThrow(/dispatch is quarantined/);
    await db.query(`UPDATE "OrderIntent" SET status='blocked',"blockReason"='test' WHERE id=$1`, [provenance.intentId]);
    await db.query(`UPDATE "OrderIntent" SET status='failed' WHERE id=$1`, [provenance.intentId]);
    expect((await db.query(`SELECT status FROM "OrderIntent" WHERE id=$1`, [provenance.intentId])).rows[0].status).toBe('failed');
    await expect(db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview','EXE','buy','market','day','pending','hostile-pending','{}',$1,$2,$3,$4,now(),now())`, [paperId, assignmentId, subscriptionId, provenance.accountCycleId])).rejects.toThrow(/must be created in received status/);
  });

  it('rejects accepted EXIT preemption and terminal or blocked lifecycle reuse', async () => {
    await db.query(`UPDATE "OrderIntent" SET status='received' WHERE id=$1`, [provenance.intentId]);
    await db.query('BEGIN');
    try {
      const exitId = (await db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","createdAt") SELECT $1,$2,$3,$4,2,$5,c."externalTradeCycleRef",$6,1,$7,c.id,'EXIT_LONG','EXE','15m',now(),$8,now() FROM "ExternalSignalTradeCycle" c WHERE c.id=$9 RETURNING id`, [sourceId, bindingId, strategyId, securityId, `exit:${randomUUID()}`, randomUUID(), revisionId, 'd'.repeat(64), provenance.cycleId])).rows[0].id;
      await db.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING',0,now(),now(),now())`, [exitId]);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, [provenance.intentId, provenance.accountCycleId, provenance.cycleId, provenance.signalId, provenance.routeId, authorizationId, executeGenerationId, '0'.repeat(64), provenance.clientOrderId])).rejects.toThrow(/accepted EXIT preempts|lifecycle is not admissible/);
    await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='BLOCKED' WHERE id=$1`, [provenance.accountCycleId]);
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, [provenance.intentId, provenance.accountCycleId, provenance.cycleId, provenance.signalId, provenance.routeId, authorizationId, executeGenerationId, '0'.repeat(64), provenance.clientOrderId])).rejects.toThrow(/lifecycle is not admissible/);
    await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=now(),"terminalReasonCode"='HOSTILE_TEST',"noExposureProof"='ENTRY_REJECTED_WITHOUT_INTENT' WHERE id=$1`, [provenance.accountCycleId]);
    await db.query(`UPDATE "ExternalSignalTradeCycle" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=now(),"terminalReasonCode"='HOSTILE_TEST' WHERE id=$1`, [provenance.cycleId]);
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, [provenance.intentId, provenance.accountCycleId, provenance.cycleId, provenance.signalId, provenance.routeId, authorizationId, executeGenerationId, '0'.repeat(64), provenance.clientOrderId])).rejects.toThrow(/lifecycle is not admissible/);
  });

  it('invalidates on exact identity supersession and preserves history', async () => {
    await db.query(`UPDATE "StrategySignalRevision" SET status='RETIRED',"retiredAt"=now() WHERE id=$1`, [revisionId]);
    expect((await db.query(`SELECT status,"invalidationReasonCode" FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=$1`, [authorizationId])).rows[0]).toEqual({ status: 'INVALIDATED', invalidationReasonCode: 'REVISION_SUPERSEDED' });
    expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalEntryExecutionAuthorization"`)).rows[0].n).toBeGreaterThanOrEqual(4);
  });

});
