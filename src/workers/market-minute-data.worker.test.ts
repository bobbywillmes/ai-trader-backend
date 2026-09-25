import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock('../services/market-bar-ingestion.service.js', () => ({ syncMinuteBars: mocks.sync }));
import { runMarketMinuteDataWorker } from './market-minute-data.worker.js';
import { HttpError } from '../errors/http-error.js';
beforeEach(() => vi.clearAllMocks());
describe('market minute worker', () => {
  it('prevents in-process overlap and reports useful work', async () => {
    let finish!: (value: unknown) => void; mocks.sync.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = runMarketMinuteDataWorker(); expect(await runMarketMinuteDataWorker()).toEqual({ outcome: 'skipped', skipReason: 'already_running' });
    finish({ inserted: 2, missing: 0, notDue: false }); expect(await first).toEqual({ outcome: 'success', workSucceeded: true });
  });
  it('reports cross-process contention as skipped', async () => { mocks.sync.mockRejectedValue(new HttpError(409, 'locked')); expect(await runMarketMinuteDataWorker()).toEqual({ outcome: 'skipped', skipReason: 'already_running' }); });
  it('propagates failed provider work and then recovers on next attempt', async () => {
    mocks.sync.mockRejectedValueOnce(new Error('missing')).mockResolvedValue({ inserted: 0, missing: 0, notDue: true });
    await expect(runMarketMinuteDataWorker()).rejects.toThrow('missing'); expect(await runMarketMinuteDataWorker()).toEqual({ outcome: 'skipped', skipReason: 'not_due' });
  });
  it('reports idle when nothing eligible is missing and nothing was inserted', async () => {
    mocks.sync.mockResolvedValue({ inserted: 0, missing: 0, notDue: false });
    expect(await runMarketMinuteDataWorker()).toEqual({ outcome: 'idle', workSucceeded: false });
  });
  it('surfaces continued absence of an eligible expected bar as a failure, not idle', async () => {
    mocks.sync.mockResolvedValueOnce({ inserted: 0, missing: 1, notDue: false }).mockResolvedValue({ inserted: 1, missing: 0, notDue: false });
    await expect(runMarketMinuteDataWorker()).rejects.toThrow('1 eligible MINUTE_15 bar');
    expect(await runMarketMinuteDataWorker()).toEqual({ outcome: 'success', workSucceeded: true }); // Recovers once evidence arrives.
  });
});
