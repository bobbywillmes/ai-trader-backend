import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../config/env.js', () => ({ env: { MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-09-24' } }));
import { readPersistedSplits } from './persisted-split-evidence.service.js';
import { normalizeSplits } from './trend-calculation.js';

function fixture(factor = 2, eventProvider = 'TIINGO') {
  const bars = ['2026-09-24', '2026-09-25'].map((date, i) => ({ id: i + 2, securityId: 1, timeframe: 'DAY_1',
    barStartAt: new Date(`${date}T00:00:00Z`), provider: 'TIINGO', adjustmentMode: 'UNADJUSTED', splitFactor: new Prisma.Decimal(i ? 1 : factor) }));
  const events = factor === 1 ? [] : [{ id: 7, executionDate: new Date('2026-09-24'), provider: eventProvider,
    provenance: 'TIINGO:EOD:SPY:2026-09-24', splitFactor: new Prisma.Decimal(factor) }];
  const db = { security: { findUnique: vi.fn().mockResolvedValue({ id: 1 }) },
    marketSplitCoverage: { findMany: vi.fn().mockResolvedValue([{ fromDate: new Date('2026-09-23'), throughDate: new Date('2026-09-23'), provider: 'MASSIVE' }]) },
    marketBar: { findMany: vi.fn().mockResolvedValue(bars) }, setting: { findUnique: vi.fn().mockResolvedValue(null) },
    marketCalendarException: { findMany: vi.fn().mockResolvedValue([]) },
    marketSplitEvent: { findMany: vi.fn().mockResolvedValue(events) } };
  return { bars, events, db };
}
describe('persisted split evidence across the daily provider seam', () => {
  it('uses Tiingo splitFactor as coverage and one persisted event as normalization authority', async () => {
    const { db } = fixture();
    const splits = await readPersistedSplits(db as never, 'SPY', '2026-09-23', '2026-09-25');
    expect(splits).toEqual([{ id: 'market-split-event:7', symbol: 'SPY', executionDate: '2026-09-24', splitFrom: 1, splitTo: 2, priceFactor: 0.5 }]);
    const normalized = normalizeSplits(['2026-09-23', '2026-09-24', '2026-09-25'].map((date, id) => ({ id,
      date, open: 100, high: 101, low: 99, close: 100, volume: 1000 })), splits, '2026-09-25');
    expect(normalized.map(bar => bar.normalizationFactor)).toEqual([0.5, 1, 1]);
  });
  it('requires each Tiingo session and rejects missing or conflicting split events', async () => {
    const missing = fixture(); missing.db.marketSplitEvent.findMany.mockResolvedValue([]);
    await expect(readPersistedSplits(missing.db as never, 'SPY', '2026-09-23', '2026-09-25')).rejects.toThrow('Missing persisted');
    const conflict = fixture(2, 'MASSIVE');
    await expect(readPersistedSplits(conflict.db as never, 'SPY', '2026-09-23', '2026-09-25')).rejects.toThrow('conflicts');
    const noBar = fixture(); noBar.db.marketBar.findMany.mockResolvedValue([noBar.bars[0]]);
    await expect(readPersistedSplits(noBar.db as never, 'SPY', '2026-09-23', '2026-09-25')).rejects.toThrow('Incomplete Tiingo');
  });
});
