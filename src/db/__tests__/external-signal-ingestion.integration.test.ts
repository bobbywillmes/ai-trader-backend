import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createExternalSignalIngressController } from '../../controllers/external-signal-ingress.controller.js';
import { authenticateExternalSignal, ingestExternalSignal, type SignalRequestEvidence } from '../../services/external-signal-ingestion.service.js';
import { getExternalSignalWebhook, regenerateExternalSignalWebhook, hashWebhookKey, createStrategySignalBinding } from '../../services/external-signal-config.service.js';
import { changeStrategySignalRevision } from '../../services/strategy-signal-revision.service.js';
import { createStrategySignalBindingSchema } from '../../validators/external-signal.schema.js';
import { canonicalSignalPayload, hashCanonicalPayload } from '../../services/external-signal-normalization.js';
import { routeSignal } from '../../services/signal-routing.service.js';
import { evaluateSignalRoute } from '../../services/signal-evaluation.service.js';

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && databaseUrl ? describe : describe.skip;

describeDatabase('external signal PostgreSQL atomicity and restrictive identities', () => {
  const schema = `external_signal_${randomUUID().replaceAll('-', '')}`;
  let admin: Client;
  let db: PrismaClient;
  let legacySignal: Record<string, unknown>;
  let legacyDelivery: Record<string, unknown>;
  let numericLegacySignal: Record<string, unknown>;
  let token = 'x'.repeat(43);
  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(`
      CREATE TABLE "Strategy" (id integer PRIMARY KEY, key text DEFAULT 'momentum', name text DEFAULT 'Momentum');
      CREATE TABLE "Security" (id integer PRIMARY KEY, symbol text UNIQUE NOT NULL);
      CREATE TYPE "SystemEventSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');
      CREATE TABLE "SystemEvent" (
        id serial PRIMARY KEY, "tradingAccountId" integer, "actorUserId" integer,
        type text NOT NULL, "entityType" text NOT NULL, "entityId" text NOT NULL,
        message text, "payloadJson" jsonb NOT NULL, severity "SystemEventSeverity" NOT NULL,
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed boolean NOT NULL DEFAULT false
      );
      INSERT INTO "Strategy" (id) VALUES (1);
      INSERT INTO "Security" VALUES (1, 'QQQ');
      CREATE TABLE "TradingAccount" (id integer PRIMARY KEY, "displayName" text NOT NULL);
      CREATE TABLE "Subscription" (id integer PRIMARY KEY, key text NOT NULL, name text NOT NULL,
        "strategyId" integer NOT NULL REFERENCES "Strategy"(id), "securityId" integer NOT NULL REFERENCES "Security"(id), enabled boolean NOT NULL DEFAULT true);
      CREATE TABLE "TradingAccountSubscription" (id serial PRIMARY KEY, "tradingAccountId" integer NOT NULL REFERENCES "TradingAccount"(id),
        "subscriptionId" integer NOT NULL REFERENCES "Subscription"(id), enabled boolean NOT NULL DEFAULT true,
        UNIQUE ("tradingAccountId", "subscriptionId"));
      INSERT INTO "TradingAccount" VALUES (1, 'Paper'), (2, 'Live'), (3, 'Other');
      INSERT INTO "Subscription" VALUES (1, 'conservative', 'Conservative', 1, 1, true), (2, 'core', 'Core', 1, 1, true), (3, 'aggressive', 'Aggressive', 1, 1, true);
      INSERT INTO "TradingAccountSubscription" ("tradingAccountId", "subscriptionId") VALUES (1, 1), (1, 2);
    `);
    await admin.query(await readFile('prisma/migrations/20260907120000_external_signal_ingestion/migration.sql', 'utf8'));
    const url = new URL(databaseUrl!); url.searchParams.delete('schema');
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), options: `-c search_path=${schema}` }, { schema }) });
    await admin.query(`INSERT INTO "ExternalSignalSource" (name, provider, "webhookTokenHash", "updatedAt") VALUES ('Integration fixture', 'GENERIC_WEBHOOK', $1, CURRENT_TIMESTAMP)`, [hashWebhookKey(token)]);
    await admin.query(`INSERT INTO "StrategySignalBinding" ("signalSourceId", "strategyId", "externalStrategyKey", "expectedRevision", "updatedAt") VALUES (1, 1, 'test', 'acceptance-2', CURRENT_TIMESTAMP)`);
    await admin.query(`INSERT INTO "Signal" ("signalSourceId", "strategySignalBindingId", "strategyId", "securityId", "schemaVersion", "externalEventKey", "strategyRevision", event, symbol, timeframe, "signalTime", "canonicalPayloadHash") VALUES (1, 1, 1, 1, 1, 'legacy', 'acceptance-2', 'ENTRY_LONG', 'QQQ', '15m', CURRENT_TIMESTAMP, 'original-hash')`);
    await admin.query(`INSERT INTO "SignalDelivery" ("signalSourceId", "signalId", "requestId", "receivedAt", "processedAt", status, "bodySizeBytes", "rawPayloadHash", "rawPayloadRedacted") VALUES (1, 1, 'legacy-request', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'NORMALIZED', 15, 'original-raw-hash', '{"strategyRevision":"acceptance-2"}')`);
    legacySignal = (await admin.query('SELECT * FROM "Signal" WHERE id = 1')).rows[0];
    legacyDelivery = (await admin.query('SELECT * FROM "SignalDelivery" WHERE id = 1')).rows[0];
    await admin.query(await readFile('prisma/migrations/20260908120000_strategy_signal_revisions/migration.sql', 'utf8'));
    await admin.query(`INSERT INTO "Signal" ("signalSourceId", "strategySignalBindingId", "strategyId", "securityId", "schemaVersion", "externalEventKey", "strategyRevision", "strategySignalRevisionId", event, symbol, timeframe, "signalTime", "canonicalPayloadHash") VALUES (1, 1, 1, 1, 1, 'legacy-numeric-key', 1, 1, 'EXIT_LONG', 'QQQ', '15m', CURRENT_TIMESTAMP, 'numeric-original-hash')`);
    numericLegacySignal = (await admin.query('SELECT * FROM "Signal" WHERE id = 2')).rows[0];
    await admin.query(await readFile('prisma/migrations/20260910120000_external_signal_provider_contract/migration.sql', 'utf8'));
    const routingMigration = await readFile('prisma/migrations/20260913120000_signal_authority_routing/migration.sql', 'utf8');
    await expect(admin.query(routingMigration)).rejects.toThrow('Conflicting enabled TradingAccountSubscriptions');
    await admin.query('ROLLBACK');
    expect((await admin.query('SELECT count(*)::int AS count FROM "TradingAccountSubscription" WHERE enabled')).rows[0].count).toBe(2);
    await admin.query('UPDATE "TradingAccountSubscription" SET enabled = false WHERE "subscriptionId" = 2');
    await admin.query(routingMigration);
    await admin.query(`
      ALTER TABLE "TradingAccountSubscription" ADD COLUMN "entriesEnabled" boolean NOT NULL DEFAULT true,
        ADD COLUMN "exitsEnabled" boolean NOT NULL DEFAULT true;
      ALTER TABLE "Subscription" ADD COLUMN "exitProfileId" integer;
      CREATE TABLE "ExitProfile" (id integer PRIMARY KEY, key text, "exitMode" text, "takeProfitBehavior" text, "targetPct" double precision, "trailingStopPct" double precision);
      CREATE TABLE "TrackedPosition" (id serial PRIMARY KEY, "tradingAccountId" integer, "tradingAccountSubscriptionId" integer,
        "subscriptionId" integer, "securityId" integer, side text, status text);
      CREATE TABLE "PositionExitState" (id serial PRIMARY KEY, "trackedPositionId" integer UNIQUE,
        status text, "exitProfileKey" text, "exitMode" text, "takeProfitBehavior" text, "targetPct" double precision, "trailingStopPct" double precision,
        "updatedAt" timestamp(3));
      INSERT INTO "TrackedPosition" ("subscriptionId", status) VALUES (1, 'open');
    `);
    await admin.query(await readFile('prisma/migrations/20260914120000_signal_evaluation_exit_ownership/migration.sql', 'utf8'));
    expect(await db.externalSignalSource.findUnique({ where: { webhookKeyHash: hashWebhookKey(token) } })).toBeNull();
    token = (await getExternalSignalWebhook(1, -1, db)).webhookKey;
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      // Only the randomly named schema created by this test is removed.
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  const occurrences = new Map<string, string>();
  function occurrence(label: string) { if (!occurrences.has(label)) occurrences.set(label, new Date(Date.UTC(2026, 0, 1, 0, occurrences.size)).toISOString()); return occurrences.get(label)!; }
  async function ingest(label: string, metadata: object = {}, event: 'ENTRY_LONG' | 'EXIT_LONG' = 'ENTRY_LONG', revision = 1, barTime?: string) {
    const source = await db.externalSignalSource.findUniqueOrThrow({ where: { id: 1 } });
    const body = Buffer.from(JSON.stringify({ externalStrategyKey: 'test', strategyRevision: revision,
      event, symbol: 'QQQ', timeframe: '15m', signalTime: occurrence(label), barTime, metadata }));
    const evidence: SignalRequestEvidence = { requestId: randomUUID(), receivedAt: new Date(), contentType: 'application/json',
      bodySizeBytes: body.length, body, rawPayloadHash: createHash('sha256').update(body).digest('hex'), tooLarge: false, validContentType: true };
    return ingestExternalSignal(source, token, evidence, db);
  }

  it('backfills active Revision 1 without rewriting legacy Signal or Delivery evidence', async () => {
    const { legacyStrategyRevision, strategyRevision, strategySignalRevisionId, eventFingerprint, ...row } = (await admin.query('SELECT * FROM "Signal" WHERE id = 1')).rows[0];
    expect({ ...row, strategyRevision: legacyStrategyRevision }).toEqual(legacySignal);
    expect(eventFingerprint).toBeNull(); expect(strategyRevision).toBeNull(); expect(strategySignalRevisionId).toBeNull();
    expect((await admin.query('SELECT * FROM "SignalDelivery" WHERE id = 1')).rows[0]).toEqual(legacyDelivery);
    expect(await db.strategySignalRevision.findMany({ where: { strategySignalBindingId: 1 } })).toMatchObject([{ revision: 1, status: 'ACTIVE', authorityMode: 'EVIDENCE_ONLY' }]);
    const { eventFingerprint: fingerprint, ...numeric } = (await admin.query('SELECT * FROM "Signal" WHERE id = 2')).rows[0];
    expect(fingerprint).toBeNull(); expect(numeric).toEqual(numericLegacySignal);
  });

  it('retrieves the same encrypted source capability across concurrent owner reads', async () => {
    const urls = await Promise.all([1, 2, 3].map(() => getExternalSignalWebhook(1, -1, db)));
    expect(urls).toEqual(Array(3).fill({ webhookKey: token }));
    const source = await db.externalSignalSource.findUniqueOrThrow({ where: { id: 1 } });
    expect(source.webhookKeyCiphertext).not.toContain(token);
    expect(source.webhookKeyHash).toBe(hashWebhookKey(token));
  });

  it.each([undefined, { test: 'revised smaller signal', nested: { rsi: 28.4 } }])('HTTP exact-byte retry is a duplicate and changed metadata conflicts: %j', async metadata => {
    const app = express();
    app.post('/api/external-signals/:webhookKey', createExternalSignalIngressController(db));
    const server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No HTTP port');
      const input = { externalStrategyKey: 'test', strategyRevision: 1, event: 'ENTRY_LONG', symbol: 'QQQ', timeframe: '15m',
        signalTime: occurrence(`http-${metadata === undefined ? 'minimal' : 'metadata'}`), metadata };
      const body = JSON.stringify(input);
      const post = (bytes: string) => fetch(`http://127.0.0.1:${address.port}/api/external-signals/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes });
      const first = await post(body);
      expect(first.status).toBe(201);
      const firstResponse = await first.json() as { status: string; requestId: string };
      expect(firstResponse.status).toBe('NORMALIZED');
      const initialDelivery = await db.signalDelivery.findFirstOrThrow({ where: { requestId: firstResponse.requestId } });
      const original = await db.signal.findUniqueOrThrow({ where: { id: initialDelivery.signalId! } });
      const retry = await post(body);
      expect(retry.status).toBe(200);
      const retryResponse = await retry.json() as { status: string; requestId: string };
      expect(retryResponse.status).toBe('DUPLICATE');
      const retryDelivery = await db.signalDelivery.findFirstOrThrow({ where: { requestId: retryResponse.requestId } });
      expect(retryDelivery.signalId).toBe(original.id);
      expect(retryDelivery.rawPayloadHash).toBe(initialDelivery.rawPayloadHash);
      const conflict = await post(JSON.stringify({ ...input, metadata: { test: 'revised smaller signal.' } }));
      expect(conflict.status).toBe(400);
      const conflictResponse = await conflict.json() as { requestId: string };
      expect(await db.signalDelivery.findFirst({ where: { requestId: conflictResponse.requestId } })).toMatchObject({ status: 'REJECTED', rejectionCode: 'EVENT_FINGERPRINT_CONFLICT', signalId: null });
      expect(await db.signal.count({ where: { signalSourceId: 1, eventFingerprint: original.eventFingerprint } })).toBe(1);
      expect(await db.signal.findUnique({ where: { id: original.id } })).toEqual(original);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('uses bar identity while treating changed signalTime or metadata as a payload conflict', async () => {
    const bar = '2025-12-31T23:45:00Z';
    expect((await ingest('bar-event', {}, 'ENTRY_LONG', 1, bar))?.status).toBe('NORMALIZED');
    expect((await ingest('bar-event', {}, 'ENTRY_LONG', 1, bar))?.status).toBe('DUPLICATE');
    expect((await ingest('bar-event', { rsi: 20 }, 'ENTRY_LONG', 1, bar))?.rejectionCode).toBe('EVENT_FINGERPRINT_CONFLICT');
    expect((await ingest('changed-signal-time', {}, 'ENTRY_LONG', 1, bar))?.rejectionCode).toBe('EVENT_FINGERPRINT_CONFLICT');
    expect((await ingest('bar-event', {}, 'ENTRY_LONG', 1, '2025-12-31T23:30:00Z'))?.status).toBe('NORMALIZED');
  });

  it('compares an older storage-inclusive hash through the same payload projection without rewriting it', async () => {
    const signalTime = occurrence('prior-hash-representation');
    const active = await db.strategySignalRevision.findFirstOrThrow({ where: { strategySignalBindingId: 1, status: 'ACTIVE' } });
    const identity = { signalSourceId: 1, strategySignalBindingId: 1, strategySignalRevisionId: active.id,
      securityId: 1, event: 'ENTRY_LONG' as const, timeframe: '15m' };
    const oldContent = { ...identity, strategyId: 1, symbol: 'QQQ', schemaVersion: 1, strategyRevision: 1,
      eventFingerprint: hashCanonicalPayload({ ...identity, eventOccurrenceTime: signalTime }), signalTime, barTime: null, metadata: {} };
    // Historical fixture is inserted with the exact previous hash representation.
    const original = await db.signal.create({ data: { ...oldContent, signalTime: new Date(signalTime), canonicalPayloadHash: hashCanonicalPayload(oldContent) } });
    expect(hashCanonicalPayload(canonicalSignalPayload(original, 'test'))).not.toBe(original.canonicalPayloadHash);
    expect(await ingest('prior-hash-representation')).toMatchObject({ status: 'DUPLICATE', signalId: original.id });
    expect(await ingest('prior-hash-representation', { changed: true })).toMatchObject({ status: 'REJECTED', rejectionCode: 'EVENT_FINGERPRINT_CONFLICT' });
    expect(await db.signal.findUnique({ where: { id: original.id } })).toEqual(original);
  });

  it('atomically creates initial active revision and rolls back on audit failure', async () => {
    const binding = await createStrategySignalBinding({ signalSourceId: 1, strategyId: 1, externalStrategyKey: 'initial' }, -1, db);
    expect(binding.revisions).toMatchObject([{ revision: 1, status: 'ACTIVE', authorityMode: 'EVIDENCE_ONLY' }]);
    await admin.query(`ALTER TABLE "SystemEvent" ADD CONSTRAINT test_audit_failure CHECK (type <> 'strategy_signal_binding_created') NOT VALID`);
    try {
      await expect(createStrategySignalBinding({ signalSourceId: 1, strategyId: 1, externalStrategyKey: 'rolled-back-binding' }, -1, db)).rejects.toThrow();
      expect(await db.strategySignalBinding.count({ where: { externalStrategyKey: 'rolled-back-binding' } })).toBe(0);
    } finally { await admin.query('ALTER TABLE "SystemEvent" DROP CONSTRAINT test_audit_failure'); }
  });

  it('serializes preparation, prevents competing candidates, and never reuses abandoned numbers', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => changeStrategySignalRevision(1, 'prepare', null, 'Added ADX confirmation', -1, db)));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    let prepared = await db.strategySignalRevision.findFirstOrThrow({ where: { strategySignalBindingId: 1, status: 'PREPARED' } });
    expect(prepared.revision).toBe(2);
    await expect(db.strategySignalRevision.create({ data: { strategySignalBindingId: 1, revision: 100, status: 'PREPARED' } })).rejects.toThrow();
    await changeStrategySignalRevision(1, 'retire', prepared.id, undefined, -1, db);
    prepared = await changeStrategySignalRevision(1, 'prepare', null, undefined, -1, db);
    expect(prepared.revision).toBe(3);
    await expect(ingest('prepared-not-accepted', {}, 'ENTRY_LONG', 3)).resolves.toMatchObject({ rejectionCode: 'STRATEGY_REVISION_MISMATCH', rejectionDetails: { activeRevision: 1, receivedRevision: 3 } });
  });

  it('enforces uniqueness when two new binding inputs normalize to the same key', async () => {
    const input = (externalStrategyKey: string) => createStrategySignalBindingSchema.parse({ signalSourceId: 1, strategyId: 1, externalStrategyKey, enabled: true });
    await db.strategySignalBinding.create({ data: { ...input('  Mean\tReversion -- V2  '), enabled: true } });
    await expect(db.strategySignalBinding.create({ data: { ...input('mean---reversion-v2'), enabled: true } })).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.strategySignalBinding.count({ where: { externalStrategyKey: 'mean-reversion-v2' } })).toBe(1);
  });
  it('uses database uniqueness for 12 concurrent identical retries', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => ingest('concurrent')));
    expect(results.filter(row => row?.status === 'NORMALIZED')).toHaveLength(1);
    expect(results.filter(row => row?.status === 'DUPLICATE')).toHaveLength(11);
    expect(new Set(results.map(row => row?.signalId)).size).toBe(1);
    expect(await db.signal.count({ where: { signalTime: new Date(occurrence('concurrent')) } })).toBe(1);
  });
  it('rejects concurrent conflicting content and preserves the winning Signal', async () => {
    const results = await Promise.all([ingest('conflicting-race', { rsi: 20 }), ingest('conflicting-race', { rsi: 30 })]);
    expect(results.map(row => row?.status).sort()).toEqual(['NORMALIZED', 'REJECTED']);
    expect(results.find(row => row?.status === 'REJECTED')?.rejectionCode).toBe('EVENT_FINGERPRINT_CONFLICT');
    expect(await db.systemEvent.count({ where: { type: 'external_signal_event_fingerprint_conflict' } })).toBeGreaterThanOrEqual(1);
    expect(await db.signal.count({ where: { signalTime: new Date(occurrence('conflicting-race')) } })).toBe(1);
  });
  it('rolls back Signal creation when normalized Delivery insertion fails', async () => {
    const beforeRuns = await db.signalRoutingRun.count();
    const beforeRoutes = await db.signalRoute.count();
    await admin.query(`ALTER TABLE "SignalDelivery" ADD CONSTRAINT test_delivery_failure CHECK (status <> 'NORMALIZED') NOT VALID`);
    try {
      await expect(ingest('rollback')).rejects.toThrow();
      expect(await db.signal.count({ where: { signalTime: new Date(occurrence('rollback')) } })).toBe(0);
      expect(await db.signalRoutingRun.count()).toBe(beforeRuns);
      expect(await db.signalRoute.count()).toBe(beforeRoutes);
    } finally {
      await admin.query(`ALTER TABLE "SignalDelivery" DROP CONSTRAINT test_delivery_failure`);
    }
  });
  it('records entry and exit metadata without execution tables', async () => {
    for (const event of ['ENTRY_LONG', 'EXIT_LONG'] as const) {
      const result = await ingest(`no-trading-${event}`, { quantity: 999999, tradingAccountId: 42, bypassRisk: true }, event);
      expect(result?.status).toBe('NORMALIZED');
    }
    const tables = await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [schema]);
    for (const name of ['EntryDecision', 'OrderIntent', 'BrokerOrder', 'BrokerActivity']) {
      expect(tables.rows.map(row => row.table_name)).not.toContain(name);
    }
  });
  it('activates transactionally under concurrent requests, fails old revisions closed and preserves evidence', async () => {
    const before = await db.signal.findMany({ orderBy: { id: 'asc' } });
    const prepared = await db.strategySignalRevision.findFirstOrThrow({ where: { strategySignalBindingId: 1, status: 'PREPARED' } });
    await admin.query(`ALTER TABLE "SystemEvent" ADD CONSTRAINT test_activation_failure CHECK (type <> 'strategy_signal_revision_activated') NOT VALID`);
    try {
      await expect(changeStrategySignalRevision(1, 'activate', prepared.id, undefined, -1, db)).rejects.toThrow();
      expect(await db.strategySignalRevision.findMany({ where: { strategySignalBindingId: 1, status: 'ACTIVE' } })).toMatchObject([{ revision: 1 }]);
      expect((await db.strategySignalRevision.findUniqueOrThrow({ where: { id: prepared.id } })).status).toBe('PREPARED');
    } finally { await admin.query('ALTER TABLE "SystemEvent" DROP CONSTRAINT test_activation_failure'); }
    const results = await Promise.allSettled([1, 2].map(() => changeStrategySignalRevision(1, 'activate', prepared.id, undefined, -1, db)));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(await db.strategySignalRevision.findMany({ where: { strategySignalBindingId: 1, status: 'ACTIVE' } })).toMatchObject([{ revision: 3 }]);
    await expect(db.strategySignalRevision.create({ data: { strategySignalBindingId: 1, revision: 100, status: 'ACTIVE', activatedAt: new Date() } })).rejects.toThrow();
    expect(await db.signal.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await ingest('old')).toMatchObject({ rejectionCode: 'STRATEGY_REVISION_MISMATCH', rejectionDetails: { activeRevision: 3, receivedRevision: 1 } });
    const normalized = await ingest('new-revision', {}, 'EXIT_LONG', 3);
    expect(normalized?.status).toBe('NORMALIZED');
    expect(await db.signal.findUnique({ where: { id: normalized!.signalId! } })).toMatchObject({ strategyRevision: 3, strategySignalRevisionId: prepared.id, legacyStrategyRevision: null });
    expect((await ingest('new-revision', {}, 'EXIT_LONG', 3))?.status).toBe('DUPLICATE');
    expect(await changeStrategySignalRevision(1, 'prepare', null, undefined, -1, db)).toMatchObject({ revision: 4 });
  });
  it('restricts deleting historical relations and keeps history unchanged across config updates', async () => {
    const before = await db.signal.findMany({ orderBy: { id: 'asc' } });
    await expect(db.externalSignalSource.delete({ where: { id: 1 } })).rejects.toThrow();
    await expect(db.strategySignalBinding.delete({ where: { id: 1 } })).rejects.toThrow();
    await expect(admin.query('DELETE FROM "Strategy" WHERE id = 1')).rejects.toThrow();
    await expect(admin.query('DELETE FROM "Security" WHERE id = 1')).rejects.toThrow();
    await db.strategySignalBinding.update({ where: { id: 1 }, data: { enabled: false } });
    await db.externalSignalSource.update({ where: { id: 1 }, data: { enabled: false } });
    expect((await ingest('concurrent'))?.rejectionCode).toBe('SOURCE_DISABLED');
    expect(await db.signal.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
  it('rejects reactivation, active abandonment, cross-binding actions, and credential notes', async () => {
    const active = await db.strategySignalRevision.findFirstOrThrow({ where: { strategySignalBindingId: 1, status: 'ACTIVE' } });
    const retired = await db.strategySignalRevision.findFirstOrThrow({ where: { strategySignalBindingId: 1, status: 'RETIRED' } });
    const other = await db.strategySignalBinding.findFirstOrThrow({ where: { externalStrategyKey: 'initial' } });
    await expect(changeStrategySignalRevision(1, 'retire', active.id, undefined, -1, db)).rejects.toMatchObject({ statusCode: 409 });
    await expect(changeStrategySignalRevision(1, 'activate', retired.id, undefined, -1, db)).rejects.toMatchObject({ statusCode: 409 });
    await expect(changeStrategySignalRevision(other.id, 'activate', active.id, undefined, -1, db)).rejects.toMatchObject({ statusCode: 404 });
    await expect(changeStrategySignalRevision(999999, 'prepare', null, undefined, -1, db)).rejects.toMatchObject({ statusCode: 404 });
    for (const note of [`Bearer ${token}`, token, hashWebhookKey(token)]) {
      await expect(changeStrategySignalRevision(other.id, 'prepare', null, note, -1, db)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await db.strategySignalRevision.count({ where: { strategySignalBindingId: other.id } })).toBe(1);
    const audits = JSON.stringify(await db.systemEvent.findMany({ where: { type: { startsWith: 'strategy_signal_revision_' } } }));
    expect(audits).not.toContain(token); expect(audits).not.toContain(hashWebhookKey(token));
    expect(audits).not.toContain('Added ADX confirmation');
  });
  it('regenerates the source capability, invalidates the old URL and preserves all relationships and evidence', async () => {
    const before = await Promise.all([db.signal.findMany(), db.signalDelivery.findMany(), db.strategySignalBinding.findMany(), db.strategySignalRevision.findMany()]);
    const old = token;
    const result = await regenerateExternalSignalWebhook(1, -1, db);
    expect(result).not.toHaveProperty('webhookKeyHash'); expect(result).not.toHaveProperty('webhookKeyCiphertext');
    token = (await getExternalSignalWebhook(1, -1, db)).webhookKey;
    expect(token).not.toBe(old);
    expect(await authenticateExternalSignal(old, db)).toBeNull();
    expect(await authenticateExternalSignal(token, db)).toMatchObject({ id: 1 });
    expect(await Promise.all([db.signal.findMany(), db.signalDelivery.findMany(), db.strategySignalBinding.findMany(), db.strategySignalRevision.findMany()])).toEqual(before);
    expect(JSON.stringify(await db.systemEvent.findMany())).not.toContain(token);
  });
  async function routingFixture(mode: 'EVIDENCE_ONLY' | 'EVALUATION_ONLY' | 'TRADE_ELIGIBLE') {
    const binding = await createStrategySignalBinding({ signalSourceId: 1, strategyId: 1, externalStrategyKey: `routing-${randomUUID()}` }, -1, db);
    let revision = binding.revisions[0]!;
    if (mode !== 'EVIDENCE_ONLY') {
      const prepared = await changeStrategySignalRevision(binding.id, 'prepare', null, undefined, -1, db);
      await changeStrategySignalRevision(binding.id, 'authority', prepared.id, undefined, -1, db, { authorityMode: mode, confirmTradeEligible: true });
      revision = await changeStrategySignalRevision(binding.id, 'activate', prepared.id, undefined, -1, db);
    }
    const signal = await db.signal.create({ data: {
      signalSourceId: 1, strategySignalBindingId: binding.id, strategySignalRevisionId: revision.id,
      strategyRevision: revision.revision, strategyId: 1, securityId: 1, schemaVersion: 1,
      eventFingerprint: randomUUID(), event: 'ENTRY_LONG', symbol: 'QQQ', timeframe: '1m',
      signalTime: new Date(), canonicalPayloadHash: 'routing-fixture', metadata: { testMode: true, bypassRisk: true },
    } });
    return { signal, binding, revision };
  }

  it('enforces enabled identity while preserving inactive alternatives and cross-account variants', async () => {
    await expect(admin.query('UPDATE "TradingAccountSubscription" SET enabled = true WHERE "tradingAccountId" = 1 AND "subscriptionId" = 2')).rejects.toMatchObject({ code: '23505' });
    await admin.query('INSERT INTO "TradingAccountSubscription" ("tradingAccountId", "subscriptionId", enabled) VALUES (1, 3, false), (2, 2, true)');
    expect((await admin.query('SELECT count(*)::int AS count FROM "TradingAccountSubscription" WHERE "tradingAccountId" = 1')).rows[0].count).toBe(3);
    // Caller-supplied mirrors cannot bypass the invariant.
    await expect(admin.query('INSERT INTO "TradingAccountSubscription" ("tradingAccountId", "subscriptionId", "routingStrategyId", "routingSecurityId") VALUES (2, 3, 999, 999)')).rejects.toMatchObject({ code: '23505' });
  });

  it('serializes concurrent conflicting inserts with a real unique index', async () => {
    const results = await Promise.allSettled([1, 2].map(subscriptionId => db.$executeRaw`INSERT INTO "TradingAccountSubscription" ("tradingAccountId", "subscriptionId") VALUES (3, ${subscriptionId})`));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await admin.query('SELECT count(*)::int AS count FROM "TradingAccountSubscription" WHERE "tradingAccountId" = 3 AND enabled')).rows[0].count).toBe(1);
    await admin.query('UPDATE "TradingAccountSubscription" SET enabled = false WHERE "tradingAccountId" = 3');
  });

  it('keeps mirrors synchronized and prevents catalog identity edits from creating ambiguity', async () => {
    await admin.query(`INSERT INTO "Security" VALUES (2, 'RSP'); INSERT INTO "Subscription" VALUES (4, 'rsp', 'RSP', 1, 2, true);
      INSERT INTO "TradingAccountSubscription" ("tradingAccountId", "subscriptionId") VALUES (1, 4)`);
    await expect(admin.query('UPDATE "Subscription" SET "securityId" = 1 WHERE id = 4')).rejects.toMatchObject({ code: '23505' });
    expect((await admin.query('SELECT "securityId" FROM "Subscription" WHERE id = 4')).rows[0].securityId).toBe(2);
    await admin.query('UPDATE "TradingAccountSubscription" SET enabled = false WHERE "subscriptionId" = 4');
    await admin.query('UPDATE "Subscription" SET "securityId" = 1 WHERE id = 4');
    expect((await admin.query('SELECT "routingSecurityId" FROM "TradingAccountSubscription" WHERE "subscriptionId" = 4')).rows[0].routingSecurityId).toBe(1);
  });

  it('inherits authority, audits deliberate promotion and downgrade, and freezes historical authority', async () => {
    const { binding, signal, revision } = await routingFixture('EVALUATION_ONLY');
    const prepared = await changeStrategySignalRevision(binding.id, 'prepare', null, undefined, -1, db);
    expect(prepared.authorityMode).toBe('EVALUATION_ONLY');
    await expect(changeStrategySignalRevision(binding.id, 'authority', prepared.id, undefined, -1, db, { authorityMode: 'TRADE_ELIGIBLE' })).rejects.toMatchObject({ statusCode: 400 });
    await changeStrategySignalRevision(binding.id, 'authority', prepared.id, undefined, -1, db, { authorityMode: 'TRADE_ELIGIBLE', confirmTradeEligible: true });
    expect(await db.systemEvent.findFirst({ where: { type: 'strategy_signal_revision_authority_changed', entityId: String(prepared.id) }, orderBy: { id: 'desc' } })).toMatchObject({ payloadJson: { previousAuthorityMode: 'EVALUATION_ONLY', authorityMode: 'TRADE_ELIGIBLE' } });
    await changeStrategySignalRevision(binding.id, 'authority', prepared.id, undefined, -1, db, { authorityMode: 'EVIDENCE_ONLY' });
    await changeStrategySignalRevision(binding.id, 'activate', prepared.id, undefined, -1, db);
    for (const frozen of [revision, prepared]) {
      await expect(changeStrategySignalRevision(binding.id, 'authority', frozen.id, undefined, -1, db, { authorityMode: 'TRADE_ELIGIBLE', confirmTradeEligible: true })).rejects.toMatchObject({ statusCode: 409 });
      await expect(db.strategySignalRevision.update({ where: { id: frozen.id }, data: { authorityMode: 'TRADE_ELIGIBLE' } })).rejects.toThrow();
      await expect(db.strategySignalRevision.update({ where: { id: frozen.id }, data: { status: 'PREPARED', activatedAt: null, retiredAt: null } })).rejects.toThrow();
    }
    expect(await routeSignal(signal.id, db)).toMatchObject({ authorityMode: 'EVALUATION_ONLY', status: 'COMPLETED', routeCount: 2 });
    expect(await db.signal.findUnique({ where: { id: signal.id } })).toEqual(signal);
  });

  it('rolls back authority when its sanitized transactional audit fails', async () => {
    const { binding } = await routingFixture('EVIDENCE_ONLY');
    const prepared = await changeStrategySignalRevision(binding.id, 'prepare', null, undefined, -1, db);
    await admin.query(`ALTER TABLE "SystemEvent" ADD CONSTRAINT authority_audit_failure CHECK (type <> 'strategy_signal_revision_authority_changed') NOT VALID`);
    try {
      await expect(changeStrategySignalRevision(binding.id, 'authority', prepared.id, undefined, -1, db, { authorityMode: 'TRADE_ELIGIBLE', confirmTradeEligible: true })).rejects.toThrow();
      expect(await db.strategySignalRevision.findUnique({ where: { id: prepared.id } })).toMatchObject({ authorityMode: 'EVIDENCE_ONLY' });
    } finally { await admin.query('ALTER TABLE "SystemEvent" DROP CONSTRAINT authority_audit_failure'); }
  });

  it('stops evidence-only and legacy Signals idempotently without inspecting subscriptions', async () => {
    const { signal } = await routingFixture('EVIDENCE_ONLY');
    const run = await routeSignal(signal.id, db);
    expect(run).toMatchObject({ authorityMode: 'EVIDENCE_ONLY', status: 'STOPPED', stopReason: 'EVIDENCE_ONLY_AUTHORITY', routeCount: 0, routes: [] });
    expect(await routeSignal(signal.id, db)).toEqual(run);
    expect(await routeSignal(1, db)).toMatchObject({ authorityMode: 'EVIDENCE_ONLY', status: 'STOPPED', stopReason: 'LEGACY_REVISION_NO_AUTHORITY', routeCount: 0 });
  });

  it.each(['EVALUATION_ONLY', 'TRADE_ELIGIBLE'] as const)('fans out %s identically and cannot touch trading models', async mode => {
    const { signal, binding, revision } = await routingFixture(mode);
    const results = await Promise.all(Array.from({ length: 12 }, () => routeSignal(signal.id, db)));
    expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    const run = results[0]!;
    expect(run).toMatchObject({ authorityMode: mode, status: 'COMPLETED', routeCount: 2, stopReason: null });
    expect(run.routes.map(route => [route.tradingAccountId, route.subscriptionId])).toEqual([[1, 1], [2, 2]]);
    expect(await db.signalRoutingRun.count({ where: { signalId: signal.id } })).toBe(1);
    expect(await db.signalRoute.count({ where: { signalRoutingRunId: run.id } })).toBe(2);
    // Exercise the real normalization -> routing transaction for both event types too.
    const source = await db.externalSignalSource.update({ where: { id: 1 }, data: { enabled: true } });
    for (const event of ['ENTRY_LONG', 'EXIT_LONG']) {
      const body = Buffer.from(JSON.stringify({ externalStrategyKey: binding.externalStrategyKey, strategyRevision: revision.revision,
        event, symbol: 'QQQ', timeframe: '1m', signalTime: new Date().toISOString(), metadata: { testMode: true, quantity: 99999 } }));
      const evidence: SignalRequestEvidence = { requestId: randomUUID(), receivedAt: new Date(), contentType: 'application/json',
        bodySizeBytes: body.length, rawPayloadHash: createHash('sha256').update(body).digest('hex'), body, tooLarge: false, validContentType: true };
      const delivery = await ingestExternalSignal(source, token, evidence, db);
      expect(delivery?.status).toBe('NORMALIZED');
      expect(await db.signalRoutingRun.findUnique({ where: { signalId: delivery!.signalId! } })).toMatchObject({ authorityMode: mode, routeCount: 2, status: 'COMPLETED' });
    }
    const tables = (await admin.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [schema])).rows.map(row => row.table_name);
    for (const table of ['OrderIntent', 'BrokerOrder', 'BrokerActivity', 'EntryDecision', 'PositionCloseRequest']) expect(tables).not.toContain(table);
  });

  it('completes zero routes when the catalog is disabled and keeps retries frozen after configuration changes', async () => {
    const { signal } = await routingFixture('EVALUATION_ONLY');
    await admin.query('UPDATE "Subscription" SET enabled = false');
    const run = await routeSignal(signal.id, db);
    expect(run).toMatchObject({ status: 'COMPLETED', routeCount: 0, routes: [] });
    await admin.query('UPDATE "Subscription" SET enabled = true');
    expect(await routeSignal(signal.id, db)).toEqual(run);
  });

  it('preserves target snapshots and rejects evidence updates, deletes, and later appended routes', async () => {
    const { signal } = await routingFixture('EVALUATION_ONLY');
    const run = await routeSignal(signal.id, db);
    await admin.query(`UPDATE "TradingAccount" SET "displayName" = 'Renamed' WHERE id = 1; UPDATE "Subscription" SET name = 'Renamed' WHERE id = 1`);
    expect(await routeSignal(signal.id, db)).toEqual(run);
    await expect(db.signalRoute.update({ where: { id: run.routes[0]!.id }, data: { subscriptionId: 3 } })).rejects.toThrow();
    await expect(db.signalRoute.delete({ where: { id: run.routes[0]!.id } })).rejects.toThrow();
    await expect(db.signalRoutingRun.update({ where: { id: run.id }, data: { routeCount: 3 } })).rejects.toThrow();
    await expect(db.signalRoutingRun.delete({ where: { id: run.id } })).rejects.toThrow();
    await expect(db.signalRoute.create({ data: { signalRoutingRunId: run.id, tradingAccountId: 3, tradingAccountSubscriptionId: run.routes[0]!.tradingAccountSubscriptionId, subscriptionId: 1, targetSnapshot: {} } })).rejects.toThrow();
    expect(await routeSignal(signal.id, db)).toEqual(run);
  });

  it('rolls back the entire run when a route fails and succeeds on a clean retry', async () => {
    const { signal } = await routingFixture('TRADE_ELIGIBLE');
    const before = await db.signalRoute.count();
    await admin.query('ALTER TABLE "SignalRoute" ADD CONSTRAINT route_failure CHECK ("tradingAccountId" <> 2) NOT VALID');
    try {
      await expect(routeSignal(signal.id, db)).rejects.toThrow();
      expect(await db.signalRoutingRun.count({ where: { signalId: signal.id } })).toBe(0);
      expect(await db.signalRoute.count()).toBe(before);
    } finally { await admin.query('ALTER TABLE "SignalRoute" DROP CONSTRAINT route_failure'); }
    expect(await routeSignal(signal.id, db)).toMatchObject({ routeCount: 2, status: 'COMPLETED' });
  });

  it('backfills existing positions and subscriptions without external ownership', async () => {
    expect((await admin.query('SELECT "exitManagementMode" FROM "Subscription"')).rows.every(r => r.exitManagementMode === 'BACKEND_MANAGED')).toBe(true);
    expect((await admin.query('SELECT "exitManagementModeSnapshot" FROM "PositionExitState" WHERE "trackedPositionId" = 1')).rows[0]).toEqual({ exitManagementModeSnapshot: 'BACKEND_MANAGED' });
  });

  it('serializes evaluations, freezes gates and rejects appended or retroactive evidence', async () => {
    const { signal } = await routingFixture('EVALUATION_ONLY');
    const run = await routeSignal(signal.id, db);
    const route = run.routes[0]!;
    const evaluations = await Promise.all(Array.from({ length: 12 }, () => evaluateSignalRoute(route.id, db)));
    expect(evaluations.every(e => JSON.stringify(e) === JSON.stringify(evaluations[0]))).toBe(true);
    const evaluation = evaluations[0]!;
    expect(evaluation).toMatchObject({ status: 'COMPLETED', outcome: 'ELIGIBLE', gateCount: 4 });
    expect(evaluation.gates.map(g => g.sequence)).toEqual([1, 2, 3, 4]);
    await admin.query('UPDATE "TradingAccountSubscription" SET "entriesEnabled" = false WHERE id = $1', [route.tradingAccountSubscriptionId]);
    expect(await evaluateSignalRoute(route.id, db)).toEqual(evaluation);
    await admin.query('UPDATE "TradingAccountSubscription" SET "entriesEnabled" = true WHERE id = $1', [route.tradingAccountSubscriptionId]);
    await expect(db.signalEvaluation.update({ where: { id: evaluation.id }, data: { outcome: 'BLOCKED' } })).rejects.toThrow('immutable');
    await expect(db.signalEvaluation.delete({ where: { id: evaluation.id } })).rejects.toThrow('immutable');
    await expect(db.signalEvaluationGate.update({ where: { id: evaluation.gates[0]!.id }, data: { result: 'BLOCKED' } })).rejects.toThrow('immutable');
    await expect(db.signalEvaluationGate.delete({ where: { id: evaluation.gates[0]!.id } })).rejects.toThrow('immutable');
    await expect(db.signalEvaluationGate.create({ data: { signalEvaluationId: evaluation.id, sequence: 5, gateKey: 'LATER', result: 'PASS', evaluatedAt: new Date() } })).rejects.toThrow();
    const historicalSignal = (await routingFixture('EVALUATION_ONLY')).signal;
    const historical = await db.signalRoutingRun.create({ data: { signalId: historicalSignal.id, authorityMode: 'EVALUATION_ONLY',
      status: 'COMPLETED', routeCount: 1, startedAt: new Date(), completedAt: new Date(),
      routes: { create: { tradingAccountId: route.tradingAccountId, tradingAccountSubscriptionId: route.tradingAccountSubscriptionId,
        subscriptionId: route.subscriptionId, targetSnapshot: {} } } }, include: { routes: true } });
    expect(await evaluateSignalRoute(historical.routes[0]!.id, db)).toBeNull();
    expect(await db.signalEvaluation.count({ where: { signalRouteId: historical.routes[0]!.id } })).toBe(0);
  });

  it('uses frozen position ownership, never mutates positions and fails closed on ambiguity', async () => {
    const fixture = await routingFixture('EVALUATION_ONLY');
    async function exitRoute() {
      const { id: _id, ...data } = fixture.signal;
      const signal = await db.signal.create({ data: { ...data, metadata: {}, eventFingerprint: randomUUID(), event: 'EXIT_LONG' } });
      return (await routeSignal(signal.id, db)).routes[0]!;
    }
    const route = await exitRoute();
    const insertPosition = async () => (await admin.query(`INSERT INTO "TrackedPosition" ("tradingAccountId", "tradingAccountSubscriptionId", "subscriptionId", "securityId", side, status) VALUES ($1,$2,$3,1,'long','open') RETURNING id`, [route.tradingAccountId, route.tradingAccountSubscriptionId, route.subscriptionId])).rows[0];
    const position = await insertPosition();
    const provenance = { tradingAccountId: route.tradingAccountId, tradingAccountSubscriptionId: route.tradingAccountSubscriptionId, subscriptionId: route.subscriptionId, strategyId: 1, securityId: 1 };
    await admin.query(`INSERT INTO "PositionExitState" ("trackedPositionId", "exitManagementModeSnapshot", "exitOwnershipProvenance") VALUES ($1,'EXTERNAL_SIGNAL',$2)`, [position.id, provenance]);
    const before = (await admin.query('SELECT * FROM "PositionExitState" ORDER BY id')).rows;
    const beforePositions = (await admin.query('SELECT * FROM "TrackedPosition" ORDER BY id')).rows;
    expect(await evaluateSignalRoute(route.id, db)).toMatchObject({ outcome: 'ELIGIBLE', positionExitManagementMode: 'EXTERNAL_SIGNAL', trackedPositionId: position.id });
    expect((await admin.query('SELECT * FROM "TrackedPosition" ORDER BY id')).rows).toEqual(beforePositions);
    await admin.query(`UPDATE "Subscription" SET "exitManagementMode" = 'EXTERNAL_SIGNAL' WHERE id = $1`, [route.subscriptionId]);
    expect((await admin.query('SELECT * FROM "PositionExitState" ORDER BY id')).rows).toEqual(before);
    await expect(admin.query(`UPDATE "PositionExitState" SET "exitManagementModeSnapshot" = 'BACKEND_MANAGED' WHERE "trackedPositionId" = $1`, [position.id])).rejects.toThrow('immutable');
    expect(await evaluateSignalRoute((await exitRoute()).id, db)).toMatchObject({ outcome: 'ELIGIBLE' });
    const other = await insertPosition();
    expect(await evaluateSignalRoute((await exitRoute()).id, db)).toMatchObject({ status: 'FAILED', outcome: null, reasonCode: 'AMBIGUOUS_MATCHING_POSITIONS' });
    await admin.query(`UPDATE "TrackedPosition" SET status = 'closed' WHERE id IN ($1,$2)`, [position.id, other.id]);
    await admin.query(`UPDATE "Subscription" SET "exitManagementMode" = 'BACKEND_MANAGED'`);
    const backend = await insertPosition();
    await admin.query('INSERT INTO "PositionExitState" ("trackedPositionId") VALUES ($1)', [backend.id]);
    expect(await evaluateSignalRoute((await exitRoute()).id, db)).toMatchObject({ outcome: 'NO_ACTION', reasonCode: 'EXTERNAL_EXIT_NOT_APPLICABLE' });
    await admin.query(`UPDATE "TrackedPosition" SET "subscriptionId" = 999 WHERE id = $1`, [backend.id]);
    expect(await evaluateSignalRoute((await exitRoute()).id, db)).toMatchObject({ outcome: 'NO_ACTION', reasonCode: 'NO_MATCHING_OPEN_POSITION' });
  });

  it('preserves normalized ingress and records a sanitized failure after a database evaluation error', async () => {
    const { binding, revision } = await routingFixture('EVALUATION_ONLY');
    const source = await db.externalSignalSource.update({ where: { id: 1 }, data: { enabled: true } });
    const body = Buffer.from(JSON.stringify({ externalStrategyKey: binding.externalStrategyKey, strategyRevision: revision.revision,
      event: 'EXIT_LONG', symbol: 'QQQ', timeframe: '1m', signalTime: new Date().toISOString() }));
    await admin.query('ALTER TABLE "TrackedPosition" RENAME COLUMN side TO temporary_side');
    try {
      const delivery = await ingestExternalSignal(source, token, { requestId: randomUUID(), receivedAt: new Date(), contentType: 'application/json',
        bodySizeBytes: body.length, rawPayloadHash: createHash('sha256').update(body).digest('hex'), body, tooLarge: false, validContentType: true }, db);
      expect(delivery?.status).toBe('NORMALIZED');
      const evaluations = await db.signalEvaluation.findMany({ where: { route: { routingRun: { signalId: delivery!.signalId! } } }, include: { gates: true } });
      expect(evaluations).toHaveLength(2);
      for (const evaluation of evaluations) {
        expect(evaluation).toMatchObject({ status: 'FAILED', outcome: null, reasonCode: 'EVALUATION_PROCESSING_FAILED', gates: [{ sequence: 1, gateKey: 'PROCESSING', result: 'FAILED' }] });
        expect(JSON.stringify(evaluation)).not.toContain('temporary_side');
      }
    } finally { await admin.query('ALTER TABLE "TrackedPosition" RENAME COLUMN temporary_side TO side'); }
  });

});
