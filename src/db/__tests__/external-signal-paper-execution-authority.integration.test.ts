import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

(enabled ? describe : describe.skip)('External signal PAPER execution authority foundation', () => {
  const database = `external_exec_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, db: Client, databaseUrl: string;
  let ownerId: number, paperId: number, liveId: number, assignmentId: number, liveAssignmentId: number;
  let sourceId: number, bindingId: number, revisionId: number, strategyId: number, securityId: number, subscriptionId: number;
  let executeGenerationId: number, authorizationId: number;

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

  it('is default-off and SHADOW evidence cannot authorize execution', async () => {
    expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalExecutionRolloutActivation"`)).rows[0].n).toBe(0);
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionAuthorization" ("rolloutGenerationId","authorizationSequence",status,"tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId","signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","accountHolderUserId","assignmentFingerprint","sourceFingerprint","authorizationFingerprint","authorizedByUserId","grantReason") SELECT id,1,'AUTHORIZED',$1,$2,$3,$4,$5,$6,$7,1,$8,$9,$9,$9,$8,'forged shadow' FROM "ExternalSignalExecutionRolloutGeneration" WHERE "authorityMode"='SHADOW'`, [paperId, assignmentId, subscriptionId, securityId, sourceId, bindingId, revisionId, ownerId, '0'.repeat(64)])).rejects.toThrow(/rollout is not active/);
  });

  it('requires explicit activation and serializes rollout transitions', async () => {
    const svc = await import('../../services/external-signal-execution-authority.service.js');
    const generation = await svc.createExternalSignalExecuteGeneration({ configuration: {}, reason: 'Create isolated PAPER entry epoch' }, ownerId);
    executeGenerationId = generation.id;
    expect((await svc.listExternalSignalExecutionRollouts()).activeExecutionGenerationId).toBeNull();
    const results = await Promise.allSettled([
      svc.changeExternalSignalExecutionRollout(generation.id, 'ACTIVATE', 'Activate exact PAPER entry epoch', ownerId),
      svc.changeExternalSignalExecutionRollout(generation.id, 'ACTIVATE', 'Concurrent duplicate activation', ownerId),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await svc.listExternalSignalExecutionRollouts()).activeExecutionGenerationId).toBe(generation.id);
  });

  it('rejects LIVE direct SQL and grants only the exact PAPER identity', async () => {
    const svc = await import('../../services/external-signal-execution-authority.service.js');
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionAuthorization" ("rolloutGenerationId","authorizationSequence",status,"tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId","signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","accountHolderUserId","assignmentFingerprint","sourceFingerprint","authorizationFingerprint","authorizedByUserId","grantReason") VALUES ($1,1,'AUTHORIZED',$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$10,$10,$9,'forged live')`, [executeGenerationId, liveId, liveAssignmentId, subscriptionId, securityId, sourceId, bindingId, revisionId, ownerId, '0'.repeat(64)])).rejects.toThrow(/PAPER-only/);
    const authorization = await svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, reason: 'Authorize exact PAPER assignment identity' }, ownerId);
    authorizationId = authorization.id;
    expect(authorization).toMatchObject({ status: 'AUTHORIZED', tradingAccountId: paperId, tradingAccountSubscriptionId: assignmentId, strategySignalRevisionId: revisionId });
    expect(authorization.assignmentFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('revocation is terminal and reauthorization establishes a later boundary', async () => {
    const svc = await import('../../services/external-signal-execution-authority.service.js');
    const revoked = await svc.revokeExternalSignalEntryExecutionAuthorization(paperId, assignmentId, authorizationId, 'Revoke before any admission exists', ownerId);
    expect(revoked.status).toBe('REVOKED');
    await expect(db.query(`UPDATE "ExternalSignalEntryExecutionAuthorization" SET status='AUTHORIZED' WHERE id=$1`, [authorizationId])).rejects.toThrow(/invalid authorization transition/);
    const later = await svc.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, reason: 'Reauthorize only future accepted signals' }, ownerId);
    expect(later.authorizationSequence).toBe(2);
    authorizationId = later.id;
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
      const intentId = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview','EXE','buy','market','day','pending','{}',$1,$2,$3,$4,now(),now()) RETURNING id`, [paperId, assignmentId, subscriptionId, accountCycleId])).rows[0].id;
      const obligationId = (await db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8) RETURNING id`, [intentId, accountCycleId, cycleId, signalId, routeId, authorizationId, executeGenerationId, '0'.repeat(64)])).rows[0].id;
      await db.query('COMMIT');
      await expect(db.query(`UPDATE "ExternalSignalEntryExecutionObligation" SET "entrySignalId"=$2 WHERE id=$1`, [obligationId, signalId])).rejects.toThrow(/immutable/);
      await expect(db.query(`DELETE FROM "ExternalSignalEntryExecutionObligation" WHERE id=$1`, [obligationId])).rejects.toThrow(/immutable/);
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  });

  it('invalidates on exact identity supersession and preserves history', async () => {
    await db.query(`UPDATE "StrategySignalRevision" SET status='RETIRED',"retiredAt"=now() WHERE id=$1`, [revisionId]);
    expect((await db.query(`SELECT status,"invalidationReasonCode" FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=$1`, [authorizationId])).rows[0]).toEqual({ status: 'INVALIDATED', invalidationReasonCode: 'REVISION_SUPERSEDED' });
    expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalEntryExecutionAuthorization"`)).rows[0].n).toBe(2);
  });

});
