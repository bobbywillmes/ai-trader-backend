import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { ingestExternalSignal, type SignalRequestEvidence } from '../../services/external-signal-ingestion.service.js';
import { hashWebhookToken } from '../../services/external-signal-config.service.js';
import { createStrategySignalBindingSchema } from '../../validators/external-signal.schema.js';

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && databaseUrl ? describe : describe.skip;

describeDatabase('external signal PostgreSQL atomicity and restrictive identities', () => {
  const schema = `external_signal_${randomUUID().replaceAll('-', '')}`;
  let admin: Client;
  let db: PrismaClient;
  const token = 'x'.repeat(43);
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
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema }) });
    await db.externalSignalSource.create({ data: { name: 'Integration fixture', provider: 'GENERIC_WEBHOOK', webhookTokenHash: hashWebhookToken(token) } });
    await db.strategySignalBinding.create({ data: { signalSourceId: 1, strategyId: 1, externalStrategyKey: 'test', expectedRevision: 'r1' } });
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      // Only the randomly named schema created by this test is removed.
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
  async function ingest(eventKey: string, metadata: object = {}, event: 'ENTRY_LONG' | 'EXIT_LONG' = 'ENTRY_LONG') {
    const source = await db.externalSignalSource.findUniqueOrThrow({ where: { id: 1 } });
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, externalStrategyKey: 'test', strategyRevision: 'r1',
      event, symbol: 'QQQ', timeframe: '15m', signalTime: '2026-01-01T00:00:00Z', eventKey, metadata }));
    const evidence: SignalRequestEvidence = { requestId: randomUUID(), receivedAt: new Date(), contentType: 'application/json',
      bodySizeBytes: body.length, body, rawPayloadHash: createHash('sha256').update(body).digest('hex'), tooLarge: false, validContentType: true };
    return ingestExternalSignal(source, token, evidence, db);
  }

  it('enforces uniqueness when two new binding inputs normalize to the same key', async () => {
    const input = (externalStrategyKey: string) => createStrategySignalBindingSchema.parse({ signalSourceId: 1, strategyId: 1, externalStrategyKey, expectedRevision: 'r1', enabled: true });
    await db.strategySignalBinding.create({ data: { ...input('  Mean\tReversion -- V2  '), enabled: true } });
    await expect(db.strategySignalBinding.create({ data: { ...input('mean---reversion-v2'), enabled: true } })).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.strategySignalBinding.count({ where: { externalStrategyKey: 'mean-reversion-v2' } })).toBe(1);
  });
  it('uses database uniqueness for 12 concurrent identical retries', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => ingest('concurrent')));
    expect(results.filter(row => row?.status === 'NORMALIZED')).toHaveLength(1);
    expect(results.filter(row => row?.status === 'DUPLICATE')).toHaveLength(11);
    expect(new Set(results.map(row => row?.signalId)).size).toBe(1);
    expect(await db.signal.count({ where: { externalEventKey: 'concurrent' } })).toBe(1);
  });
  it('rejects concurrent conflicting content and preserves the winning Signal', async () => {
    const results = await Promise.all([ingest('conflicting-race', { rsi: 20 }), ingest('conflicting-race', { rsi: 30 })]);
    expect(results.map(row => row?.status).sort()).toEqual(['NORMALIZED', 'REJECTED']);
    expect(results.find(row => row?.status === 'REJECTED')?.rejectionCode).toBe('EVENT_KEY_CONFLICT');
    expect(await db.systemEvent.count({ where: { type: 'external_signal_event_key_conflict' } })).toBe(1);
    expect(await db.signal.count({ where: { externalEventKey: 'conflicting-race' } })).toBe(1);
  });
  it('rolls back Signal creation when normalized Delivery insertion fails', async () => {
    await admin.query(`ALTER TABLE "SignalDelivery" ADD CONSTRAINT test_delivery_failure CHECK (status <> 'NORMALIZED') NOT VALID`);
    try {
      await expect(ingest('rollback')).rejects.toThrow();
      expect(await db.signal.count({ where: { externalEventKey: 'rollback' } })).toBe(0);
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
  it('restricts deleting historical relations and keeps history unchanged across config updates', async () => {
    const before = await db.signal.findMany({ orderBy: { id: 'asc' } });
    await expect(db.externalSignalSource.delete({ where: { id: 1 } })).rejects.toThrow();
    await expect(db.strategySignalBinding.delete({ where: { id: 1 } })).rejects.toThrow();
    await expect(admin.query('DELETE FROM "Strategy" WHERE id = 1')).rejects.toThrow();
    await expect(admin.query('DELETE FROM "Security" WHERE id = 1')).rejects.toThrow();
    await db.strategySignalBinding.update({ where: { id: 1 }, data: { expectedRevision: 'r2', enabled: false } });
    await db.externalSignalSource.update({ where: { id: 1 }, data: { enabled: false } });
    expect((await ingest('concurrent'))?.rejectionCode).toBe('SOURCE_DISABLED');
    expect(await db.signal.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});
