import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
const reads = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: { marketRegimeDimensionAssessment: reads } }));
import {
  getBreadthV1Assessment, latestBreadthV1Assessment, listBreadthV1Assessments, publishBreadthV1Assessments,
} from './breadth-v1-assessment.service.js';
import { datesBetween, marketSession, type CalendarException } from './market-calendar.js';
import * as calculation from './breadth-v1-calculation.js';

type ObservationRow = { id: number; sessionDate: Date; previousSessionDate: Date; universeCount: number; currentBarCount: number; priorBarCount: number; advancingCount: number; decliningCount: number; unchangedCount: number; directionalCount: number; excludedCount: number; advanceShare: Prisma.Decimal; netBreadth: Prisma.Decimal };
const historyDates = datesBetween('2026-05-01', '2026-09-14').filter(d => marketSession(d));
let observations: ObservationRow[];
let assessments: MarketRegimeDimensionAssessment[];
let exceptions: CalendarException[];
let locked: boolean;
let tx: ReturnType<typeof makeTx>;

function addObservation(date: string, advanceShare = 0.6) {
  const directionalCount = 100;
  const advancingCount = Math.round(advanceShare * directionalCount);
  const decliningCount = directionalCount - advancingCount;
  const previousDate = historyDates[historyDates.indexOf(date) - 1] ?? '2026-04-30';
  observations.push({
    id: observations.length + 1, sessionDate: new Date(date), previousSessionDate: new Date(previousDate),
    universeCount: 100, currentBarCount: 100, priorBarCount: 100, advancingCount, decliningCount, unchangedCount: 0,
    directionalCount, excludedCount: 0, advanceShare: new Prisma.Decimal(advanceShare), netBreadth: new Prisma.Decimal((advancingCount - decliningCount) / directionalCount),
  });
}
function makeTx() {
  return {
    $queryRaw: vi.fn(async () => [{ acquired: !locked }]),
    marketBreadthObservation: {
      count: vi.fn(async () => observations.length),
      findFirst: vi.fn(async (args?: { orderBy?: { sessionDate: string } }) => {
        if (!observations.length) return null;
        const sorted = [...observations].sort((a, b) => +a.sessionDate - +b.sessionDate);
        return args?.orderBy?.sessionDate === 'asc' ? sorted[0]! : sorted.at(-1)!;
      }),
      findMany: vi.fn(async (args: { where: { sessionDate: { lte: Date } } }) => observations.filter(row => row.sessionDate <= args.where.sessionDate.lte).sort((a, b) => +a.sessionDate - +b.sessionDate)),
    },
    marketCalendarException: { findMany: vi.fn(async () => exceptions.map(row => ({ ...row, sessionDate: new Date(row.sessionDate) }))) },
    marketRegimeDimensionAssessment: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: { dimension?: string; algorithmVersion?: string; status?: string; targetAt?: { gt: Date }; sessionDate?: Date }; orderBy: unknown }) => {
        const matches = assessments.filter(a => (!where.dimension || a.dimension === where.dimension) && (!where.algorithmVersion || a.algorithmVersion === where.algorithmVersion) && (!where.status || a.status === where.status) && (!where.targetAt || a.targetAt > where.targetAt.gt) && (!where.sessionDate || +a.sessionDate! === +where.sessionDate));
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
  const db = {
    $transaction: async (execute: (client: typeof tx) => unknown) => execute(tx),
    marketRegimeDimensionAssessment: { findFirst: async ({ where }: { where: { targetAt: Date } }) => assessments.find(a => a.status === 'VALID' && +a.targetAt === +where.targetAt) ?? null },
  } as unknown as PrismaClient;
  return publishBreadthV1Assessments({ db, now: new Date(at), clock: () => new Date(at) });
}
const evidence = (index = assessments.length - 1) => assessments[index]!.evidenceJson as unknown as {
  bootstrap: boolean; historicalReplay: { sessionCount: number }; transition: calculation.BreadthV1Transition;
  provenance: { canonicalReplayHash: string }; measurements: { breadth1: { state: string } }; nextExpectedSession: { sessionDate: string };
};
beforeEach(() => {
  vi.restoreAllMocks(); reads.findFirst.mockReset(); reads.findMany.mockReset();
  assessments = []; observations = []; exceptions = []; locked = false; tx = makeTx();
  historyDates.forEach(date => addObservation(date, 0.6));
});

