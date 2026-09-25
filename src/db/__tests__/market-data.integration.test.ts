import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ingestDailyRange } from '../../services/market-bar-ingestion.service.js';
import { datesBetween, etInstant, isWeekend } from '../../services/market-calendar.js';
import { publishTrendAssessments } from '../../services/trend-assessment.service.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('market data PostgreSQL integrity and full migration replay', () => {
  const schema = `market_data_${randomUUID().replaceAll('-', '')}`;
  let db: Client;
  let admin: Client;
  let prisma: PrismaClient;
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
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    securityId = (await db.query(`INSERT INTO "Security" (symbol, name, "assetType", "updatedAt") VALUES ('SPY', 'SPY fixture', 'ETF', now()) RETURNING id`)).rows[0].id;
  }, 120_000);
  afterAll(async () => {
    await prisma?.$disconnect();
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
  it('accepts legacy null split factors and rejects invalid present factors', async () => {
    const legacy = await bar('2020-01-06T04:00:00Z');
    expect(legacy.rows[0].id).toBeGreaterThan(0);
    for (const factor of ['0', '-1', 'NaN']) {
      await expect(db.query(`INSERT INTO "MarketBar" ("securityId", timeframe, "barStartAt", open, high, low, close, volume, provider, "adjustmentMode", "receivedAt", "splitFactor") VALUES ($1,'DAY_1','2020-01-07T04:00:00Z',100,102,99,101,1000,'TIINGO','UNADJUSTED',now(),$2)`, [securityId, factor])).rejects.toThrow();
    }
    await db.query(`INSERT INTO "MarketBar" ("securityId", timeframe, "barStartAt", open, high, low, close, volume, provider, "adjustmentMode", "receivedAt", "splitFactor") VALUES ($1,'DAY_1','2020-01-07T04:00:00Z',100,102,99,101,1000,'TIINGO','UNADJUSTED',now(),2)`, [securityId]);
    expect((await db.query(`SELECT "splitFactor"::text AS factor FROM "MarketBar" WHERE "barStartAt"='2020-01-07T04:00:00Z'`)).rows[0].factor).toBe('2.0000000000');
  });
  it('enforces nonoverlapping membership, frozen revisions, and canonical split uniqueness', async () => {
    const universe = (await db.query(`INSERT INTO "SecurityUniverse" (code,name) VALUES ('SP500','S&P 500') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO "SecurityUniverseMembership" ("universeId","securityId","effectiveFrom") VALUES ($1,$2,'2026-01-01')`, [universe, securityId]);
    await expect(db.query(`INSERT INTO "SecurityUniverseMembership" ("universeId","securityId","effectiveFrom") VALUES ($1,$2,'2026-06-01')`, [universe, securityId])).rejects.toThrow();
    const revision = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-01',1) RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [revision, securityId]);
    await expect(db.query(`UPDATE "BreadthUniverseRevision" SET "memberCount"=2 WHERE id=$1`, [revision])).rejects.toThrow('immutable');
    await expect(db.query(`DELETE FROM "BreadthUniverseRevisionMember" WHERE "revisionId"=$1`, [revision])).rejects.toThrow('immutable');
    const split = `INSERT INTO "MarketSplitEvent" ("securityId","executionDate","splitFactor",provider,provenance,"receivedAt") VALUES ($1,'2026-09-12',$2,'TIINGO','Tiingo EOD',now())`;
    await expect(db.query(split, [securityId, '0'])).rejects.toThrow();
    await db.query(split, [securityId, '2']);
    await expect(db.query(split, [securityId, '3'])).rejects.toThrow();
    await expect(db.query(`UPDATE "MarketSplitEvent" SET "splitFactor"=3 WHERE "securityId"=$1`, [securityId])).rejects.toThrow('immutable');
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
  it('real ingestion overlaps and concurrent inserts preserve original observations', async () => {
    const makeBar = (date: string, close = '101') => ({barStartAt:etInstant(date,0),open:'100',high:'102',low:'99',close,volume:'1000',receivedAt:new Date('2026-09-16T00:00Z')});
    const options = {db:prisma,now:new Date('2026-09-16T00:00Z'),fetchBars:async()=>[makeBar('2026-09-15')]};
    const results=await Promise.all([ingestDailyRange('SPY','2026-09-15','2026-09-15',options),ingestDailyRange('SPY','2026-09-15','2026-09-15',options)]);
    expect(results.reduce((sum,result)=>sum+result.inserted,0)).toBe(1);
    const retry=await ingestDailyRange('SPY','2026-09-14','2026-09-15',{...options,fetchBars:async()=>[makeBar('2026-09-14','100'),makeBar('2026-09-15','100')]});
    expect(retry.inserted).toBe(0);
    expect((await prisma.marketBar.findMany({where:{securityId,barStartAt:{gte:etInstant('2026-09-14',0)}},orderBy:{barStartAt:'asc'}})).map(row=>row.close.toNumber())).toEqual([101,101]);
  });
  async function tradingCounts() {
    const tables = ['OrderIntent', 'BrokerOrder', 'BrokerActivity', 'TrackedPosition', 'Subscription', 'Signal', 'SignalDelivery', 'SignalEvaluation', 'CurrentMarketState'];
    const counts = [];
    for (const table of tables) counts.push({ table, count: (await db.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n });
    return counts;
  }
  it('serializes real publishers under the transaction lock, bootstraps once, and has no trading writes', async () => {
    await db.query(`INSERT INTO "Security" (symbol,name,"assetType","updatedAt") VALUES ('RSP','RSP fixture','ETF',now())`);
    const securities = await prisma.security.findMany({ where: { symbol: { in: ['SPY', 'RSP'] } } });
    const dates = datesBetween('2026-05-01', '2026-09-14').filter(date => !isWeekend(date));
    await prisma.marketBar.createMany({ data: securities.flatMap(security => dates.map((date, i) => ({ securityId: security.id, timeframe: 'DAY_1' as const, barStartAt: etInstant(date, 0), open: String(100 + i), high: String(100 + i), low: String(100 + i), close: String(100 + i), volume: '1000', provider: 'MASSIVE' as const, adjustmentMode: 'UNADJUSTED' as const, receivedAt: new Date() }))), skipDuplicates: true });
    const before = await tradingCounts();
    let entered!: () => void; const inside = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const options = { db: prisma, now: new Date('2026-09-14T20:31Z'), fetchSplits: async () => { entered(); await gate; return []; } };
    const first = publishTrendAssessments(options);
    await inside;
    try { await expect(publishTrendAssessments(options)).rejects.toMatchObject({ statusCode: 409 }); }
    finally { release(); }
    expect(await first).toMatchObject({ published: 1, attempts: 1 });
    expect(await publishTrendAssessments({ ...options, fetchSplits: async () => [] })).toMatchObject({ notDue: true });
    const published = await prisma.marketRegimeDimensionAssessment.findMany({ where: { algorithmVersion: 'TREND_V1' } });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ status: 'VALID', previousAssessmentId: null, targetAt: new Date('2026-09-14T20:00Z'), dataThroughAt: new Date('2026-09-14T20:00Z') });
    expect(published[0]!.evidenceJson).toMatchObject({ bootstrap: true, historicalReplay: { sessionCount: dates.length } });
    expect(await tradingCounts()).toEqual(before);
  });
  it('recovers a real missing Tuesday before Wednesday with immutable attempts and correct links', async () => {
    const rsp = await prisma.security.findUniqueOrThrow({ where: { symbol: 'RSP' } });
    async function insert(securityId: number, date: string) {
      await prisma.marketBar.create({ data: { securityId, timeframe: 'DAY_1', barStartAt: etInstant(date, 0), open: '190', high: '190', low: '190', close: '190', volume: '1000', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', receivedAt: new Date() } });
    }
    await insert(securityId, '2026-09-16'); await insert(rsp.id, '2026-09-16');
    const options = { db: prisma, now: new Date('2026-09-16T20:31Z'), fetchSplits: async () => [] };
    const before = await tradingCounts();
    expect(await publishTrendAssessments(options)).toMatchObject({ published: 0, blocked: { sessionDate: '2026-09-15', reasonCode: 'MISSING_MARKET_DATA' } });
    expect(await publishTrendAssessments(options)).toMatchObject({ suppressed: true, attempts: 0 });
    expect(await prisma.marketRegimeDimensionAssessment.count({ where: { algorithmVersion: 'TREND_V1', sessionDate: new Date('2026-09-16') } })).toBe(0);
    await insert(rsp.id, '2026-09-15');
    expect(await publishTrendAssessments(options)).toMatchObject({ published: 2, blocked: null });
    const rows = await prisma.marketRegimeDimensionAssessment.findMany({ where: { algorithmVersion: 'TREND_V1' }, orderBy: { id: 'asc' } });
    expect(rows.map(row => row.status)).toEqual(['VALID', 'UNAVAILABLE', 'VALID', 'VALID']);
    expect(rows[2]!.attempt).toBe(2);
    expect(rows[2]!.previousAssessmentId).toBe(rows[0]!.id);
    expect(rows[3]!.previousAssessmentId).toBe(rows[2]!.id);
    expect(await tradingCounts()).toEqual(before);
    await expect(prisma.marketRegimeDimensionAssessment.update({ where: { id: rows[3]!.id }, data: { effectiveState: 'DOWN' } })).rejects.toThrow('immutable');
    const { id: _id, createdAt: _created, ...duplicate } = rows[3]!;
    await expect(prisma.marketRegimeDimensionAssessment.create({ data: { ...duplicate, attempt: 2, evidenceJson: {} } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.marketRegimeDimensionAssessment.create({ data: { ...duplicate, algorithmVersion: 'OTHER_VERSION', attempt: 1, evidenceJson: {} } })).rejects.toMatchObject({ code: 'P2003' });
  });
});
