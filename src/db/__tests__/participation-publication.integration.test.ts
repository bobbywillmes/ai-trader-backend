import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publishParticipationAssessments, latestParticipationV1Assessment } from '../../services/participation-assessment.service.js';
import { verifiedCalendarRows } from '../../services/market-calendar-bootstrap.service.js';
import { datesBetween, etInstant, isFullMarketSession } from '../../services/market-calendar.js';
import { PARTICIPATION_SYMBOLS } from '../../services/participation-v1.definition.js';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
(enabled ? describe : describe.skip)('Participation publisher on disposable PostgreSQL', () => {
  const database = `participation_publication_${randomUUID().replaceAll('-', '')}`;
  let admin: Client, sql: Client, db: PrismaClient, second: PrismaClient;
  beforeAll(async () => {
    const source = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) throw new Error('Publication integration harness requires local PostgreSQL.');
    // Administrative connection is used only to create/drop a separate random database.
    source.pathname = '/postgres'; source.searchParams.delete('schema');
    admin = new Client({ connectionString: source.toString() }); await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`);
    source.pathname = `/${database}`;
    sql = new Client({ connectionString: source.toString() }); await sql.connect();
    expect((await sql.query('SELECT current_database() AS name')).rows[0].name).toBe(database);
    const migrations = (await readdir('prisma/migrations', { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort();
    expect(migrations).toContain('20260919120000_intraday_stress_v1_assessment_constraints'); expect(migrations).toHaveLength(71);
    for (const migration of migrations) await sql.query(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: source.toString() }) });
    second = new PrismaClient({ adapter: new PrismaPg({ connectionString: source.toString() }) });
    await db.security.createMany({ data: PARTICIPATION_SYMBOLS.map(symbol => ({ symbol, name: symbol, assetType: 'ETF' })) });
  }, 120_000);
  beforeEach(async () => {
    // Only fixture tables in the verified random disposable database are cleared.
    expect((await sql.query('SELECT current_database() AS name')).rows[0].name).toBe(database);
    await sql.query('TRUNCATE "MarketRegimeDimensionAssessment", "MarketBar", "MarketCalendarException", "SystemEvent" RESTART IDENTITY CASCADE');
    await db.marketCalendarException.createMany({ data: verifiedCalendarRows.map(e => ({ ...e, sessionDate: new Date(e.sessionDate) })) });
    await addHistory('2026-07-01', '2026-09-11');
  });
  afterAll(async () => {
    await second?.$disconnect(); await db?.$disconnect(); await sql?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end(); }
  });
  async function addHistory(from: string, through: string, volume = '1000') {
    const securities = await db.security.findMany({ orderBy: { id: 'asc' } });
    const dates = datesBetween(from, through).filter(d => isFullMarketSession(d, verifiedCalendarRows));
    await db.marketBar.createMany({ data: dates.flatMap(date => securities.map(s => ({ securityId: s.id, timeframe: 'DAY_1' as const, provider: 'MASSIVE' as const, adjustmentMode: 'UNADJUSTED' as const,
      barStartAt: etInstant(date, 0), open: '100', high: '101', low: '99', close: '100', volume, receivedAt: new Date('2026-09-14T20:20Z') }))) });
  }
  const run = (date = '2026-09-14') => publishParticipationAssessments({ db, now: etInstant(date, 990), fetchSplits: async () => [] });
  async function authoritySnapshot() {
    const tables = ['OrderIntent', 'BrokerOrder', 'BrokerActivity', 'TrackedPosition', 'PositionExitState', 'Signal', 'SignalDelivery', 'SignalEvaluation', 'EntryDecision', 'CurrentMarketState', 'Strategy', 'Subscription', 'TradingAccountSubscription', 'OperationalAttention', 'MarketBar'];
    const snapshot: Record<string, unknown[]> = {};
    for (const table of tables) snapshot[table] = (await sql.query(`SELECT * FROM "${table}" ORDER BY id`)).rows;
    return snapshot;
  }
  it.each([['QUIET', '700'], ['NORMAL', '1000'], ['ACTIVE', '1300'], ['INTENSE', '1600']])('publisher persists %s with raw/effective equality and complete evidence', async (state, volume) => {
    await addHistory('2026-09-14', '2026-09-14', volume); const before = await authoritySnapshot();
    expect(await run()).toMatchObject({ published: 1, attempts: 1 });
    const row = await db.marketRegimeDimensionAssessment.findFirstOrThrow();
    expect(row).toMatchObject({ dimension: 'PARTICIPATION', algorithmVersion: 'PARTICIPATION_V1', rawState: state, effectiveState: state, attempt: 1, previousAssessmentId: null,
      targetAt: new Date('2026-09-14T20:00Z'), dataThroughAt: new Date('2026-09-14T20:00Z'), validUntil: new Date('2026-09-15T20:30Z') });
    expect(row.evidenceJson).toMatchObject({ bootstrap: true, initialization: { inputBarCount: 105, replayedAssessmentCount: 0, publishedHistoricalAssessmentCount: 0 } });
    const event = await db.systemEvent.findFirstOrThrow(); expect(event).toMatchObject({ type: 'participation_assessment_bootstrap', entityId: String(row.id) });
    expect(await authoritySnapshot()).toEqual(before);
    const { id: _id, createdAt: _createdAt, ...data } = row;
    await expect(db.marketRegimeDimensionAssessment.create({ data: { ...data, attempt: 2, evidenceJson: {} } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.marketRegimeDimensionAssessment.update({ where: { id: row.id }, data: { reasonCode: 'EDIT' } })).rejects.toThrow('immutable');
    await expect(db.marketRegimeDimensionAssessment.delete({ where: { id: row.id } })).rejects.toThrow('immutable');
    expect(await run()).toMatchObject({ attempts: 0, notDue: true });
  });
  it('latest-due bootstrap failure pins target, suppresses duplicates and recovers with correct chain/events', async () => {
    let before = await authoritySnapshot(); expect(await run()).toMatchObject({ blocked: { sessionDate: '2026-09-14' }, published: 0 });
    expect(await authoritySnapshot()).toEqual(before);
    await addHistory('2026-09-15', '2026-09-16'); before = await authoritySnapshot();
    expect(await run('2026-09-16')).toMatchObject({ suppressed: true, attempts: 0, blocked: { sessionDate: '2026-09-14' } });
    expect(await db.marketRegimeDimensionAssessment.count()).toBe(1); expect(await authoritySnapshot()).toEqual(before);
    await addHistory('2026-09-14', '2026-09-14'); before = await authoritySnapshot();
    expect(await run('2026-09-16')).toMatchObject({ published: 3, attempts: 3 });
    const chain = await db.marketRegimeDimensionAssessment.findMany({ orderBy: { id: 'asc' } });
    expect(chain.map(r => [r.status, r.attempt, r.previousAssessmentId])).toEqual([['UNAVAILABLE', 1, null], ['VALID', 2, null], ['VALID', 1, chain[1]!.id], ['VALID', 1, chain[2]!.id]]);
    expect(chain[0]!.targetAt).toEqual(chain[1]!.targetAt); expect(chain[0]).toMatchObject({ rawState: null, effectiveState: null, validUntil: null, dataThroughAt: null });
    expect(await db.systemEvent.findMany({ select: { type: true }, orderBy: { id: 'asc' } })).toEqual([{ type: 'participation_assessment_blocked' }, { type: 'participation_assessment_bootstrap' }]);
    expect(await authoritySnapshot()).toEqual(before);
  });
  it('unresolved continuation blocks newer evidence, then emits recovery and retains failed attempt', async () => {
    await addHistory('2026-09-14', '2026-09-14'); await run(); await addHistory('2026-09-16', '2026-09-16');
    expect(await run('2026-09-16')).toMatchObject({ blocked: { sessionDate: '2026-09-15' } });
    const before = await latestParticipationV1Assessment(db); expect(before.latestAttempt!.status).toBe('UNAVAILABLE'); expect(before.latestValid!.sessionDate).toEqual(new Date('2026-09-14'));
    await addHistory('2026-09-15', '2026-09-15'); const authority = await authoritySnapshot(); expect(await run('2026-09-16')).toMatchObject({ published: 2 });
    expect(await db.marketRegimeDimensionAssessment.findUnique({ where: { id: before.latestAttempt!.id } })).toEqual(before.latestAttempt);
    expect(await db.systemEvent.count({ where: { type: 'participation_assessment_recovered' } })).toBe(1); expect(await authoritySnapshot()).toEqual(authority);
  });
  it('excludes early closes and keeps Friday current until Tuesday 16:30 exclusively', async () => {
    await db.marketCalendarException.create({ data: { sessionDate: new Date('2026-09-14'), name: 'Fixture early close', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 } });
    await run('2026-09-11'); const row = (await latestParticipationV1Assessment(db)).latestValid!;
    expect(row.validUntil).toEqual(new Date('2026-09-15T20:30Z')); expect(await run()).toMatchObject({ notDue: true });
    expect(+new Date('2026-09-15T20:29:59.999Z') < +row.validUntil!).toBe(true); expect(+new Date('2026-09-15T20:30Z') < +row.validUntil!).toBe(false);
    await addHistory('2026-09-15', '2026-09-15'); expect(await run('2026-09-15')).toMatchObject({ published: 1 });
    expect(await db.marketRegimeDimensionAssessment.count({ where: { sessionDate: new Date('2026-09-14') } })).toBe(0);
    expect(await db.marketRegimeDimensionAssessment.findUnique({ where: { id: row.id } })).toEqual(row);
  });
  it('two independent clients contend before dependencies and commit one winner', async () => {
    await addHistory('2026-09-14', '2026-09-14'); const before = await authoritySnapshot();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    const first = publishParticipationAssessments({ db, now: etInstant('2026-09-14', 990), fetchSplits: async () => { enter(); await gate; return []; } });
    await entered;
    try { await expect(publishParticipationAssessments({ db: second, now: etInstant('2026-09-14', 990), fetchSplits: async () => { throw new Error('Loser must not fetch'); } })).rejects.toMatchObject({ statusCode: 409 }); }
    finally { release(); }
    expect(await first).toMatchObject({ published: 1, attempts: 1 }); expect(await db.marketRegimeDimensionAssessment.count()).toBe(1); expect(await authoritySnapshot()).toEqual(before);
  });
  it('event insertion failure rolls back assessment and releases transaction lock', async () => {
    await addHistory('2026-09-14', '2026-09-14');
    await sql.query(`CREATE FUNCTION reject_participation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture event failure'; END $$;
      CREATE TRIGGER reject_participation_event BEFORE INSERT ON "SystemEvent" FOR EACH ROW EXECUTE FUNCTION reject_participation_event()`);
    try { await expect(run()).rejects.toThrow('fixture event failure'); }
    finally { await sql.query('DROP TRIGGER reject_participation_event ON "SystemEvent"; DROP FUNCTION reject_participation_event()'); }
    expect(await db.marketRegimeDimensionAssessment.count()).toBe(0); expect(await db.systemEvent.count()).toBe(0);
    expect(await publishParticipationAssessments({ db: second, now: etInstant('2026-09-14', 990), fetchSplits: async () => [] })).toMatchObject({ published: 1 });
  });
  it('terminated publication connection releases lock and leaves no rows or events', async () => {
    await addHistory('2026-09-14', '2026-09-14');
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    const first = publishParticipationAssessments({ db, now: etInstant('2026-09-14', 990), fetchSplits: async () => { enter(); await gate; return []; } });
    const settled = Promise.allSettled([first]); await entered;
    try {
      const holders = await sql.query("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
      expect(holders.rows).toHaveLength(1); await sql.query('SELECT pg_terminate_backend($1)', [holders.rows[0].pid]);
    } finally { release(); }
    expect((await settled)[0]!.status).toBe('rejected');
    expect(await db.marketRegimeDimensionAssessment.count()).toBe(0); expect(await db.systemEvent.count()).toBe(0);
    expect(await publishParticipationAssessments({ db: second, now: etInstant('2026-09-14', 990), fetchSplits: async () => [] })).toMatchObject({ published: 1 });
  }, 30_000);
});
