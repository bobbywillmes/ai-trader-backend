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
    const accountCycleId = (await db.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'ENTRY_INTENT_CREATED',now(),now()) RETURNING id`, [cycleId, routeId, paperId, assignmentId, subscriptionId, securityId])).rows[0].id;
    return { cycleId, cycleRef, signalId, routeId, accountCycleId };
  }

  async function insertExit(client: Client, fixture: Awaited<ReturnType<typeof createAdmissionFixture>>) {
    const signalId = (await client.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","createdAt") VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,$9,'EXIT_LONG','EXE','15m',now(),$10,now()) RETURNING id`, [sourceId, bindingId, strategyId, securityId, `exit:${randomUUID()}`, fixture.cycleRef, randomUUID(), revisionId, fixture.cycleId, 'b'.repeat(64)])).rows[0].id;
    await client.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING',0,now(),now(),now())`, [signalId]);
    return signalId;
  }

  async function insertIntentAndObligation(client: Client, fixture: Awaited<ReturnType<typeof createAdmissionFixture>>, label: string) {
    const clientOrderId = `${label}-${randomUUID()}`;
    const intentId = (await client.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview','EXE','buy','market','day','received',$5,'{}',$1,$2,$3,$4,now(),now()) RETURNING id`, [paperId, assignmentId, subscriptionId, fixture.accountCycleId, clientOrderId])).rows[0].id;
    return client.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, [intentId, fixture.accountCycleId, fixture.cycleId, fixture.signalId, fixture.routeId, authorizationId, executeGenerationId, '0'.repeat(64), clientOrderId]);
  }

  it('is default-off and SHADOW evidence cannot authorize execution', async () => {
    expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalExecutionRolloutActivation"`)).rows[0].n).toBe(0);
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionAuthorization" ("rolloutGenerationId","authorizationSequence",status,"tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId","signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","accountHolderUserId","assignmentFingerprint","sourceFingerprint","authorizationFingerprint","authorizedByUserId","grantReason") SELECT id,1,'AUTHORIZED',$1,$2,$3,$4,$5,$6,$7,1,$8,$9,$9,$9,$8,'forged shadow' FROM "ExternalSignalExecutionRolloutGeneration" WHERE "authorityMode"='SHADOW'`, [paperId, assignmentId, subscriptionId, securityId, sourceId, bindingId, revisionId, ownerId, '0'.repeat(64)])).rejects.toThrow(/rollout is not active/);
  });

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
      const accountCycleId = (await stale.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'ENTRY_INTENT_CREATED',now(),now()) RETURNING id`, [cycleId, routeId, paperId, assignmentId, subscriptionId, securityId])).rows[0].id;
      const clientOrderId = `stale-${randomUUID()}`;
      const intentId = (await stale.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview','EXE','buy','market','day','received',$5,'{}',$1,$2,$3,$4,now(),now()) RETURNING id`, [paperId, assignmentId, subscriptionId, accountCycleId, clientOrderId])).rows[0].id;
      await svc.changeExternalSignalExecutionRollout(executeGenerationId, 'DEACTIVATE', 'READ COMMITTED P8 deactivation', ownerId);
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
    const accountCycleId = (await db.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'ENTRY_INTENT_CREATED',now(),now()) RETURNING id`, [cycleId, routeId, paperId, assignmentId, subscriptionId, securityId])).rows[0].id;
    await db.query('BEGIN');
    try {
      const clientOrderId = `tv-${randomUUID()}`;
      const intentId = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview','EXE','buy','market','day','received',$5,'{}',$1,$2,$3,$4,now(),now()) RETURNING id`, [paperId, assignmentId, subscriptionId, accountCycleId, clientOrderId])).rows[0].id;
      const obligationId = (await db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9) RETURNING id`, [intentId, accountCycleId, cycleId, signalId, routeId, authorizationId, executeGenerationId, '0'.repeat(64), clientOrderId])).rows[0].id;
      await db.query('COMMIT');
      provenance = { cycleId, signalId, routeId, accountCycleId, intentId, obligationId, clientOrderId };
      await expect(db.query(`UPDATE "ExternalSignalEntryExecutionObligation" SET "entrySignalId"=$2 WHERE id=$1`, [obligationId, signalId])).rejects.toThrow(/immutable/);
      await expect(db.query(`DELETE FROM "ExternalSignalEntryExecutionObligation" WHERE id=$1`, [obligationId])).rejects.toThrow(/immutable/);
    } catch (error) { await db.query('ROLLBACK'); throw error; }
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
    await expect(db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9)`, [provenance.intentId, provenance.accountCycleId, provenance.cycleId, provenance.signalId, provenance.routeId, authorizationId, executeGenerationId, '0'.repeat(64), provenance.clientOrderId])).rejects.toThrow(/accepted EXIT preempts/);
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
