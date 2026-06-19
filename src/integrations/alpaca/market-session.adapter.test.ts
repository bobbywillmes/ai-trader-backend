import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMarketSessionCache,
  getAlpacaMarketSessionSnapshot,
} from './market-session.adapter.js';

const mocks = vi.hoisted(() => ({
  alpacaRequest: vi.fn(),
  settingFindUnique: vi.fn(),
  settingUpsert: vi.fn(),
}));

vi.mock('./client.js', () => ({
  alpacaRequest: mocks.alpacaRequest,
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
    mocks.alpacaRequest.mockReset();
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
    mocks.alpacaRequest
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

    const first = await getAlpacaMarketSessionSnapshot();
    vi.setSystemTime(new Date('2026-06-18T16:00:30.000Z'));
    const second = await getAlpacaMarketSessionSnapshot();

    expect(mocks.alpacaRequest).toHaveBeenCalledTimes(2);
    expect(first.evaluatedTimestamp).toBe('2026-06-18T16:00:00.000Z');
    expect(second.evaluatedTimestamp).toBe('2026-06-18T16:00:30.000Z');
    expect(second.cache).toEqual({ clock: 'cached', calendar: 'cached' });
    expect(second.sessionOpenAt).toBe('2026-06-18T13:30:00.000Z');
    expect(second.sessionCloseAt).toBe('2026-06-18T20:00:00.000Z');
  });

  it('deduplicates simultaneous in-flight requests', async () => {
    mocks.alpacaRequest
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
      getAlpacaMarketSessionSnapshot(),
      getAlpacaMarketSessionSnapshot(),
    ]);

    expect(mocks.alpacaRequest).toHaveBeenCalledTimes(2);
  });

  it('uses persisted next_open and next_close until the cached close is stale', async () => {
    vi.setSystemTime(new Date('2026-06-19T13:03:00.000Z'));
    mocks.alpacaRequest.mockResolvedValueOnce({
      timestamp: '2026-06-19T13:03:00.000Z',
      is_open: false,
      next_open: '2026-06-22T13:30:00.000Z',
      next_close: '2026-06-22T20:00:00.000Z',
    });

    const holiday = await getAlpacaMarketSessionSnapshot();

    expect(holiday.marketOpen).toBe(false);
    expect(holiday.sessionOpenAt).toBeNull();
    expect(holiday.nextOpenAt).toBe('2026-06-22T13:30:00.000Z');
    expect(mocks.alpacaRequest).toHaveBeenCalledTimes(1);

    clearMarketSessionCache();
    mocks.alpacaRequest.mockClear();
    vi.setSystemTime(new Date('2026-06-22T14:00:00.000Z'));

    const monday = await getAlpacaMarketSessionSnapshot();

    expect(mocks.alpacaRequest).not.toHaveBeenCalled();
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
    mocks.alpacaRequest
      .mockResolvedValueOnce({
        timestamp: '2026-06-22T20:01:00.000Z',
        is_open: false,
        next_open: '2026-06-23T13:30:00.000Z',
        next_close: '2026-06-23T20:00:00.000Z',
      });

    const refreshed = await getAlpacaMarketSessionSnapshot();

    expect(mocks.alpacaRequest).toHaveBeenCalledWith('/v2/clock');
    expect(refreshed.nextOpenAt).toBe('2026-06-23T13:30:00.000Z');
  });
});