describe('authoritative BREADTH_V1 publication', () => {
  it('reports bootstrapRequired without any assessment attempt when no observations exist', async () => {
    observations = [];
    expect(await run()).toMatchObject({ bootstrapRequired: true, published: 0, attempts: 0 });
    expect(assessments).toHaveLength(0);
  });
  it('internally replays history but inserts exactly one bootstrap with explicit provenance', async () => {
    expect(await run()).toMatchObject({ published: 1, attempts: 1, blocked: null, bootstrapRequired: false });
    expect(assessments).toHaveLength(1);
    expect(assessments[0]).toMatchObject({ previousAssessmentId: null, status: 'VALID', algorithmVersion: 'BREADTH_V1', dimension: 'BREADTH', rawState: 'POSITIVE', effectiveState: 'POSITIVE', attempt: 1, sessionDate: new Date('2026-09-14') });
    expect(evidence()).toMatchObject({ bootstrap: true, historicalReplay: { sessionCount: historyDates.length }, measurements: { breadth1: { state: 'POSITIVE' } } });
    expect(evidence().provenance.canonicalReplayHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tx.systemEvent.create).toHaveBeenCalledTimes(1);
    expect(await run()).toMatchObject({ notDue: true, published: 0 });
    expect(assessments).toHaveLength(1);
  });
  it('never chooses a predecessor from Trend, Volatility, or another Breadth algorithm', async () => {
    await run();
    const valid = assessments[0]!;
    assessments = [{ ...valid, id: 50, dimension: 'TREND', algorithmVersion: 'TREND_V1' }, { ...valid, id: 51, algorithmVersion: 'BREADTH_V2' }];
    expect(await run()).toMatchObject({ published: 1 });
    expect(assessments.at(-1)!.previousAssessmentId).toBeNull();
  });
  it('blocks on a missing expected session, never fabricates a state, and suppresses identical retries', async () => {
    observations = observations.filter(row => +row.sessionDate !== +new Date('2026-09-10'));
    expect(await run()).toMatchObject({ published: 1, blocked: { sessionDate: '2026-09-10', status: 'UNAVAILABLE', reasonCode: 'MISSING_MARKET_DATA' } });
    expect(assessments[1]).toMatchObject({ rawState: null, effectiveState: null });
    expect(await run()).toMatchObject({ suppressed: true, attempts: 0 });
  });
  it('recovers a backfilled gap in chronological order without skipping the sessions after it', async () => {
    observations = observations.filter(row => +row.sessionDate !== +new Date('2026-09-10'));
    await run();
    addObservation('2026-09-10', 0.6);
    // Recovers 09-10 and then continues chronologically through every remaining due
    // session (09-11, 09-14) in the same call, exactly like Trend/Volatility.
    expect(await run()).toMatchObject({ published: 3, blocked: null });
    const chain = assessments;
    expect(chain.slice(0, 3).map(a => [a.sessionDate!.toISOString().slice(0, 10), a.status, a.attempt])).toEqual([
      ['2026-09-09', 'VALID', 1], ['2026-09-10', 'UNAVAILABLE', 1], ['2026-09-10', 'VALID', 2],
    ]);
    expect(chain[2]!.previousAssessmentId).toBe(chain[0]!.id);
    expect(chain.at(-1)!.sessionDate).toEqual(new Date('2026-09-14'));
    expect(evidence().bootstrap).toBe(false);
  });
  it('continues both hysteresis counters across independent invocations using persisted evidence, not recomputation', async () => {
    const original = calculation.calculateBreadthV1Series;
    let raw: calculation.BreadthState = 'POSITIVE';
    vi.spyOn(calculation, 'calculateBreadthV1Series').mockImplementation((...args) => original(...args).map(day => day.rawState === null ? day : { ...day, rawState: raw }));
    await run(); // bootstrap: raw POSITIVE -> effective POSITIVE
    raw = 'MIXED';
    addObservation('2026-09-15'); await run('2026-09-15T20:31Z'); // first MIXED: mild hold, still POSITIVE
    addObservation('2026-09-16'); await run('2026-09-16T20:31Z'); // second MIXED: confirmed drop to MIXED
    expect(assessments.map(a => a.effectiveState)).toEqual(['POSITIVE', 'POSITIVE', 'MIXED']);
    expect(assessments.map((_, i) => evidence(i).transition)).toMatchObject([
      { mildDeteriorationConfirmationAfter: 0 }, { mildDeteriorationConfirmationAfter: 1 }, { mildDeteriorationConfirmationAfter: 0, transitioned: true },
    ]);
  });
  it('fails closed on calculation failures without fabricating a state', async () => {
    const spy = vi.spyOn(calculation, 'calculateBreadthV1Series').mockImplementation(() => { throw new Error('bad calculation'); });
    expect(await run()).toMatchObject({ blocked: { status: 'FAILED', reasonCode: 'CALCULATION_FAILED' } });
    spy.mockRestore();
  });
  it('does no extra work when already current before eligibility', async () => {
    await run();
    expect(await run('2026-09-15T20:29:59Z')).toMatchObject({ notDue: true });
  });
  it('rejects lock contention before reading state and treats DB uniqueness as idempotent', async () => {
    locked = true;
    await expect(run()).rejects.toMatchObject({ statusCode: 409 });
    expect(tx.marketRegimeDimensionAssessment.findFirst).not.toHaveBeenCalled();
    locked = false;
    tx.marketRegimeDimensionAssessment.create.mockImplementationOnce(async ({ data }) => {
      assessments.push({ ...data, id: 99, createdAt: new Date() });
      throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
    });
    expect(await run()).toMatchObject({ published: 0, suppressed: true });
  });
  it('does not hide an attempt collision without a valid winner', async () => {
    tx.marketRegimeDimensionAssessment.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }));
    await expect(run()).rejects.toMatchObject({ code: 'P2002' });
  });
  it('reads both the latest attempt and last valid result, list, and get without cross-dimension leakage', async () => {
    await run();
    reads.findFirst.mockResolvedValueOnce(assessments[0]).mockResolvedValueOnce(assessments[0]);
    expect(await latestBreadthV1Assessment()).toEqual({ latestAttempt: assessments[0], latestValid: assessments[0] });
    expect(reads.findFirst.mock.calls.map(call => call[0].where)).toEqual([
      { dimension: 'BREADTH', algorithmVersion: 'BREADTH_V1' },
      { dimension: 'BREADTH', algorithmVersion: 'BREADTH_V1', status: 'VALID' },
    ]);
    reads.findMany.mockResolvedValue(assessments);
    expect(await listBreadthV1Assessments(10, 7)).toEqual(assessments);
    expect(reads.findMany).toHaveBeenCalledWith({ where: { dimension: 'BREADTH', algorithmVersion: 'BREADTH_V1', id: { lt: 7 } }, orderBy: { id: 'desc' }, take: 10 });
    reads.findFirst.mockResolvedValueOnce(assessments[0]).mockResolvedValueOnce(null);
    expect(await getBreadthV1Assessment(1)).toBe(assessments[0]);
    await expect(getBreadthV1Assessment(999)).rejects.toMatchObject({ statusCode: 404 });
  });
});
