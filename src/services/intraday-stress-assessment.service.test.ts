import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
const reads = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: { marketRegimeDimensionAssessment: reads } }));
import { getIntradayStressAssessment, latestIntradayStressAssessment, listIntradayStressAssessments, publishIntradayStressAssessments } from './intraday-stress-assessment.service.js';
import { datesBetween, etInstant, marketSession, type CalendarException } from './market-calendar.js';
import { verifiedClosureRows } from './market-calendar-bootstrap.service.js';

type Row = { id: number; securityId: number; timeframe: 'DAY_1' | 'MINUTE_15'; barStartAt: Date; open: number; high: number; low: number; close: number; volume: number };
type WhereClause = { dimension?: string; algorithmVersion?: string; status?: string; targetAt?: Date; securityId?: number | { in: number[] }; timeframe?: string; barStartAt?: { gte?: Date; lt?: Date; lte?: Date } };
const SESSION_DATE = '2026-09-14'; // Monday
const PRIOR_DATE = '2026-09-11'; // Prior Friday session
const openMs = etInstant(SESSION_DATE, 570).getTime();
function targetAtFor(index: number) { return new Date(openMs + index * 900_000); }
function dueAt(index: number, offsetMs = 61_000) { return new Date(targetAtFor(index).getTime() + 5 * 60_000 + offsetMs); }
let rows: Row[];
let assessments: MarketRegimeDimensionAssessment[];
let exceptions: CalendarException[];
let locked: boolean;
let tx: ReturnType<typeof makeTx>;
const fetchSplits = vi.fn().mockResolvedValue([]);
function minuteBar(index: number, securityId: number, open: number, high: number, low: number, close: number, volume = 1000): Row {
  return { id: rows.length + 1, securityId, timeframe: 'MINUTE_15', barStartAt: new Date(openMs + (index - 1) * 900_000), open, high, low, close, volume };
}
function dailyHistory(atrHigh = 101, atrLow = 99) {
  // Constant close=100 daily with a fixed true range gives a stable, nonzero ATR14 baseline (2%).
  const dates = datesBetween('2026-07-01', PRIOR_DATE).filter(date => marketSession(date, verifiedClosureRows));
  for (const date of dates) {
    rows.push({ id: rows.length + 1, securityId: 1, timeframe: 'DAY_1', barStartAt: etInstant(date, 0), open: 100, high: atrHigh, low: atrLow, close: 100, volume: 1000 });
    rows.push({ id: rows.length + 1, securityId: 2, timeframe: 'DAY_1', barStartAt: etInstant(date, 0), open: 100, high: atrHigh, low: atrLow, close: 100, volume: 1000 });
  }
}
function makeTx() {
  return {
    $queryRaw: vi.fn(async () => [{ acquired: !locked }]),
    security: {
      findUnique: vi.fn(async ({ where }: { where: { symbol: string } }) => where.symbol === 'SPY' ? { id: 1 } : where.symbol === 'RSP' ? { id: 2 } : null),
      findMany: vi.fn(async () => [{ id: 1, symbol: 'SPY' }, { id: 2, symbol: 'RSP' }]),
    },
    marketBar: {
      findMany: vi.fn(async ({ where }: { where: WhereClause }) => rows.filter(row => {
        if (where.timeframe && row.timeframe !== where.timeframe) return false;
        if (where.securityId !== undefined) {
          const ids = typeof where.securityId === 'number' ? [where.securityId] : where.securityId.in;
          if (!ids.includes(row.securityId)) return false;
        }
        if (where.barStartAt?.gte && row.barStartAt < where.barStartAt.gte) return false;
        if (where.barStartAt?.lt && row.barStartAt >= where.barStartAt.lt) return false;
        if (where.barStartAt?.lte && row.barStartAt > where.barStartAt.lte) return false;
        return true;
      }).sort((a, b) => +a.barStartAt - +b.barStartAt || a.id - b.id)),
    },
    marketCalendarException: { findMany: vi.fn(async () => exceptions.map(row => ({ ...row, sessionDate: new Date(row.sessionDate) }))) },
    marketRegimeDimensionAssessment: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: WhereClause; orderBy?: { targetAt?: 'asc' | 'desc'; attempt?: 'asc' | 'desc' } }) => {
        const matches = assessments.filter(a => (!where.dimension || a.dimension === where.dimension) && (!where.algorithmVersion || a.algorithmVersion === where.algorithmVersion)
          && (!where.status || a.status === where.status) && (where.targetAt === undefined || +a.targetAt === +where.targetAt));
        if (orderBy?.targetAt) return matches.sort((a, b) => (orderBy.targetAt === 'asc' ? 1 : -1) * (+a.targetAt - +b.targetAt))[0] ?? null;
        if (orderBy?.attempt) return matches.sort((a, b) => (orderBy.attempt === 'asc' ? 1 : -1) * (a.attempt - b.attempt))[0] ?? null;
        return matches[0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<MarketRegimeDimensionAssessment, 'id' | 'createdAt'> }) => {
        const row = { ...data, id: assessments.length + 1, createdAt: new Date() }; assessments.push(row); return row;
      }),
    },
    systemEvent: { create: vi.fn(async () => ({})) },
  };
}
function run(now: Date) {
  const db = {
    $transaction: async (execute: (client: typeof tx) => unknown) => execute(tx),
    marketRegimeDimensionAssessment: { findFirst: async ({ where }: { where: { targetAt: Date } }) => assessments.find(a => a.status === 'VALID' && +a.targetAt === +where.targetAt) ?? null },
  } as unknown as PrismaClient;
  return publishIntradayStressAssessments({ db, now, clock: () => now, fetchSplits });
}
type Evidence = {
  baseline: { spy: number | null; rsp: number | null; frozenForSession: boolean; provenance: { reused: boolean; fromAssessmentId?: number } | null };
  session: { sameSession: boolean; bootstrap: boolean; previousSessionDate: string | null };
  replay: { fromIndex: number; throughIndex: number; replayedCount: number };
  spy: { rollingStatus: string; instrumentRawState: string | null } | null;
  rsp: { rollingStatus: string; instrumentRawState: string | null } | null;
  market: { rawState: string | null };
  transition: { effectiveState: string | null; confirmationAfter: number; transitioned: boolean };
};
const evidence = (index = assessments.length - 1) => assessments[index]!.evidenceJson as unknown as Evidence;

