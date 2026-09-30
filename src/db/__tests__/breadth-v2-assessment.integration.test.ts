import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { datesBetween, marketSession, type CalendarException } from '../../services/market-calendar.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('BREADTH_V2 shadow assessment PostgreSQL path', () => {
  const database = `breadth_v2_assessment_${randomUUID().replaceAll('-', '')}`;
  const originalUrl = process.env.DATABASE_URL;
  const firstNow = new Date('2026-09-30T03:00:00Z');
  const completedClock = () => new Date('2026-10-03T03:00:00Z');
  const exceptions: CalendarException[] = [
    { sessionDate: '2020-12-25', type: 'CLOSED', closeTimeMinutesEt: null },
    { sessionDate: '2021-01-01', type: 'CLOSED', closeTimeMinutesEt: null },
    { sessionDate: '2026-09-07', type: 'CLOSED', closeTimeMinutesEt: null },
  ];
  let admin: Client; let db: Client; let prismaModule: typeof import('../prisma.js');
  let measurement: typeof import('../../services/breadth-v2-measurement.service.js');
  let assessment: typeof import('../../services/breadth-v2-assessment.service.js');
  let securityIds: number[]; let revisionId: number; let v1Id: number;
  const addBar = (securityId: number, date: string, close: number, receivedAt: string) => db.query(`INSERT INTO "MarketBar" ("securityId",timeframe,"barStartAt",open,high,low,close,volume,"splitFactor",provider,"adjustmentMode","receivedAt") VALUES ($1,'DAY_1',$2,$3,$3,$3,$3,1000,1,'TIINGO','UNADJUSTED',$4)`, [securityId, date, close, receivedAt]);
  beforeAll(async () => {
    admin = new Client({ connectionString: originalUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(originalUrl!); url.pathname = `/${database}`; url.searchParams.delete('schema');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    for (const exception of exceptions) await db.query(`INSERT INTO "MarketCalendarException" ("sessionDate",name,type,"updatedAt") VALUES ($1,'Reviewed closure','CLOSED',now())`, [exception.sessionDate]);
    securityIds = [];
    for (const symbol of ['AAA', 'BBB', 'CCC']) securityIds.push((await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ($1,$1,'STOCK',false,now()) RETURNING id`, [symbol])).rows[0].id);
    revisionId = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-01',3) RETURNING id`)).rows[0].id;
    for (const id of securityIds) await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [revisionId, id]);
    const historical = datesBetween('2020-12-01', '2021-01-15').filter(date => marketSession(date, exceptions));
    for (const [i, date] of historical.entries()) if (date !== '2021-01-08') {
      await addBar(securityIds[0]!, date, 100 + i, `${date}T22:00:00Z`);
      await addBar(securityIds[1]!, date, 200 - i, `${date}T22:00:00Z`);
    }
    const recent = datesBetween('2026-08-20', '2026-09-29').filter(date => marketSession(date, exceptions)).slice(-21);
    for (const [i, date] of recent.entries()) {
      await addBar(securityIds[0]!, date, 100 + i, '2026-09-30T00:16:00Z');
      await addBar(securityIds[1]!, date, 200 - i, '2026-09-30T00:16:00Z');
      await addBar(securityIds[2]!, date, 300 - (i === recent.length - 1 ? i - 1 : i), '2026-09-30T00:16:00Z');
    }
    v1Id = (await db.query(`INSERT INTO "MarketRegimeDimensionAssessment" (dimension,"algorithmVersion","evidenceSchemaVersion","targetAt","sessionDate",attempt,status,"rawState","effectiveState","dataThroughAt","validUntil","startedAt","completedAt","evidenceJson") VALUES ('BREADTH','BREADTH_V1',1,'2026-09-30T00:15:00Z','2026-09-29',1,'VALID','POSITIVE','POSITIVE','2026-09-30T00:00:00Z','2026-10-01T00:15:00Z',now(),now(),'{}') RETURNING id`)).rows[0].id;
    process.env.DATABASE_URL = url.toString();
    prismaModule = await import('../prisma.js');
    measurement = await import('../../services/breadth-v2-measurement.service.js');
    assessment = await import('../../services/breadth-v2-assessment.service.js');
    expect(await measurement.runBreadthV2Observations({ now: firstNow })).toMatchObject({ inserted: 1, blocked: null });
  }, 120_000);
  afterAll(async () => {
    await prismaModule?.prisma.$disconnect(); process.env.DATABASE_URL = originalUrl;
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  it('previews a fixed-revision historical bootstrap without writes or provider calls', async () => {
    const before = (await db.query(`SELECT count(*)::int n FROM "SystemEvent"`)).rows[0].n;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider calls allowed.'));
    let status;
    try { status = await assessment.breadthV2AssessmentStatus({ now: firstNow }); }
    finally { expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore(); }
    expect(status).toMatchObject({ readiness: 'READY', bootstrap: true, sessionDate: '2026-09-29', observationSetId: expect.any(Number), revisionId, rawState: 'NEGATIVE', horizonStates: { DAY_1: 'MIXED', DAY_5: 'NEGATIVE', DAY_20: 'NEGATIVE' }, historicalReplay: { populationPolicy: 'TARGET_OBSERVATION_REVISION_FIXED_BACKCAST', replayFrom: '2021-01-04', revisionId, memberCount: 3 } });
    if (status.readiness !== 'READY') throw new Error('Expected ready bootstrap fixture.');
    expect(status.historicalReplay!.validRawSessionCount).toBeGreaterThan(0);
    expect(status.historicalReplay!.unavailableRawSessionCount).toBeGreaterThan(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE "securityId"=$1 AND "barStartAt"::date BETWEEN '2021-01-04' AND '2021-01-15'`, [securityIds[2]])).rows[0].n).toBe(0);
    expect(status.historicalReplay!.historicalReplayHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await assessment.breadthV2AssessmentStatus({ now: firstNow })).historicalReplay).toEqual(status.historicalReplay);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment" WHERE "algorithmVersion"='BREADTH_V2_TERTILE_V1'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "SystemEvent"`)).rows[0].n).toBe(before);
  });

  it('holds a dedicated advisory lock and publishes one shadow bootstrap with delayed receipt provenance', async () => {
    await db.query('BEGIN');
    try {
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [assessment.BREADTH_V2_PUBLICATION_LOCK_KEY.toString()]);
      await expect(assessment.publishBreadthV2Assessments({ now: firstNow, clock: completedClock })).rejects.toThrow('already running');
    } finally { await db.query('ROLLBACK'); }
    const result = await assessment.publishBreadthV2Assessments({ now: new Date('2026-10-01T03:00:00Z'), clock: completedClock });
    expect(result).toMatchObject({ published: 1, attempts: 1, blocked: null });
    const row = await assessment.latestBreadthV2Assessment();
    expect(row).toMatchObject({ dimension: 'BREADTH', algorithmVersion: 'BREADTH_V2_TERTILE_V1', sessionDate: new Date('2026-09-29'), targetAt: new Date('2026-09-30T00:15:00Z'), validUntil: new Date('2026-10-01T00:15:00Z'), dataThroughAt: new Date('2026-09-30T00:16:00Z'), rawState: 'NEGATIVE', previousAssessmentId: null });
    expect((row?.evidenceJson as { bootstrap?: boolean }).bootstrap).toBe(true);
    expect((await assessment.publishBreadthV2Assessments({ now: firstNow, clock: completedClock })).published).toBe(0);
    expect((await assessment.breadthV2AssessmentStatus({ now: firstNow })).readiness).toBe('ALREADY_PUBLISHED');
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment" WHERE "algorithmVersion"='BREADTH_V2_TERTILE_V1'`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment" WHERE "algorithmVersion"='BREADTH_V2_TERTILE_V1' AND "sessionDate"='2026-09-30'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment" WHERE id=$1 AND "algorithmVersion"='BREADTH_V1'`, [v1Id])).rows[0].n).toBe(1);
    await expect(db.query(`INSERT INTO "MarketRegimeDimensionAssessment" (dimension,"algorithmVersion","evidenceSchemaVersion","targetAt","sessionDate",attempt,status,"rawState","effectiveState","dataThroughAt","validUntil","startedAt","completedAt","evidenceJson") VALUES ('BREADTH','BREADTH_V1',1,'2026-10-02T00:15:00Z','2026-10-01',1,'VALID','MIXED','MIXED','2026-10-02T00:16:00Z','2026-10-03T00:15:00Z',now(),now(),'{}')`)).rejects.toThrow();
  });

  it('continues from persisted V2 evidence across a new revision without replaying history', async () => {
    const nextRevision = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-30',3) RETURNING id`)).rows[0].id;
    for (const id of securityIds) await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [nextRevision, id]);
    for (const [i, id] of securityIds.entries()) await addBar(id, '2026-09-30', i === 0 ? 121 : i === 1 ? 179 : 280, '2026-10-01T00:16:00Z');
    const now = new Date('2026-10-01T03:00:00Z');
    expect((await measurement.runBreadthV2Observations({ now })).inserted).toBe(1);
    const status = await assessment.breadthV2AssessmentStatus({ now });
    expect(status).toMatchObject({ readiness: 'READY', bootstrap: false, sessionDate: '2026-09-30', revisionId: nextRevision, historicalReplay: null });
    const result = await assessment.publishBreadthV2Assessments({ now, clock: completedClock });
    expect(result).toMatchObject({ published: 1, attempts: 1 });
    const latest = await assessment.latestBreadthV2Assessment();
    expect(latest?.previousAssessmentId).toBe((await assessment.listBreadthV2Assessments(2))[1]?.id);
    expect((latest?.evidenceJson as { bootstrap?: boolean; historicalReplay?: unknown }).bootstrap).toBe(false);
    expect((latest?.evidenceJson as { historicalReplay?: unknown }).historicalReplay).toBeNull();
  });

  it('pins a missing expected measurement, suppresses repeats, and recovers with the next immutable attempt', async () => {
    const now = new Date('2026-10-02T03:00:00Z');
    expect(await assessment.breadthV2AssessmentStatus({ now })).toMatchObject({ readiness: 'BLOCKED', sessionDate: '2026-10-01', blocker: { reasonCode: 'MISSING_MEASUREMENT' } });
    expect((await assessment.publishBreadthV2Assessments({ now, clock: completedClock })).blocked?.reasonCode).toBe('MISSING_MEASUREMENT');
    expect((await assessment.publishBreadthV2Assessments({ now, clock: completedClock })).suppressed).toBe(true);
    const unavailable = await assessment.latestBreadthV2Assessment();
    expect(unavailable).toMatchObject({ status: 'UNAVAILABLE', attempt: 1, sessionDate: new Date('2026-10-01') });
    for (const [i, id] of securityIds.entries()) await addBar(id, '2026-10-01', i === 0 ? 122 : i === 1 ? 178 : 279, '2026-10-02T00:16:00Z');
    expect((await measurement.runBreadthV2Observations({ now })).inserted).toBe(1);
    const recovered = await assessment.publishBreadthV2Assessments({ now, clock: completedClock });
    expect(recovered).toMatchObject({ published: 1, attempts: 1, blocked: null });
    const latest = await assessment.latestBreadthV2Assessment();
    expect(latest).toMatchObject({ status: 'VALID', attempt: 2, sessionDate: new Date('2026-10-01') });
    expect(latest?.previousAssessmentId).not.toBe(v1Id);
    expect((await db.query(`SELECT count(*)::int n FROM "SignalEvaluation"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "OrderIntent"`)).rows[0].n).toBe(0);
  });

  it('classifies persisted horizon children without consulting current-session MarketBars', async () => {
    const date = '2026-10-02';
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE "barStartAt"::date=$1`, [date])).rows[0].n).toBe(0);
    const revision = (await db.query(`SELECT id FROM "BreadthUniverseRevision" WHERE "effectiveFrom"='2026-09-30'`)).rows[0].id;
    const populationHash = createHash('sha256').update('AAA\nBBB\nCCC\n').digest('hex');
    const horizonHashes = [1, 5, 20].map(h => createHash('sha256').update(`synthetic-fixture:${date}:${h}`).digest('hex'));
    const parentHash = createHash('sha256').update(JSON.stringify({ measurementVersion: 'BREADTH_V2_MEASUREMENT_V1', revisionId: revision, constituentHash: populationHash, date, horizonHashes })).digest('hex');
    const evidenceJson = { revisionId: revision, memberCount: 3, constituentHash: populationHash, source: { provider: 'TIINGO', timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED' }, gapPolicy: 'STRICT', splitNormalizationVersion: 'RAW_CLOSE_CUMULATIVE_TIINGO_SPLIT_V1' };
    const setId = (await db.query(`INSERT INTO "MarketBreadthObservationSet" ("breadthUniverseRevisionId","sessionDate",provider,"measurementVersion","evidenceSchemaVersion","universeCount","targetBarCount","targetCoverageRatio","dataThroughAt","canonicalInputHash","evidenceJson","startedAt","completedAt") VALUES ($1,$2,'TIINGO','BREADTH_V2_MEASUREMENT_V1',1,3,3,1,'2026-10-03T00:16:00Z',$3,$4,now(),now()) RETURNING id`, [revision, date, parentHash, JSON.stringify(evidenceJson)])).rows[0].id;
    const expected = datesBetween('2026-08-01', date).filter(d => marketSession(d, exceptions)).slice(-21);
    for (const [i, horizon] of [1, 5, 20].entries()) await db.query(`INSERT INTO "MarketBreadthHorizonObservation" ("observationSetId","horizonSessions","anchorSessionDate","universeCount","anchorBarCount","eligibleCount","excludedCount","advancingCount","decliningCount","unchangedCount","directionalCount","coverageRatio","advanceShare","netBreadth","canonicalInputHash","evidenceJson") VALUES ($1,$2,$3,3,3,3,0,1,2,0,3,1,0.3333333333,-0.3333333333,$4,'{}')`, [setId, horizon, expected[20 - horizon], horizonHashes[i]]);
    const now = new Date('2026-10-03T03:00:00Z');
    expect(await assessment.breadthV2AssessmentStatus({ now })).toMatchObject({ readiness: 'READY', sessionDate: date, observationSetId: setId, rawState: 'NEGATIVE' });
    expect((await assessment.publishBreadthV2Assessments({ now, clock: completedClock })).published).toBe(1);
    expect((await assessment.latestBreadthV2Assessment())?.evidenceJson).toMatchObject({ observationSetId: setId, bootstrap: false });
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar" WHERE "barStartAt"::date=$1`, [date])).rows[0].n).toBe(0);
  });

  it('does not skip to a later set and records invalid next-session evidence as a distinct failed attempt', async () => {
    const laterRevision = (await db.query(`SELECT id FROM "BreadthUniverseRevision" WHERE "effectiveFrom"='2026-09-30'`)).rows[0].id;
    const addPartialSet = (date: string) => db.query(`INSERT INTO "MarketBreadthObservationSet" ("breadthUniverseRevisionId","sessionDate",provider,"measurementVersion","evidenceSchemaVersion","universeCount","targetBarCount","targetCoverageRatio","dataThroughAt","canonicalInputHash","evidenceJson","startedAt","completedAt") VALUES ($1,$2,'TIINGO','BREADTH_V2_MEASUREMENT_V1',1,3,3,1,'2026-10-06T00:16:00Z',$3,'{}',now(),now()) RETURNING id`, [laterRevision, date, 'a'.repeat(64)]);
    await addPartialSet('2026-10-06');
    const now = new Date('2026-10-07T03:00:00Z');
    const lateClock = () => new Date('2026-10-07T03:01:00Z');
    expect(await assessment.breadthV2AssessmentStatus({ now })).toMatchObject({ sessionDate: '2026-10-05', readiness: 'BLOCKED', blocker: { reasonCode: 'MISSING_MEASUREMENT' } });
    expect((await assessment.publishBreadthV2Assessments({ now, clock: lateClock })).blocked?.reasonCode).toBe('MISSING_MEASUREMENT');
    await addPartialSet('2026-10-05');
    expect(await assessment.breadthV2AssessmentStatus({ now })).toMatchObject({ sessionDate: '2026-10-05', readiness: 'BLOCKED', blocker: { reasonCode: 'INVALID_MEASUREMENT_EVIDENCE' } });
    expect((await assessment.publishBreadthV2Assessments({ now, clock: lateClock })).blocked?.reasonCode).toBe('INVALID_MEASUREMENT_EVIDENCE');
    expect((await assessment.publishBreadthV2Assessments({ now, clock: lateClock })).suppressed).toBe(true);
    const attempts = await db.query(`SELECT attempt,status,"reasonCode" FROM "MarketRegimeDimensionAssessment" WHERE "algorithmVersion"='BREADTH_V2_TERTILE_V1' AND "sessionDate"='2026-10-05' ORDER BY attempt`);
    expect(attempts.rows).toMatchObject([{ attempt: 1, status: 'UNAVAILABLE', reasonCode: 'MISSING_MEASUREMENT' }, { attempt: 2, status: 'FAILED', reasonCode: 'INVALID_MEASUREMENT_EVIDENCE' }]);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment" WHERE "algorithmVersion"='BREADTH_V2_TERTILE_V1' AND "sessionDate"='2026-10-06'`)).rows[0].n).toBe(0);
  });
});
