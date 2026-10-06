import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { etInstant } from './market-calendar.js';

vi.mock('../config/env.js', () => ({ env: {
  MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-10-07',
  MARKET_DAILY_MASSIVE_RESUME_SESSION: '2026-10-12',
} }));
vi.mock('./market-calendar.service.js', () => ({ calendarExceptions: vi.fn(async () => []) }));

import { planAutomaticMarketSplitExtension, planMarketSplitBootstrap } from './market-split-bootstrap.service.js';

const symbols = ['SPY', 'QQQ', 'DIA', 'IWM', 'RSP'];
const db = {
  security: { findUnique: vi.fn(async ({ where }: { where: { symbol: string } }) => ({ id: symbols.indexOf(where.symbol) + 1 })) },
  marketBar: { findFirst: vi.fn() },
  marketSplitCoverage: { findMany: vi.fn(async () => []) },
} as never;

describe('Massive split coverage authority planning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    (db as any).marketBar.findFirst.mockImplementation(async ({ orderBy }: { orderBy?: { barStartAt: string } }) => ({
      barStartAt: orderBy?.barStartAt === 'asc' ? etInstant('2026-09-01', 0) : etInstant('2026-10-13', 0),
    }));
  });
  afterEach(() => vi.useRealTimers());

  it('plans manual bootstrap requests only inside Massive authority segments', async () => {
    const fetch = vi.fn(async (_symbol: string, _from: string, _through: string) => []);
    await planMarketSplitBootstrap(db, '2026-10-13', fetch);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(new Set(fetch.mock.calls.map(call => `${call[1]}:${call[2]}`))).toEqual(new Set([
      '2026-09-01:2026-10-06',
      '2026-10-12:2026-10-13',
    ]));
  });

  it('extends only the active resumed Massive segment after eligible DAY_1 evidence exists', async () => {
    const fetch = vi.fn(async (_symbol: string, _from: string, _through: string) => []);
    const plan = await planAutomaticMarketSplitExtension(db, etInstant('2026-10-13', 21 * 60), fetch);
    expect(plan).toHaveLength(5);
    expect(fetch.mock.calls.every(call => call[1] === '2026-10-12' && call[2] === '2026-10-13')).toBe(true);
  });

  it('is dormant inside the Tiingo authority interval without provider requests', async () => {
    const fetch = vi.fn(async (_symbol: string, _from: string, _through: string) => []);
    expect(await planAutomaticMarketSplitExtension(db, etInstant('2026-10-08', 21 * 60), fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