beforeEach(() => {
  vi.restoreAllMocks(); reads.findFirst.mockReset(); reads.findMany.mockReset(); fetchSplits.mockReset().mockResolvedValue([]);
  assessments = []; rows = []; exceptions = [...verifiedClosureRows]; locked = false; tx = makeTx();
});

describe('authoritative INTRADAY_STRESS_V1 publication', () => {
  it('requires verified calendar coverage before computing anything', async () => {
    exceptions = [];
    expect(await run(dueAt(1))).toMatchObject({ blocked: { reasonCode: 'CALENDAR_EVIDENCE_UNAVAILABLE' } });
    expect(assessments[0]).toMatchObject({ status: 'FAILED', reasonCode: 'CALENDAR_EVIDENCE_UNAVAILABLE', rawState: null, effectiveState: null });
  });

  it('bootstraps the first target of a session with a freshly computed frozen baseline', async () => {
    dailyHistory();
    rows.push(minuteBar(1, 1, 100, 100.5, 99.7, 100.2), minuteBar(1, 2, 100, 100.3, 99.8, 100.1));
    const result = await run(dueAt(1));
    expect(result).toMatchObject({ published: 1, notDue: false, blocked: null });
    expect(assessments).toHaveLength(1);
    expect(assessments[0]).toMatchObject({ status: 'VALID', sessionDate: new Date(SESSION_DATE), targetAt: targetAtFor(1), attempt: 1, previousAssessmentId: null });
    const ev = evidence();
    expect(ev.baseline).toMatchObject({ spy: 0.02, rsp: 0.02, frozenForSession: true });
    expect(ev.baseline.provenance).toMatchObject({ reused: false });
    expect(ev.session).toMatchObject({ sameSession: false, bootstrap: true });
    expect(ev.spy!.rollingStatus).toBe('NOT_APPLICABLE_SESSION_WARMUP');
    expect(tx.systemEvent.create).toHaveBeenCalledTimes(1);
  });

  it('is not due until the next target has exhausted its evidence grace', async () => {
    dailyHistory();
    rows.push(minuteBar(1, 1, 100, 100.1, 99.9, 100), minuteBar(1, 2, 100, 100.1, 99.9, 100));
    await run(dueAt(1));
    expect(await run(new Date(dueAt(1).getTime() + 1000))).toMatchObject({ notDue: true, published: 0 });
    expect(assessments).toHaveLength(1);
  });

  it('reuses the frozen same-session baseline without recomputing or refetching splits', async () => {
    dailyHistory();
    rows.push(minuteBar(1, 1, 100, 100.5, 99.7, 100.2), minuteBar(1, 2, 100, 100.3, 99.8, 100.1));
    await run(dueAt(1));
    fetchSplits.mockClear();
    rows.push(minuteBar(2, 1, 100.2, 100.6, 100.0, 100.3), minuteBar(2, 2, 100.1, 100.4, 99.9, 100.2));
    const result = await run(dueAt(2));
    expect(result).toMatchObject({ published: 1 });
    expect(fetchSplits).not.toHaveBeenCalled();
    const ev = evidence();
    expect(ev.baseline).toMatchObject({ spy: 0.02, rsp: 0.02 });
    expect(ev.baseline.provenance).toMatchObject({ reused: true, fromAssessmentId: assessments[0]!.id });
    expect(ev.session).toMatchObject({ sameSession: true });
    expect(assessments[1]!.previousAssessmentId).toBe(assessments[0]!.id);
  });

  it('never applies cross-session hysteresis: a new session bootstraps directly from its own raw state', async () => {
    dailyHistory();
    // Session 1: a large upside shock drives effective state to HIGH (0.016/0.02 = 0.80 >= 0.70).
    rows.push(minuteBar(1, 1, 100, 101.6, 100, 100), minuteBar(1, 2, 100, 100.05, 99.95, 100));
    await run(dueAt(1));
    expect(assessments[0]!.effectiveState).toBe('HIGH');
    // Session 2 (next trading day): daily history extended through the new prior session; calm open.
    dailyHistory();
    rows.push({ id: rows.length + 1, securityId: 1, timeframe: 'DAY_1', barStartAt: etInstant(SESSION_DATE, 0), open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    rows.push({ id: rows.length + 1, securityId: 2, timeframe: 'DAY_1', barStartAt: etInstant(SESSION_DATE, 0), open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    const nextOpenMs = etInstant('2026-09-15', 570).getTime();
    rows.push({ id: rows.length + 1, securityId: 1, timeframe: 'MINUTE_15', barStartAt: new Date(nextOpenMs), open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 });
    rows.push({ id: rows.length + 1, securityId: 2, timeframe: 'MINUTE_15', barStartAt: new Date(nextOpenMs), open: 100, high: 100.1, low: 99.9, close: 100, volume: 1000 });
    const result = await run(new Date(nextOpenMs + 900_000 + 5 * 60_000 + 1000));
    expect(result).toMatchObject({ published: 1 });
    expect(assessments[1]).toMatchObject({ rawState: 'NORMAL', effectiveState: 'NORMAL' }); // Not held at HIGH; no carryover.
    expect(evidence().session).toMatchObject({ sameSession: false });
    expect(evidence().transition).toMatchObject({ confirmationAfter: 0, transitioned: false });
  });

  it('reports evidence failure when the prior daily ATR baseline is unavailable', async () => {
    rows.push(minuteBar(1, 1, 100, 100.1, 99.9, 100), minuteBar(1, 2, 100, 100.1, 99.9, 100));
    const result = await run(dueAt(1));
    expect(result).toMatchObject({ blocked: { reasonCode: 'PRIOR_ATR_UNAVAILABLE', status: 'UNAVAILABLE' } });
    expect(assessments[0]).toMatchObject({ status: 'UNAVAILABLE', rawState: null, effectiveState: null });
  });

  it('reports evidence failure when required intraday bars are missing', async () => {
    dailyHistory();
    const result = await run(dueAt(1)); // No MINUTE_15 bars at all.
    expect(result).toMatchObject({ blocked: { reasonCode: 'MISSING_INTRADAY_EVIDENCE', status: 'UNAVAILABLE' } });
  });

  it('advances past a stuck target without retroactively publishing every skipped 15-minute target', async () => {
    dailyHistory();
    rows.push(minuteBar(1, 1, 100, 100.1, 99.9, 100), minuteBar(1, 2, 100, 100.1, 99.9, 100));
    await run(dueAt(1));
    // Simulate downtime through target 5: bars for 2..5 exist (backfilled), but nothing was published meanwhile.
    for (const index of [2, 3, 4, 5]) { rows.push(minuteBar(index, 1, 100, 100.1, 99.9, 100), minuteBar(index, 2, 100, 100.1, 99.9, 100)); }
    const result = await run(dueAt(5));
    expect(result).toMatchObject({ published: 1 });
    expect(assessments).toHaveLength(2); // Only target 1 and target 5 are ever persisted.
    expect(assessments[1]!.targetAt).toEqual(targetAtFor(5));
    const ev = evidence();
    expect(ev.replay).toMatchObject({ fromIndex: 2, throughIndex: 5, replayedCount: 4 });
  });

  it('suppresses a repeated identical failure at the same stuck target without extra work', async () => {
    dailyHistory();
    const first = await run(dueAt(1)); // No bars: MISSING_INTRADAY_EVIDENCE.
    expect(first).toMatchObject({ blocked: { reasonCode: 'MISSING_INTRADAY_EVIDENCE' } });
    expect(assessments).toHaveLength(1);
    const second = await run(new Date(dueAt(1).getTime() + 60_000));
    expect(second).toMatchObject({ suppressed: true, blocked: { reasonCode: 'MISSING_INTRADAY_EVIDENCE' } });
    expect(assessments).toHaveLength(1); // No duplicate row inserted.
  });

  it('eventually recovers a stuck target once evidence arrives, using attempt numbering correctly', async () => {
    dailyHistory();
    await run(dueAt(1)); // Fails: no bars yet.
    rows.push(minuteBar(1, 1, 100, 100.1, 99.9, 100), minuteBar(1, 2, 100, 100.1, 99.9, 100));
    const result = await run(new Date(dueAt(1).getTime() + 60_000));
    expect(result).toMatchObject({ published: 1 });
    expect(assessments.map(a => [a.status, a.attempt])).toEqual([['UNAVAILABLE', 1], ['VALID', 2]]);
    expect(assessments[1]!.previousAssessmentId).toBeNull();
  });

  it('recovers effective state exactly one level after two supporting lower assessments', async () => {
    dailyHistory();
    // Target 1: acute 3% emergency SEVERE.
    rows.push(minuteBar(1, 1, 100, 100.1, 96.8, 96.9), minuteBar(1, 2, 100, 100.1, 99.9, 100));
    await run(dueAt(1));
    expect(assessments[0]!.effectiveState).toBe('SEVERE');
    // Targets 2 and 3: calm, confirming recovery.
    rows.push(minuteBar(2, 1, 96.9, 97.0, 96.8, 96.9), minuteBar(2, 2, 100, 100.1, 99.9, 100));
    await run(dueAt(2));
    expect(assessments[1]!.effectiveState).toBe('SEVERE'); // First confirmation only; no transition yet.
    expect(evidence().transition).toMatchObject({ confirmationAfter: 1, transitioned: false });
    rows.push(minuteBar(3, 1, 96.9, 97.0, 96.8, 96.9), minuteBar(3, 2, 100, 100.1, 99.9, 100));
    await run(dueAt(3));
    expect(assessments[2]!.effectiveState).toBe('HIGH'); // Recovers exactly one level.
    expect(evidence().transition).toMatchObject({ confirmationAfter: 0, transitioned: true });
  });

  it('caps the final actionable target validity at session close, never into the next session', async () => {
    dailyHistory();
    for (let index = 1; index <= 25; index++) { rows.push(minuteBar(index, 1, 100, 100.1, 99.9, 100)); rows.push(minuteBar(index, 2, 100, 100.1, 99.9, 100)); }
    const result = await run(new Date(targetAtFor(25).getTime() + 6 * 60_000));
    expect(result).toMatchObject({ published: 1 });
    expect(assessments[0]!.validUntil).toEqual(etInstant(SESSION_DATE, 960));
  });

  it('rejects lock contention before reading any state', async () => {
    locked = true;
    await expect(run(dueAt(1))).rejects.toMatchObject({ statusCode: 409 });
    expect(tx.marketRegimeDimensionAssessment.findFirst).not.toHaveBeenCalled();
  });

  it('treats a concurrently committed winner as idempotent', async () => {
    dailyHistory();
    rows.push(minuteBar(1, 1, 100, 100.1, 99.9, 100), minuteBar(1, 2, 100, 100.1, 99.9, 100));
    tx.marketRegimeDimensionAssessment.create.mockImplementationOnce(async ({ data }) => {
      assessments.push({ ...data, id: 99, createdAt: new Date() } as MarketRegimeDimensionAssessment);
      throw new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' });
    });
    expect(await run(dueAt(1))).toMatchObject({ published: 0, suppressed: true });
  });

  it('does not hide an attempt collision without a valid winner', async () => {
    dailyHistory();
    rows.push(minuteBar(1, 1, 100, 100.1, 99.9, 100), minuteBar(1, 2, 100, 100.1, 99.9, 100));
    tx.marketRegimeDimensionAssessment.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }));
    await expect(run(dueAt(1))).rejects.toMatchObject({ code: 'P2002' });
  });

  it('reads both the latest attempt and the last valid result without hiding a chronological gap', async () => {
    dailyHistory();
    rows.push(minuteBar(1, 1, 100, 100.1, 99.9, 100), minuteBar(1, 2, 100, 100.1, 99.9, 100));
    await run(dueAt(1));
    reads.findFirst.mockResolvedValueOnce(assessments[0]).mockResolvedValueOnce(assessments[0]);
    expect(await latestIntradayStressAssessment()).toEqual({ latestAttempt: assessments[0], latestValid: assessments[0] });
    reads.findMany.mockResolvedValue(assessments);
    expect(await listIntradayStressAssessments(10, 7)).toEqual(assessments);
    expect(reads.findMany).toHaveBeenCalledWith({ where: { dimension: 'INTRADAY_STRESS', algorithmVersion: 'INTRADAY_STRESS_V1', id: { lt: 7 } }, orderBy: { id: 'desc' }, take: 10 });
    reads.findFirst.mockResolvedValueOnce(assessments[0]).mockResolvedValueOnce(null);
    expect(await getIntradayStressAssessment(1)).toBe(assessments[0]);
    await expect(getIntradayStressAssessment(999)).rejects.toMatchObject({ statusCode: 404 });
  });
});
