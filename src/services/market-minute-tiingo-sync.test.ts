import { beforeEach, describe, expect, it, vi } from 'vitest';
import { etInstant } from './market-calendar.js';

const mocks = vi.hoisted(() => ({ security: vi.fn(), rows: vi.fn(), create: vi.fn(), setting: vi.fn(), fetchMassive: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: { security: { findUnique: mocks.security }, marketBar: { findMany: mocks.rows, create: mocks.create }, setting: { findUnique: mocks.setting } } }));
vi.mock('./market-minute-data-lock.service.js', () => ({ withMarketMinuteDataLock: async (work: () => Promise<unknown>) => work() }));
vi.mock('./market-calendar.service.js', () => ({ calendarExceptions: async () => [] }));
vi.mock('../integrations/massive/evidence.client.js', () => ({ fetchMinuteEvidence: mocks.fetchMassive }));
vi.mock('./intraday-stress-provider-authority.js', () => ({ intradayAuthority: () => ({ provider: 'TIINGO', cutoverSession: '2026-09-24', authorityVersion: 'SESSION_CUTOVER_V1' }) }));
import { syncMinuteBars } from './market-bar-ingestion.service.js';

const start = etInstant('2026-09-24', 570);
const due = new Date(start.getTime() + 20 * 60_000);
const minute = (i: number) => ({ barStartAt: new Date(start.getTime() + i * 60_000), open: 100, high: 101, low: 99, close: 100, volume: 1 });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.security.mockImplementation(async ({ where }: { where: { symbol: string } }) => ({ id: where.symbol === 'SPY' ? 1 : 2 }));
  mocks.rows.mockResolvedValue([]); mocks.setting.mockResolvedValue(null); mocks.create.mockResolvedValue({});
});

describe('Tiingo current-session minute sync', () => {
  it('makes no request before grace or when all eligible windows already exist', async () => {
    const fetch = vi.fn();
    expect(await syncMinuteBars(new Date(due.getTime() - 1), fetch)).toMatchObject({ inserted: 0, missing: 0 });
    mocks.rows.mockResolvedValue([{ barStartAt: start, provider: 'TIINGO' }]);
    expect(await syncMinuteBars(due, fetch)).toMatchObject({ inserted: 0, missing: 0 });
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('fails before request when a canonical Massive row occupies this session', async () => {
    mocks.rows.mockResolvedValue([{ barStartAt: start, provider: 'MASSIVE' }]);
    const fetch = vi.fn();
    await expect(syncMinuteBars(due, fetch)).rejects.toThrow('Canonical provider conflict');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fetches SPY and RSP concurrently, freezes complete bars, and leaves incomplete windows absent', async () => {
    let resolveSpy!: (value: ReturnType<typeof minute>[]) => void;
    let resolveRsp!: (value: ReturnType<typeof minute>[]) => void;
    const fetch = vi.fn((symbol: string) => new Promise<ReturnType<typeof minute>[]>(resolve => {
      if (symbol === 'SPY') resolveSpy = resolve; else resolveRsp = resolve;
    }));
    const work = syncMinuteBars(due, fetch);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    resolveSpy(Array.from({ length: 15 }, (_, i) => minute(i)));
    resolveRsp(Array.from({ length: 14 }, (_, i) => minute(i)));
    await expect(work).rejects.toThrow('strict 15/15');
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0].data).toMatchObject({ securityId: 1, provider: 'TIINGO', timeframe: 'MINUTE_15', adjustmentMode: 'UNADJUSTED' });
    expect(mocks.fetchMassive).not.toHaveBeenCalled();
  });
  it('honors the retention pause before acquiring Tiingo evidence', async () => {
    mocks.setting.mockResolvedValue({ value: 'true' });
    const fetch = vi.fn();
    await expect(syncMinuteBars(due, fetch)).rejects.toThrow('paused');
    expect(fetch).not.toHaveBeenCalled();
  });
});
