import { describe, expect, it, vi } from 'vitest';
import { lockMarketDailySession, marketDailySessionLockKey } from './market-daily-session-lock.service.js';

describe('logical DAY_1 session lock', () => {
  it('derives one stable key per Security and canonical session date', () => {
    expect(marketDailySessionLockKey(42, '2026-01-15')).toBe(marketDailySessionLockKey(42, '2026-01-15'));
    expect(marketDailySessionLockKey(42, '2026-01-15')).not.toBe(marketDailySessionLockKey(43, '2026-01-15'));
    expect(marketDailySessionLockKey(42, '2026-01-15')).not.toBe(marketDailySessionLockKey(42, '2026-01-16'));
  });

  it('requires the transaction lock query to confirm acquisition', async () => {
    const acquired = { $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]) };
    await expect(lockMarketDailySession(acquired as never, 42, '2026-01-15')).resolves.toBeUndefined();
    expect(acquired.$queryRaw).toHaveBeenCalledOnce();
    await expect(lockMarketDailySession({ $queryRaw: vi.fn().mockResolvedValue([]) } as never, 42, '2026-01-15'))
      .rejects.toThrow('Failed to acquire');
  });
});
