import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Participation PostgreSQL integrity and complete migration replay', () => {
  const database = `participation_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient, databaseUrl: string;
  let sequence = 0;
  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    sql = new Client({ connectionString: databaseUrl }); await sql.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
    const intradayIndex = migrations.indexOf('20260919120000_intraday_stress_v1_assessment_constraints');
    expect(intradayIndex).toBeGreaterThan(-1);
    expect(migrations[intradayIndex + 1]).toBe('20260920120000_participation_v1_assessment_constraints');
    for (const name of migrations) {
      await sql.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
    }
  }, 120_000);
  afterAll(async () => {
    await db?.$disconnect(); if (sql) { await sql.query('ROLLBACK'); await sql.end(); }
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });
  const valid = (overrides: Partial<MarketRegimeDimensionAssessment> = {}) => ({
    dimension: 'PARTICIPATION' as const, algorithmVersion: 'PARTICIPATION_V1', evidenceSchemaVersion: 1,
    sessionDate: new Date('2026-09-14'), targetAt: new Date(Date.parse('2026-09-14T20:00Z') + ++sequence * 1000), attempt: 1,
    status: 'VALID' as const, rawState: 'QUIET', effectiveState: 'QUIET', dataThroughAt: new Date('2026-09-14T20:00Z'),
    validUntil: new Date('2026-09-15T20:30Z'), startedAt: new Date(), completedAt: new Date(), ...overrides, evidenceJson: {},
  });
  it('replays all migrations from zero and has no Prisma schema drift', () => {
    const output = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000, stdio: 'pipe',
    });
    expect(output).toContain('No difference detected');
  }, 70_000);
  it.each(['QUIET', 'NORMAL', 'ACTIVE', 'INTENSE'])('accepts V1 %s', async state => {
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ rawState: state, effectiveState: state }) })).toMatchObject({ rawState: state, effectiveState: state });
  });
  it.each(['NORMAL', 'ELEVATED', 'HIGH', 'SEVERE'])('retains Intraday Stress %s', async state => {
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ dimension: 'INTRADAY_STRESS', algorithmVersion: 'INTRADAY_STRESS_V1', rawState: state, effectiveState: state }) })).toMatchObject({ rawState: state, effectiveState: state });
  });
  it.each(['VALID', 'UNAVAILABLE', 'FAILED'] as const)('requires Intraday Stress sessionDate for %s', async status => {
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ dimension: 'INTRADAY_STRESS', algorithmVersion: 'INTRADAY_STRESS_V1', sessionDate: null, status,
      rawState: status === 'VALID' ? 'NORMAL' : null, effectiveState: status === 'VALID' ? 'NORMAL' : null, reasonCode: status === 'VALID' ? null : 'TEST' }) })).rejects.toThrow();
  });
  it('preserves Intraday Stress independent raw/effective states and unversioned vocabulary', async () => {
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ dimension: 'INTRADAY_STRESS', algorithmVersion: 'REGRESSION', rawState: 'NORMAL', effectiveState: 'SEVERE' }) })).toMatchObject({ rawState: 'NORMAL', effectiveState: 'SEVERE' });
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ dimension: 'INTRADAY_STRESS', rawState: 'QUIET', effectiveState: 'QUIET' }) })).rejects.toThrow();
  });
  it.each([
    { rawState: 'QUIET', effectiveState: 'NORMAL' }, { rawState: 'UNKNOWN' },
    { algorithmVersion: 'PARTICIPATION_V2' }, { sessionDate: null },
    { status: 'UNAVAILABLE' as const, sessionDate: null, rawState: null, effectiveState: null, reasonCode: 'TEST' },
    { status: 'FAILED' as const, sessionDate: null, rawState: null, effectiveState: null, reasonCode: 'TEST' },
    { attempt: 0 }, { evidenceSchemaVersion: 0 }, { dataThroughAt: new Date('2027-01-01') },
    { validUntil: new Date('2020-01-01') }, { status: 'FAILED' as const, reasonCode: 'TEST' },
    { status: 'FAILED' as const, rawState: null, effectiveState: null, reasonCode: '' },
  ])('rejects invalid assessment %j', async override => {
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid(override) })).rejects.toThrow();
  });
  it.each([['TREND', 'UP'], ['TREND', 'NEUTRAL'], ['TREND', 'DOWN'], ['VOLATILITY', 'LOW'], ['VOLATILITY', 'NORMAL'], ['VOLATILITY', 'HIGH'], ['VOLATILITY', 'EXTREME'], ['BREADTH', 'POSITIVE'], ['BREADTH', 'MIXED'], ['BREADTH', 'NEGATIVE']] as const)('retains %s %s', async (dimension, state) => {
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ dimension, algorithmVersion: 'REGRESSION', rawState: state, effectiveState: state }) })).toMatchObject({ dimension, rawState: state });
  });
  it('retains immutable rows, attempt/VALID uniqueness, composite predecessor and no-self invariants', async () => {
    const parent = await db.marketRegimeDimensionAssessment.create({ data: valid() });
    await expect(db.marketRegimeDimensionAssessment.update({ where: { id: parent.id }, data: { reasonCode: 'rewrite' } })).rejects.toThrow('immutable');
    await expect(db.marketRegimeDimensionAssessment.delete({ where: { id: parent.id } })).rejects.toThrow('immutable');
    for (const attempt of [1, 2]) await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ targetAt: parent.targetAt, attempt }) })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ dimension: 'TREND', rawState: 'UP', effectiveState: 'UP', previousAssessmentId: parent.id }) })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ algorithmVersion: 'OTHER', status: 'FAILED', rawState: null, effectiveState: null, reasonCode: 'TEST', previousAssessmentId: parent.id }) })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ id: 900000, previousAssessmentId: 900000 }) })).rejects.toThrow();
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ previousAssessmentId: parent.id }) })).toMatchObject({ previousAssessmentId: parent.id });
  });
  it('fails closed on incompatible preexisting Participation evidence without rewriting it', async () => {
    await sql.query('BEGIN');
    try {
      await sql.query('ALTER TABLE "MarketRegimeDimensionAssessment" DROP CONSTRAINT "RegimeDimension_terminal_check"');
      await sql.query(`INSERT INTO "MarketRegimeDimensionAssessment" (dimension, "algorithmVersion", "evidenceSchemaVersion", "targetAt", attempt, status, "reasonCode", "evidenceJson", "startedAt", "completedAt") VALUES ('PARTICIPATION', 'LEGACY', 1, NOW(), 1, 'FAILED', 'LEGACY', '{}', NOW(), NOW())`);
      const migration = await readFile('prisma/migrations/20260920120000_participation_v1_assessment_constraints/migration.sql', 'utf8');
      const terminal = migration.slice(migration.indexOf('ADD CONSTRAINT "RegimeDimension_terminal_check"'), migration.indexOf('  -- Extend')) .trim().replace(/,$/, '');
      await expect(sql.query(`ALTER TABLE "MarketRegimeDimensionAssessment" ${terminal}`)).rejects.toThrow(/violated/);
    } finally { await sql.query('ROLLBACK'); }
  });
});
