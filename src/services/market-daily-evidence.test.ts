import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { MARKET_DAILY_EVIDENCE_SYMBOLS } from './market-daily-evidence.definition.js';
import { TREND_SYMBOLS } from './trend-lab.config.js';
import { etInstant } from './market-calendar.js';
const mocks = vi.hoisted(() => ({ db: { security: { findUnique: vi.fn() }, marketCalendarException: { findMany: vi.fn() }, marketBar: { findMany: vi.fn(), upsert: vi.fn() }, setting: { upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn() }, systemEvent: { create: vi.fn(), findMany: vi.fn() }, $queryRaw: vi.fn(), $transaction: vi.fn() }, fetch: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: mocks.db }));
vi.mock('../config/env.js', () => ({ env: { MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-10-07', MARKET_DAILY_MASSIVE_RESUME_SESSION: '2026-10-12' } }));
vi.mock('./market-data-lock.service.js', () => ({ withMarketDataLock: async (run: () => unknown) => run() }));
vi.mock('../integrations/massive/evidence.client.js', () => ({ fetchDailyEvidence: mocks.fetch }));
vi.mock('./tiingo-daily.service.js', () => ({
  withTiingoDailyLock: async (run: () => unknown) => run(),
  ensureTiingoSplitEvent: vi.fn(async () => false),
  canonicalTiingoBar: (bar: { open: number; high: number; low: number; close: number; volume: number; splitFactor: number }) => ({
    open: new Prisma.Decimal(bar.open), high: new Prisma.Decimal(bar.high), low: new Prisma.Decimal(bar.low), close: new Prisma.Decimal(bar.close),
    volume: new Prisma.Decimal(bar.volume), splitFactor: new Prisma.Decimal(bar.splitFactor),
  }),
}));
import { backfillDailyBars, ingestDailyRange, marketDataStatus, syncDailyBars } from './market-bar-ingestion.service.js';
const now = etInstant('2026-09-14', 1000);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.security.findUnique.mockImplementation(async ({ where }) => ({ id: MARKET_DAILY_EVIDENCE_SYMBOLS.indexOf(where.symbol) + 1 }));
  mocks.db.marketCalendarException.findMany.mockResolvedValue([]);
  mocks.db.$queryRaw.mockResolvedValue([{ acquired: true }]);
  mocks.db.marketBar.findMany.mockResolvedValue([]);
  mocks.db.marketBar.upsert.mockImplementation(async ({ create }) => create);
  mocks.db.$transaction.mockImplementation(async work => work(mocks.db));
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
    for (const [arg] of mocks.db.marketBar.upsert.mock.calls) expect(arg).toMatchObject({ create: { timeframe: 'DAY_1', provider: 'MASSIVE', adjustmentMode: 'UNADJUSTED' }, update: {} });
  });
  it('sync covers all five, preserves filters and persisted checkpoint retry', async () => {
    expect(await syncDailyBars(now)).toMatchObject({ inserted: 5, missing: 0 });
    expect(mocks.fetch.mock.calls.map(x => x[0])).toEqual(MARKET_DAILY_EVIDENCE_SYMBOLS);
    for (const [arg] of mocks.db.marketBar.findMany.mock.calls) expect(arg.where).toMatchObject({ timeframe: 'DAY_1' });
    const stored = JSON.parse(mocks.db.setting.update.mock.calls.at(-1)![0].data.value);
    expect(stored.fromDate).toBe('2026-09-14'); expect(stored.nextAttemptAt).toBe(new Date(now.getTime() + 3600000).toISOString());
  });
  it('a completed initialized checkpoint cannot certify historical coverage for added sensors', async () => {
    mocks.db.marketBar.findMany.mockResolvedValue([{ id: 1, securityId: 1, timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED', provider: 'MASSIVE', barStartAt: etInstant('2026-09-14', 0) }]);
    const status = await marketDataStatus(now);
    expect(status.symbols.map(x => x.symbol)).toEqual(MARKET_DAILY_EVIDENCE_SYMBOLS);
    expect(status.dailyAuthority).toMatchObject({ configuredCutoverSession: '2026-10-07', configuredMassiveResumeSession: '2026-10-12',
      expectedProvider: 'MASSIVE', authoritySegments: [
        { provider: 'MASSIVE', through: '2026-10-06' },
        { provider: 'TIINGO', from: '2026-10-07', through: '2026-10-11' },
        { provider: 'MASSIVE', from: '2026-10-12' },
      ] });
    for (const sensor of status.symbols) {
      expect(sensor.missing).toEqual([]); expect(sensor.count).toBe(1);
      expect(sensor.historicalMissing).toContain('2026-09-11'); expect(sensor.earliest).toBe('2026-09-14');
    }
    for (const [arg] of mocks.db.marketBar.findMany.mock.calls) expect(arg.where).toMatchObject({ timeframe: 'DAY_1' });
  });
  it('fails clearly on missing catalog and never creates hidden Securities', async () => {
    mocks.db.security.findUnique.mockResolvedValue(null);
    await expect(ingestDailyRange('QQQ', '2026-09-14', '2026-09-14', { now })).rejects.toThrow('Existing Security QQQ');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await marketDataStatus(now)).symbols.every(x => x.securityId === null && x.count === 0)).toBe(true);
  });
  it('accepts early-close daily evidence and preserves immutable overlaps', async () => {
    mocks.db.marketCalendarException.findMany.mockResolvedValue([{ sessionDate: new Date('2026-09-14'), type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }]);
    const existing = { id: 1, securityId: 4, timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED', provider: 'MASSIVE', barStartAt: etInstant('2026-09-14', 0),
      open: new Prisma.Decimal(1), high: new Prisma.Decimal(2), low: new Prisma.Decimal(1), close: new Prisma.Decimal(2), volume: new Prisma.Decimal(100), splitFactor: null };
    mocks.db.marketBar.findMany.mockResolvedValue([existing]); mocks.db.marketBar.upsert.mockResolvedValue(existing);
    expect(await ingestDailyRange('DIA', '2026-09-14', '2026-09-14', { now })).toMatchObject({ eligible: 1, inserted: 0, alreadyStored: 1 });
  });
  it('recovers missing sessions across Massive to Tiingo to Massive without cross-provider fallback', async () => {
    const runAt = etInstant('2026-10-12', 1300);
    mocks.db.setting.upsert.mockResolvedValue({ value: JSON.stringify({ fromDate: '2026-10-06', nextAttemptAt: runAt.toISOString(), lastAttemptAt: null, lastResult: 'INITIALIZED' }) });
    mocks.db.setting.findUnique.mockResolvedValue(null);
    mocks.fetch.mockImplementation(async (_symbol, from) => [{ barStartAt: etInstant(from, 0), open: '1', high: '2', low: '1', close: '2', volume: '100', receivedAt: runAt }]);
    const tiingo = vi.fn(async (_symbol, date) => [{ barStartAt: new Date(`${date}T00:00:00Z`), open: 1, high: 2, low: 1, close: 2, volume: 100, splitFactor: 1 }]);
    expect(await syncDailyBars(runAt, tiingo)).toMatchObject({ inserted: 25, missing: 0 });
    expect(mocks.fetch).toHaveBeenCalledTimes(10);
    expect(tiingo).toHaveBeenCalledTimes(15);
    expect(mocks.db.marketBar.upsert.mock.calls.filter(([arg]) => arg.create.provider === 'MASSIVE')).toHaveLength(10);
    expect(mocks.db.marketBar.upsert.mock.calls.filter(([arg]) => arg.create.provider === 'TIINGO')).toHaveLength(15);
  });
  it('allows Massive owner backfill wholly before cutover and wholly after resume', async () => {
    const before = etInstant('2026-10-12', 1300);
    mocks.fetch.mockImplementation(async (_symbol, from) => [{ barStartAt: etInstant(from, 0), open: '1', high: '2', low: '1', close: '2', volume: '100', receivedAt: before }]);
    await expect(ingestDailyRange('SPY', '2026-10-06', '2026-10-06', { now: before })).resolves.toMatchObject({ inserted: 1 });
    await expect(ingestDailyRange('SPY', '2026-10-12', '2026-10-12', { now: before })).resolves.toMatchObject({ inserted: 1 });
  });
  it('rejects a Massive owner backfill that intersects an open Tiingo-authority session', async () => {
    const runAt = etInstant('2026-10-12', 1300);
    await expect(ingestDailyRange('SPY', '2026-10-06', '2026-10-09', { now: runAt })).rejects.toThrow('intersects');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
