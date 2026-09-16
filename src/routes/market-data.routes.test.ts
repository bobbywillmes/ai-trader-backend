import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), status: vi.fn(), backfill: vi.fn(), lab: vi.fn(), day: vi.fn() }));
vi.mock('../services/market-calendar.service.js', () => ({ listCalendar: mocks.list, saveCalendar: mocks.save, deleteCalendar: mocks.remove }));
vi.mock('../services/market-bar-ingestion.service.js', () => ({ marketDataStatus: mocks.status, backfillDailyBars: mocks.backfill }));
vi.mock('../services/trend-lab.service.js', () => ({ getTrendLab: mocks.lab, getTrendDay: mocks.day }));
import router from './market-data.routes.js';
import { HttpError } from '../errors/http-error.js';
let server: Server; let base: string;
beforeEach(async () => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.save.mockResolvedValue({ id: 1 }); mocks.remove.mockResolvedValue({}); mocks.status.mockResolvedValue({ symbols: [] }); mocks.backfill.mockResolvedValue({ results: [] }); mocks.lab.mockResolvedValue({ profiles: {} }); mocks.day.mockResolvedValue({ rawState: 'NEUTRAL' });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.headers.role) Object.assign(res.locals, { user: { id: 1, platformRole: String(req.headers.role) } }); next(); });
  app.use('/api/market-data', router);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error instanceof HttpError ? error.statusCode : 500).json({ message: error.message }); });
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/market-data`;
});
afterEach(async () => { await new Promise<void>((resolve,reject) => server.close(e=>e?reject(e):resolve())); });
describe('market-data permissions and API', () => {
  it.each(['SYSTEM_OWNER','OPERATOR'])('allows %s calendar CRUD and research reads', async role => {
    expect((await fetch(`${base}/calendar?year=2026`, { headers: { role } })).status).toBe(200);
    const body = { sessionDate: '2026-11-27', name: 'Thanksgiving Friday', type: 'EARLY_CLOSE', closeTimeMinutesEt: 780 };
    for (const [path,method] of [['/calendar','POST'],['/calendar/1','PUT']] as const) expect((await fetch(base+path, { method, headers: { role, 'content-type':'application/json' }, body:JSON.stringify(body) })).status).toBe(method==='POST'?201:200);
    expect((await fetch(`${base}/calendar/1`,{method:'DELETE',headers:{role}})).status).toBe(204);
    expect((await fetch(`${base}/trend-lab?from=2023-01-01&to=2026-09-15`, {headers:{role}})).status).toBe(200);
  });
  it.each([undefined,'ACCOUNT_USER'])('denies access for %s', async role => {
    const headers = role ? {role} : undefined;
    for (const path of ['/status','/calendar?year=2026','/trend-lab?from=2023-01-01&to=2026-09-15']) expect((await fetch(base+path, headers ? {headers}:{})).status).toBe(role?403:401);
    expect(mocks.lab).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });
  it('limits backfill to owner and validates calendar input before writing', async () => {
    const request = {method:'POST',headers:{role:'OPERATOR','content-type':'application/json'},body:JSON.stringify({from:'2023-01-01',to:'2023-12-31'})};
    expect((await fetch(`${base}/backfill`,request)).status).toBe(403); expect(mocks.backfill).not.toHaveBeenCalled();
    expect((await fetch(`${base}/backfill`,{...request,headers:{...request.headers,role:'SYSTEM_OWNER'}})).status).toBe(200);
    expect((await fetch(`${base}/calendar`,{...request,body:JSON.stringify({sessionDate:'2026-02-30',name:'bad',type:'EARLY_CLOSE',closeTimeMinutesEt:960})})).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('selects date/profile on a specific immutable research snapshot', async () => {
    const datasetId='a'.repeat(64);
    expect((await fetch(`${base}/trend-lab/day?datasetId=${datasetId}&profile=LOOSE&date=2026-09-14&from=2026-09-01&to=2026-09-15`,{headers:{role:'OPERATOR'}})).status).toBe(200);
    expect(mocks.day).toHaveBeenCalledWith(datasetId,'LOOSE','2026-09-14','2026-09-01','2026-09-15');
    expect((await fetch(`${base}/trend-lab/day?datasetId=${datasetId}&profile=TREND_V1&date=2026-09-14&from=2026-09-01&to=2026-09-15`,{headers:{role:'OPERATOR'}})).status).toBe(400);
  });
});

it('awaits stale and unknown-day errors and validates recovery ranges',async()=>{
  const path=base+'/trend-lab/day?datasetId='+'a'.repeat(64)+'&profile=TIGHT&date=2022-08-31';
  for(const range of ['', '&from=2022-02-30&to=2022-08-31','&from=2022-09-01&to=2022-08-31']) expect((await fetch(path+range,{headers:{role:'OPERATOR'}})).status).toBe(400);
  expect(mocks.day).not.toHaveBeenCalled();
  for(const code of [409,404]){
    mocks.day.mockRejectedValueOnce(new HttpError(code,'Research evidence changed.'));
    const response=await fetch(path+'&from=2022-06-01&to=2022-08-31',{headers:{role:'OPERATOR'}});
    expect(response.status).toBe(code);expect(await response.json()).toEqual({message:'Research evidence changed.'});
  }
});
