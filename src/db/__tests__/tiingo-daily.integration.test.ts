import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Tiingo daily PostgreSQL ingestion', () => {
  const database = `tiingo_daily_${randomUUID().replaceAll('-', '')}`;
  const originalUrl = process.env.DATABASE_URL;
  let admin: Client; let db: Client;
  let service: typeof import('../../services/tiingo-daily.service.js');
  let TiingoRequestError: typeof import('../../integrations/tiingo/rest.client.js').TiingoRequestError;
  let prismaModule: typeof import('../prisma.js');
  let revisionId: number;
  beforeAll(async () => {
    admin = new Client({ connectionString: originalUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(originalUrl!); url.pathname = `/${database}`; url.searchParams.delete('schema');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    const aapl = (await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ('AAPL','Apple','STOCK',false,now()) RETURNING id`)).rows[0].id;
    const brk = (await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ('BRK.B','Berkshire','STOCK',false,now()) RETURNING id`)).rows[0].id;
    revisionId = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-01',2) RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2),($1,$3)`, [revisionId, aapl, brk]);
    process.env.DATABASE_URL = url.toString();
    TiingoRequestError = (await import('../../integrations/tiingo/rest.client.js')).TiingoRequestError;
    service = await import('../../services/tiingo-daily.service.js');
    prismaModule = await import('../prisma.js');
  }, 120_000);
  afterAll(async () => {
    await service?.closeTiingoDailyLockPool();
    if (service) await (await import('../../services/market-minute-data-lock.service.js')).closeMarketMinuteDataLockPool();
    await prismaModule?.prisma.$disconnect();
    process.env.DATABASE_URL = originalUrl;
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });
  const now = new Date('2026-09-28T12:00:00Z');
  const row = (date: string, splitFactor = 1, close = 101) => ({ barStartAt: new Date(`${date}T00:00:00Z`), open: 100, high: 102, low: 99, close, volume: 1234, splitFactor });
  it('previews frozen disabled members without provider calls or writes and rejects escape', async () => {
    let calls = 0;
    const fetchDaily = async () => { calls++; return []; };
    const result = await service.tiingoDailyBackfill({ revisionId, from: '2026-09-24', through: '2026-09-25', now, fetchDaily });
    expect(result.preview).toMatchObject({ memberCount: 2, selectedSecurities: 2, expectedRequests: 2 });
    expect(calls).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar"`)).rows[0].n).toBe(0);
    await expect(service.tiingoDailyBackfill({ revisionId, from: '2026-09-24', through: '2026-09-25', symbols: ['MSFT'], now, fetchDaily })).rejects.toThrow('frozen revision');
    const broken = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-02',3) RETURNING id`)).rows[0].id;
    await expect(service.tiingoDailyBackfill({ revisionId: broken, from: '2026-09-24', through: '2026-09-25', now, fetchDaily })).rejects.toThrow('memberCount integrity');
  });
  it('ingests one range per symbol with canonical raw bars and split evidence', async () => {
    const calls: string[] = [];
    const result = await service.tiingoDailyBackfill({ revisionId, from: '2026-09-24', through: '2026-09-25', symbols: ['BRK.B'], apply: true, now, fetchDaily: async (symbol, from, through) => { calls.push(`${symbol}:${from}:${through}`); return [row('2026-09-24'), row('2026-09-25', 2)]; } });
    expect(calls).toEqual(['BRK-B:2026-09-24:2026-09-25']);
    expect(result.counts).toMatchObject({ requested: 1, succeeded: 2, splitEvents: 1, conflict: 0 });
    const bars = (await db.query(`SELECT b.provider,b."adjustmentMode",b."splitFactor"::text factor,b.close::text close,b.volume::text volume,s.enabled FROM "MarketBar" b JOIN "Security" s ON s.id=b."securityId" WHERE s.symbol='BRK.B' ORDER BY b."barStartAt"`)).rows;
    expect(bars).toHaveLength(2);
    expect(bars[1]).toMatchObject({ provider: 'TIINGO', adjustmentMode: 'UNADJUSTED', factor: '2.0000000000', close: '101.0000000000', volume: '1234.000000', enabled: false });
    expect((await db.query(`SELECT provider,provenance FROM "MarketSplitEvent"`)).rows[0]).toMatchObject({ provider: 'TIINGO', provenance: 'TIINGO:EOD:BRK.B:2026-09-25' });
    expect((await db.query(`SELECT count(*)::int n FROM "MarketSplitCoverage"`)).rows[0].n).toBe(0);
    const retry = await service.tiingoDailyBackfill({ revisionId, from: '2026-09-24', through: '2026-09-25', symbols: ['BRK.B'], apply: true, now, fetchDaily: async () => { throw new Error('must not refetch complete range'); } });
    expect(retry.preview.expectedRequests).toBe(0);
  });
  it('preserves Massive collision and reports a differing Tiingo observation', async () => {
    const aapl = (await db.query(`SELECT id FROM "Security" WHERE symbol='AAPL'`)).rows[0].id;
    await db.query(`INSERT INTO "MarketBar" ("securityId",timeframe,"barStartAt",open,high,low,close,volume,provider,"adjustmentMode","receivedAt") VALUES ($1,'DAY_1','2026-09-24',100,102,99,101,1234,'MASSIVE','UNADJUSTED',now())`, [aapl]);
    const result = await service.tiingoDailyBackfill({ revisionId, from: '2026-09-24', through: '2026-09-25', symbols: ['AAPL'], apply: true, now, fetchDaily: async () => [row('2026-09-24'), row('2026-09-25')] });
    expect(result.counts.otherProvider).toBe(1);
    expect((await db.query(`SELECT provider FROM "MarketBar" WHERE "securityId"=$1 AND "barStartAt"='2026-09-24'`, [aapl])).rows[0].provider).toBe('MASSIVE');
    const brk = (await db.query(`SELECT id FROM "Security" WHERE symbol='BRK.B'`)).rows[0].id;
    // A missing earlier date forces a range fetch containing the immutable later Tiingo row.
    const conflict = await service.tiingoDailyBackfill({ revisionId, from: '2026-09-23', through: '2026-09-24', symbols: ['BRK.B'], apply: true, now, fetchDaily: async () => [row('2026-09-24', 1, 100)] });
    expect(conflict.counts.conflict).toBe(1);
    expect((await db.query(`SELECT close::text close FROM "MarketBar" WHERE "securityId"=$1 AND "barStartAt"='2026-09-24'`, [brk])).rows[0].close).toBe('101.0000000000');
  });
  it('rolls back a new bar when canonical split evidence conflicts', async () => {
    const aapl = (await db.query(`SELECT id FROM "Security" WHERE symbol='AAPL'`)).rows[0].id;
    await db.query(`INSERT INTO "MarketSplitEvent" ("securityId","executionDate","splitFactor",provider,provenance,"receivedAt") VALUES ($1,'2026-09-23',3,'MASSIVE','MASSIVE:test',now())`, [aapl]);
    const result = await service.tiingoDailyBackfill({ revisionId, from: '2026-09-23', through: '2026-09-23', symbols: ['AAPL'], apply: true, now, fetchDaily: async () => [row('2026-09-23', 2)] });
    expect(result.counts.conflict).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE "securityId"=$1 AND "barStartAt"='2026-09-23'`, [aapl])).rows[0].n).toBe(0);
  });
  it('bounds concurrent symbol fetches and counts out-of-order missing results', async () => {
    const symbols = Array.from({ length: 20 }, (_, i) => `TEST${String(i).padStart(2, '0')}`);
    const ids: number[] = [];
    for (const symbol of symbols) {
      ids.push((await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ($1,$1,'STOCK',false,now()) RETURNING id`, [symbol])).rows[0].id);
    }
    const largeRevision = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-03',20) RETURNING id`)).rows[0].id;
    for (const id of ids) await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [largeRevision, id]);
    let active = 0; let maximum = 0; const called: string[] = [];
    const fetchDaily = async (symbol: string) => {
      called.push(symbol); active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return symbol === symbols[0] ? [] : [row('2026-09-22')];
    };
    const result = await service.tiingoDailyBackfill({ revisionId: largeRevision, from: '2026-09-22', through: '2026-09-22', apply: true, now, fetchDaily });
    expect(maximum).toBe(8);
    expect(called.sort()).toEqual(symbols);
    expect(result.counts).toMatchObject({ requested: 20, succeeded: 19, missing: 1, failed: 0, conflict: 0 });
    const narrowed = await service.tiingoDailyBackfill({ revisionId: largeRevision, from: '2026-09-21', through: '2026-09-21', symbols: symbols.slice(0, 3), apply: true, now, fetchDaily: async () => [row('2026-09-21')] });
    expect(narrowed.counts).toMatchObject({ requested: 3, succeeded: 3, missing: 0 });
  });
  it('persists empty-session retries, processes older due work, and resolves a terminal manual recheck', async () => {
    const securityId = (await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ('NHP','NHP','STOCK',false,now()) RETURNING id`)).rows[0].id;
    const revision = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-05',1) RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [revision, securityId]);
    const session = '2026-09-24';
    const firstAt = new Date('2026-09-28T21:00:00Z');
    const empty = async () => [];
    const first = await service.tiingoDailyBackfill({ revisionId: revision, from: session, through: session, apply: true, now: firstAt, fetchDaily: empty });
    expect(first.counts).toMatchObject({ requested: 1, missing: 1, retryScheduled: 1, failed: 0 });
    const state = async () => (await db.query(`SELECT status,"attemptCount","nextAttemptAt","resolvedAt" FROM "TiingoDailyObservationState" WHERE "securityId"=$1 AND "sessionDate"=$2`, [securityId, session])).rows[0];
    expect(await state()).toMatchObject({ status: 'RETRYING', attemptCount: 1, nextAttemptAt: new Date('2026-09-28T22:00:00Z') });
    let calls = 0;
    const early = await service.tiingoDailyBackfill({ revisionId: revision, from: session, through: session, apply: true, now: new Date('2026-09-28T21:59:59Z'), fetchDaily: async () => { calls++; return []; } });
    expect(early.preview).toMatchObject({ expectedRequests: 0, deferredRetries: 1 });
    expect(calls).toBe(0);
    await service.tiingoDailyBackfill({ revisionId: revision, from: session, through: session, apply: true, now: new Date('2026-09-28T22:00:00Z'), fetchDaily: empty });
    expect(await state()).toMatchObject({ status: 'RETRYING', attemptCount: 2, nextAttemptAt: new Date('2026-09-29T02:00:00Z') });
    const workerCalls: string[] = [];
    const third = await service.syncTiingoDaily(new Date('2026-09-29T02:00:00Z'), async (_symbol, from) => { workerCalls.push(from); return from === session ? [] : [row(from)]; });
    expect(third.notDue).toBe(false);
    expect(workerCalls).toContain(session);
    expect(workerCalls).toContain('2026-09-28');
    expect(await state()).toMatchObject({ status: 'RETRYING', attemptCount: 3, nextAttemptAt: new Date('2026-09-30T02:00:00Z') });
    await service.syncTiingoDaily(new Date('2026-09-30T02:00:00Z'), async (_symbol, from) => from === session ? [] : [row(from)]);
    expect(await state()).toMatchObject({ status: 'NO_EOD_COVERAGE', attemptCount: 4, nextAttemptAt: null });
    const terminal = await service.tiingoDailyBackfill({ revisionId: revision, from: session, through: session, now: new Date('2026-10-01T02:00:00Z'), fetchDaily: async () => { throw new Error('preview called provider'); } });
    expect(terminal.preview).toMatchObject({ expectedRequests: 0, noEodCoverage: 1 });
    const terminalWorkerCalls: string[] = [];
    await service.syncTiingoDaily(new Date('2026-10-01T02:00:00Z'), async (_symbol, from) => { terminalWorkerCalls.push(from); return [row(from)]; });
    expect(terminalWorkerCalls).not.toContain(session);
    const recheckPreview = await service.tiingoDailyBackfill({ revisionId: revision, from: session, through: session, retryTerminal: true, now: new Date('2026-10-01T02:00:00Z') });
    expect(recheckPreview.preview.expectedRequests).toBe(1);
    await service.tiingoDailyBackfill({ revisionId: revision, from: session, through: session, retryTerminal: true, apply: true, now: new Date('2026-10-01T02:00:00Z'), fetchDaily: empty });
    expect(await state()).toMatchObject({ status: 'NO_EOD_COVERAGE', attemptCount: 4, nextAttemptAt: null });
    const resolved = await service.tiingoDailyBackfill({ revisionId: revision, from: session, through: session, retryTerminal: true, apply: true, now: new Date('2026-10-01T03:00:00Z'), fetchDaily: async () => [row(session)] });
    expect(resolved.counts.resolvedPreviouslyMissing).toBe(1);
    expect(await state()).toMatchObject({ status: 'RESOLVED', attemptCount: 4, nextAttemptAt: null, resolvedAt: expect.any(Date) });
    const failed = await service.tiingoDailyBackfill({ revisionId: revision, from: '2026-09-25', through: '2026-09-25', apply: true, now: new Date('2026-10-01T03:00:00Z'), fetchDaily: async () => { throw new TiingoRequestError(429, 0); } });
    expect(failed.counts).toMatchObject({ failed: 1, retries: 3, throttled: 4, missing: 0 });
    expect((await db.query(`SELECT count(*)::int n FROM "TiingoDailyObservationState" WHERE "securityId"=$1 AND "sessionDate"='2026-09-25'`, [securityId])).rows[0].n).toBe(0);
    await service.tiingoDailyBackfill({ revisionId: revision, from: '2026-09-23', through: '2026-09-23', apply: true, now: new Date('2026-10-01T03:00:00Z'), fetchDaily: empty });
    const retryResolved = await service.tiingoDailyBackfill({ revisionId: revision, from: '2026-09-23', through: '2026-09-23', apply: true, now: new Date('2026-10-01T04:00:00Z'), fetchDaily: async () => [row('2026-09-23')] });
    expect(retryResolved.counts.resolvedPreviouslyMissing).toBe(1);
    expect((await db.query(`SELECT status FROM "TiingoDailyObservationState" WHERE "securityId"=$1 AND "sessionDate"='2026-09-23'`, [securityId])).rows[0].status).toBe('RESOLVED');
  });
  it('reports latest-session untracked, retrying, due, and terminal coverage separately', async () => {
    const at = new Date('2026-09-28T12:00:00Z');
    const securityId = (await db.query(`SELECT id FROM "Security" WHERE symbol='NHP'`)).rows[0].id;
    expect(await service.tiingoDailyStatus(at)).toMatchObject({ memberCount: 1, latestEligibleSessionDate: '2026-09-25', missing: 1, untrackedMissing: 1, retrying: 0, dueRetries: 0, noEodCoverage: 0 });
    await db.query(`INSERT INTO "TiingoDailyObservationState" ("securityId","sessionDate",status,"attemptCount","firstAttemptAt","lastAttemptAt","nextAttemptAt","reasonCode","updatedAt") VALUES ($1,'2026-09-25','RETRYING',1,$2,$2,'2026-09-28T13:00:00Z','PROVIDER_NO_EOD_BAR',now())`, [securityId, at]);
    expect(await service.tiingoDailyStatus(at)).toMatchObject({ missing: 1, untrackedMissing: 0, retrying: 1, dueRetries: 0, noEodCoverage: 0 });
    await db.query(`UPDATE "TiingoDailyObservationState" SET "nextAttemptAt"='2026-09-28T11:00:00Z' WHERE "securityId"=$1 AND "sessionDate"='2026-09-25'`, [securityId]);
    expect(await service.tiingoDailyStatus(at)).toMatchObject({ retrying: 1, dueRetries: 1 });
    await db.query(`UPDATE "TiingoDailyObservationState" SET status='NO_EOD_COVERAGE',"nextAttemptAt"=NULL WHERE "securityId"=$1 AND "sessionDate"='2026-09-25'`, [securityId]);
    expect(await service.tiingoDailyStatus(at)).toMatchObject({ missing: 1, untrackedMissing: 0, retrying: 0, dueRetries: 0, noEodCoverage: 1 });
  });
  it('enforces observation-state attempt and status invariants in PostgreSQL', async () => {
    const securityId = (await db.query(`SELECT id FROM "Security" WHERE symbol='NHP'`)).rows[0].id;
    const insert = (status: string, attempts: number, next: string | null, resolved: string | null) => db.query(`INSERT INTO "TiingoDailyObservationState" ("securityId","sessionDate",status,"attemptCount","firstAttemptAt","lastAttemptAt","nextAttemptAt","resolvedAt","reasonCode","updatedAt") VALUES ($1,'2026-09-21',$2,$3,now(),now(),$4,$5,'TEST',now())`, [securityId, status, attempts, next, resolved]);
    await expect(insert('RETRYING', 0, '2026-09-28T12:00:00Z', null)).rejects.toThrow();
    await expect(insert('RETRYING', 1, null, null)).rejects.toThrow();
    await expect(insert('NO_EOD_COVERAGE', 4, '2026-09-28T12:00:00Z', null)).rejects.toThrow();
    await expect(insert('RESOLVED', 1, null, null)).rejects.toThrow();
  });
  it('serializes jobs and purges Tiingo evidence only', async () => {
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const first = service.withTiingoDailyLock(async () => { entered(); await hold; });
    await started;
    try {
      await expect(service.withTiingoDailyLock(async () => {})).rejects.toMatchObject({ statusCode: 409 });
      const revision = (await db.query(`SELECT id FROM "BreadthUniverseRevision" WHERE "effectiveFrom"='2026-09-05'`)).rows[0].id;
      await expect(service.tiingoDailyBackfill({ revisionId: revision, from: '2026-09-24', through: '2026-09-24', apply: true, now, fetchDaily: async () => { throw new Error('lock must prevent request'); } })).rejects.toMatchObject({ statusCode: 409 });
    }
    finally { release(); }
    await first;
    const barsByProviderAndSession = (await db.query(`SELECT provider,"barStartAt"::date::text AS session_date,count(*)::int n FROM "MarketBar" GROUP BY provider,"barStartAt"::date ORDER BY provider,session_date`)).rows;
    expect(barsByProviderAndSession).toEqual([
      { provider: 'MASSIVE', session_date: '2026-09-24', n: 1 },
      ...Object.entries({ '2026-09-21': 3, '2026-09-22': 20, '2026-09-23': 2, '2026-09-24': 2, '2026-09-25': 2, '2026-09-28': 1, '2026-09-29': 1, '2026-09-30': 1 }).map(([session_date, n]) => ({ provider: 'TIINGO', session_date, n })),
    ]);
    const securityId = (await db.query(`SELECT id FROM "Security" WHERE symbol='AAPL'`)).rows[0].id;
    await db.query(`INSERT INTO "MarketBar" ("securityId",timeframe,"barStartAt",open,high,low,close,volume,provider,"adjustmentMode","receivedAt") VALUES ($1,'MINUTE_15','2026-09-24T13:30:00Z',100,101,99,100,15,'TIINGO','UNADJUSTED',now())`, [securityId]);
    const tiingoBarCount = 1 + barsByProviderAndSession.filter(row => row.provider === 'TIINGO').reduce((total, row) => total + row.n, 0);
    const preview = await service.tiingoRetentionPurge();
    expect(preview).toMatchObject({ preview: true, counts: { marketBars: tiingoBarCount, marketSplitEvents: 1, observationStates: 5 } });
    const applied = await service.tiingoRetentionPurge(true, 'DELETE-TIINGO-DATA');
    expect(applied.preview).toBe(false);
    expect(applied.counts).toEqual(preview.counts);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE provider='TIINGO'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE provider='TIINGO' AND timeframe='MINUTE_15'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "TiingoDailyObservationState"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE provider='MASSIVE'`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketSplitEvent" WHERE provider='MASSIVE'`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT value FROM "Setting" WHERE key='tiingoDailyIngestionPaused'`)).rows[0].value).toBe('true');
  });
});
