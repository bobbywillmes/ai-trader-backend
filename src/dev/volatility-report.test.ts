import { beforeEach, describe, expect, it, vi } from 'vitest';
import { datesBetween, etInstant, marketSession } from '../services/market-calendar.js';
import { VOLATILITY_RESEARCH_CALENDAR, volatilityResearchExceptions } from './volatility-research-calendar.js';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), readOnly: vi.fn(), securities: vi.fn(), bars: vi.fn(), exceptions: vi.fn(), splits: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: new Proxy({ $transaction: mocks.transaction }, {
  get(target, property) {
    if (property === '$transaction') return target.$transaction;
    throw new Error(`Forbidden database access outside read-only transaction: ${String(property)}`);
  },
}) }));
vi.mock('../integrations/massive/evidence.client.js', () => ({ fetchSplitEvidence: mocks.splits }));
import { buildVolatilityReport } from './volatility-report.js';

const expectedDates = datesBetween('2024-01-02', '2024-03-01').filter(date => marketSession(date, volatilityResearchExceptions([])));
const fixture = () => expectedDates.flatMap(date => [1, 2].map(securityId => ({ id: securityId * 1000 + expectedDates.indexOf(date), securityId, barStartAt: etInstant(date, 0), open: 100, high: 101, low: 99, close: 100, volume: 1000 })));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.securities.mockResolvedValue([{ id: 1, symbol: 'SPY' }, { id: 2, symbol: 'RSP' }]);
  mocks.bars.mockResolvedValue(fixture()); mocks.exceptions.mockResolvedValue([]); mocks.splits.mockResolvedValue([]);
  mocks.transaction.mockImplementation(async (callback: (db: unknown) => Promise<unknown>) => {
    const readModel = (findMany: unknown) => new Proxy({ findMany }, { get(target, property) {
      if (property === 'findMany') return target.findMany;
      throw new Error(`Forbidden model mutation: ${String(property)}`);
    } });
    const allowed = { $executeRaw: mocks.readOnly, security: readModel(mocks.securities), marketBar: readModel(mocks.bars), marketCalendarException: readModel(mocks.exceptions) };
    const db = new Proxy(allowed, { get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      // This includes every MarketRegimeDimensionAssessment and trading method.
      throw new Error(`Forbidden database model: ${String(property)}`);
    } });
    return callback(db);
  });
});

describe('read-only Volatility research runner', () => {
  it('runs without any assessment/trading/write capability and sets PostgreSQL read-only', async () => {
    const report = await buildVolatilityReport(new Date('2024-03-02T00:00:00Z'));
    expect(report.summary.validSessions).toBe(expectedDates.length - 20);
    expect(report.summary.unavailableSessions).toBe(20);
    expect(report.missingSessions).toEqual([]);
    expect(mocks.readOnly).toHaveBeenCalledExactlyOnceWith(['SET TRANSACTION READ ONLY']);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead', timeout: 30_000 });
    expect(mocks.securities).toHaveBeenCalledExactlyOnceWith({ where: { symbol: { in: ['SPY', 'RSP'] } }, select: { id: true, symbol: true } });
    expect(mocks.bars).toHaveBeenCalledWith(expect.objectContaining({ where: { securityId: { in: [1, 2] }, timeframe: 'DAY_1' } }));
    expect(mocks.splits.mock.calls).toEqual([['SPY', '2024-01-02', '2024-03-01'], ['RSP', '2024-01-02', '2024-03-01']]);
    expect(mocks.readOnly.mock.invocationCallOrder[0]).toBeLessThan(mocks.securities.mock.invocationCallOrder[0]!);
    expect(await buildVolatilityReport(new Date('2024-03-02T00:00:00Z'))).toEqual(report);
  });
  it('detects a missing expected session even when both instruments are absent', async () => {
    mocks.bars.mockResolvedValue(fixture().filter(row => row.barStartAt.getTime() !== etInstant('2024-02-01', 0).getTime()));
    const report = await buildVolatilityReport(new Date('2024-03-02T00:00:00Z'));
    expect(report.missingSessions).toEqual([{ date: '2024-02-01', missing: ['SPY', 'RSP'] }]);
    expect(report.days.find(day => day.date === '2024-02-02')!.spy.consecutiveSessions).toBe(1);
    expect(report.days.find(day => day.date === '2024-02-01')!.status).toBe('UNAVAILABLE');
  });
  it('does not treat uncompleted bars as valid daily evidence', async () => {
    const report = await buildVolatilityReport(new Date('2024-03-01T20:00:00Z'));
    expect(report.summary.availableDateRange.last).toBe('2024-02-29');
  });
  it('fails rather than calculate without required split evidence', async () => {
    mocks.splits.mockRejectedValue(new Error('split unavailable'));
    await expect(buildVolatilityReport()).rejects.toThrow('split unavailable');
  });
  it('rejects duplicates, unsupported calendar coverage, and closed-date bars', async () => {
    const rows = fixture(); mocks.bars.mockResolvedValue([...rows, rows.at(-1)]);
    await expect(buildVolatilityReport()).rejects.toThrow('Duplicate');
    mocks.bars.mockResolvedValue([{ ...rows[0], barStartAt: etInstant('2020-01-02', 0) }]);
    await expect(buildVolatilityReport()).rejects.toThrow('coverage');
    mocks.bars.mockResolvedValue([{ ...rows[0], barStartAt: etInstant('2024-01-01', 0) }]);
    await expect(buildVolatilityReport()).rejects.toThrow('closure');
  });
  it('rejects missing securities and empty history', async () => {
    mocks.securities.mockResolvedValue([]);
    await expect(buildVolatilityReport()).rejects.toThrow('securities');
    mocks.securities.mockResolvedValue([{ id: 1, symbol: 'SPY' }, { id: 2, symbol: 'RSP' }]); mocks.bars.mockResolvedValue([]);
    await expect(buildVolatilityReport()).rejects.toThrow('No completed');
  });
  it('uses reviewed holidays, retains early closes and rejects operator conflicts', () => {
    const exceptions = volatilityResearchExceptions([]);
    expect(VOLATILITY_RESEARCH_CALENDAR.closedDates).toHaveLength(59);
    expect(marketSession('2022-06-20', exceptions)).toBeNull();
    expect(marketSession('2025-01-09', exceptions)).toBeNull();
    expect(marketSession('2021-12-31', exceptions)).not.toBeNull();
    expect(marketSession('2024-11-29', exceptions)).not.toBeNull();
    expect(() => volatilityResearchExceptions([{ sessionDate: '2025-01-09', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 }])).toThrow('conflict');
  });
});
