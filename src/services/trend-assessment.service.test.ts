import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
const reads = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: { marketRegimeDimensionAssessment: reads } }));
import { getTrendAssessment, latestTrendAssessment, listTrendAssessments, publishTrendAssessments } from './trend-assessment.service.js';
import { datesBetween, etInstant, isWeekend, type CalendarException } from './market-calendar.js';
import * as calculation from './trend-calculation.js';

type Row = { id: number; securityId: number; barStartAt: Date; open: number; high: number; low: number; close: number; volume: number };
const historyDates = datesBetween('2026-05-01', '2026-09-14').filter(d => !isWeekend(d));
let rows: Row[];
let assessments: MarketRegimeDimensionAssessment[];
let exceptions: CalendarException[];
let locked: boolean;
let tx: ReturnType<typeof makeTx>;
const fetchSplits = vi.fn().mockResolvedValue([]);
function add(date: string, securityId: number, close = 100 + historyDates.length) {
  rows.push({ id: rows.length + 1, securityId, barStartAt: etInstant(date, 0), open: close, high: close, low: close, close, volume: 1000 });
}
function makeTx() {
  return {
    $queryRaw: vi.fn(async () => [{ acquired: !locked }]),
    security: { findMany: vi.fn(async () => [{ id: 1, symbol: 'SPY' }, { id: 2, symbol: 'RSP' }]) },
    marketBar: { findMany: vi.fn(async (args: { where: { barStartAt: { lt: Date } } }) => rows.filter(row => row.barStartAt < args.where.barStartAt.lt).sort((a, b) => +a.barStartAt - +b.barStartAt || a.id - b.id)) },
    marketCalendarException: { findMany: vi.fn(async () => exceptions.map(row => ({ ...row, sessionDate: new Date(row.sessionDate) }))) },
    marketRegimeDimensionAssessment: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: { status?: string; targetAt?: { gt: Date }; sessionDate?: Date }; orderBy: unknown }) => {
        const matches = assessments.filter(a => (!where.status || a.status === where.status) && (!where.targetAt || a.targetAt > where.targetAt.gt) && (!where.sessionDate || +a.sessionDate! === +where.sessionDate));
        const asc = JSON.stringify(orderBy).includes('asc');
        return matches.sort((a, b) => (asc ? 1 : -1) * (+a.targetAt - +b.targetAt) || b.attempt - a.attempt)[0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<MarketRegimeDimensionAssessment, 'id' | 'createdAt'> }) => {
        const row = { ...data, id: assessments.length + 1, createdAt: new Date() }; assessments.push(row); return row;
      }),
    },
    systemEvent: { create: vi.fn(async () => ({})) },
  };
}
function run(at = '2026-09-14T20:31:00Z') {
  const db = { $transaction: async (execute: (client: typeof tx) => unknown) => execute(tx), marketRegimeDimensionAssessment: { findFirst: async ({ where }: { where: { targetAt: Date } }) => assessments.find(a => a.status === 'VALID' && +a.targetAt === +where.targetAt) ?? null } } as unknown as PrismaClient;
  return publishTrendAssessments({ db, now: new Date(at), clock: () => new Date(at), fetchSplits });
}
const evidence = (index = assessments.length - 1) => assessments[index]!.evidenceJson as unknown as { bootstrap: boolean; historicalReplay: { sessionCount: number }; transition: calculation.TransitionEvidence; provenance: { canonicalInputHash: string; instruments: { splits: unknown[] }[] }; spy: calculation.InstrumentEvidence; nextExpectedSession: { sessionDate: string } };
beforeEach(() => {
  vi.restoreAllMocks(); reads.findFirst.mockReset(); reads.findMany.mockReset(); fetchSplits.mockReset().mockResolvedValue([]);
  assessments = []; rows = []; exceptions = []; locked = false; tx = makeTx();
  historyDates.forEach((date, i) => { add(date, 1, 100 + i); add(date, 2, 100 + i); });
});

