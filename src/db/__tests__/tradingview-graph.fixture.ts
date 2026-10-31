import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';

/**
 * Real TradingView authority and admission graphs for database tests, written through the production
 * triggers and authority services. Call only after process.env.DATABASE_URL names a disposable database.
 */
export async function createTradingViewGraphFixture(db: Client) {
  const ownerId = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('tv-graph-owner@test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id as number;
  const strategyId = (await db.query(`INSERT INTO "Strategy" (key,name,enabled,"createdAt","updatedAt") VALUES ('tv-graph','TV graph',true,now(),now()) RETURNING id`)).rows[0].id as number;
  const exitId = (await db.query(`INSERT INTO "ExitProfile" (key,name,"exitMode","takeProfitBehavior",enabled,"createdAt","updatedAt") VALUES ('tv-graph','TV graph','fixed','limit',true,now(),now()) RETURNING id`)).rows[0].id as number;
  const paperId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","tradingBlocked","createdAt","updatedAt") VALUES ($1,'TV graph paper','PAPER','ACTIVE',true,false,false,now(),now()) RETURNING id`, [ownerId])).rows[0].id as number;
  await db.query(`INSERT INTO "TradingAccountCredential" ("tradingAccountId",status,"apiKeyCiphertext","apiSecretCiphertext","keyFingerprint","verifiedAt","createdAt","updatedAt") VALUES ($1,'ACTIVE','test','test',$2,now(),now(),now())`, [paperId, 'f'.repeat(64)]);
  const sourceId = (await db.query(`INSERT INTO "ExternalSignalSource" (name,provider,enabled,"authMethod","webhookKeyHash","createdAt","updatedAt") VALUES ('TV','TRADINGVIEW',true,'URL_TOKEN',$1,now(),now()) RETURNING id`, ['a'.repeat(64)])).rows[0].id as number;
  const bindingId = (await db.query(`INSERT INTO "StrategySignalBinding" ("signalSourceId","strategyId","externalStrategyKey",enabled,"createdAt","updatedAt") VALUES ($1,$2,'tv-graph',true,now(),now()) RETURNING id`, [sourceId, strategyId])).rows[0].id as number;
  const revisionId = (await db.query(`INSERT INTO "StrategySignalRevision" ("strategySignalBindingId",revision,status,"authorityMode","createdAt","activatedAt") VALUES ($1,1,'ACTIVE','TRADE_ELIGIBLE',now(),now()) RETURNING id`, [bindingId])).rows[0].id as number;
  await db.query(`INSERT INTO "ExternalSignalExecutionRolloutGeneration" (direction,generation,enabled,"authorityMode","configurationJson","configurationFingerprint","effectiveAt") VALUES ('ENTRY',1,true,'SHADOW','{}',$1,now())`, ['b'.repeat(64)]);
  const authority = await import('../../services/external-signal-execution-authority.service.js');
  const executeGenerationId = (await authority.createExternalSignalExecuteGeneration({ configuration: {}, reason: 'Isolated TradingView graph epoch' }, ownerId)).id;
  await authority.changeExternalSignalExecutionRollout(executeGenerationId, 'ACTIVATE', 'Activate isolated TradingView graph epoch', ownerId);
  const dispatchVersion = (await authority.changeExternalSignalBrokerDispatchState(executeGenerationId, 'ACTIVATE', 'Exercise inert worker claims', ownerId)).stateVersion;
  let sequence = 0;

  async function createTarget() {
    sequence += 1;
    const symbol = `TV${sequence}`;
    const securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ($1,$1,true,'STOCK',now(),now()) RETURNING id`, [symbol])).rows[0].id as number;
    const subscriptionId = (await db.query(`INSERT INTO "Subscription" (key,name,symbol,enabled,"strategyId","exitProfileId","securityId","createdAt","updatedAt") VALUES ($1,$1,$2,true,$3,$4,$5,now(),now()) RETURNING id`, [`tv-graph-${sequence}`, symbol, strategyId, exitId, securityId])).rows[0].id as number;
    const assignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [paperId, subscriptionId])).rows[0].id as number;
    const allocationId = (await db.query(`INSERT INTO "TradingAccountAllocation" ("tradingAccountId",key,name,enabled,"maxAllocatedNotional","maxPositionNotional","createdAt","updatedAt") VALUES ($1,$2,$2,true,10000,1000,now(),now()) RETURNING id`, [paperId, `tv-graph-${sequence}`])).rows[0].id as number;
    await db.query(`UPDATE "TradingAccountSubscription" SET "allocationId"=$2 WHERE id=$1`, [assignmentId, allocationId]);
    const grant = await authority.grantExternalSignalEntryExecutionAuthorization(paperId, assignmentId, { rolloutGenerationId: executeGenerationId, strategySignalBindingId: bindingId, expectedStrategySignalRevisionId: revisionId, expectedSecurityId: securityId, reason: 'Authorize isolated graph target' }, ownerId);
    return { symbol, securityId, subscriptionId, assignmentId, authorizationId: grant.id };
  }

  /** A marked 'received' intent with its ENTRY_PENDING claim and frozen obligation. */
  async function admit(label: string) {
    const target = await createTarget();
    const cycleRef = `${label}:${randomUUID()}`;
    const cycleId = (await db.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"createdAt","updatedAt") VALUES ($1,$2,1,$3,$4,'ENTRY_RECEIVED',now(),now()) RETURNING id`, [bindingId, revisionId, target.securityId, cycleRef])).rows[0].id;
    await db.query('BEGIN');
    const signalId = (await db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","createdAt") VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,$9,'ENTRY_LONG',$11,'15m',now(),$10,now()) RETURNING id`, [sourceId, bindingId, strategyId, target.securityId, `entry:${randomUUID()}`, cycleRef, randomUUID(), revisionId, cycleId, 'a'.repeat(64), target.symbol])).rows[0].id;
    await db.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt","completedAt") VALUES ($1,'COMPLETED',0,now(),now(),now(),now())`, [signalId]);
    await db.query('COMMIT');
    await db.query('BEGIN');
    const runId = (await db.query(`INSERT INTO "SignalRoutingRun" ("signalId","authorityMode",status,"startedAt","completedAt","routeCount","createdAt") VALUES ($1,'TRADE_ELIGIBLE','COMPLETED',now(),now(),1,now()) RETURNING id`, [signalId])).rows[0].id;
    const routeId = (await db.query(`INSERT INTO "SignalRoute" ("signalRoutingRunId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","targetSnapshot","createdAt") VALUES ($1,$2,$3,$4,'{}',now()) RETURNING id`, [runId, paperId, target.assignmentId, target.subscriptionId])).rows[0].id;
    await db.query('COMMIT');
    const accountCycleId = (await db.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'ENTRY_ROUTE_PENDING',now(),now()) RETURNING id`, [cycleId, routeId, paperId, target.assignmentId, target.subscriptionId, target.securityId])).rows[0].id as number;
    const clientOrderId = `${label}-${randomUUID()}`;
    await db.query('BEGIN');
    const raw = { symbol: target.symbol, side: 'buy', orderType: 'market', timeInForce: 'day', qty: 1, signalType: 'entry', tradingAccountSubscriptionId: target.assignmentId };
    const intentId = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview',$6,'buy','market','day','received',$5,$7,$1,$2,$3,$4,now(),now()) RETURNING id`, [paperId, target.assignmentId, target.subscriptionId, accountCycleId, clientOrderId, target.symbol, JSON.stringify(raw)])).rows[0].id as number;
    const claimId = (await db.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,'ENTRY_PENDING',now(),now()) RETURNING id`, [paperId, target.securityId, intentId, `tv-graph:${accountCycleId}`])).rows[0].id as number;
    await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_EXECUTION_PROSPECTIVE',"entryRolloutGenerationId"=$2 WHERE id=$1`, [accountCycleId, executeGenerationId]);
    await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_INTENT_CREATED',"entryOrderIntentId"=$2 WHERE id=$1`, [accountCycleId, intentId]);
    const obligationId = (await db.query(`INSERT INTO "ExternalSignalEntryExecutionObligation" ("orderIntentId","accountCycleId","sourceCycleId","entrySignalId","entrySignalRouteId","authorizationId","rolloutGenerationId","executionEpochAt","authorizationFingerprint","obligationFingerprint","clientOrderId") VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,$8,$9) RETURNING id`, [intentId, accountCycleId, cycleId, signalId, routeId, target.authorizationId, executeGenerationId, '0'.repeat(64), clientOrderId])).rows[0].id as number;
    await db.query('COMMIT');
    return { intentId, claimId, accountCycleId, obligationId, clientOrderId };
  }

  /** The worker's atomic claim, stranded as a crash would leave it: 'submitting' and past its stale age. */
  async function workerClaim(graph: Awaited<ReturnType<typeof admit>>) {
    await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [graph.intentId]);
    await db.query('BEGIN');
    try {
      const workerClaimId = (await db.query(`INSERT INTO "ExternalSignalBrokerWorkerClaim" ("orderIntentId","executionObligationId","accountCycleId","rolloutGenerationId","dispatchStateVersion","clientOrderId","claimFingerprint") VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [graph.intentId, graph.obligationId, graph.accountCycleId, executeGenerationId, dispatchVersion, graph.clientOrderId, '0'.repeat(64)])).rows[0].id as number;
      await db.query(`UPDATE "EntryExposureClaim" SET status='ENTRY_SUBMITTING' WHERE id=$1`, [graph.claimId]);
      await db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'WORKER_CLAIMED_FOR_SUBMISSION',$2)`, [graph.claimId, JSON.stringify({ markerProtocol: 'ADAPTER_MARKER_V1', workerClaimId, executionMode: 'TRADINGVIEW_C2_NON_EXECUTABLE' })]);
      await db.query(`UPDATE "OrderIntent" SET status='submitting',"updatedAt"=now()-interval '10 minutes' WHERE id=$1`, [graph.intentId]);
      await db.query('COMMIT');
      return workerClaimId;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }

  return { ownerId, paperId, admit, workerClaim };
}
