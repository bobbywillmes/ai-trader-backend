import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('Phase 4A.1A external signal shadow identity foundation', () => {
  const schema = `external_signal_shadow_${randomUUID().replaceAll('-', '')}`;
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await db.query(`
      CREATE TYPE "SignalEvent" AS ENUM ('ENTRY_LONG', 'EXIT_LONG');
      CREATE TABLE "User" (id serial PRIMARY KEY);
      CREATE TABLE "StrategySignalBinding" (id serial PRIMARY KEY);
      CREATE TABLE "StrategySignalRevision" (
        id serial PRIMARY KEY, "strategySignalBindingId" integer NOT NULL, revision integer NOT NULL,
        UNIQUE ("strategySignalBindingId", revision), UNIQUE (id, "strategySignalBindingId", revision)
      );
      CREATE TABLE "Security" (id serial PRIMARY KEY, symbol text NOT NULL UNIQUE);
      CREATE TABLE "TradingAccount" (id serial PRIMARY KEY);
      CREATE TABLE "Subscription" (id serial PRIMARY KEY);
      CREATE TABLE "TradingAccountSubscription" (
        id serial PRIMARY KEY, "tradingAccountId" integer NOT NULL, "subscriptionId" integer NOT NULL,
        "routingSecurityId" integer NOT NULL
      );
      CREATE TABLE "OrderIntent" (id serial PRIMARY KEY);
      CREATE TABLE "TrackedPosition" (id serial PRIMARY KEY);
      CREATE TABLE "Signal" (
        id serial PRIMARY KEY, "signalSourceId" integer NOT NULL, "strategySignalBindingId" integer NOT NULL,
        "strategySignalRevisionId" integer, "strategyRevision" integer, "strategyId" integer NOT NULL,
        "securityId" integer NOT NULL, "schemaVersion" integer NOT NULL, "externalEventKey" text,
        "eventFingerprint" text, event "SignalEvent" NOT NULL, symbol text NOT NULL, timeframe text NOT NULL,
        "signalTime" timestamp(3) NOT NULL, "barTime" timestamp(3), metadata jsonb,
        "canonicalPayloadHash" text NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Signal_event_identity_check" CHECK (
          ("externalEventKey" IS NOT NULL AND "eventFingerprint" IS NULL)
          OR ("externalEventKey" IS NULL AND "eventFingerprint" IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX "Signal_signalSourceId_externalEventKey_key" ON "Signal"("signalSourceId", "externalEventKey");
      CREATE UNIQUE INDEX "Signal_signalSourceId_eventFingerprint_key" ON "Signal"("signalSourceId", "eventFingerprint");
      CREATE TABLE "SignalRoutingRun" (id serial PRIMARY KEY, "signalId" integer NOT NULL UNIQUE);
      CREATE TABLE "SignalRoute" (
        id serial PRIMARY KEY, "signalRoutingRunId" integer NOT NULL, "tradingAccountId" integer NOT NULL,
        "tradingAccountSubscriptionId" integer NOT NULL, "subscriptionId" integer NOT NULL
      );
      INSERT INTO "StrategySignalBinding" (id) VALUES (1);
      INSERT INTO "StrategySignalRevision" (id, "strategySignalBindingId", revision) VALUES (1, 1, 1);
      INSERT INTO "Security" (id, symbol) VALUES (1, 'SPY'), (2, 'QQQ');
      INSERT INTO "TradingAccount" (id) VALUES (1), (2);
      INSERT INTO "Subscription" (id) VALUES (1);
      INSERT INTO "TradingAccountSubscription" (id, "tradingAccountId", "subscriptionId", "routingSecurityId") VALUES (1, 1, 1, 1);
      INSERT INTO "Signal" ("signalSourceId", "strategySignalBindingId", "strategySignalRevisionId", "strategyRevision", "strategyId", "securityId", "schemaVersion", "externalEventKey", event, symbol, timeframe, "signalTime", "canonicalPayloadHash")
        VALUES (1, 1, 1, 1, 1, 1, 1, 'legacy-key', 'ENTRY_LONG', 'SPY', '15m', CURRENT_TIMESTAMP, 'legacy-hash');
    `);
    await db.query(await readFile('prisma/migrations/20261028120000_external_signal_shadow_identity_foundation/migration.sql', 'utf8'));
    await db.query(await readFile('prisma/migrations/20261028150000_external_signal_identity_integrity_corrections/migration.sql', 'utf8'));
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  });

  async function transactionClient() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query(`SET search_path TO "${schema}"`);
    return client;
  }

  async function waitForLock(pid: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = (await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
      if (row?.wait_event_type === 'Lock') return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Backend ${pid} did not reach the explicit lock barrier.`);
  }

  async function cycleFixture(label: string, withAccount: boolean) {
    const cycleRef = `${label}:${randomUUID()}`;
    const cycle = (await db.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"updatedAt") VALUES (1,1,1,1,$1,'ACTIVE',CURRENT_TIMESTAMP) RETURNING id`, [cycleRef])).rows[0];
    const signal = (await db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash") VALUES (1,1,1,1,1,1,2,$1,$2,$3,$4,'ENTRY_LONG','SPY','15m',CURRENT_TIMESTAMP,$3) RETURNING id`, [`${label}:${randomUUID()}`, cycleRef, randomUUID().replaceAll('-', '').repeat(2), cycle.id])).rows[0];
    const run = (await db.query(`INSERT INTO "SignalRoutingRun" ("signalId") VALUES ($1) RETURNING id`, [signal.id])).rows[0];
    const route = (await db.query(`INSERT INTO "SignalRoute" ("signalRoutingRunId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId") VALUES ($1,1,1,1) RETURNING id`, [run.id])).rows[0];
    if (withAccount) await db.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"updatedAt") VALUES ($1,$2,1,1,1,1,'ENTRY_ROUTE_PENDING',CURRENT_TIMESTAMP)`, [cycle.id, route.id]);
    return { cycleId: cycle.id as number, routeId: route.id as number };
  }

  it('preserves historical v1 identity and rejects mixed or unknown contract shapes', async () => {
    expect((await db.query(`SELECT "externalEventKey", "eventFingerprint", "externalEventId", "externalTradeCycleRef" FROM "Signal" WHERE id=1`)).rows[0])
      .toEqual({ externalEventKey: 'legacy-key', eventFingerprint: null, externalEventId: null, externalTradeCycleRef: null });
    await expect(db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","strategyId","securityId","schemaVersion","externalEventKey","eventFingerprint",event,symbol,timeframe,"signalTime","canonicalPayloadHash") VALUES (1,1,1,1,1,1,1,'legacy','fingerprint','ENTRY_LONG','SPY','15m',CURRENT_TIMESTAMP,'x')`)).rejects.toThrow(/Signal_event_identity_check/);
    await expect(db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","strategyId","securityId","schemaVersion","eventFingerprint",event,symbol,timeframe,"signalTime","canonicalPayloadHash") VALUES (1,1,1,1,1,1,3,'fingerprint','ENTRY_LONG','SPY','15m',CURRENT_TIMESTAMP,'x')`)).rejects.toThrow(/Signal_event_identity_check/);
  });

  it('permits SHADOW rollout generations only and makes them immutable', async () => {
    await expect(db.query(`INSERT INTO "ExternalSignalExecutionRolloutGeneration" (direction,generation,enabled,"authorityMode","configurationJson","configurationFingerprint","effectiveAt") VALUES ('ENTRY',1,true,'EXECUTE','{}',$1,CURRENT_TIMESTAMP)`, ['a'.repeat(64)])).rejects.toThrow(/shadow_only/);
    const row = (await db.query(`INSERT INTO "ExternalSignalExecutionRolloutGeneration" (direction,generation,enabled,"authorityMode","configurationJson","configurationFingerprint","effectiveAt") VALUES ('ENTRY',1,true,'SHADOW','{}',$1,CURRENT_TIMESTAMP) RETURNING id`, ['a'.repeat(64)])).rows[0];
    await expect(db.query(`UPDATE "ExternalSignalExecutionRolloutGeneration" SET enabled=false WHERE id=$1`, [row.id])).rejects.toThrow(/immutable/);
    await expect(db.query(`INSERT INTO "ExternalSignalExecutionRolloutGeneration" (direction,generation,enabled,"authorityMode","configurationJson","configurationFingerprint","effectiveAt") VALUES ('ENTRY',2,true,'SHADOW','{}',$1,CURRENT_TIMESTAMP)`, ['b'.repeat(64)])).rejects.toThrow(/generation 1/);
  });

  it('enforces exact v2 event identity, same-bar distinction, and cycle consistency', async () => {
    const cycle = (await db.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"updatedAt") VALUES (1,1,1,1,'Cycle:A','ENTRY_RECEIVED',CURRENT_TIMESTAMP) RETURNING id`)).rows[0];
    const cycleB = (await db.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"updatedAt") VALUES (1,1,1,1,'Cycle:B','ENTRY_RECEIVED',CURRENT_TIMESTAMP) RETURNING id`)).rows[0];
    const cycleC = (await db.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"updatedAt") VALUES (1,1,1,1,'Cycle:C','ENTRY_RECEIVED',CURRENT_TIMESTAMP) RETURNING id`)).rows[0];
    const insert = (eventId: string, fingerprint: string, cycleRef = 'Cycle:A', cycleId = cycle.id, securityId = 1) => db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","barTime","canonicalPayloadHash") VALUES (1,1,1,1,1,$1,2,$2,$3,$4,$5,'ENTRY_LONG','SPY','15m','2026-10-28T14:30:00Z','2026-10-28T14:15:00Z',$4) RETURNING id`, [securityId, eventId, cycleRef, fingerprint, cycleId]);
    await insert('Event:A', 'a'.repeat(64));
    await insert('Event:B', 'b'.repeat(64), 'Cycle:B', cycleB.id);
    expect((await db.query(`SELECT count(*)::int AS count FROM "Signal" WHERE "schemaVersion"=2`)).rows[0].count).toBe(2);
    await expect(insert('Event:A', 'c'.repeat(64))).rejects.toThrow(/externalEventId/);
    await expect(insert('Event:A2', 'f'.repeat(64))).rejects.toThrow(/Signal_externalSignalTradeCycle_entry_key/);
    await expect(insert(' Event:C', 'd'.repeat(64))).rejects.toThrow(/identifier_syntax/);
    await expect(insert('Event:C', 'e'.repeat(64), 'Cycle:C', cycleC.id, 2)).rejects.toThrow(/does not match its external trade cycle identity/);
  });

  it('freezes assignment identity while allowing lifecycle updates after catalog changes', async () => {
    const suffix = randomUUID();
    const cycle = (await db.query(`INSERT INTO "ExternalSignalTradeCycle" ("strategySignalBindingId","strategySignalRevisionId","strategyRevision","securityId","externalTradeCycleRef",status,"updatedAt") VALUES (1,1,1,1,$1,'ENTRY_RECEIVED',CURRENT_TIMESTAMP) RETURNING id`, [`Assignment:${suffix}`])).rows[0];
    const signal = (await db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategySignalRevisionId","strategyRevision","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash") VALUES (1,1,1,1,1,1,2,$1,$2,$3,$4,'ENTRY_LONG','SPY','15m',CURRENT_TIMESTAMP,$3) RETURNING id`, [`AssignmentEvent:${suffix}`, `Assignment:${suffix}`, 'a'.repeat(63) + 'b', cycle.id])).rows[0];
    const run = (await db.query(`INSERT INTO "SignalRoutingRun" ("signalId") VALUES ($1) RETURNING id`, [signal.id])).rows[0];
    const route = (await db.query(`INSERT INTO "SignalRoute" ("signalRoutingRunId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId") VALUES ($1,1,1,1) RETURNING id`, [run.id])).rows[0];
    const accountCycle = (await db.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"updatedAt") VALUES ($1,$2,1,1,1,1,'ENTRY_ROUTE_PENDING',CURRENT_TIMESTAMP) RETURNING id`, [cycle.id, route.id])).rows[0];
    await db.query(`UPDATE "TradingAccountSubscription" SET "subscriptionId"=99,"routingSecurityId"=2 WHERE id=1`);
    try {
      await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_ADMISSION_PENDING',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [accountCycle.id]);
      expect((await db.query(`SELECT status,"subscriptionId","securityId" FROM "ExternalSignalTradeCycleAccount" WHERE id=$1`, [accountCycle.id])).rows[0])
        .toEqual({ status: 'ENTRY_ADMISSION_PENDING', subscriptionId: 1, securityId: 1 });
      await expect(db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET "securityId"=2 WHERE id=$1`, [accountCycle.id])).rejects.toThrow(/identity is immutable/);
      const exitRollout = (await db.query(`INSERT INTO "ExternalSignalExecutionRolloutGeneration" (direction,generation,enabled,"authorityMode","configurationJson","configurationFingerprint","effectiveAt") VALUES ('EXIT',1,true,'SHADOW','{}',$1,CURRENT_TIMESTAMP) RETURNING id`, ['c'.repeat(64)])).rows[0];
      await expect(db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET "entryRolloutGenerationId"=$1 WHERE id=$2`, [exitRollout.id, accountCycle.id])).rejects.toThrow(/entry rollout identity is invalid/);
      const entryRollout = (await db.query(`SELECT id FROM "ExternalSignalExecutionRolloutGeneration" WHERE direction='ENTRY'`)).rows[0];
      await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET "entryRolloutGenerationId"=$1 WHERE id=$2`, [entryRollout.id, accountCycle.id]);
    } finally {
      await db.query(`UPDATE "TradingAccountSubscription" SET "subscriptionId"=1,"routingSecurityId"=1 WHERE id=1`);
    }
  });

  it('serializes concurrent account INSERT and source terminalization in both commit orders', async () => {
    const sourceFirst = await cycleFixture('InsertSourceFirst', false);
    const a = await transactionClient(); const b = await transactionClient();
    try {
      const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await a.query('BEGIN');
      await a.query(`UPDATE "ExternalSignalTradeCycle" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=CURRENT_TIMESTAMP,"terminalReasonCode"='DONE',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [sourceFirst.cycleId]);
      await b.query('BEGIN');
      const blockedInsert = b.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"updatedAt") VALUES ($1,$2,1,1,1,1,'ENTRY_ROUTE_PENDING',CURRENT_TIMESTAMP)`, [sourceFirst.cycleId, sourceFirst.routeId]);
      await waitForLock(bPid);
      await a.query('COMMIT');
      await blockedInsert;
      await expect(b.query('COMMIT')).rejects.toThrow(/requires compatible account cycles/);
      expect((await db.query(`SELECT status FROM "ExternalSignalTradeCycle" WHERE id=$1`, [sourceFirst.cycleId])).rows[0].status).toBe('TERMINAL_NO_EXPOSURE');
      expect((await db.query(`SELECT count(*)::int AS count FROM "ExternalSignalTradeCycleAccount" WHERE "externalSignalTradeCycleId"=$1`, [sourceFirst.cycleId])).rows[0].count).toBe(0);

      const accountFirst = await cycleFixture('InsertAccountFirst', false);
      const aPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await b.query('BEGIN');
      await b.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"updatedAt") VALUES ($1,$2,1,1,1,1,'ENTRY_ROUTE_PENDING',CURRENT_TIMESTAMP)`, [accountFirst.cycleId, accountFirst.routeId]);
      await a.query('BEGIN');
      const blockedTerminal = a.query(`UPDATE "ExternalSignalTradeCycle" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=CURRENT_TIMESTAMP,"terminalReasonCode"='DONE',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [accountFirst.cycleId]);
      await waitForLock(aPid);
      await b.query('COMMIT');
      await blockedTerminal;
      await expect(a.query('COMMIT')).rejects.toThrow(/unresolved or incompatible/);
      expect((await db.query(`SELECT status FROM "ExternalSignalTradeCycle" WHERE id=$1`, [accountFirst.cycleId])).rows[0].status).toBe('ACTIVE');
      expect((await db.query(`SELECT status FROM "ExternalSignalTradeCycleAccount" WHERE "externalSignalTradeCycleId"=$1`, [accountFirst.cycleId])).rows[0].status).toBe('ENTRY_ROUTE_PENDING');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined); await b.query('ROLLBACK').catch(() => undefined);
      await a.end(); await b.end();
    }
  }, 15000);

  it('serializes concurrent account status UPDATE and source terminalization in both commit orders', async () => {
    const accountFirst = await cycleFixture('UpdateAccountFirst', true);
    const a = await transactionClient(); const b = await transactionClient();
    try {
      const aPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await b.query('BEGIN');
      await b.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=CURRENT_TIMESTAMP,"terminalReasonCode"='DONE',"noExposureProof"='ENTRY_SUPPRESSED_BEFORE_ADMISSION',"updatedAt"=CURRENT_TIMESTAMP WHERE "externalSignalTradeCycleId"=$1`, [accountFirst.cycleId]);
      await a.query('BEGIN');
      const blockedTerminal = a.query(`UPDATE "ExternalSignalTradeCycle" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=CURRENT_TIMESTAMP,"terminalReasonCode"='DONE',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [accountFirst.cycleId]);
      await waitForLock(aPid);
      await b.query('COMMIT');
      await blockedTerminal; await a.query('COMMIT');
      expect((await db.query(`SELECT status FROM "ExternalSignalTradeCycle" WHERE id=$1`, [accountFirst.cycleId])).rows[0].status).toBe('TERMINAL_NO_EXPOSURE');

      const sourceFirst = await cycleFixture('UpdateSourceFirst', true);
      const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await a.query('BEGIN');
      await a.query(`UPDATE "ExternalSignalTradeCycle" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=CURRENT_TIMESTAMP,"terminalReasonCode"='DONE',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [sourceFirst.cycleId]);
      await b.query('BEGIN');
      const blockedAccount = b.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=CURRENT_TIMESTAMP,"terminalReasonCode"='DONE',"noExposureProof"='ENTRY_SUPPRESSED_BEFORE_ADMISSION',"updatedAt"=CURRENT_TIMESTAMP WHERE "externalSignalTradeCycleId"=$1`, [sourceFirst.cycleId]);
      await waitForLock(bPid);
      await expect(a.query('COMMIT')).rejects.toThrow(/unresolved or incompatible/);
      await blockedAccount; await b.query('COMMIT');
      expect((await db.query(`SELECT status FROM "ExternalSignalTradeCycle" WHERE id=$1`, [sourceFirst.cycleId])).rows[0].status).toBe('ACTIVE');
      expect((await db.query(`SELECT status FROM "ExternalSignalTradeCycleAccount" WHERE "externalSignalTradeCycleId"=$1`, [sourceFirst.cycleId])).rows[0].status).toBe('TERMINAL_NO_EXPOSURE');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined); await b.query('ROLLBACK').catch(() => undefined);
      await a.end(); await b.end();
    }
  }, 15000);

  it('enforces original route/account identity and compatible terminal aggregation', async () => {
    const cycle = (await db.query(`SELECT id FROM "ExternalSignalTradeCycle" WHERE "externalTradeCycleRef"='Cycle:A'`)).rows[0];
    const signal = (await db.query(`SELECT id FROM "Signal" WHERE "externalEventId"='Event:A'`)).rows[0];
    const run = (await db.query(`INSERT INTO "SignalRoutingRun" ("signalId") VALUES ($1) RETURNING id`, [signal.id])).rows[0];
    const route = (await db.query(`INSERT INTO "SignalRoute" ("signalRoutingRunId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId") VALUES ($1,1,1,1) RETURNING id`, [run.id])).rows[0];
    await db.query(`INSERT INTO "ExternalSignalTradeCycleAccount" ("externalSignalTradeCycleId","entrySignalRouteId","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","securityId",status,"updatedAt") VALUES ($1,$2,1,1,1,1,'ENTRY_ROUTE_PENDING',CURRENT_TIMESTAMP)`, [cycle.id, route.id]);
    await expect(db.query(`UPDATE "ExternalSignalTradeCycle" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=CURRENT_TIMESTAMP,"terminalReasonCode"='DONE',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [cycle.id])).rejects.toThrow(/unresolved or incompatible/);
    await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=CURRENT_TIMESTAMP,"terminalReasonCode"='SUPPRESSED',"noExposureProof"='ENTRY_SUPPRESSED_BEFORE_ADMISSION',"updatedAt"=CURRENT_TIMESTAMP WHERE "externalSignalTradeCycleId"=$1`, [cycle.id]);
    await db.query(`UPDATE "ExternalSignalTradeCycle" SET status='TERMINAL_NO_EXPOSURE',"terminalAt"=CURRENT_TIMESTAMP,"terminalReasonCode"='ALL_NO_EXPOSURE',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [cycle.id]);
    await expect(db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='EXIT_PENDING',"terminalAt"=NULL,"terminalReasonCode"=NULL,"noExposureProof"=NULL,"updatedAt"=CURRENT_TIMESTAMP WHERE "externalSignalTradeCycleId"=$1`, [cycle.id])).rejects.toThrow(/absorbing/);
  });
});
