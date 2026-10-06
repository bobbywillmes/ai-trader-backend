import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('shared market panel Tiingo DAY_1 PostgreSQL cutover', () => {
  const database = `market_daily_tiingo_${randomUUID().replaceAll('-', '')}`;
  const originalUrl = process.env.DATABASE_URL;
  const originalCutover = process.env.MARKET_DAILY_TIINGO_CUTOVER_SESSION;
  let admin: Client; let db: Client;
  let service: typeof import('../../services/market-bar-ingestion.service.js');
  let tiingo: typeof import('../../services/tiingo-daily.service.js');
  let prismaModule: typeof import('../prisma.js');
  beforeAll(async () => {
    admin = new Client({ connectionString: originalUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(originalUrl!); url.pathname = `/${database}`; url.searchParams.delete('schema');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    for (const symbol of ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP'])
      await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ($1,$1,'STOCK',false,now())`, [symbol]);
    await db.query(`INSERT INTO "MarketBar" ("securityId",timeframe,"barStartAt",open,high,low,close,volume,provider,"adjustmentMode","receivedAt")
      SELECT id,'DAY_1','2026-09-23T04:00:00Z',100,101,99,100,1000,'MASSIVE','UNADJUSTED',now() FROM "Security" WHERE symbol='SPY'`);
    process.env.DATABASE_URL = url.toString(); process.env.MARKET_DAILY_TIINGO_CUTOVER_SESSION = '2026-09-24';
    service = await import('../../services/market-bar-ingestion.service.js');
    tiingo = await import('../../services/tiingo-daily.service.js');
    prismaModule = await import('../prisma.js');
  }, 120_000);
  afterAll(async () => {
    if (service) await (await import('../../services/market-data-lock.service.js')).closeMarketDataLockPool();
    if (tiingo) await tiingo.closeTiingoDailyLockPool();
    if (service) await (await import('../../services/market-minute-data-lock.service.js')).closeMarketMinuteDataLockPool();
    await prismaModule?.prisma.$disconnect();
    process.env.DATABASE_URL = originalUrl;
    if (originalCutover === undefined) delete process.env.MARKET_DAILY_TIINGO_CUTOVER_SESSION;
    else process.env.MARKET_DAILY_TIINGO_CUTOVER_SESSION = originalCutover;
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });
  const fetch = vi.fn(async (symbol: string, date: string) => [{ barStartAt: new Date(`${date}T00:00:00Z`),
    open: 100, high: 101, low: 99, close: 100, volume: symbol === 'SPY' ? 1234.125 : 1000,
    splitFactor: symbol === 'SPY' ? 2 : 1 }]);
  it('waits until 20:15 ET, then acquires five ETF sensors without a Breadth revision', async () => {
    expect(await service.syncDailyBars(new Date('2026-09-24T23:00:00Z'), fetch)).toMatchObject({ inserted: 0, missing: 0 });
    expect(fetch).not.toHaveBeenCalled();
    const result = await service.syncDailyBars(new Date('2026-09-25T00:16:00Z'), fetch);
    expect(result.inserted).toBe(5);
    expect(fetch.mock.calls.map(call => call[0]).sort()).toEqual(['DIA', 'IWM', 'QQQ', 'RSP', 'SPY']);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE provider='TIINGO' AND timeframe='DAY_1'`)).rows[0].n).toBe(5);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketSplitEvent" WHERE provider='TIINGO'`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT volume::text FROM "MarketBar" b JOIN "Security" s ON s.id=b."securityId" WHERE s.symbol='SPY' AND b.provider='TIINGO'`)).rows[0].volume).toBe('1234.125000');
    expect((await db.query(`SELECT count(*)::int n FROM "BreadthUniverseRevision"`)).rows[0].n).toBe(0);
    fetch.mockClear();
    expect(await service.syncDailyBars(new Date('2026-09-25T01:20:00Z'), fetch)).toMatchObject({ inserted: 0, missing: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails on a wrong-provider canonical session before any Tiingo request', async () => {
    await db.query(`INSERT INTO "MarketBar" ("securityId",timeframe,"barStartAt",open,high,low,close,volume,provider,"adjustmentMode","receivedAt")
      SELECT id,'DAY_1','2026-09-25T04:00:00Z',100,101,99,100,1000,'MASSIVE','UNADJUSTED',now() FROM "Security" WHERE symbol='RSP'`);
    fetch.mockClear();
    await expect(service.syncDailyBars(new Date('2026-09-26T00:16:00Z'), fetch)).rejects.toThrow('provider conflict');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retention removes ETF Tiingo bars and pauses their acquisition while Massive history survives', async () => {
    const preview = await tiingo.tiingoRetentionPurge();
    expect(preview.counts.marketBars).toBe(5);
    await tiingo.tiingoRetentionPurge(true, 'DELETE-TIINGO-DATA');
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE provider='TIINGO'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE provider='MASSIVE'`)).rows[0].n).toBe(2);
    await expect(service.syncDailyBars(new Date('2026-09-27T01:20:00Z'), fetch)).rejects.toThrow('paused');
    expect(fetch).not.toHaveBeenCalled();
  });
});
