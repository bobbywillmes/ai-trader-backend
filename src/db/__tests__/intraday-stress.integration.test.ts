import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifiedClosureRows } from '../../services/market-calendar-bootstrap.service.js';
import { datesBetween, etInstant, marketSession } from '../../services/market-calendar.js';
import { publishIntradayStressAssessments } from '../../services/intraday-stress-assessment.service.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Intraday Stress PostgreSQL integrity and complete migration replay', () => {
  const database = `intraday_stress_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient, databaseUrl: string;
  let sequence = 0;
  const SESSION_DATE = '2026-09-14'; const PRIOR_DATE = '2026-09-11';
  const openMs = etInstant(SESSION_DATE, 570).getTime();
  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; url.searchParams.delete('schema'); databaseUrl = url.toString();
    sql = new Client({ connectionString: databaseUrl }); await sql.connect();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    for (const name of (await readdir('prisma/migrations', { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()) {
      await sql.query(await readFile(`prisma/migrations/${name}/migration.sql`, 'utf8'));
    }
    for (const row of verifiedClosureRows) await db.marketCalendarException.create({ data: { sessionDate: new Date(row.sessionDate), name: row.name, type: row.type, closeTimeMinutesEt: row.closeTimeMinutesEt } });
    await db.security.createMany({ data: ['SPY', 'RSP'].map(symbol => ({ symbol, name: symbol, assetType: 'ETF' as const })) });
  }, 120_000);
  afterAll(async () => {
    await db?.$disconnect(); if (sql) { await sql.query('ROLLBACK'); await sql.end(); }
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });
  const valid = (overrides: Partial<MarketRegimeDimensionAssessment> = {}) => ({
    dimension: 'INTRADAY_STRESS' as const, algorithmVersion: `DB_TEST_${++sequence}`, evidenceSchemaVersion: 1,
    sessionDate: new Date(SESSION_DATE), targetAt: new Date(openMs + 900_000), attempt: 1,
    status: 'VALID' as const, rawState: 'NORMAL', effectiveState: 'NORMAL', dataThroughAt: new Date(openMs + 900_000),
    validUntil: new Date(openMs + 2 * 900_000 + 5 * 60_000), startedAt: new Date(), completedAt: new Date(), ...overrides, evidenceJson: {},
  });
  it('replays all migrations from zero and has no Prisma schema drift', () => {
    const output = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000, stdio: 'pipe',
    });
    expect(output).toContain('No difference detected');
  }, 70_000);
  it.each(['NORMAL', 'ELEVATED', 'HIGH', 'SEVERE'])('accepts Intraday Stress %s', async state => {
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ rawState: state, effectiveState: state }) })).toMatchObject({ dimension: 'INTRADAY_STRESS', rawState: state });
  });
  it.each([
    ['INTRADAY_STRESS', 'UP'], ['INTRADAY_STRESS', 'LOW'], ['INTRADAY_STRESS', 'UNKNOWN'],
    ['VOLATILITY', 'SEVERE'], ['TREND', 'ELEVATED'],
  ] as const)('rejects cross-vocabulary/invalid %s %s', async (dimension, state) => {
    await expect(db.marketRegimeDimensionAssessment.create({ data: valid({ dimension, rawState: state, effectiveState: state }) })).rejects.toThrow();
  });
  it.each(['VALID', 'UNAVAILABLE', 'FAILED'] as const)('requires sessionDate for Intraday Stress %s', async status => {
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
    expect(await db.marketRegimeDimensionAssessment.create({ data: valid({ algorithmVersion: parent.algorithmVersion, targetAt: new Date(openMs + 2 * 900_000), previousAssessmentId: parent.id }) })).toMatchObject({ previousAssessmentId: parent.id });
  });
  async function untouchedEvidence() {
    const tables = ['Signal', 'SignalDelivery', 'SignalEvaluation', 'EntryDecision', 'OrderIntent', 'BrokerOrder', 'TrackedPosition', 'CurrentMarketState'];
    const counts = [];
    for (const table of tables) counts.push({ table, rows: (await sql.query(`SELECT * FROM "${table}" ORDER BY id`)).rows });
    return { counts, trend: await db.marketRegimeDimensionAssessment.findMany({ where: { dimension: 'TREND' }, orderBy: { id: 'asc' } }) };
  }
  async function addDailySession(date: string) {
    const securities = await db.security.findMany({ where: { symbol: { in: ['SPY', 'RSP'] } } });
    await db.marketBar.createMany({ data: securities.map(security => ({ securityId: security.id, timeframe: 'DAY_1' as const, provider: 'MASSIVE' as const, adjustmentMode: 'UNADJUSTED' as const, barStartAt: etInstant(date, 0), open: '100', high: '101', low: '99', close: '100', volume: '1000', receivedAt: new Date() })) });
  }
  async function addMinuteBar(index: number) {
    const securities = await db.security.findMany({ where: { symbol: { in: ['SPY', 'RSP'] } } });
    await db.marketBar.createMany({ data: securities.map(security => ({ securityId: security.id, timeframe: 'MINUTE_15' as const, provider: 'MASSIVE' as const, adjustmentMode: 'UNADJUSTED' as const, barStartAt: new Date(openMs + (index - 1) * 900_000), open: '100', high: '100.1', low: '99.9', close: '100', volume: '1000', receivedAt: new Date() })) });
  }
  it('serializes real competing publishers, publishes exactly one bootstrap and preserves all trading/Trend evidence', async () => {
    for (const date of datesBetween('2026-07-01', PRIOR_DATE).filter(d => marketSession(d, verifiedClosureRows))) await addDailySession(date);
    await addMinuteBar(1);
    const before = await untouchedEvidence();
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const options = { db, now: new Date(openMs + 900_000 + 5 * 60_000 + 1000), fetchSplits: async () => { entered(); await gate; return []; } };
    const first = publishIntradayStressAssessments(options); await inside;
    try { await expect(publishIntradayStressAssessments(options)).rejects.toMatchObject({ statusCode: 409 }); } finally { release(); }
    expect(await first).toMatchObject({ published: 1 });
    expect(await publishIntradayStressAssessments({ ...options, fetchSplits: async () => [] })).toMatchObject({ published: 0, notDue: true });
    const published = await db.marketRegimeDimensionAssessment.findMany({ where: { algorithmVersion: 'INTRADAY_STRESS_V1' } });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ previousAssessmentId: null, rawState: 'NORMAL', effectiveState: 'NORMAL', sessionDate: new Date(SESSION_DATE) });
    expect(published[0]!.evidenceJson).toMatchObject({ session: { bootstrap: true }, baseline: { frozenForSession: true } });
    expect(await untouchedEvidence()).toEqual(before);
  }, 30_000);
  it('advances past a stuck target and only ever persists the current due target, never retroactive history', async () => {
    const before = await untouchedEvidence();
    for (const index of [2, 3, 4, 5]) await addMinuteBar(index);
    const options = { db, now: new Date(openMs + 5 * 900_000 + 5 * 60_000 + 1000), fetchSplits: async () => [] };
    expect(await publishIntradayStressAssessments(options)).toMatchObject({ published: 1 });
    const rows = await db.marketRegimeDimensionAssessment.findMany({ where: { algorithmVersion: 'INTRADAY_STRESS_V1' }, orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(2); // Target 1 (previous test) and target 5 only; 2-4 are never persisted.
    expect(rows[1]).toMatchObject({ targetAt: new Date(openMs + 5 * 900_000), previousAssessmentId: rows[0]!.id });
    expect((rows[1]!.evidenceJson as { replay: { fromIndex: number; throughIndex: number } }).replay).toMatchObject({ fromIndex: 2, throughIndex: 5 });
    expect((await untouchedEvidence()).counts).toEqual(before.counts);
  });
});
