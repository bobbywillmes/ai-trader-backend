import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBreadthV1Bootstrap, previewBreadthV1Bootstrap } from '../../services/breadth-v1-bootstrap-import.service.js';
import { publishBreadthV1Assessments } from '../../services/breadth-v1-assessment.service.js';
import { bootstrapMarketCalendar } from '../../services/market-calendar-bootstrap.service.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Breadth PostgreSQL integrity, complete migration replay, and real bootstrap/publish', () => {
  const database = `breadth_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient, databaseUrl: string;
  let sequence = 0;
  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    sql = new Client({ connectionString: databaseUrl }); await sql.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    for (const name of (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()) {
      await sql.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
    }
  }, 120_000);
  afterAll(async () => {
    await db?.$disconnect(); if (sql) { await sql.query('ROLLBACK'); await sql.end(); }
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });

  it('replays all migrations from zero and has no Prisma schema drift', () => {
    let output: string;
    try {
      output = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], {
        env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000, stdio: 'pipe',
      });
    } catch (error) {
      throw new Error(`Prisma migration drift: ${String((error as { stdout?: string }).stdout ?? error)}`);
    }
    expect(output).toContain('No difference detected');
  }, 70_000);

  async function tradingCounts() {
    const tables = ['OrderIntent', 'BrokerOrder', 'BrokerActivity', 'TrackedPosition', 'Subscription', 'Signal', 'SignalDelivery', 'SignalEvaluation'];
    const counts = [];
    for (const table of tables) counts.push({ table, count: (await sql.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n });
    return counts;
  }

  // Runs first and alone against a still-empty MarketBreadthObservation table: every later
  // test below inserts synthetic fixture rows, which (being immutable, per this migration's
  // own trigger) can never be cleaned up afterward and would otherwise corrupt this test's
  // "earliest observation" bootstrap detection.
  it('runs the real bootstrap import from the checked-in artifact then a real bootstrap publication, matching the frozen accepted terminal result, with zero trading writes', async () => {
    // The accepted research replay assumed the real verified NYSE closures were in effect;
    // reproduce that here, exactly as the Volatility integration test does.
    await bootstrapMarketCalendar(true, db);
    const preview = await previewBreadthV1Bootstrap({ db });
    expect(preview.conflicts).toEqual([]);
    expect(preview.inserts).toBe(1252);
    const before = await tradingCounts();
    const applied = await applyBreadthV1Bootstrap({ db, now: new Date('2026-09-17T12:00Z') });
    expect(applied).toMatchObject({ inserted: 1252, skipped: 0, conflicts: [] });
    // Idempotent rerun.
    expect(await applyBreadthV1Bootstrap({ db, now: new Date('2026-09-17T12:00Z') })).toMatchObject({ inserted: 0, skipped: 1252 });

    const published = await publishBreadthV1Assessments({ db, now: new Date('2026-09-17T15:00:00Z') });
    expect(published).toMatchObject({ published: 1, attempts: 1, bootstrapRequired: false, blocked: null });
    const rows = await db.marketRegimeDimensionAssessment.findMany({ where: { algorithmVersion: 'BREADTH_V1' } });
    expect(rows).toHaveLength(1);
    // Matches the frozen accepted research terminal result exactly (see breadth-v1-calculation.regression.test.ts).
    expect(rows[0]).toMatchObject({ previousAssessmentId: null, status: 'VALID', rawState: 'NEGATIVE', effectiveState: 'NEGATIVE', sessionDate: new Date('2026-09-16') });
    expect(rows[0]!.evidenceJson).toMatchObject({ bootstrap: true, historicalReplay: { sessionCount: 1252 }, transition: { recoveryConfirmationAfter: 0, mildDeteriorationConfirmationAfter: 0 } });
    // A second publish call the same run is a clean no-op, not a duplicate.
    expect(await publishBreadthV1Assessments({ db, now: new Date('2026-09-17T15:00:00Z') })).toMatchObject({ notDue: true, published: 0 });
    expect(await db.marketRegimeDimensionAssessment.count({ where: { algorithmVersion: 'BREADTH_V1' } })).toBe(1);
    expect(await tradingCounts()).toEqual(before);
    await expect(db.marketRegimeDimensionAssessment.update({ where: { id: rows[0]!.id }, data: { effectiveState: 'MIXED' } })).rejects.toThrow('immutable');
  }, 60_000);

  it('a later preview against the already-imported data reports zero conflicts and zero inserts', async () => {
    const preview = await previewBreadthV1Bootstrap({ db });
    expect(preview).toMatchObject({ inserts: 0, existingMatches: 1252, conflicts: [] });
  });

  // Deliberately outside the accepted bootstrap artifact's 2021-09-16..2026-09-16 range, so
  // these synthetic fixture rows never collide with the real bootstrapped data above.
  function observation(overrides: Partial<{ sessionDate: Date; previousSessionDate: Date; universeCount: number; currentBarCount: number; priorBarCount: number; advancingCount: number; decliningCount: number; unchangedCount: number; directionalCount: number; excludedCount: number; advanceShare: string; netBreadth: string; canonicalInputHash: string }> = {}) {
    return {
      sessionDate: new Date('2020-01-03'), previousSessionDate: new Date('2020-01-02'), provider: 'MASSIVE' as const, universeDefinitionVersion: 'BREADTH_UNIVERSE_V1',
      evidenceSchemaVersion: 1, universeCount: 100, currentBarCount: 100, priorBarCount: 100, advancingCount: 60, decliningCount: 40, unchangedCount: 0,
      directionalCount: 100, excludedCount: 0, advanceShare: '0.600000', netBreadth: '0.200000', dataThroughAt: new Date('2020-01-03T20:00Z'),
      canonicalInputHash: 'a'.repeat(64), evidenceJson: {}, startedAt: new Date(), completedAt: new Date(), ...overrides,
    };
  }
  it('accepts a valid MarketBreadthObservation and enforces its immutability', async () => {
    const row = await db.marketBreadthObservation.create({ data: observation() });
    await expect(db.marketBreadthObservation.update({ where: { id: row.id }, data: { advanceShare: '0.5' } })).rejects.toThrow('immutable');
    await expect(db.marketBreadthObservation.delete({ where: { id: row.id } })).rejects.toThrow('immutable');
  });
  it('rejects a duplicate (provider, universeDefinitionVersion, sessionDate)', async () => {
    await expect(db.marketBreadthObservation.create({ data: observation({ sessionDate: new Date('2020-01-03') }) })).rejects.toMatchObject({ code: 'P2002' });
  });
  it.each([
    { advancingCount: 60, decliningCount: 39 }, // directionalCount mismatch (still says 100 via override below)
    { directionalCount: 0, advancingCount: 0, decliningCount: 0, unchangedCount: 100 }, // zero-directional: no fake row allowed
    { advanceShare: '1.5' }, { advanceShare: '-0.1' }, { netBreadth: '1.5' }, { netBreadth: '-1.5' },
    { universeCount: -1 }, { excludedCount: -1 },
    { previousSessionDate: new Date('2020-01-04'), sessionDate: new Date('2020-01-03') }, // previous must precede
    { canonicalInputHash: 'short' },
  ])('rejects invalid observation %j', async overrides => {
    await expect(db.marketBreadthObservation.create({ data: observation({ sessionDate: new Date(`2019-0${sequence + 1}-01`), ...overrides }) })).rejects.toThrow();
    sequence++;
  });

  const validAssessment = (overrides: Partial<MarketRegimeDimensionAssessment> = {}) => ({
    dimension: 'BREADTH' as const, algorithmVersion: `DB_TEST_${++sequence}`, evidenceSchemaVersion: 1,
    sessionDate: new Date('2026-09-14'), targetAt: new Date('2026-09-14T20:00Z'), attempt: 1,
    status: 'VALID' as const, rawState: 'POSITIVE', effectiveState: 'POSITIVE', dataThroughAt: new Date('2026-09-14T20:00Z'),
    validUntil: new Date('2026-09-15T20:30Z'), startedAt: new Date(), completedAt: new Date(), ...overrides, evidenceJson: {},
  });
  it.each(['POSITIVE', 'MIXED', 'NEGATIVE'])('accepts Breadth %s', async state => {
    expect(await db.marketRegimeDimensionAssessment.create({ data: validAssessment({ rawState: state, effectiveState: state }) })).toMatchObject({ dimension: 'BREADTH', rawState: state });
  });
  it.each([
    ['BREADTH', 'UP'], ['BREADTH', 'LOW'], ['BREADTH', 'UNKNOWN'],
    ['TREND', 'POSITIVE'], ['VOLATILITY', 'NEGATIVE'],
  ] as const)('rejects cross-vocabulary/invalid %s %s', async (dimension, state) => {
    await expect(db.marketRegimeDimensionAssessment.create({ data: validAssessment({ dimension, rawState: state, effectiveState: state }) })).rejects.toThrow();
  });
  it.each(['VALID', 'UNAVAILABLE', 'FAILED'] as const)('requires sessionDate for daily Breadth %s', async status => {
    await expect(db.marketRegimeDimensionAssessment.create({ data: validAssessment({ sessionDate: null, status,
      ...(status !== 'VALID' ? { rawState: null, effectiveState: null, reasonCode: 'TEST' } : {}) }) })).rejects.toThrow();
  });
});
