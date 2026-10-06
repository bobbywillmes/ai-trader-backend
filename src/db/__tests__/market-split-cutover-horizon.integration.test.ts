import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import { extendMarketSplitCoverage } from '../../services/market-split-bootstrap.service.js';
import { readPersistedSplits } from '../../services/persisted-split-evidence.service.js';
import { etInstant } from '../../services/market-calendar.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('split cutover horizon PostgreSQL integrity', () => {
  const name = `split_cutover_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient;
  const original = { cutover: env.MARKET_DAILY_TIINGO_CUTOVER_SESSION, resume: env.MARKET_DAILY_MASSIVE_RESUME_SESSION };
  beforeAll(async () => {
    (env as any).MARKET_DAILY_TIINGO_CUTOVER_SESSION = '2026-03-09';
    (env as any).MARKET_DAILY_MASSIVE_RESUME_SESSION = undefined;
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; url.searchParams.delete('schema');
    sql = new Client({ connectionString: url.toString() }); await sql.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    for (const migration of (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort())
      await sql.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    for (const symbol of ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP']) {
      const security = await db.security.create({ data: { symbol, name: symbol, assetType: 'ETF', enabled: false } });
      await db.marketBar.create({ data: { securityId: security.id, timeframe: 'DAY_1', barStartAt: etInstant('2026-03-02', 0), open: 100, high: 101, low: 99, close: 100, volume: 1000, provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', receivedAt: new Date() } });
    }
  }, 120_000);
  afterAll(async () => {
    (env as any).MARKET_DAILY_TIINGO_CUTOVER_SESSION = original.cutover;
    (env as any).MARKET_DAILY_MASSIVE_RESUME_SESSION = original.resume;
    await db?.$disconnect(); await sql?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end(); }
  });

  it('closes the weekend seam before a Monday Tiingo cutover without manual bootstrap', async () => {
    const calls: Array<[string, string, string]> = [];
    await extendMarketSplitCoverage({ db, now: new Date('2026-03-08T18:00:00Z'), fetchSplits: async (symbol, from, through) => { calls.push([symbol, from, through]); return []; } });
    expect(calls.every(([, from, through]) => from === '2026-03-02' && through === '2026-03-08')).toBe(true);
    await expect(readPersistedSplits(db, 'SPY', '2026-03-02', '2026-03-08')).resolves.toEqual([]);
  });

  it('extends across a reviewed holiday closure before the next-day cutover', async () => {
    (env as any).MARKET_DAILY_TIINGO_CUTOVER_SESSION = '2026-03-11';
    await db.marketCalendarException.create({ data: { sessionDate: new Date('2026-03-10'), type: 'CLOSED', name: 'Reviewed test closure' } });
    const calls: Array<[string, string, string]> = [];
    await extendMarketSplitCoverage({ db, now: new Date('2026-03-10T18:00:00Z'), fetchSplits: async (symbol, from, through) => { calls.push([symbol, from, through]); return []; } });
    expect(calls.every(([, from, through]) => from === '2026-03-09' && through === '2026-03-10')).toBe(true);
    expect(await db.marketSplitCoverage.count({ where: { throughDate: new Date('2026-03-10') } })).toBe(5);
  });
});
