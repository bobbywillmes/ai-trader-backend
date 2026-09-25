import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapMarketSplits } from '../../services/market-split-bootstrap.service.js';
import { readPersistedSplits } from '../../services/persisted-split-evidence.service.js';
import { publishTrendAssessments } from '../../services/trend-assessment.service.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('persisted split bootstrap PostgreSQL integrity', () => {
  const name = `market_split_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient;
  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; url.searchParams.delete('schema');
    sql = new Client({ connectionString: url.toString() }); await sql.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    for (const migration of (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort())
      await sql.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    for (const symbol of ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP']) {
      const security = await db.security.create({ data: { symbol, name: symbol, assetType: 'ETF', enabled: false } });
      await db.marketBar.create({ data: { securityId: security.id, timeframe: 'DAY_1', barStartAt: new Date('2026-09-01T04:00:00Z'), open: 100, high: 101, low: 99, close: 100, volume: 1000, provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', receivedAt: new Date() } });
    }
  }, 120_000);
  afterAll(async () => { await db?.$disconnect(); await sql?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end(); } });
  const fetchSplits = async (symbol: 'SPY' | 'QQQ' | 'DIA' | 'IWM' | 'RSP') => symbol === 'SPY' || symbol === 'IWM'
    ? [{ id: symbol, symbol, executionDate: '2026-09-10', splitFrom: symbol === 'SPY' ? 1 : 10, splitTo: symbol === 'SPY' ? 2 : 1, priceFactor: symbol === 'SPY' ? 0.5 : 10 }]
    : [];
  it('fails a Trend attempt closed when split coverage is absent', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('provider must not be called'); };
    try {
      const result = await publishTrendAssessments({ db, now: new Date('2026-09-01T20:31:00Z') });
      expect(result.blocked?.reasonCode).toBe('SPLIT_EVIDENCE_UNAVAILABLE');
    } finally { globalThis.fetch = original; }
  });
  it('previews, applies atomically, reads forward/reverse splits, and is idempotent', async () => {
    const args = { db, through: '2026-09-25', now: new Date('2026-09-25T20:00Z'), fetchSplits };
    expect((await bootstrapMarketSplits(args)).symbols.map(s => s.pendingEvents)).toEqual([1, 0, 0, 1, 0]);
    expect(await db.marketSplitCoverage.count()).toBe(0);
    expect(await db.marketSplitEvent.count()).toBe(0);
    expect((await bootstrapMarketSplits({ ...args, apply: true })).symbols.map(s => s.pendingEvents)).toEqual([1, 0, 0, 1, 0]);
    expect(await db.marketSplitCoverage.count()).toBe(5);
    expect(await db.marketSplitEvent.count()).toBe(2);
    expect((await readPersistedSplits(db, 'SPY', '2026-09-01', '2026-09-25'))[0]?.priceFactor).toBe(0.5);
    expect((await readPersistedSplits(db, 'IWM', '2026-09-01', '2026-09-25'))[0]?.priceFactor).toBe(10);
    expect(await readPersistedSplits(db, 'QQQ', '2026-09-01', '2026-09-25')).toEqual([]);
    expect((await bootstrapMarketSplits({ ...args, apply: true })).symbols.every(s => s.pendingEvents === 0 && s.coverageExists)).toBe(true);
  });
  it('refuses conflicting canonical event and immutable evidence changes', async () => {
    await expect(bootstrapMarketSplits({ db, through: '2026-09-25', fetchSplits: async symbol => symbol === 'SPY' ? [] : fetchSplits(symbol), apply: true })).rejects.toThrow('Conflicting canonical');
    const row = await db.marketSplitEvent.findFirstOrThrow();
    await expect(db.marketSplitEvent.update({ where: { id: row.id }, data: { splitFactor: 3 } })).rejects.toThrow('immutable');
    const coverage = await db.marketSplitCoverage.findFirstOrThrow();
    await expect(db.marketSplitCoverage.delete({ where: { id: coverage.id } })).rejects.toThrow('immutable');
  });
  it('publishes a fail-closed Trend attempt without consulting the provider', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('provider must not be called'); };
    try {
      const result = await publishTrendAssessments({ db, now: new Date('2026-09-01T20:31:00Z') });
      expect(result.blocked?.reasonCode).toBe('INSUFFICIENT_HISTORY');
      expect(result.blocked?.reasonCode).not.toBe('SPLIT_EVIDENCE_UNAVAILABLE');
    } finally { globalThis.fetch = original; }
  });
});
