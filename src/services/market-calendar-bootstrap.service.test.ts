import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
vi.mock('../db/prisma.js', () => ({ prisma: {} }));
import { bootstrapMarketCalendar, planCalendarBootstrap, verifiedClosureRows } from './market-calendar-bootstrap.service.js';
import { marketSession } from './market-calendar.js';

describe('verified calendar bootstrap', () => {
  it('contains the unscheduled closure and never marks early closes CLOSED', () => {
    expect(verifiedClosureRows.find(row => row.sessionDate === '2025-01-09')).toMatchObject({ type: 'CLOSED', closeTimeMinutesEt: null });
    expect(marketSession('2024-11-29', verifiedClosureRows)).not.toBeNull();
    expect(marketSession('2024-11-29', [{ sessionDate: '2024-11-29', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }])!.closeMinutes).toBe(780);
  });
  it('skips equivalent rows, reports type/close/name conflicts, and leaves unrelated operator rows alone', () => {
    expect(planCalendarBootstrap(verifiedClosureRows).skipped).toHaveLength(59);
    for (const change of [{ type: 'EARLY_CLOSE' as const, closeTimeMinutesEt: 780 }, { closeTimeMinutesEt: 780 }, { name: 'Different canonical purpose' }]) {
      const plan = planCalendarBootstrap([{ ...verifiedClosureRows[0]!, ...change }]);
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0]!.existing).toMatchObject(change);
    }
    const plan = planCalendarBootstrap([{ sessionDate: '2027-01-01', name: 'Owner future date', type: 'CLOSED', closeTimeMinutesEt: null }]);
    expect(plan.missing).toHaveLength(59);
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
      expect(await bootstrapMarketCalendar(false, db)).toMatchObject({ inserted: 0, wouldInsert: 59, conflicts: [] });
      expect(tx.marketCalendarException.createMany).not.toHaveBeenCalled();
      expect(await bootstrapMarketCalendar(true, db)).toMatchObject({ inserted: 59, skipped: 0, conflicts: [] });
      expect(await bootstrapMarketCalendar(true, db)).toMatchObject({ inserted: 0, skipped: 59, conflicts: [] });
      expect(tx.marketCalendarException.createMany).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw).toHaveBeenCalledWith(['LOCK TABLE "MarketCalendarException" IN SHARE ROW EXCLUSIVE MODE']);
      stored = [{ ...stored[0]!, name: 'Operator conflict' }];
      expect(await bootstrapMarketCalendar(true, db)).toMatchObject({ applied: false, inserted: 0, conflicts: [expect.objectContaining({ sessionDate: '2021-01-01' })] });
      expect(tx.marketCalendarException.createMany).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});
