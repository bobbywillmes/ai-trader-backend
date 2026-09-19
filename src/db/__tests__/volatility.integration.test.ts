import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapMarketCalendar, verifiedClosureRows } from '../../services/market-calendar-bootstrap.service.js';
import { datesBetween, etInstant, marketSession } from '../../services/market-calendar.js';
import { publishVolatilityAssessments } from '../../services/volatility-assessment.service.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Volatility PostgreSQL integrity and complete migration replay', () => {
  const database = `volatility_${randomUUID().replaceAll('-', '')}`;
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
  const valid = (overrides: Partial<MarketRegimeDimensionAssessment> = {}) => ({
    dimension: 'VOLATILITY' as const, algorithmVersion: `DB_TEST_${++sequence}`, evidenceSchemaVersion: 1,
    sessionDate: new Date('2026-09-14'), targetAt: new Date('2026-09-14T20:00Z'), attempt: 1,
    status: 'VALID' as const, rawState: 'LOW', effectiveState: 'LOW', dataThroughAt: new Date('2026-09-14T20:00Z'),
    validUntil: new Date('2026-09-15T20:30Z'), startedAt: new Date(), completedAt: new Date(), ...overrides, evidenceJson: {},
  });
  it('replays all migrations from zero and has no Prisma schema drift', () => {
    const output = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000, stdio: 'pipe',
    });
    expect(output).toContain('No difference detected');
  }, 70_000);
  it.each(['LOW', 'NORMAL', 'HIGH', 'EXTREME'])('accepts Volatility %s', async state => {
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ rawState: state, effectiveState: state }) })).toMatchObject({ dimension: 'VOLATILITY', rawState: state });
  });
  it.each(['UP', 'NEUTRAL', 'DOWN'])('retains Trend %s', async state => {
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ dimension: 'TREND', rawState: state, effectiveState: state }) })).toMatchObject({ rawState: state });
  });
  it.each([
    ['VOLATILITY', 'UP'], ['VOLATILITY', 'NEUTRAL'], ['VOLATILITY', 'DOWN'], ['VOLATILITY', 'UNKNOWN'],
    ['TREND', 'LOW'], ['TREND', 'NORMAL'], ['TREND', 'HIGH'], ['TREND', 'EXTREME'],
  ] as const)('rejects cross-vocabulary/invalid %s %s', async (dimension, state) => {
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ dimension, rawState: state, effectiveState: state }) })).rejects.toThrow();
  });
  it.each(['VALID', 'UNAVAILABLE', 'FAILED'] as const)('requires sessionDate for daily Volatility %s', async status => {
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ sessionDate: null, status,
      ...(status !== 'VALID' ? { rawState: null, effectiveState: null, reasonCode: 'TEST' } : {}) }) })).rejects.toThrow();
  });
  it('enforces immutability, attempt/VALID uniqueness and predecessor integrity', async () => {
    const parent = await db.marketRegimeDimensionAssessment.create({ data: valid() });
    await expect(db.marketRegimeDimensionAssessment.update({ where: { id: parent.id }, data: { effectiveState: 'HIGH' } })).rejects.toThrow('immutable');
    await expect(db.marketRegimeDimensionAssessment.delete({ where: { id: parent.id } })).rejects.toThrow('immutable');
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ algorithmVersion: parent.algorithmVersion, attempt: 2 }) })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ algorithmVersion: parent.algorithmVersion }) })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ previousAssessmentId: parent.id }) })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ dimension: 'TREND', algorithmVersion: parent.algorithmVersion, rawState: 'UP', effectiveState: 'UP', previousAssessmentId: parent.id }) })).rejects.toMatchObject({ code: 'P2003' });
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ id: 900000, previousAssessmentId: 900000 }) })).rejects.toThrow();
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ algorithmVersion: parent.algorithmVersion, targetAt: new Date('2026-09-15T20:00Z'), sessionDate: new Date('2026-09-15'), validUntil: new Date('2026-09-16T20:30Z'), previousAssessmentId: parent.id }) })).toMatchObject({ previousAssessmentId: parent.id });
  });
  it('bootstraps the calendar once, skips equivalents and rolls back every insert on conflicts', async () => {
    await db.marketCalendarException.create({ data: { sessionDate: new Date('2025-01-09'), name: 'Operator early close', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 } });
    expect(await bootstrapMarketCalendar(true, db)).toMatchObject({ inserted: 0, conflicts: [expect.any(Object)] });
    expect(await db.marketCalendarException.count()).toBe(1);
    // Only the isolated fixture's deliberately conflicting mutable operator row is removed.
    await db.marketCalendarException.deleteMany();
    expect(await bootstrapMarketCalendar(true, db)).toMatchObject({ inserted: 71, skipped: 0, conflicts: [] });
    expect(await bootstrapMarketCalendar(true, db)).toMatchObject({ inserted: 0, skipped: 71, conflicts: [] });
    expect(await db.marketCalendarException.findUnique({ where: { sessionDate: new Date('2025-01-09') } })).toMatchObject({ type: 'CLOSED', closeTimeMinutesEt: null });
  });
  async function untouchedEvidence() {
    const tables = ['Signal', 'SignalDelivery', 'SignalEvaluation', 'EntryDecision', 'OrderIntent', 'BrokerOrder', 'TrackedPosition', 'CurrentMarketState'];
    const counts = [];
    for (const table of tables) counts.push({ table, rows: (await sql.query(`SELECT * FROM "${table}" ORDER BY id`)).rows });
    return { counts, trend: await db.marketRegimeDimensionAssessment.findMany({ where: { dimension: 'TREND' }, orderBy: { id: 'asc' } }) };
  }
  async function addSession(date: string) {
    const securities = await db.security.findMany({ where: { symbol: { in: ['SPY', 'RSP'] } } });
    await db.marketBar.createMany({ data: securities.map(security => ({ securityId: security.id, timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED', barStartAt: etInstant(date, 0), open: '100', high: '101', low: '99', close: '100', volume: '1000', receivedAt: new Date() })) });
  }
  it('serializes real competing publishers, publishes one bootstrap and preserves all trading/Trend evidence', async () => {
    await db.security.createMany({ data: ['SPY', 'RSP'].map(symbol => ({ symbol, name: symbol, assetType: 'ETF' as const })) });
    for (const date of datesBetween('2026-05-01', '2026-09-14').filter(d => marketSession(d, verifiedClosureRows))) await addSession(date);
    const before = await untouchedEvidence();
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const options = { db, now: new Date('2026-09-14T20:30Z'), fetchSplits: async () => { entered(); await gate; return []; } };
    const first = publishVolatilityAssessments(options); await inside;
    try { await expect(publishVolatilityAssessments(options)).rejects.toMatchObject({ statusCode: 409 }); } finally { release(); }
    expect(await first).toMatchObject({ published: 1, attempts: 1 });
    expect(await publishVolatilityAssessments({ ...options, fetchSplits: async () => [] })).toMatchObject({ published: 0, attempts: 0, notDue: true });
    const published = await db.marketRegimeDimensionAssessment.findMany({ where: { algorithmVersion: 'VOLATILITY_V1' } });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ previousAssessmentId: null, rawState: 'LOW', effectiveState: 'LOW', sessionDate: new Date('2026-09-14') });
    expect(published[0]!.evidenceJson).toMatchObject({ bootstrap: true, definition: { algorithmVersion: 'VOLATILITY_V1' }, spy: { severities: [0, 0, 2] } });
    expect(await untouchedEvidence()).toEqual(before);
  }, 30_000);
  it('pins the first unresolved date, retries immutably, and links the chronological valid chain', async () => {
    const before = await untouchedEvidence(); await addSession('2026-09-16');
    const options = { db, now: new Date('2026-09-16T20:30Z'), fetchSplits: async () => [] };
    expect(await publishVolatilityAssessments(options)).toMatchObject({ blocked: { sessionDate: '2026-09-15', reasonCode: 'MISSING_MARKET_DATA' } });
    const failed = await db.marketRegimeDimensionAssessment.findFirstOrThrow({ where: { algorithmVersion: 'VOLATILITY_V1', status: 'UNAVAILABLE' } });
    expect(await publishVolatilityAssessments(options)).toMatchObject({ suppressed: true, attempts: 0 });
    expect(await db.marketRegimeDimensionAssessment.count({ where: { algorithmVersion: 'VOLATILITY_V1', sessionDate: new Date('2026-09-16') } })).toBe(0);
    await addSession('2026-09-15');
    expect(await publishVolatilityAssessments(options)).toMatchObject({ published: 2, blocked: null });
    const chain = await db.marketRegimeDimensionAssessment.findMany({ where: { algorithmVersion: 'VOLATILITY_V1' }, orderBy: { id: 'asc' } });
    expect(chain.map(row => row.status)).toEqual(['VALID', 'UNAVAILABLE', 'VALID', 'VALID']);
    expect(chain[2]).toMatchObject({ attempt: 2, previousAssessmentId: chain[0]!.id });
    expect(chain[3]!.previousAssessmentId).toBe(chain[2]!.id);
    expect(await db.marketRegimeDimensionAssessment.findUnique({ where: { id: failed.id } })).toEqual(failed);
    expect(await untouchedEvidence()).toEqual(before);
  });
});
