import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('market data PostgreSQL integrity and full migration replay', () => {
  const schema = `market_data_${randomUUID().replaceAll('-', '')}`;
  let db: Client;
  let admin: Client;
  let securityId: number;
  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${schema}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${schema}`;
    url.searchParams.delete('schema');
    db = new Client({ connectionString: url.toString() });
    await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    securityId = (await db.query(`INSERT INTO "Security" (symbol, name, "assetType", "updatedAt") VALUES ('SPY', 'SPY fixture', 'ETF', now()) RETURNING id`)).rows[0].id;
  }, 120_000);
  afterAll(async () => {
    if (db) { await db.query('ROLLBACK'); await db.end(); }
    // Only the randomly named database created by this test is removed.
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${schema}"`); await admin.end(); }
  });
  async function calendar(date: string, type: string, close: number | null) {
    return db.query(`INSERT INTO "MarketCalendarException" ("sessionDate", name, type, "closeTimeMinutesEt", "updatedAt") VALUES ($1,'Test',$2,$3,now())`, [date, type, close]);
  }
  async function bar(date: string, overrides: { open?: string; high?: string; low?: string; close?: string; volume?: string } = {}) {
    return db.query(`INSERT INTO "MarketBar" ("securityId", timeframe, "barStartAt", open, high, low, close, volume, provider, "adjustmentMode", "receivedAt")
      VALUES ($1,'DAY_1',$2,$3,$4,$5,$6,$7,'MASSIVE','UNADJUSTED',now()) ON CONFLICT ("securityId",timeframe,"barStartAt") DO NOTHING RETURNING id`,
    [securityId, date, overrides.open ?? '100', overrides.high ?? '102', overrides.low ?? '99', overrides.close ?? '101', overrides.volume ?? '1000.25']);
  }
  it('replays every migration into an empty schema', async () => {
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment"`)).rows[0].n).toBe(0);
  });
  it('enforces unique calendar dates and permits mutable configuration', async () => {
    await calendar('2026-12-25', 'CLOSED', null);
    await expect(calendar('2026-12-25', 'CLOSED', null)).rejects.toThrow();
    await db.query(`UPDATE "MarketCalendarException" SET name='Christmas' WHERE "sessionDate"='2026-12-25'`);
    await db.query(`DELETE FROM "MarketCalendarException" WHERE "sessionDate"='2026-12-25'`);
  });
  it.each([['CLOSED', 780], ['EARLY_CLOSE', null], ['EARLY_CLOSE', 570], ['EARLY_CLOSE', 960]])('rejects invalid calendar %s/%s', async (type, close) => {
    await expect(calendar('2026-11-27', String(type), close as number | null)).rejects.toThrow();
  });
  it('accepts an early close', async () => { await calendar('2026-11-27', 'EARLY_CLOSE', 780); });
  it('overlap is a no-op and cannot rewrite accepted data', async () => {
    const date = '2026-09-14T04:00:00Z';
    expect((await bar(date)).rowCount).toBe(1);
    expect((await bar(date, { close: '100' })).rowCount).toBe(0);
    expect((await db.query(`SELECT close::text FROM "MarketBar" WHERE "barStartAt"=$1`, [date])).rows[0].close).toBe('101.0000000000');
  });
  it('rejects update, delete and deletion of referenced Security', async () => {
    await expect(db.query(`UPDATE "MarketBar" SET close=100`)).rejects.toThrow('immutable');
    await expect(db.query(`DELETE FROM "MarketBar"`)).rejects.toThrow('immutable');
    await expect(db.query(`DELETE FROM "Security" WHERE id=$1`, [securityId])).rejects.toThrow();
  });
  it.each([{ low: '103' }, { high: '100' }, { open: '0' }, { volume: '-1' }, { open: 'NaN' }, { volume: 'NaN' }])('rejects invalid OHLCV %j', async values => {
    await expect(bar('2026-09-15T04:00:00Z', values)).rejects.toThrow();
  });
  async function assessment(attempt: number, status: string, raw: string | null, dimension = 'TREND', algorithm = 'TEST_PRODUCTION_VERSION') {
    return db.query(`INSERT INTO "MarketRegimeDimensionAssessment" (dimension, "algorithmVersion", "evidenceSchemaVersion", "targetAt", "sessionDate", attempt, status, "reasonCode", "rawState", "effectiveState", "dataThroughAt", "validUntil", "startedAt", "completedAt", "evidenceJson")
      VALUES ($1,$2,1,'2026-09-14T20:30Z','2026-09-14',$3,$4,'TEST',$5,$5,'2026-09-14T20:00Z','2026-09-15T20:30Z',now(),now(),'{}')`, [dimension, algorithm, attempt, status, raw]);
  }
  it('keeps failed attempts and allows at most one valid result', async () => {
    await assessment(1, 'UNAVAILABLE', null); await assessment(2, 'FAILED', null); await assessment(3, 'VALID', 'UP');
    await expect(assessment(4, 'VALID', 'DOWN')).rejects.toThrow();
    await expect(assessment(1, 'FAILED', null)).rejects.toThrow();
    await assessment(1, 'VALID', 'DOWN', 'TREND', 'INDEPENDENT_VERSION');
  });
  it.each([['VALID', null, 'TREND'], ['UNAVAILABLE', 'NEUTRAL', 'TREND'], ['VALID', 'SIDEWAYS', 'TREND'], ['VALID', 'UP', 'BREADTH']])('rejects invalid dimension state %s/%s/%s', async (status, raw, dimension) => {
    await expect(assessment(10, status!, raw, dimension!)).rejects.toThrow();
  });
  it('rejects assessment mutation', async () => {
    await expect(db.query(`UPDATE "MarketRegimeDimensionAssessment" SET "reasonCode"='CHANGED'`)).rejects.toThrow('immutable');
    await expect(db.query(`DELETE FROM "MarketRegimeDimensionAssessment"`)).rejects.toThrow('immutable');
  });
});
