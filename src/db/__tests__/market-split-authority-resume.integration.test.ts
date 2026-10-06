import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { bootstrapMarketSplits, extendMarketSplitCoverage } from '../../services/market-split-bootstrap.service.js';
import { readPersistedSplits } from '../../services/persisted-split-evidence.service.js';
import { datesBetween, etInstant, marketSession } from '../../services/market-calendar.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('split authority resume PostgreSQL integrity', () => {
  const name = `split_resume_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient;
  const original = {
    cutover: env.MARKET_DAILY_TIINGO_CUTOVER_SESSION,
    resume: env.MARKET_DAILY_MASSIVE_RESUME_SESSION,
  };
  beforeAll(async () => {
    (env as any).MARKET_DAILY_TIINGO_CUTOVER_SESSION = '2026-02-01';
    (env as any).MARKET_DAILY_MASSIVE_RESUME_SESSION = '2026-03-01';
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; url.searchParams.delete('schema');
    sql = new Client({ connectionString: url.toString() }); await sql.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    for (const migration of (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort())
      await sql.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    for (const symbol of ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP']) {
      const security = await db.security.create({ data: { symbol, name: symbol, assetType: 'ETF', enabled: false } });
      for (const date of ['2026-01-30', '2026-03-02']) await db.marketBar.create({ data: {
        securityId: security.id, timeframe: 'DAY_1', barStartAt: etInstant(date, 0), open: 100, high: 101, low: 99, close: 100,
        volume: 1000, provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', receivedAt: new Date('2026-03-03T12:00:00Z'),
      } });
      for (const date of datesBetween('2026-02-01', '2026-02-28').filter(date => marketSession(date, []))) await db.marketBar.create({ data: {
        securityId: security.id, timeframe: 'DAY_1', barStartAt: new Date(`${date}T00:00:00Z`), open: 100, high: 101, low: 99, close: 100,
        volume: 1000, splitFactor: symbol === 'SPY' && date === '2026-02-17' ? 2 : 1,
        provider: 'TIINGO', adjustmentMode: 'UNADJUSTED', receivedAt: new Date('2026-03-01T12:00:00Z'),
      } });
      if (symbol === 'SPY') await db.marketSplitEvent.create({ data: { securityId: security.id, executionDate: new Date('2026-02-17'), splitFactor: 2, provider: 'TIINGO', provenance: 'TIINGO:EOD:SPY:2026-02-17', receivedAt: new Date('2026-02-18T01:00:00Z') } });
    }
  }, 120_000);
  afterAll(async () => {
    (env as any).MARKET_DAILY_TIINGO_CUTOVER_SESSION = original.cutover;
    (env as any).MARKET_DAILY_MASSIVE_RESUME_SESSION = original.resume;
    await db?.$disconnect(); await sql?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end(); }
  });

  it('keeps failed automatic requests atomic, then extends the resumed Massive segment through the current session without its DAY_1 bar', async () => {
    await bootstrapMarketSplits({ db, through: '2026-01-31', apply: true, now: new Date('2026-03-03T12:00:00Z'), fetchSplits: async () => [] });
    expect(await db.marketSplitCoverage.count()).toBe(5);
    await expect(extendMarketSplitCoverage({ db, now: new Date('2026-03-03T12:00:00Z'), fetchSplits: async symbol => {
      if (symbol === 'DIA') throw new Error('provider failure');
      return [];
    } })).rejects.toThrow('provider failure');
    expect(await db.marketSplitCoverage.count()).toBe(5);
    const calls: Array<[string, string, string]> = [];
    const result = await extendMarketSplitCoverage({ db, now: new Date('2026-03-03T12:00:00Z'), fetchSplits: async (symbol, from, through) => {
      calls.push([symbol, from, through]); return [];
    } });
    expect(result).toMatchObject({ dormant: false, extended: 5 });
    expect(calls.every(([, from, through]) => from === '2026-03-01' && through === '2026-03-03')).toBe(true);
    await expect(readPersistedSplits(db, 'SPY', '2026-03-01', '2026-03-03')).resolves.toEqual([]);
  });

  it('preserves and validates Tiingo split provenance between Massive coverage segments', async () => {
    const before = await db.marketSplitEvent.findFirstOrThrow({ where: { provider: 'TIINGO' } });
    const splits = await readPersistedSplits(db, 'SPY', '2026-01-30', '2026-03-02');
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({ executionDate: '2026-02-17', priceFactor: 0.5 });
    expect(await db.marketSplitEvent.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await db.marketSplitCoverage.findMany({ where: { security: { symbol: 'SPY' } }, orderBy: { fromDate: 'asc' }, select: { fromDate: true, throughDate: true, provider: true } })).toEqual([
      { fromDate: new Date('2026-01-30'), throughDate: new Date('2026-01-31'), provider: 'MASSIVE' },
      { fromDate: new Date('2026-03-01'), throughDate: new Date('2026-03-03'), provider: 'MASSIVE' },
    ]);
  });

});
