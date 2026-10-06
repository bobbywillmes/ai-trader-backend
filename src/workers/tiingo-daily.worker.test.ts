import { describe, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => vi.fn());
vi.mock('../services/tiingo-daily.service.js', () => ({ syncTiingoDaily: sync }));
import { runTiingoDailyWorker } from './tiingo-daily.worker.js';

describe('Tiingo daily worker health', () => {
  it('accepts scheduled and terminal provider absences as successful work', async () => {
    sync.mockResolvedValueOnce({ notDue: false, status: { missing: 2, retrying: 1, noEodCoverage: 1, existingOtherProvider: 0 }, result: { counts: { succeeded: 0, retryScheduled: 1, terminalizedNoEodCoverage: 1, otherProvider: 0, conflict: 0, failed: 0 } } });
    await expect(runTiingoDailyWorker()).resolves.toMatchObject({ outcome: 'success', workSucceeded: true });
    sync.mockResolvedValueOnce({ notDue: true, status: { missing: 2, retrying: 1, noEodCoverage: 1, existingOtherProvider: 0 } });
    await expect(runTiingoDailyWorker()).resolves.toMatchObject({ outcome: 'skipped', skipReason: 'not_due' });
  });
  it('fails for provider failures and canonical collisions', async () => {
    sync.mockResolvedValueOnce({ notDue: false, status: { missing: 1, existingOtherProvider: 0 }, result: { counts: { failed: 1, conflict: 0, otherProvider: 0 } } });
    await expect(runTiingoDailyWorker()).rejects.toThrow('operational failure');
    sync.mockResolvedValueOnce({ notDue: true, status: { missing: 1, existingOtherProvider: 1 } });
    await expect(runTiingoDailyWorker()).rejects.toThrow('operational failure');
  });
  it('treats the absence of an applicable frozen revision as dormant', async () => {
    sync.mockResolvedValueOnce({ notDue: true, dormant: true, dormantReason: 'no_applicable_frozen_revision' });
    await expect(runTiingoDailyWorker()).resolves.toEqual({ outcome: 'skipped', skipReason: 'not_due' });
  });
});
