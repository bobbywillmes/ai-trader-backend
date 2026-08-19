import { describe, expect, it, vi } from 'vitest';

import { clearSyntheticAcceptanceMarketClockCache } from './startup-cache.js';

describe('manual acceptance startup market-clock cleanup', () => {
  it('removes only the synthetic account persisted clock before startup', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 7 });
    const settings = new Map([
      ['alpacaMarketClockCache:7', '{"nextClose":"2026-08-18T14:39:12.566Z"}'],
      ['alpacaMarketClockCache:99', '{"nextClose":"2026-08-18T20:00:00.000Z"}'],
      ['unrelatedSetting', 'preserved'],
    ]);
    const deleteMany = vi.fn().mockImplementation(async ({ where: { key } }) => ({
      count: settings.delete(key) ? 1 : 0,
    }));

    await expect(clearSyntheticAcceptanceMarketClockCache({
      tradingAccount: { findFirst },
      setting: { deleteMany },
    })).resolves.toEqual({
      accountId: 7,
      key: 'alpacaMarketClockCache:7',
      deleted: 1,
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: { displayName: 'Synthetic Live Acceptance' },
      select: { id: true },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { key: 'alpacaMarketClockCache:7' },
    });
    expect(settings.has('alpacaMarketClockCache:7')).toBe(false);
    expect(settings.get('alpacaMarketClockCache:99')).toContain('20:00:00.000Z');
    expect(settings.get('unrelatedSetting')).toBe('preserved');
  });

  it('fails closed instead of deleting a broad cache scope when the synthetic account is absent', async () => {
    const deleteMany = vi.fn();

    await expect(clearSyntheticAcceptanceMarketClockCache({
      tradingAccount: { findFirst: vi.fn().mockResolvedValue(null) },
      setting: { deleteMany },
    })).rejects.toThrow('Synthetic Live Acceptance account was not found');
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
