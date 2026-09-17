import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
vi.mock('../db/prisma.js', () => ({ prisma: {} }));
import { ingestDueBreadthObservations } from './breadth-observation-ingestion.service.js';

type Row = { id: number; sessionDate: Date };
let rows: Row[];
let created: Record<string, unknown>[];
let exceptions: { sessionDate: Date; type: string; closeTimeMinutesEt: number | null }[];

function makeDb() {
  return {
    marketBreadthObservation: {
      count: vi.fn(async () => rows.length),
      findFirst: vi.fn(async () => (rows.length ? [...rows].sort((a, b) => +b.sessionDate - +a.sessionDate)[0] : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: rows.length + created.length + 1 };
        created.push(row);
        return row;
      }),
    },
    marketCalendarException: { findMany: vi.fn(async () => exceptions) },
  } as unknown as PrismaClient;
}
function grouped(map: Record<string, number>) { return new Map(Object.entries(map)); }

beforeEach(() => {
  rows = [{ id: 1, sessionDate: new Date('2026-09-14') }];
  created = [];
  exceptions = [];
});

describe('live BREADTH_V1 observation ingestion (bounded, Massive only)', () => {
  it('reports bootstrapRequired and makes zero provider calls when never bootstrapped', async () => {
    rows = [];
    const fetchGrouped = vi.fn();
    const fetchUniverse = vi.fn();
    const result = await ingestDueBreadthObservations({ db: makeDb(), fetchGrouped, fetchUniverse, now: new Date('2026-09-16T21:00Z') });
    expect(result).toMatchObject({ bootstrapRequired: true, inserted: 0, attempted: 0 });
    expect(fetchGrouped).not.toHaveBeenCalled();
    expect(fetchUniverse).not.toHaveBeenCalled();
  });
  it('is notDue when the latest observation is already current before eligibility', async () => {
    const result = await ingestDueBreadthObservations({ db: makeDb(), now: new Date('2026-09-14T20:31Z') });
    expect(result).toMatchObject({ bootstrapRequired: false, notDue: true, inserted: 0 });
  });
  it('inserts due sessions with correct derived counts, reusing the grouped cache across the shared boundary date', async () => {
    const closes: Record<string, Record<string, number>> = {
      '2026-09-14': { A: 100, B: 100, C: 100 }, '2026-09-15': { A: 110, B: 90, C: 100 }, '2026-09-16': { A: 90, B: 110, C: 100 },
    };
    const fetchGrouped = vi.fn(async (date: string) => grouped(closes[date]!));
    const fetchUniverse = vi.fn(async () => ['A', 'B', 'C']);
    const db = makeDb();
    const result = await ingestDueBreadthObservations({ db, fetchGrouped, fetchUniverse, now: new Date('2026-09-16T21:00Z') });
    expect(result).toMatchObject({ inserted: 2, attempted: 2, blocked: null });
    expect(created[0]).toMatchObject({ advancingCount: 1, decliningCount: 1, unchangedCount: 1, directionalCount: 2, advanceShare: 0.5 });
    // grouped('2026-09-15') is both the current close for 09-15 and the prior close for
    // 09-16, fetched once and reused, not refetched per session.
    expect(fetchGrouped).toHaveBeenCalledTimes(3);
  });
  it('blocks on a zero-directional session without inserting a fabricated row', async () => {
    const fetchGrouped = vi.fn(async () => grouped({ A: 100 }));
    const fetchUniverse = vi.fn(async () => ['A']);
    const result = await ingestDueBreadthObservations({ db: makeDb(), fetchGrouped, fetchUniverse, now: new Date('2026-09-16T21:00Z') });
    expect(result).toMatchObject({ blocked: { sessionDate: '2026-09-15', reasonCode: 'ZERO_DIRECTIONAL_BREADTH' } });
    expect(created).toHaveLength(0);
  });
  it('fails closed and stops (does not skip past) a provider failure', async () => {
    const fetchGrouped = vi.fn().mockRejectedValue(new Error('Massive breadth reference: request returned HTTP 503'));
    const fetchUniverse = vi.fn(async () => ['A']);
    const result = await ingestDueBreadthObservations({ db: makeDb(), fetchGrouped, fetchUniverse, now: new Date('2026-09-16T21:00Z') });
    expect(result).toMatchObject({ blocked: { sessionDate: '2026-09-15', reasonCode: 'PROVIDER_FAILURE' } });
    expect(created).toHaveLength(0);
  });
  it('never fetches more than the bounded number of missing sessions in one run', async () => {
    rows = [{ id: 1, sessionDate: new Date('2026-08-01') }];
    const fetchGrouped = vi.fn(async () => grouped({ A: 110, B: 90 }));
    const fetchUniverse = vi.fn(async () => ['A', 'B']);
    const result = await ingestDueBreadthObservations({ db: makeDb(), fetchGrouped, fetchUniverse, now: new Date('2026-09-16T21:00Z') });
    expect(result.attempted).toBeLessThanOrEqual(5);
    expect(result.inserted).toBeLessThanOrEqual(5);
  });
  it('treats a concurrent duplicate insert as already-handled rather than a failure', async () => {
    const closes: Record<string, Record<string, number>> = { '2026-09-14': { A: 100, B: 100 }, '2026-09-15': { A: 110, B: 90 } };
    const fetchGrouped = vi.fn(async (date: string) => grouped(closes[date]!));
    const fetchUniverse = vi.fn(async () => ['A', 'B']);
    const db = makeDb();
    (db.marketBreadthObservation.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }));
    const result = await ingestDueBreadthObservations({ db, fetchGrouped, fetchUniverse, now: new Date('2026-09-15T21:00Z') });
    expect(result.blocked).toBeNull();
  });
});
