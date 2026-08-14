import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMarketSessionCache,
  getAlpacaMarketSessionSnapshot,
} from './market-session.adapter.js';

const mocks = vi.hoisted(() => ({
  alpacaRequestForAccount: vi.fn(),
  settingFindUnique: vi.fn(),
  settingUpsert: vi.fn(),
}));

vi.mock('./client.js', () => ({
  alpacaRequestForAccount: mocks.alpacaRequestForAccount,
}));

vi.mock('../../db/prisma.js', () => ({
  prisma: {
    setting: {
      findUnique: mocks.settingFindUnique,
      upsert: mocks.settingUpsert,
    },
  },
}));

describe('Alpaca market session adapter', () => {
  let persistedClockValue: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T16:00:00.000Z'));
    clearMarketSessionCache();
    persistedClockValue = undefined;
    mocks.alpacaRequestForAccount.mockReset();
    mocks.settingFindUnique.mockReset();
    mocks.settingUpsert.mockReset();
    mocks.settingFindUnique.mockImplementation(async () =>
      persistedClockValue === undefined ? null : { value: persistedClockValue }
    );
    mocks.settingUpsert.mockImplementation(async (args) => {
      persistedClockValue = args.update.value;
      return { key: args.where.key, value: persistedClockValue };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearMarketSessionCache();
  });

  it('caches repeated clock and calendar calls while advancing effective time', async () => {
    mocks.alpacaRequestForAccount
      .mockResolvedValueOnce({
        timestamp: '2026-06-18T16:00:00.000Z',
        is_open: true,
        next_open: '2026-06-19T13:30:00.000Z',
        next_close: '2026-06-18T20:00:00.000Z',
      })
      .mockResolvedValueOnce([
        {
          date: '2026-06-18',
          open: '09:30',
          close: '16:00',
        },
      ]);

    const first = await getAlpacaMarketSessionSnapshot(1);
    vi.setSystemTime(new Date('2026-06-18T16:00:30.000Z'));
    const second = await getAlpacaMarketSessionSnapshot(1);

    expect(mocks.alpacaRequestForAccount).toHaveBeenCalledTimes(2);
    expect(first.evaluatedTimestamp).toBe('2026-06-18T16:00:00.000Z');
    expect(second.evaluatedTimestamp).toBe('2026-06-18T16:00:30.000Z');
    expect(second.cache).toEqual({ clock: 'cached', calendar: 'cached' });
    expect(second.sessionOpenAt).toBe('2026-06-18T13:30:00.000Z');
    expect(second.sessionCloseAt).toBe('2026-06-18T20:00:00.000Z');
  });

  it('normalizes the observed LIVE response as the regular session', async () => {
    vi.setSystemTime(new Date('2026-08-13T17:00:00.000Z'));
    mocks.alpacaRequestForAccount
      .mockResolvedValueOnce({
        timestamp: '2026-08-13T17:00:00.000Z',
        is_open: true,
        next_open: '2026-08-14T13:30:00.000Z',
        next_close: '2026-08-13T20:00:00.000Z',
      })
      .mockResolvedValueOnce([{
        date: '2026-08-13',
        open: '09:30',
        close: '16:00',
        session_open: '0400',
        session_close: '2000',
        settlement_date: '2026-08-14',
      }]);

    const snapshot = await getAlpacaMarketSessionSnapshot(2);

    expect(snapshot).toMatchObject({
      marketOpen: true,
      sessionOpenAt: '2026-08-13T13:30:00.000Z',
      sessionCloseAt: '2026-08-13T20:00:00.000Z',
    });
  });

  it('accepts compact session fields as a compatibility fallback', async () => {
    mocks.alpacaRequestForAccount
      .mockResolvedValueOnce({
        timestamp: '2026-06-18T16:00:00.000Z',
        is_open: true,
        next_open: '2026-06-19T13:30:00.000Z',
        next_close: '2026-06-18T20:00:00.000Z',
      })
      .mockResolvedValueOnce([{
        date: '2026-06-18',
        session_open: '0400',
        session_close: '2000',
      }]);

    const snapshot = await getAlpacaMarketSessionSnapshot(2);
    expect(snapshot.sessionOpenAt).toBe('2026-06-18T08:00:00.000Z');
    expect(snapshot.sessionCloseAt).toBe('2026-06-19T00:00:00.000Z');
  });

  it.each(['400', '04000', '04:0', '2400', '1260', 'abcd'])(
    'rejects invalid compact calendar time %s',
    async (invalidTime) => {
      mocks.alpacaRequestForAccount
        .mockResolvedValueOnce({
          timestamp: '2026-06-18T16:00:00.000Z',
          is_open: true,
          next_open: '2026-06-19T13:30:00.000Z',
          next_close: '2026-06-18T20:00:00.000Z',
        })
        .mockResolvedValueOnce([{
          date: '2026-06-18',
          open: invalidTime,
          close: '16:00',
        }]);

      await expect(getAlpacaMarketSessionSnapshot(2)).rejects.toThrow(
        'missing valid open or close timestamps'
      );
    }
  );

  it('deduplicates simultaneous in-flight requests', async () => {
    mocks.alpacaRequestForAccount
      .mockResolvedValueOnce({
        timestamp: '2026-06-18T16:00:00.000Z',
        is_open: true,
        next_open: '2026-06-19T13:30:00.000Z',
        next_close: '2026-06-18T20:00:00.000Z',
      })
      .mockResolvedValueOnce([
        {
          date: '2026-06-18',
          open: '09:30',
          close: '16:00',
        },
      ]);

    await Promise.all([
      getAlpacaMarketSessionSnapshot(1),
      getAlpacaMarketSessionSnapshot(1),
    ]);

    expect(mocks.alpacaRequestForAccount).toHaveBeenCalledTimes(2);
  });

  it('uses persisted next_open and next_close until the cached close is stale', async () => {
    vi.setSystemTime(new Date('2026-06-19T13:03:00.000Z'));
    mocks.alpacaRequestForAccount.mockResolvedValueOnce({
      timestamp: '2026-06-19T13:03:00.000Z',
      is_open: false,
      next_open: '2026-06-22T13:30:00.000Z',
      next_close: '2026-06-22T20:00:00.000Z',
    });

    const holiday = await getAlpacaMarketSessionSnapshot(1);

    expect(holiday.marketOpen).toBe(false);
    expect(holiday.sessionOpenAt).toBeNull();
    expect(holiday.nextOpenAt).toBe('2026-06-22T13:30:00.000Z');
    expect(mocks.alpacaRequestForAccount).toHaveBeenCalledTimes(1);

    clearMarketSessionCache();
    mocks.alpacaRequestForAccount.mockClear();
    vi.setSystemTime(new Date('2026-06-22T14:00:00.000Z'));

    const monday = await getAlpacaMarketSessionSnapshot(1);

    expect(mocks.alpacaRequestForAccount).not.toHaveBeenCalled();
    expect(monday.marketOpen).toBe(true);
    expect(monday.sessionOpenAt).toBe('2026-06-22T13:30:00.000Z');
    expect(monday.sessionCloseAt).toBe('2026-06-22T20:00:00.000Z');
  });

  it('refreshes the persisted clock once next_close is stale', async () => {
    persistedClockValue = JSON.stringify({
      timestamp: '2026-06-19T13:03:00.000Z',
      isOpen: false,
      nextOpen: '2026-06-22T13:30:00.000Z',
      nextClose: '2026-06-22T20:00:00.000Z',
      fetchedAt: '2026-06-19T13:03:00.000Z',
    });
    vi.setSystemTime(new Date('2026-06-22T20:01:00.000Z'));
    mocks.alpacaRequestForAccount
      .mockResolvedValueOnce({
        timestamp: '2026-06-22T20:01:00.000Z',
        is_open: false,
        next_open: '2026-06-23T13:30:00.000Z',
        next_close: '2026-06-23T20:00:00.000Z',
      });

    const refreshed = await getAlpacaMarketSessionSnapshot(1);

    expect(mocks.alpacaRequestForAccount).toHaveBeenCalledWith(
      1,
      '/v2/clock',
      expect.objectContaining({
        metadata: expect.objectContaining({
          operation: 'market_clock',
          endpoint: 'GET /v2/clock',
        }),
      })
    );
    expect(refreshed.nextOpenAt).toBe('2026-06-23T13:30:00.000Z');
  });
});
