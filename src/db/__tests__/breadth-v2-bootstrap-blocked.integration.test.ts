import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { datesBetween, marketSession, type CalendarException } from '../../services/market-calendar.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('BREADTH_V2 blocked bootstrap and recovery', () => {
  it('records one unavailable attempt when replay has no valid raw state, then recovers from new persisted history', async () => {
    const name = `breadth_v2_blocked_${randomUUID().replaceAll('-', '')}`;
    const originalUrl = process.env.DATABASE_URL!;
    const admin = new Client({ connectionString: originalUrl }); await admin.connect();
    let db: Client | null = null;
    let client: import('@prisma/client').PrismaClient | null = null;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(originalUrl); url.pathname = `/${name}`; url.searchParams.delete('schema');
      db = new Client({ connectionString: url.toString() }); await db.connect();
      const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
      for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
      const exceptions: CalendarException[] = [
        { sessionDate: '2020-12-25', type: 'CLOSED', closeTimeMinutesEt: null },
        { sessionDate: '2021-01-01', type: 'CLOSED', closeTimeMinutesEt: null },
        { sessionDate: '2026-09-07', type: 'CLOSED', closeTimeMinutesEt: null },
      ];
      for (const exception of exceptions) await db.query(`INSERT INTO "MarketCalendarException" ("sessionDate",name,type,"updatedAt") VALUES ($1,'Reviewed closure','CLOSED',now())`, [exception.sessionDate]);
      const ids: number[] = [];
      for (const symbol of ['AAA', 'BBB', 'CCC']) ids.push((await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ($1,$1,'STOCK',false,now()) RETURNING id`, [symbol])).rows[0].id);
      const revision = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-01',3) RETURNING id`)).rows[0].id;
      for (const id of ids) await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [revision, id]);
      const date = '2026-09-29', populationHash = createHash('sha256').update('AAA\nBBB\nCCC\n').digest('hex');
      const horizonHashes = [1, 5, 20].map(h => createHash('sha256').update(`blocked-bootstrap:${h}`).digest('hex'));
      const parentHash = createHash('sha256').update(JSON.stringify({ measurementVersion: 'BREADTH_V2_MEASUREMENT_V1', revisionId: revision, constituentHash: populationHash, date, horizonHashes })).digest('hex');
      const evidence = { revisionId: revision, memberCount: 3, constituentHash: populationHash, source: { provider: 'TIINGO', timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED' }, gapPolicy: 'STRICT', splitNormalizationVersion: 'RAW_CLOSE_CUMULATIVE_TIINGO_SPLIT_V1' };
      const setId = (await db.query(`INSERT INTO "MarketBreadthObservationSet" ("breadthUniverseRevisionId","sessionDate",provider,"measurementVersion","evidenceSchemaVersion","universeCount","targetBarCount","targetCoverageRatio","dataThroughAt","canonicalInputHash","evidenceJson","startedAt","completedAt") VALUES ($1,$2,'TIINGO','BREADTH_V2_MEASUREMENT_V1',1,3,3,1,'2026-09-30T00:16:00Z',$3,$4,now(),now()) RETURNING id`, [revision, date, parentHash, JSON.stringify(evidence)])).rows[0].id;
      const sessions = datesBetween('2026-08-01', date).filter(d => marketSession(d, exceptions)).slice(-21);
      for (const [i, horizon] of [1, 5, 20].entries()) await db.query(`INSERT INTO "MarketBreadthHorizonObservation" ("observationSetId","horizonSessions","anchorSessionDate","universeCount","anchorBarCount","eligibleCount","excludedCount","advancingCount","decliningCount","unchangedCount","directionalCount","coverageRatio","advanceShare","netBreadth","canonicalInputHash","evidenceJson") VALUES ($1,$2,$3,3,3,3,0,1,2,0,3,1,0.3333333333,-0.3333333333,$4,'{}')`, [setId, horizon, sessions[20 - horizon], horizonHashes[i]]);
      const { PrismaClient } = await import('@prisma/client');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
      const assessment = await import('../../services/breadth-v2-assessment.service.js');
      const now = new Date('2026-09-30T03:00:00Z'), clock = () => new Date('2026-10-01T03:00:00Z');
      expect(await assessment.breadthV2AssessmentStatus({ db: client, now })).toMatchObject({ readiness: 'BLOCKED', bootstrap: true, blocker: { reasonCode: 'INSUFFICIENT_BOOTSTRAP_HISTORY' } });
      expect((await assessment.publishBreadthV2Assessments({ db: client, now, clock })).blocked?.reasonCode).toBe('INSUFFICIENT_BOOTSTRAP_HISTORY');
      expect((await assessment.publishBreadthV2Assessments({ db: client, now, clock })).suppressed).toBe(true);
      const historical = datesBetween('2020-12-01', '2021-01-15').filter(d => marketSession(d, exceptions));
      for (const [i, day] of historical.entries()) for (const [memberIndex, id] of ids.entries()) await db.query(`INSERT INTO "MarketBar" ("securityId",timeframe,"barStartAt",open,high,low,close,volume,"splitFactor",provider,"adjustmentMode","receivedAt") VALUES ($1,'DAY_1',$2,$3,$3,$3,$3,1000,1,'TIINGO','UNADJUSTED',$4)`, [id, day, memberIndex === 0 ? 100 + i : 200 + memberIndex * 100 - i, `${day}T22:00:00Z`]);
      expect((await assessment.publishBreadthV2Assessments({ db: client, now, clock })).published).toBe(1);
      const attempts = await db.query(`SELECT attempt,status,"reasonCode" FROM "MarketRegimeDimensionAssessment" WHERE "algorithmVersion"='BREADTH_V2_TERTILE_V1' ORDER BY attempt`);
      expect(attempts.rows).toMatchObject([{ attempt: 1, status: 'UNAVAILABLE', reasonCode: 'INSUFFICIENT_BOOTSTRAP_HISTORY' }, { attempt: 2, status: 'VALID', reasonCode: null }]);
      expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment" WHERE "algorithmVersion"='BREADTH_V2_TERTILE_V1' AND "sessionDate"<'2026-09-29'`)).rows[0].n).toBe(0);
    } finally {
      await client?.$disconnect();
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  }, 120_000);
});
