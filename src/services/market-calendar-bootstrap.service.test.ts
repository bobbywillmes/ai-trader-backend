import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
vi.mock('../db/prisma.js', () => ({ prisma: {} }));
import { bootstrapMarketCalendar, planCalendarBootstrap, verifiedCalendarRows } from './market-calendar-bootstrap.service.js';
import { marketSession } from './market-calendar.js';

describe('verified calendar bootstrap', () => {
  it('contains the unscheduled closure and never marks early closes CLOSED', () => {
    expect(verifiedCalendarRows.find(row => row.sessionDate === '2025-01-09')).toMatchObject({ type: 'CLOSED', closeTimeMinutesEt: null });
    expect(marketSession('2024-11-29', verifiedCalendarRows)).not.toBeNull();
    expect(marketSession('2024-11-29', [{ sessionDate: '2024-11-29', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }])!.closeMinutes).toBe(780);
  });
  it('skips equivalent rows, reports type/close/name conflicts, and leaves unrelated operator rows alone', () => {
    expect(planCalendarBootstrap(verifiedCalendarRows).skipped).toHaveLength(71);
    for (const change of [{ type: 'EARLY_CLOSE' as const, closeTimeMinutesEt: 780 }, { closeTimeMinutesEt: 780 }, { name: 'Different canonical purpose' }]) {
      const plan = planCalendarBootstrap([{ ...verifiedCalendarRows[0]!, ...change }]);
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0]!.existing).toMatchObject(change);
    }
    const plan = planCalendarBootstrap([{ sessionDate: '2027-01-01', name: 'Owner future date', type: 'CLOSED', closeTimeMinutesEt: null }]);
    expect(plan.missing).toHaveLength(71);
    expect(plan.conflicts).toEqual([]);
  });
  it('persists all twelve reviewed early closes and detects type/time/name conflicts', () => {
    const early = verifiedCalendarRows.filter(row => row.type === 'EARLY_CLOSE');
    expect(early).toHaveLength(12);
    expect(early.every(row => row.closeTimeMinutesEt === 780)).toBe(true);
    expect(planCalendarBootstrap(early).skipped).toHaveLength(12);
    for (const change of [{ type: 'CLOSED' as const }, { closeTimeMinutesEt: 790 }, { name: 'Different name' }]) {
      expect(planCalendarBootstrap([{ ...early[0]!, ...change }]).conflicts).toHaveLength(1);
    }
    expect(planCalendarBootstrap([{ ...early[0]!, name: ' NYSE   VERIFIED EARLY CLOSE ' }]).skipped).toEqual([early[0]!.sessionDate]);
  });
  it('previews, inserts once, and repeats without any update/delete/network capability', async () => {
    let stored: { sessionDate: Date; name: string; type: 'CLOSED' | 'EARLY_CLOSE'; closeTimeMinutesEt: number | null }[] = [];
    const tx = { $executeRaw: vi.fn(), marketCalendarException: {
      findMany: vi.fn(async () => stored),
      createMany: vi.fn(async ({ data }: { data: typeof stored }) => { stored = [...stored, ...data]; }),
    } };
    const db = { $transaction: async (run: (tx: unknown) => unknown) => run(tx) } as unknown as PrismaClient;
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'));
    try {
      expect(await bootstrapMarketCalendar(false, db)).toMatchObject({ inserted: 0, wouldInsert: 71, conflicts: [] });
      expect(tx.marketCalendarException.createMany).not.toHaveBeenCalled();
      expect(await bootstrapMarketCalendar(true, db)).toMatchObject({ inserted: 71, skipped: 0, conflicts: [] });
      expect(await bootstrapMarketCalendar(true, db)).toMatchObject({ inserted: 0, skipped: 71, conflicts: [] });
      expect(tx.marketCalendarException.createMany).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw).toHaveBeenCalledWith(['LOCK TABLE "MarketCalendarException" IN SHARE ROW EXCLUSIVE MODE']);
      stored = [{ ...stored[0]!, name: 'Operator conflict' }];
      expect(await bootstrapMarketCalendar(true, db)).toMatchObject({ applied: false, inserted: 0, conflicts: [expect.objectContaining({ sessionDate: '2021-01-01' })] });
      expect(tx.marketCalendarException.createMany).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