describe('authoritative TREND_V1 publication', () => {
  it('internally replays history but inserts exactly one bootstrap with explicit provenance', async () => {
    expect(await run()).toMatchObject({ published: 1, attempts: 1, blocked: null });
    expect(assessments).toHaveLength(1);
    expect(assessments[0]).toMatchObject({ previousAssessmentId: null, status: 'VALID', algorithmVersion: 'TREND_V1', rawState: 'UP', effectiveState: 'UP', attempt: 1, sessionDate: new Date('2026-09-14'), targetAt: new Date('2026-09-14T20:00Z'), dataThroughAt: new Date('2026-09-14T20:00Z'), validUntil: new Date('2026-09-15T20:30Z') });
    expect(evidence()).toMatchObject({ bootstrap: true, historicalReplay: { sessionCount: historyDates.length }, spy: { state: 'UP' } });
    expect(evidence().spy.measurements).toHaveLength(9);
    expect(evidence().provenance.canonicalInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tx.systemEvent.create).toHaveBeenCalledTimes(1);
    expect(await run()).toMatchObject({ notDue: true, published: 0 });
    expect(assessments).toHaveLength(1);
  });
  it('bootstraps the replayed effective state and pending recovery, rather than the latest raw state', async () => {
    const bars = historyDates.map((date, i) => {
      const close = i < 75 ? 200 - i : 125 + (i - 75) * 8;
      return { id: i + 1, date, open: close, high: close, low: close, close, volume: 1000, normalizationFactor: 1 };
    });
    const replay = calculation.calculateTrend(historyDates, bars, bars, 'TIGHT');
    const chosen = replay.find(day => day.status === 'VALID' && day.rawState !== day.effectiveState && day.transition.recoveryConfirmation === 1)!;
    expect(chosen).toBeDefined();
    rows = [];
    for (const bar of bars.filter(bar => bar.date <= chosen.date)) { add(bar.date, 1, bar.close); add(bar.date, 2, bar.close); }
    expect(await run(`${chosen.date}T20:31Z`)).toMatchObject({ published: 1 });
    expect(assessments).toHaveLength(1);
    expect(assessments[0]).toMatchObject({ previousAssessmentId: null, rawState: chosen.rawState, effectiveState: chosen.effectiveState });
    expect(evidence().transition).toEqual({ predecessorAssessmentId: null, ...chosen.transition });
  });
  it('blocks Wednesday behind missing Tuesday, suppresses duplicates, then recovers in order', async () => {
    await run();
    add('2026-09-15', 2); add('2026-09-16', 1); add('2026-09-16', 2);
    expect(await run('2026-09-16T20:31Z')).toMatchObject({ published: 0, blocked: { sessionDate: '2026-09-15', reasonCode: 'MISSING_MARKET_DATA' } });
    expect(assessments.map(a => a.status)).toEqual(['VALID', 'UNAVAILABLE']);
    expect(await run('2026-09-16T20:46Z')).toMatchObject({ suppressed: true, attempts: 0 });
    add('2026-09-15', 1);
    expect(await run('2026-09-16T21:00Z')).toMatchObject({ published: 2, blocked: null });
    expect(assessments.map(a => [a.sessionDate!.toISOString().slice(0, 10), a.status, a.attempt, a.previousAssessmentId])).toEqual([
      ['2026-09-14', 'VALID', 1, null], ['2026-09-15', 'UNAVAILABLE', 1, 1], ['2026-09-15', 'VALID', 2, 1], ['2026-09-16', 'VALID', 1, 3],
    ]);
    expect(evidence().bootstrap).toBe(false);
  });
  it('publishes a prior bootstrap then makes the first missing later session visible', async () => {
    expect(await run('2026-09-16T20:31Z')).toMatchObject({ published: 1, blocked: { sessionDate: '2026-09-15', status: 'UNAVAILABLE' } });
    expect(assessments).toHaveLength(2);
    expect(assessments[0]!.previousAssessmentId).toBeNull();
  });
  it('bootstraps before a more recent incomplete warm-up, then stops at the historical gap', async () => {
    add('2026-09-15', 1); add('2026-09-16', 1); add('2026-09-16', 2);
    expect(await run('2026-09-16T20:31Z')).toMatchObject({ published: 1, blocked: { sessionDate: '2026-09-15' } });
    expect(assessments[0]!.sessionDate).toEqual(new Date('2026-09-14'));
  });
  it('records insufficient warm-up and no fake neutral state', async () => {
    rows = rows.slice(-20);
    expect(await run()).toMatchObject({ published: 0, blocked: { status: 'UNAVAILABLE', reasonCode: 'INSUFFICIENT_HISTORY' } });
    expect(assessments[0]).toMatchObject({ rawState: null, effectiveState: null });
    expect(await run()).toMatchObject({ suppressed: true });
  });
  it('records missing inputs when both securities have no bars', async () => {
    rows = [];
    expect(await run()).toMatchObject({ blocked: { reasonCode: 'MISSING_MARKET_DATA', sessionDate: '2026-09-14' } });
    expect(fetchSplits).not.toHaveBeenCalled();
  });
  it('reports split failures, pins the bootstrap target and recovers without skipping', async () => {
    fetchSplits.mockRejectedValue(new Error('provider request failed'));
    expect(await run()).toMatchObject({ blocked: { status: 'FAILED', reasonCode: 'SPLIT_EVIDENCE_UNAVAILABLE' } });
    expect(await run()).toMatchObject({ suppressed: true });
    add('2026-09-15', 1); add('2026-09-15', 2);
    fetchSplits.mockResolvedValue([]);
    expect(await run('2026-09-15T20:31Z')).toMatchObject({ published: 2 });
    expect(assessments.map(a => [a.status, a.attempt, a.previousAssessmentId])).toEqual([['FAILED', 1, null], ['VALID', 2, null], ['VALID', 1, 2]]);
  });
  it('rejects invalid split evidence and preserves exact valid events and factors', async () => {
    fetchSplits.mockImplementation(async (symbol: 'SPY' | 'RSP') => [{ id: 's1', symbol, executionDate: '2026-09-01', splitFrom: 1, splitTo: 2, priceFactor: -1 }]);
    expect(await run()).toMatchObject({ blocked: { reasonCode: 'SPLIT_EVIDENCE_UNAVAILABLE' } });
    fetchSplits.mockImplementation(async (symbol: 'SPY' | 'RSP') => [{ id: 's1', symbol, executionDate: '2026-09-01', splitFrom: 1, splitTo: 2, priceFactor: .5 }]);
    expect(await run()).toMatchObject({ published: 1 });
    expect(evidence().provenance.instruments[0]!.splits).toEqual([{ id: 's1', symbol: 'SPY', executionDate: '2026-09-01', splitFrom: 1, splitTo: 2, priceFactor: .5 }]);
  });
  it('fails closed on calculation or persisted-state decoding failures', async () => {
    const spy = vi.spyOn(calculation, 'calculateTrendWithThresholds').mockImplementation(() => { throw new Error('bad calculation'); });
    expect(await run()).toMatchObject({ blocked: { status: 'FAILED', reasonCode: 'CALCULATION_FAILED' } });
    spy.mockRestore(); await run();
    assessments[1]!.evidenceJson = {};
    add('2026-09-15', 1); add('2026-09-15', 2); add('2026-09-16', 1); add('2026-09-16', 2);
    expect(await run('2026-09-16T20:31Z')).toMatchObject({ published: 0, blocked: { sessionDate: '2026-09-15', reasonCode: 'CALCULATION_FAILED' } });
  });
  it('continues recovery confirmation across independent invocations using persisted evidence', async () => {
    const original = calculation.calculateTrendWithThresholds;
    let raw: calculation.TrendState = 'DOWN';
    vi.spyOn(calculation, 'calculateTrendWithThresholds').mockImplementation((...args) => original(...args).map(day => day.status === 'VALID' ? { ...day, rawState: raw, effectiveState: raw, transition: calculation.advanceTrend({ effective: null, recoveryConfirmation: 0 }, raw) } : day));
    await run();
    raw = 'UP';
    for (const date of ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) {
      add(date, 1); add(date, 2); await run(`${date}T20:31Z`);
    }
    expect(assessments.map(a => a.effectiveState)).toEqual(['DOWN', 'DOWN', 'NEUTRAL', 'NEUTRAL', 'UP']);
    expect(assessments.map((_, i) => evidence(i).transition.recoveryConfirmation)).toEqual([0, 1, 0, 1, 0]);
    raw = 'DOWN'; add('2026-09-21', 1); add('2026-09-21', 2); await run('2026-09-21T20:31Z');
    expect(evidence().transition).toMatchObject({ previousEffectiveState: 'UP', rawState: 'DOWN', effectiveState: 'NEUTRAL', transitioned: true });
  });
  it('uses close plus grace, early closes, holidays and ET session dates', async () => {
    exceptions = [{ sessionDate: '2026-09-14', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }, { sessionDate: '2026-09-15', type: 'CLOSED', closeTimeMinutesEt: null }];
    await run('2026-09-14T17:30Z');
    expect(assessments[0]).toMatchObject({ targetAt: new Date('2026-09-14T17:00Z'), validUntil: new Date('2026-09-16T20:30Z') });
    expect(evidence().nextExpectedSession.sessionDate).toBe('2026-09-16');
    expect(await run('2026-09-16T20:29Z')).toMatchObject({ notDue: true });
    expect(await run('2026-09-16T20:30Z')).toMatchObject({ blocked: { sessionDate: '2026-09-16' } });
  });
  it('does no input work when already current before eligibility', async () => {
    await run(); tx.marketBar.findMany.mockClear(); fetchSplits.mockClear();
    expect(await run('2026-09-15T20:29:59Z')).toMatchObject({ notDue: true });
    expect(tx.marketBar.findMany).not.toHaveBeenCalled(); expect(fetchSplits).not.toHaveBeenCalled();
  });
  it('rejects lock contention before reading state and treats DB uniqueness as idempotent', async () => {
    locked = true;
    await expect(run()).rejects.toMatchObject({ statusCode: 409 });
    expect(tx.marketRegimeDimensionAssessment.findFirst).not.toHaveBeenCalled();
    locked = false;
    tx.marketRegimeDimensionAssessment.create.mockImplementationOnce(async ({ data }) => {
      assessments.push({ ...data, id: 99, createdAt: new Date() }); // Simulate an independently committed winner.
      throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
    });
    expect(await run()).toMatchObject({ published: 0, suppressed: true });
  });
  it('does not hide an attempt collision without a valid winner', async () => {
    tx.marketRegimeDimensionAssessment.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }));
    await expect(run()).rejects.toMatchObject({ code: 'P2002' });
  });
  it('reads both the latest attempt and last valid result without hiding a chronological gap', async () => {
    await run('2026-09-16T20:31Z');
    reads.findFirst.mockResolvedValueOnce(assessments[1]).mockResolvedValueOnce(assessments[0]);
    expect(await latestTrendAssessment()).toEqual({ latestAttempt: assessments[1], latestValid: assessments[0] });
    expect(reads.findFirst.mock.calls.map(call => call[0].where)).toEqual([
      { dimension: 'TREND', algorithmVersion: 'TREND_V1' },
      { dimension: 'TREND', algorithmVersion: 'TREND_V1', status: 'VALID' },
    ]);
    reads.findMany.mockResolvedValue(assessments);
    expect(await listTrendAssessments(10, 7)).toEqual(assessments);
    expect(reads.findMany).toHaveBeenCalledWith({ where: { dimension: 'TREND', algorithmVersion: 'TREND_V1', id: { lt: 7 } }, orderBy: { id: 'desc' }, take: 10 });
    reads.findFirst.mockResolvedValueOnce(assessments[0]).mockResolvedValueOnce(null);
    expect(await getTrendAssessment(1)).toBe(assessments[0]);
    expect(reads.findFirst).toHaveBeenLastCalledWith({ where: { dimension: 'TREND', algorithmVersion: 'TREND_V1', id: 1 } });
    await expect(getTrendAssessment(999)).rejects.toMatchObject({ statusCode: 404 });
  });
});
