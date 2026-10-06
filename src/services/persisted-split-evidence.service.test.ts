import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { canonicalFactor } from './market-split-bootstrap.service.js';
import { normalizedPersistedSplit, readPersistedSplits } from './persisted-split-evidence.service.js';

const split = (splitFrom: number, splitTo: number) => ({ id: 'provider-id', symbol: 'SPY' as const, executionDate: '2026-09-10', splitFrom, splitTo, priceFactor: splitFrom / splitTo });
describe('canonical persisted split semantics', () => {
  it('inverts forward and reverse provider price factors exactly', () => {
    expect(canonicalFactor(split(1, 2))).toBe('2.0000000000');
    expect(normalizedPersistedSplit(7, 'SPY', '2026-09-10', '2').priceFactor).toBe(0.5);
    expect(canonicalFactor(split(10, 1))).toBe('0.1000000000');
    expect(normalizedPersistedSplit(8, 'SPY', '2026-09-10', '0.1').priceFactor).toBe(10);
  });
  it('requires complete persisted coverage even when there are zero events', async () => {
    const db = { security: { findUnique: vi.fn().mockResolvedValue({ id: 1 }) },
      marketSplitCoverage: { findMany: vi.fn().mockResolvedValue([{ fromDate: new Date('2026-09-01'), throughDate: new Date('2026-09-09'), provider: 'MASSIVE' }]) },
      marketSplitEvent: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaClient;
    await expect(readPersistedSplits(db, 'SPY', '2026-09-01', '2026-09-10')).rejects.toThrow('Incomplete');
    expect(db.marketSplitEvent.findMany).not.toHaveBeenCalled();
    vi.mocked(db.marketSplitCoverage.findMany).mockResolvedValue([{ fromDate: new Date('2026-09-01'), throughDate: new Date('2026-09-10'), provider: 'MASSIVE' }] as never);
    expect(await readPersistedSplits(db, 'SPY', '2026-09-01', '2026-09-10')).toEqual([]);
  });
  it('normalizes stored events without provider calls and rejects corrupt provenance', async () => {
    const db = { security: { findUnique: vi.fn().mockResolvedValue({ id: 1 }) },
      marketSplitCoverage: { findMany: vi.fn().mockResolvedValue([{ fromDate: new Date('2026-09-01'), throughDate: new Date('2026-09-10'), provider: 'MASSIVE' }]) },
      marketSplitEvent: { findMany: vi.fn().mockResolvedValue([{ id: 4, executionDate: new Date('2026-09-10'), provider: 'MASSIVE', provenance: 'MASSIVE:provider-id', splitFactor: new Prisma.Decimal(2) }]) } } as unknown as PrismaClient;
    expect(await readPersistedSplits(db, 'SPY', '2026-09-01', '2026-09-10')).toEqual([{ id: 'market-split-event:4', symbol: 'SPY', executionDate: '2026-09-10', splitFrom: 1, splitTo: 2, priceFactor: 0.5 }]);
    vi.mocked(db.marketSplitEvent.findMany).mockResolvedValue([{ id: 4, executionDate: new Date('2026-09-10'), provider: 'MASSIVE', provenance: 'broken', splitFactor: new Prisma.Decimal(2) }] as never);
    await expect(readPersistedSplits(db, 'SPY', '2026-09-01', '2026-09-10')).rejects.toThrow('conflicts');
  });
});
