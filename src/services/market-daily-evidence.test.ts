import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_DAILY_EVIDENCE_SYMBOLS } from './market-daily-evidence.definition.js';
import { TREND_SYMBOLS } from './trend-lab.config.js';
import { etInstant } from './market-calendar.js';
const mocks = vi.hoisted(() => ({ db: { security: { findUnique: vi.fn() }, marketCalendarException: { findMany: vi.fn() }, marketBar: { findMany: vi.fn(), createMany: vi.fn() }, setting: { upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn() }, systemEvent: { create: vi.fn(), findMany: vi.fn() } }, fetch: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: mocks.db }));
vi.mock('./market-data-lock.service.js', () => ({ withMarketDataLock: async (run: () => unknown) => run() }));
vi.mock('../integrations/massive/evidence.client.js', () => ({ fetchDailyEvidence: mocks.fetch }));
import { backfillDailyBars, ingestDailyRange, marketDataStatus, syncDailyBars } from './market-bar-ingestion.service.js';
const now = etInstant('2026-09-14', 1000);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.security.findUnique.mockImplementation(async ({ where }) => ({ id: MARKET_DAILY_EVIDENCE_SYMBOLS.indexOf(where.symbol) + 1 }));
  mocks.db.marketCalendarException.findMany.mockResolvedValue([]);
  mocks.db.marketBar.findMany.mockResolvedValue([]);
  mocks.db.marketBar.createMany.mockResolvedValue({ count: 1 });
  mocks.db.systemEvent.findMany.mockResolvedValue([]);
  mocks.fetch.mockResolvedValue([{ barStartAt: etInstant('2026-09-14', 0), open: '1', high: '2', low: '1', close: '2', volume: '100', receivedAt: now }]);
  const checkpoint = { value: JSON.stringify({ fromDate: '2026-09-14', nextAttemptAt: now.toISOString(), lastAttemptAt: null, lastResult: 'COMPLETE:2' }) };
  mocks.db.setting.upsert.mockResolvedValue(checkpoint); mocks.db.setting.findUnique.mockResolvedValue(checkpoint);
});
describe('five-symbol daily acquisition', () => {
  it('keeps the acquisition and Trend calculation panels separate', () => {
    expect(MARKET_DAILY_EVIDENCE_SYMBOLS).toEqual(['SPY', 'QQQ', 'DIA', 'IWM', 'RSP']); expect(TREND_SYMBOLS).toEqual(['SPY', 'RSP']);
  });
  it('backfills all five with insert-only semantics', async () => {
    const result = await backfillDailyBars('2026-09-14', '2026-09-14');
    expect(result.results.map(x => x.symbol)).toEqual(MARKET_DAILY_EVIDENCE_SYMBOLS);
    expect(mocks.fetch.mock.calls.map(x => x[0])).toEqual(MARKET_DAILY_EVIDENCE_SYMBOLS);
    for (const [arg] of mocks.db.marketBar.createMany.mock.calls) expect(arg).toMatchObject({ skipDuplicates: true, data: [{ timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED' }] });
  });
  it('sync covers all five, preserves filters and persisted checkpoint retry', async () => {
    expect(await syncDailyBars(now)).toMatchObject({ inserted: 5, missing: 0 });
    expect(mocks.fetch.mock.calls.map(x => x[0])).toEqual(MARKET_DAILY_EVIDENCE_SYMBOLS);
    for (const [arg] of mocks.db.marketBar.findMany.mock.calls) expect(arg.where).toMatchObject({ timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED' });
    const stored = JSON.parse(mocks.db.setting.update.mock.calls.at(-1)![0].data.value);
    expect(stored.fromDate).toBe('2026-09-14'); expect(stored.nextAttemptAt).toBe(new Date(now.getTime() + 3600000).toISOString());
  });
  it('a completed initialized checkpoint cannot certify historical coverage for added sensors', async () => {
    mocks.db.marketBar.findMany.mockResolvedValue([{ barStartAt: etInstant('2026-09-14', 0) }]);
    const status = await marketDataStatus(now);
    expect(status.symbols.map(x => x.symbol)).toEqual(MARKET_DAILY_EVIDENCE_SYMBOLS);
    for (const sensor of status.symbols) {
      expect(sensor.missing).toEqual([]); expect(sensor.count).toBe(1);
      expect(sensor.historicalMissing).toContain('2026-09-11'); expect(sensor.earliest).toBe('2026-09-14');
    }
    for (const [arg] of mocks.db.marketBar.findMany.mock.calls) expect(arg.where).toMatchObject({ provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED' });
  });
  it('fails clearly on missing catalog and never creates hidden Securities', async () => {
    mocks.db.security.findUnique.mockResolvedValue(null);
    await expect(ingestDailyRange('QQQ', '2026-09-14', '2026-09-14', { now })).rejects.toThrow('Existing Security QQQ');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await marketDataStatus(now)).symbols.every(x => x.securityId === null && x.count === 0)).toBe(true);
  });
  it('accepts early-close daily evidence and preserves immutable overlaps', async () => {
    mocks.db.marketCalendarException.findMany.mockResolvedValue([{ sessionDate: new Date('2026-09-14'), type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }]);
    mocks.db.marketBar.createMany.mockResolvedValue({ count: 0 });
    expect(await ingestDailyRange('DIA', '2026-09-14', '2026-09-14', { now })).toMatchObject({ eligible: 1, inserted: 0, alreadyStored: 1 });
  });
});
