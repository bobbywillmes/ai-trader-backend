import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { authenticateExternalSignal, ingestExternalSignal, type SignalRequestEvidence } from '../../services/external-signal-ingestion.service.js';
import { getExternalSignalWebhook, regenerateExternalSignalWebhook, hashWebhookKey, createStrategySignalBinding } from '../../services/external-signal-config.service.js';
import { changeStrategySignalRevision } from '../../services/strategy-signal-revision.service.js';
import { createStrategySignalBindingSchema } from '../../validators/external-signal.schema.js';

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
      CREATE TABLE "Strategy" (id integer PRIMARY KEY);
      CREATE TABLE "Security" (id integer PRIMARY KEY, symbol text UNIQUE NOT NULL);
      CREATE TYPE "SystemEventSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');
      CREATE TABLE "SystemEvent" (
        id serial PRIMARY KEY, "tradingAccountId" integer, "actorUserId" integer,
        type text NOT NULL, "entityType" text NOT NULL, "entityId" text NOT NULL,
        message text, "payloadJson" jsonb NOT NULL, severity "SystemEventSeverity" NOT NULL,
        "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed boolean NOT NULL DEFAULT false
      );
      INSERT INTO "Strategy" VALUES (1);
      INSERT INTO "Security" VALUES (1, 'QQQ');
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
    expect(await db.strategySignalRevision.findMany({ where: { strategySignalBindingId: 1 } })).toMatchObject([{ revision: 1, status: 'ACTIVE' }]);
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

  it('uses bar identity while treating changed signalTime or metadata as a payload conflict', async () => {
    const bar = '2025-12-31T23:45:00Z';
    expect((await ingest('bar-event', {}, 'ENTRY_LONG', 1, bar))?.status).toBe('NORMALIZED');
    expect((await ingest('bar-event', {}, 'ENTRY_LONG', 1, bar))?.status).toBe('DUPLICATE');
    expect((await ingest('bar-event', { rsi: 20 }, 'ENTRY_LONG', 1, bar))?.rejectionCode).toBe('EVENT_FINGERPRINT_CONFLICT');
    expect((await ingest('changed-signal-time', {}, 'ENTRY_LONG', 1, bar))?.rejectionCode).toBe('EVENT_FINGERPRINT_CONFLICT');
    expect((await ingest('bar-event', {}, 'ENTRY_LONG', 1, '2025-12-31T23:30:00Z'))?.status).toBe('NORMALIZED');
  });

  it('atomically creates initial active revision and rolls back on audit failure', async () => {
    const binding = await createStrategySignalBinding({ signalSourceId: 1, strategyId: 1, externalStrategyKey: 'initial' }, -1, db);
    expect(binding.revisions).toMatchObject([{ revision: 1, status: 'ACTIVE' }]);
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
    await admin.query(`ALTER TABLE "SignalDelivery" ADD CONSTRAINT test_delivery_failure CHECK (status <> 'NORMALIZED') NOT VALID`);
    try {
      await expect(ingest('rollback')).rejects.toThrow();
      expect(await db.signal.count({ where: { signalTime: new Date(occurrence('rollback')) } })).toBe(0);
    } finally {
      await admin.query(`ALTER TABLE "SignalDelivery" DROP CONSTRAINT test_delivery_failure`);
    }
  });
  it('records entry and exit metadata while trading tables do not even exist in its schema', async () => {
    for (const event of ['ENTRY_LONG', 'EXIT_LONG'] as const) {
      const result = await ingest(`no-trading-${event}`, { quantity: 999999, tradingAccountId: 42, bypassRisk: true }, event);
      expect(result?.status).toBe('NORMALIZED');
    }
    const tables = await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [schema]);
    for (const name of ['EntryDecision', 'OrderIntent', 'BrokerOrder', 'TrackedPosition']) {
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
});
