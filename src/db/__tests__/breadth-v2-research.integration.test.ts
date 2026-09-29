import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('BREADTH_V2 read-only PostgreSQL research', () => {
  const database = `breadth_v2_${randomUUID().replaceAll('-', '')}`;
  const originalUrl = process.env.DATABASE_URL;
  const root = resolve(join('node_modules', '.cache', `breadth-v2-test-${randomUUID()}`));
  let admin: Client; let db: Client; let prismaModule: typeof import('../prisma.js');
  let research: typeof import('../../dev/breadth-v2-research.js');
  let revisionId: number;
  beforeAll(async () => {
    admin = new Client({ connectionString: originalUrl }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(originalUrl!); url.pathname = `/${database}`; url.searchParams.delete('schema');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) await db.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    const ids: number[] = [];
    for (const [symbol, enabled] of [['AAPL', false], ['BBB', true], ['CCC', false]] as const) ids.push((await db.query(`INSERT INTO "Security" (symbol,name,"assetType",enabled,"updatedAt") VALUES ($1,$1,'STOCK',$2,now()) RETURNING id`, [symbol, enabled])).rows[0].id);
    revisionId = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-01',3) RETURNING id`)).rows[0].id;
    for (const id of ids) await db.query(`INSERT INTO "BreadthUniverseRevisionMember" ("revisionId","securityId") VALUES ($1,$2)`, [revisionId, id]);
    const add = (id: number, date: string, close: number, factor: number | null, provider: string) => db.query(`INSERT INTO "MarketBar" ("securityId",timeframe,"barStartAt",open,high,low,close,volume,"splitFactor",provider,"adjustmentMode","receivedAt") VALUES ($1,'DAY_1',$2,$3,$3,$3,$3,1000,$4,$5,'UNADJUSTED',now())`, [id, date, close, factor, provider]);
    await add(ids[0]!, '2026-09-22', 100, 1, 'TIINGO');
    await add(ids[0]!, '2026-09-23', 101, 1, 'TIINGO');
    await add(ids[0]!, '2026-09-24', 50, 2, 'TIINGO');
    await add(ids[0]!, '2026-09-25', 51, 1, 'TIINGO');
    await add(ids[1]!, '2026-09-22', 100, 1, 'TIINGO');
    await add(ids[1]!, '2026-09-23', 100, null, 'MASSIVE');
    await add(ids[1]!, '2026-09-24', 99, 1, 'TIINGO');
    await add(ids[1]!, '2026-09-25', 99, 1, 'TIINGO');
    await db.query(`INSERT INTO "TiingoDailyObservationState" ("securityId","sessionDate",status,"attemptCount","firstAttemptAt","lastAttemptAt","reasonCode","updatedAt") VALUES ($1,'2026-09-24','NO_EOD_COVERAGE',4,now(),now(),'PROVIDER_NO_EOD_BAR',now())`, [ids[2]]);
    await mkdir(root, { recursive: true });
    process.env.DATABASE_URL = url.toString();
    research = await import('../../dev/breadth-v2-research.js');
    prismaModule = await import('../prisma.js');
  }, 120_000);
  afterAll(async () => {
    await prismaModule?.prisma.$disconnect(); process.env.DATABASE_URL = originalUrl;
    if (db) await db.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
    const cacheRoot = resolve(join('node_modules', '.cache'));
    if (root.startsWith(cacheRoot + '\\') || root.startsWith(cacheRoot + '/')) await rm(root, { recursive: true, force: true });
  });
  it('reads only Tiingo evidence, includes disabled members, writes deterministic artifacts and no production rows', async () => {
    const input = { revisionId, from: '2026-09-23', through: '2026-09-25', now: new Date('2026-09-29T03:00:00Z') };
    const one = await research.runBreadthV2Research({ ...input, outputDirectory: join(root, 'one') });
    const two = await research.runBreadthV2Research({ ...input, outputDirectory: join(root, 'two') });
    expect(one.summary).toEqual(two.summary);
    expect(one.summary).toMatchObject({ researchVersion: 'BREADTH_V2_RESEARCH_5A_V2', revisionMemberCount: 3, provider: 'TIINGO', adjustmentMode: 'UNADJUSTED', survivorshipBias: true, dataQuality: { expectedObservations: 9, tiingoBarsPresent: 5, missingObservations: 4, untrackedMissing: 2, terminalNoEodCoverage: 1, otherProviderCollisions: 1, disabledMembers: 2,
      gapRuns: { ONE: 1, TWO: 0, THREE_TO_FIVE: 1, OVER_FIVE: 0, longest: 3 },
      gapShapes: { FULL_RANGE_MISSING: { runCount: 1, missingSessions: 3, affectedSecurities: 1, longestRun: 3 }, LEADING_MISSING: { runCount: 1, missingSessions: 1, affectedSecurities: 1, longestRun: 1 }, INTERIOR_GAP: { runCount: 0, missingSessions: 0, affectedSecurities: 0, longestRun: 0 }, TRAILING_MISSING: { runCount: 0, missingSessions: 0, affectedSecurities: 0, longestRun: 0 } },
      interiorMissingSessions: 0, nonInteriorMissingSessions: 4, longestInteriorGaps: [] } });
    for (const file of ['summary.json', 'session-breadth.csv', 'coverage-by-session.csv', 'coverage-by-security.csv', 'gap-analysis.csv', 'bridge-candidates.csv']) {
      expect(await readFile(join(root, 'one', file), 'utf8')).toBe(await readFile(join(root, 'two', file), 'utf8'));
    }
    const breadth = await readFile(join(root, 'one', 'session-breadth.csv'), 'utf8');
    expect(breadth).toContain('2026-09-25,DAY_1,3,2,1,0.66666667,1,0,1,1,1.00000000,1.00000000');
    expect(breadth).toContain('2026-09-24,DAY_1,3,1,2,0.33333333,0,1,0,1,0.00000000,-1.00000000');
    const candidates = await readFile(join(root, 'one', 'bridge-candidates.csv'), 'utf8');
    expect(candidates).toContain('BBB,2026-09-24,DAY_1,2026-09-23,2026-09-22,1,DECLINING,true,true,false');
    expect(await readFile(join(root, 'one', 'gap-analysis.csv'), 'utf8')).toBe('symbol,fromSession,throughSession,lengthSessions,shape,lengthBucket\nBBB,2026-09-23,2026-09-23,1,LEADING_MISSING,ONE\nCCC,2026-09-23,2026-09-25,3,FULL_RANGE_MISSING,THREE_TO_FIVE\n');
    expect(await readFile(join(root, 'one', 'coverage-by-security.csv'), 'utf8')).toContain('CCC,');
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBreadthObservation"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketRegimeDimensionAssessment"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "Signal"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "SignalEvaluation"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "SignalRoutingRun"`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int n FROM "MarketBar"`)).rows[0].n).toBe(8);
  });
  it('fails closed when frozen revision integrity is broken', async () => {
    const broken = (await db.query(`INSERT INTO "BreadthUniverseRevision" ("effectiveFrom","memberCount") VALUES ('2026-09-02',4) RETURNING id`)).rows[0].id;
    await expect(research.runBreadthV2Research({ revisionId: broken, from: '2026-09-23', through: '2026-09-25', outputDirectory: join(root, 'broken'), now: new Date('2026-09-29T03:00:00Z') })).rejects.toThrow('memberCount integrity');
  });
  it('rejects a resolved acquisition state without its immutable bar', async () => {
    const securityId = (await db.query(`SELECT id FROM "Security" WHERE symbol='CCC'`)).rows[0].id;
    await db.query(`INSERT INTO "TiingoDailyObservationState" ("securityId","sessionDate",status,"attemptCount","firstAttemptAt","lastAttemptAt","resolvedAt","reasonCode","updatedAt") VALUES ($1,'2026-09-25','RESOLVED',1,now(),now(),now(),'BAR_RECEIVED',now())`, [securityId]);
    try {
      await expect(research.runBreadthV2Research({ revisionId, from: '2026-09-23', through: '2026-09-25', outputDirectory: join(root, 'inconsistent'), now: new Date('2026-09-29T03:00:00Z') })).rejects.toThrow('has no bar');
    } finally { await db.query(`DELETE FROM "TiingoDailyObservationState" WHERE "securityId"=$1 AND "sessionDate"='2026-09-25'`, [securityId]); }
  });
});
