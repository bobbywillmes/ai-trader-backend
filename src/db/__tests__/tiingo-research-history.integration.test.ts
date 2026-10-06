import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Tiingo research-history acquisition', () => {
  const database = `tiingo_research_history_${randomUUID().replaceAll('-', '')}`;
  const originalUrl = process.env.DATABASE_URL;
  let admin: Client; let db: Client;
  let service: typeof import('../../services/tiingo-daily.service.js');
  let prismaModule: typeof import('../prisma.js');
  let revisionId: number; let securityId: number;
  const now = new Date('2026-09-28T12:00:00Z');
  const row = (date: string, close = 100, splitFactor = 1) => ({ barStartAt: new Date(`${date}T00:00:00Z`), open: close, high: close, low: close, close, volume: 1000, splitFactor });
  beforeAll(async () => {
    admin = new Client({ connectionString: originalUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(originalUrl!); url.pathname = `/${database}`; url.searchParams.delete('schema');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    securityId = (await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ('HIST','Historical test','STOCK',false,now()) RETURNING id`)).rows[0].id;
    revisionId = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-01',1) RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [revisionId, securityId]);
    process.env.DATABASE_URL = url.toString();
    service = await import('../../services/tiingo-daily.service.js');
    prismaModule = await import('../prisma.js');
  }, 120_000);
  afterAll(async () => {
    await service?.closeTiingoDailyLockPool(); await prismaModule?.prisma.$disconnect();
    process.env.DATABASE_URL = originalUrl;
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });
  const stateCount = async () => (await db.query(`SELECT count(*)::int n FROM "TiingoDailyObservationState" WHERE "securityId"=$1`, [securityId])).rows[0].n as number;
  it('previews without calls or writes and persists sparse historical bars without scheduling hundreds of gaps', async () => {
    let calls = 0;
    const input = { revisionId, from: '2025-01-01', through: '2025-12-31', researchHistory: true, now };
    const preview = await service.tiingoDailyBackfill({ ...input, fetchDaily: async () => { calls++; return []; } });
    expect(preview.preview).toMatchObject({ acquisitionMode: 'RESEARCH_HISTORY', expectedRequests: 1 });
    expect(calls).toBe(0);
    expect(await stateCount()).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar"`)).rows[0].n).toBe(0);
    const result = await service.tiingoDailyBackfill({ ...input, apply: true, fetchDaily: async () => { calls++; return [row('2025-01-02'), row('2025-07-01', 50, 2)]; } });
    expect(calls).toBe(1);
    expect(result.preview.acquisitionMode).toBe('RESEARCH_HISTORY');
    expect(result.counts).toMatchObject({ requested: 1, succeeded: 2, splitEvents: 1, missing: result.counts.historicalMissing, retryScheduled: 0, terminalizedNoEodCoverage: 0 });
    expect(result.counts.historicalMissing).toBeGreaterThan(200);
    expect(await stateCount()).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE provider='TIINGO'`)).rows[0].n).toBe(2);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketSplitEvent" WHERE provider='TIINGO'`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthObservation"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment"`)).rows[0].n).toBe(0);
  });
  it('keeps operational retries and resolves a pre-existing state when research history returns a real bar', async () => {
    const operational = await service.tiingoDailyBackfill({ revisionId, from: '2026-09-24', through: '2026-09-24', apply: true, now, fetchDaily: async () => [] });
    expect(operational.preview.acquisitionMode).toBe('OPERATIONAL');
    expect(operational.counts).toMatchObject({ missing: 1, historicalMissing: 0, retryScheduled: 1 });
    expect((await db.query(`SELECT status,"attemptCount" FROM "TiingoDailyObservationState" WHERE "securityId"=$1 AND "sessionDate"='2026-09-24'`, [securityId])).rows[0]).toMatchObject({ status: 'RETRYING', attemptCount: 1 });
    const later = new Date(now.getTime() + 2 * 60 * 60_000);
    const research = await service.tiingoDailyBackfill({ revisionId, from: '2026-09-23', through: '2026-09-25', researchHistory: true, apply: true, now: later, fetchDaily: async () => [row('2026-09-24')] });
    expect(research.counts).toMatchObject({ succeeded: 1, resolvedPreviouslyMissing: 1, missing: 2, historicalMissing: 2, retryScheduled: 0 });
    expect((await db.query(`SELECT status,"attemptCount","nextAttemptAt" FROM "TiingoDailyObservationState" WHERE "securityId"=$1 AND "sessionDate"='2026-09-24'`, [securityId])).rows[0]).toMatchObject({ status: 'RESOLVED', attemptCount: 1, nextAttemptAt: null });
    expect(await stateCount()).toBe(1);
    const noHistoricalDue = await prismaModule.prisma.tiingoDailyObservationState.count({ where: { securityId, status: 'RETRYING', nextAttemptAt: { lte: new Date('2027-01-01') } } });
    expect(noHistoricalDue).toBe(0);
    const worker = await service.syncTiingoDaily(later, async (_symbol, from) => from === '2026-09-25' ? [row(from)] : []);
    expect(worker.result?.counts.requested).toBe(1);
    const idle = await service.syncTiingoDaily(new Date(later.getTime() + 15 * 60_000), async () => { throw new Error('historical gaps must not become worker retries'); });
    expect(idle.notDue).toBe(true);
    expect(await stateCount()).toBe(1);
  });
  it('rejects research history combined with terminal recheck before provider access', async () => {
    let calls = 0;
    await expect(service.tiingoDailyBackfill({ revisionId, from: '2025-01-01', through: '2025-01-02', researchHistory: true, retryTerminal: true, now, fetchDaily: async () => { calls++; return []; } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.tiingoDailyBackfill({ revisionId, from: '2025-01-01', through: '2025-01-02', researchHistory: true, retryTerminal: true, apply: true, now, fetchDaily: async () => { calls++; return []; } })).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toBe(0);
  });
  it('does not advance an existing retry state when research history omits it again', async () => {
    await service.tiingoDailyBackfill({ revisionId, from: '2026-09-22', through: '2026-09-22', apply: true, now, fetchDaily: async () => [] });
    const before = (await db.query(`SELECT status,"attemptCount","nextAttemptAt" FROM "TiingoDailyObservationState" WHERE "securityId"=$1 AND "sessionDate"='2026-09-22'`, [securityId])).rows[0];
    const result = await service.tiingoDailyBackfill({ revisionId, from: '2026-09-22', through: '2026-09-23', researchHistory: true, apply: true, now: new Date(now.getTime() + 2 * 60 * 60_000), fetchDaily: async () => [] });
    expect(result.counts).toMatchObject({ missing: 2, historicalMissing: 2, retryScheduled: 0, terminalizedNoEodCoverage: 0 });
    expect((await db.query(`SELECT status,"attemptCount","nextAttemptAt" FROM "TiingoDailyObservationState" WHERE "securityId"=$1 AND "sessionDate"='2026-09-22'`, [securityId])).rows[0]).toEqual(before);
    expect((await db.query(`SELECT count(*)::int n FROM "TiingoDailyObservationState" WHERE "securityId"=$1 AND "sessionDate"='2026-09-23'`, [securityId])).rows[0].n).toBe(0);
  });
});
