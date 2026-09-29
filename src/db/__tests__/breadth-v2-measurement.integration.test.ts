import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { datesBetween, marketSession } from '../../services/market-calendar.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('BREADTH_V2 immutable measurement PostgreSQL path', () => {
  const database = `breadth_v2_measurement_${randomUUID().replaceAll('-', '')}`;
  const originalUrl = process.env.DATABASE_URL;
  const target = '2026-09-28';
  const now = new Date('2026-09-29T03:00:00Z');
  let admin: Client; let db: Client; let prismaModule: typeof import('../prisma.js');
  let measurement: typeof import('../../services/breadth-v2-measurement.service.js');
  let revisionId: number; let sessions: string[];
  beforeAll(async () => {
    admin = new Client({ connectionString: originalUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(originalUrl!); url.pathname = `/${database}`; url.searchParams.delete('schema');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    await db.query(`INSERT INTO "MarketCalendarException" ("sessionDate",name,type,"updatedAt") VALUES ('2026-09-07','Labor Day','CLOSED',now())`);
    await db.query(`INSERT INTO "MarketCalendarException" ("sessionDate",name,type,"closeTimeMinutesEt","updatedAt") VALUES ('2026-09-25','Early close','EARLY_CLOSE',780,now())`);
    sessions = datesBetween('2026-08-17', target).filter(date => marketSession(date, [{ sessionDate: '2026-09-07', type: 'CLOSED', closeTimeMinutesEt: null }])).slice(-21);
    revisionId = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-08-01',3) RETURNING id`)).rows[0].id;
    for (const [index, symbol] of ['AAA', 'BBB', 'CCC'].entries()) {
      const id = (await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ($1,$1,'STOCK',$2,now()) RETURNING id`, [symbol, index === 0])).rows[0].id;
      await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [revisionId, id]);
      for (const [i, date] of sessions.entries()) {
        const close = index === 0 ? 100 + i : index === 1 ? 120 - i : 100;
        await db.query(`INSERT INTO "MarketBar" ("securityId",timeframe,"barStartAt",open,high,low,close,volume,"splitFactor",provider,"adjustmentMode","receivedAt") VALUES ($1,'DAY_1',$2,$3,$3,$3,$3,1000,1,'TIINGO','UNADJUSTED',now())`, [id, date, close]);
      }
    }
    process.env.DATABASE_URL = url.toString();
    prismaModule = await import('../prisma.js');
    measurement = await import('../../services/breadth-v2-measurement.service.js');
  }, 120_000);
  afterAll(async () => {
    await prismaModule?.prisma.$disconnect(); process.env.DATABASE_URL = originalUrl;
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });
  it('previews without writes, includes disabled members, exact anchors, and deterministic evidence', async () => {
    expect((await measurement.breadthV2ObservationStatus({ now: new Date('2026-09-29T00:14:00Z') })).readiness).toBe('NOT_DUE');
    const first = await measurement.computeBreadthV2Measurement(target, { now });
    const second = await measurement.computeBreadthV2Measurement(target, { now });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ readiness: 'READY', revisionId, memberCount: 3, targetBarCount: 3, targetCoverageRatio: 1 });
    expect(first.horizons.map(row => row.anchorSessionDate)).toEqual([sessions[19], sessions[15], sessions[0]]);
    expect(first.horizons.map(row => row.directionalCount)).toEqual([2, 2, 2]);
    expect(first.horizons.map(row => row.unchangedCount)).toEqual([1, 1, 1]);
    expect(first.horizons.map(row => row.advanceShare)).toEqual([0.5, 0.5, 0.5]);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthObservationSet"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment"`)).rows[0].n).toBe(0);
  });
  it('publishes only latest target atomically, then is idempotent and SQL immutable', async () => {
    const result = await measurement.runBreadthV2Observations({ now });
    expect(result).toMatchObject({ inserted: 1, attempted: 1, blocked: null });
    const set = await measurement.latestBreadthV2Observation();
    expect(set?.sessionDate.toISOString().slice(0, 10)).toBe(target);
    expect(set?.horizons.map(row => row.horizonSessions)).toEqual([1, 5, 20]);
    expect((await measurement.runBreadthV2Observations({ now })).inserted).toBe(0);
    await expect(db.query(`UPDATE "MarketBreadthObservationSet" SET "targetBarCount"=2 WHERE id=$1`, [set!.id])).rejects.toThrow();
    await expect(db.query(`DELETE FROM "MarketBreadthHorizonObservation" WHERE "observationSetId"=$1`, [set!.id])).rejects.toThrow();
    await expect(db.query(`INSERT INTO "MarketBreadthHorizonObservation" ("observationSetId","horizonSessions","anchorSessionDate","universeCount","anchorBarCount","eligibleCount","excludedCount","advancingCount","decliningCount","unchangedCount","directionalCount","coverageRatio","advanceShare","netBreadth","canonicalInputHash","evidenceJson") VALUES ($1,2,'2026-09-25',3,3,3,0,1,1,1,2,1,0.5,0,'${'0'.repeat(64)}','{}')`, [set!.id])).rejects.toThrow();
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthObservationSet"`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthHorizonObservation"`)).rows[0].n).toBe(3);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthObservation"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment"`)).rows[0].n).toBe(0);
  });
  it('blocks a newer incomplete revision without a partial set or assessment', async () => {
    const newRevision = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-29',4) RETURNING id`)).rows[0].id;
    const ids = (await db.query(`SELECT id FROM "Security" WHERE symbol IN ('AAA','BBB','CCC')`)).rows.map(row => row.id);
    const fourth = (await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ('DDD','DDD','STOCK',false,now()) RETURNING id`)).rows[0].id;
    for (const id of [...ids, fourth]) await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [newRevision, id]);
    const nextNow = new Date('2026-09-30T03:00:00Z');
    const status = await measurement.breadthV2ObservationStatus({ now: nextNow });
    expect(status).toMatchObject({ sessionDate: '2026-09-29', revisionId: newRevision, memberCount: 4, targetBarCount: 0, readiness: 'BLOCKED', blocker: { code: 'INSUFFICIENT_TARGET_COVERAGE' } });
    expect((await measurement.runBreadthV2Observations({ now: nextNow })).blocked).toMatchObject({ sessionDate: '2026-09-29', code: 'INSUFFICIENT_TARGET_COVERAGE' });
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthObservationSet"`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthHorizonObservation"`)).rows[0].n).toBe(3);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment"`)).rows[0].n).toBe(0);
  });
  it('catches up at most five sessions, then fails closed on a conflicting immutable identity', async () => {
    const fourth = (await db.query(`SELECT id FROM "Security" WHERE symbol='DDD'`)).rows[0].id;
    const ids = (await db.query(`SELECT id,symbol FROM "Security" WHERE symbol IN ('AAA','BBB','CCC','DDD') ORDER BY symbol`)).rows;
    const add = (id: number, date: string, close: number) => db.query(`INSERT INTO "MarketBar" ("securityId",timeframe,"barStartAt",open,high,low,close,volume,"splitFactor",provider,"adjustmentMode","receivedAt") VALUES ($1,'DAY_1',$2,$3,$3,$3,$3,1000,1,'TIINGO','UNADJUSTED',now())`, [id, date, close]);
    for (const [i, date] of sessions.entries()) await add(fourth, date, 100 + i);
    const later = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'];
    for (const [i, date] of later.entries()) for (const row of ids) await add(row.id, date, row.symbol === 'BBB' ? 99 - i : row.symbol === 'CCC' ? 100 : 121 + i);
    const catchUpNow = new Date('2026-10-07T03:00:00Z');
    const first = await measurement.runBreadthV2Observations({ now: catchUpNow });
    expect(first).toMatchObject({ inserted: 5, attempted: 5, blocked: null });
    expect(first.results.map(row => row.sessionDate)).toEqual(later.slice(0, 5));
    const second = await measurement.runBreadthV2Observations({ now: catchUpNow });
    expect(second).toMatchObject({ inserted: 1, attempted: 1, blocked: null });
    expect(second.results.map(row => row.sessionDate)).toEqual(later.slice(5));
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthObservationSet"`)).rows[0].n).toBe(7);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthHorizonObservation"`)).rows[0].n).toBe(21);
    const revision = (await db.query(`SELECT id FROM "BreadthUniverseRevision" WHERE "effectiveFrom"='2026-09-29'`)).rows[0].id;
    await db.query(`INSERT INTO "MarketBreadthObservationSet" ("breadthUniverseRevisionId","sessionDate",provider,"measurementVersion","evidenceSchemaVersion","universeCount","targetBarCount","targetCoverageRatio","dataThroughAt","canonicalInputHash","evidenceJson","startedAt","completedAt") VALUES ($1,'2026-10-07','TIINGO','BREADTH_V2_MEASUREMENT_V1',1,4,0,0,now(),$2,'{}',now(),now())`, [revision, '0'.repeat(64)]);
    await expect(measurement.computeBreadthV2Measurement('2026-10-07', { now: new Date('2026-10-08T03:00:00Z') })).rejects.toThrow('Conflicting immutable BREADTH_V2 observation');
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment"`)).rows[0].n).toBe(0);
  });
});
