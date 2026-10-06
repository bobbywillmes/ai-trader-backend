import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { etInstant } from './market-calendar.js';

vi.mock('../config/env.js', () => ({ env: {
  MARKET_DAILY_TIINGO_CUTOVER_SESSION: '2026-10-12',
  MARKET_DAILY_MASSIVE_RESUME_SESSION: '2026-10-19',
} }));

import { env } from '../config/env.js';
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
    vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
    (env as any).MARKET_DAILY_TIINGO_CUTOVER_SESSION = '2026-10-12';
    (env as any).MARKET_DAILY_MASSIVE_RESUME_SESSION = '2026-10-19';
    (db as any).marketBar.findFirst.mockResolvedValue({ barStartAt: etInstant('2026-09-01', 0) });
  });
  afterEach(() => vi.useRealTimers());

  it('plans manual bootstrap requests only inside Massive authority segments', async () => {
    const fetch = vi.fn(async (_symbol: string, _from: string, _through: string) => []);
    await planMarketSplitBootstrap(db, '2026-10-20', fetch);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(new Set(fetch.mock.calls.map(call => `${call[1]}:${call[2]}`))).toEqual(new Set([
      '2026-09-01:2026-10-11',
      '2026-10-19:2026-10-20',
    ]));
  });

  it('extends through the current Massive session before its DAY_1 bar is eligible', async () => {
    const fetch = vi.fn(async (_symbol: string, _from: string, _through: string) => []);
    await planAutomaticMarketSplitExtension(db, etInstant('2026-10-09', 11 * 60), fetch);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.every(call => call[2] === '2026-10-09')).toBe(true);
    expect((db as any).marketBar.findFirst).toHaveBeenCalledTimes(5);
  });

  it('covers the closed weekend boundary before a Monday Tiingo cutover', async () => {
    const fetch = vi.fn(async (_symbol: string, _from: string, _through: string) => []);
    await planAutomaticMarketSplitExtension(db, etInstant('2026-10-11', 12 * 60), fetch);
    expect(fetch.mock.calls.every(call => call[2] === '2026-10-11')).toBe(true);
  });

  it('covers a reviewed holiday date before the next-day Tiingo cutover', async () => {
    (env as any).MARKET_DAILY_TIINGO_CUTOVER_SESSION = '2026-10-13';
    (env as any).MARKET_DAILY_MASSIVE_RESUME_SESSION = '2026-10-20';
    const fetch = vi.fn(async (_symbol: string, _from: string, _through: string) => []);
    await planAutomaticMarketSplitExtension(db, etInstant('2026-10-12', 12 * 60), fetch);
    expect(fetch.mock.calls.every(call => call[2] === '2026-10-12')).toBe(true);
  });

  it('starts a resumed Massive segment at its boundary without requiring a resumed DAY_1 bar', async () => {
    const fetch = vi.fn(async (_symbol: string, _from: string, _through: string) => []);
    await planAutomaticMarketSplitExtension(db, etInstant('2026-10-19', 11 * 60), fetch);
    expect(fetch.mock.calls.every(call => call[1] === '2026-10-19' && call[2] === '2026-10-19')).toBe(true);
    expect((db as any).marketBar.findFirst).not.toHaveBeenCalled();
  });

  it('is dormant inside the Tiingo authority interval without provider requests', async () => {
    const fetch = vi.fn(async (_symbol: string, _from: string, _through: string) => []);
    expect(await planAutomaticMarketSplitExtension(db, etInstant('2026-10-15', 12 * 60), fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect((db as any).marketBar.findFirst).not.toHaveBeenCalled();
  });
});
