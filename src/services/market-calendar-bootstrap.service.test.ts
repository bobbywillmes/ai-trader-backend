import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
vi.mock('../db/prisma.js', () => ({ prisma: {} }));
import { bootstrapMarketCalendar, planCalendarBootstrap, verifiedClosureRows } from './market-calendar-bootstrap.service.js';
import { marketSession } from './market-calendar.js';

describe('verified calendar bootstrap', () => {
  it('contains the unscheduled closure and the verified NYSE early closes', () => {
    expect(verifiedClosureRows.find(row => row.sessionDate === '2025-01-09')).toMatchObject({ type: 'CLOSED', closeTimeMinutesEt: null });
    expect(verifiedClosureRows.filter(row => row.type === 'EARLY_CLOSE')).toHaveLength(12);
    expect(verifiedClosureRows.find(row => row.sessionDate === '2024-11-29')).toMatchObject({ type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 });
    expect(marketSession('2024-11-29', verifiedClosureRows)!.closeMinutes).toBe(780);
    expect(marketSession('2025-01-09', verifiedClosureRows)).toBeNull(); // Verified CLOSED, never treated as an early close.
  });
  it('skips equivalent rows, reports type/close/name conflicts, and leaves unrelated operator rows alone', () => {
    expect(planCalendarBootstrap(verifiedClosureRows).skipped).toHaveLength(71);
    for (const change of [{ type: 'EARLY_CLOSE' as const, closeTimeMinutesEt: 780 }, { closeTimeMinutesEt: 780 }, { name: 'Different canonical purpose' }]) {
      const plan = planCalendarBootstrap([{ ...verifiedClosureRows[0]!, ...change }]);
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0]!.existing).toMatchObject(change);
    }
    // An existing CLOSED row masquerading under a verified EARLY_CLOSE date is also a conflict, not a silent overwrite.
    const earlyClose = verifiedClosureRows.find(row => row.type === 'EARLY_CLOSE')!;
    const conflictingEarlyClose = planCalendarBootstrap([{ sessionDate: earlyClose.sessionDate, name: 'Operator override', type: 'CLOSED', closeTimeMinutesEt: null }]);
    expect(conflictingEarlyClose.conflicts).toHaveLength(1);
    const plan = planCalendarBootstrap([{ sessionDate: '2027-01-01', name: 'Owner future date', type: 'CLOSED', closeTimeMinutesEt: null }]);
    expect(plan.missing).toHaveLength(71);
    expect(plan.conflicts).toEqual([]);
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
