import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({sync:vi.fn()}));
vi.mock('../services/market-bar-ingestion.service.js',()=>({syncDailyBars:mocks.sync}));
import { runMarketDataWorker } from './market-data.worker.js';
import { HttpError } from '../errors/http-error.js';
beforeEach(()=>vi.clearAllMocks());
describe('market daily worker',()=>{
  it('prevents in-process overlap and reports useful work',async()=>{
    let finish!: (value:unknown)=>void;mocks.sync.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const first=runMarketDataWorker();expect(await runMarketDataWorker()).toEqual({outcome:'skipped',skipReason:'already_running'});
    finish({inserted:2,missing:0,notDue:false});expect(await first).toEqual({outcome:'success',workSucceeded:true});
  });
  it('reports cross-process contention as skipped',async()=>{mocks.sync.mockRejectedValue(new HttpError(409,'locked'));expect(await runMarketDataWorker()).toEqual({outcome:'skipped',skipReason:'already_running'});});
  it('propagates failed provider work and then recovers on next attempt',async()=>{
    mocks.sync.mockRejectedValueOnce(new Error('missing')).mockResolvedValue({inserted:0,missing:0,notDue:true});
    await expect(runMarketDataWorker()).rejects.toThrow('missing');expect(await runMarketDataWorker()).toEqual({outcome:'skipped',skipReason:'not_due'});
  });
});
