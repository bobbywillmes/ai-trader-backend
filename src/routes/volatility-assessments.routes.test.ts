import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), status: vi.fn(), backfill: vi.fn(), lab: vi.fn(), day: vi.fn(), latest: vi.fn(), assessments: vi.fn(), assessment: vi.fn(), publish: vi.fn() }));
vi.mock('../services/volatility-assessment.service.js', () => ({ latestVolatilityAssessment: mocks.latest, listVolatilityAssessments: mocks.assessments, getVolatilityAssessment: mocks.assessment, publishVolatilityAssessments: mocks.publish }));
vi.mock('../services/market-calendar.service.js', () => ({ listCalendar: mocks.list, saveCalendar: mocks.save, deleteCalendar: mocks.remove }));
vi.mock('../services/market-bar-ingestion.service.js', () => ({ marketDataStatus: mocks.status, backfillDailyBars: mocks.backfill }));
vi.mock('../services/trend-lab.service.js', () => ({ getTrendLab: mocks.lab, getTrendDay: mocks.day }));
import router from './market-data.routes.js';
import { HttpError } from '../errors/http-error.js';
let server: Server; let base: string;
beforeEach(async () => {
  vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.save.mockResolvedValue({ id: 1 }); mocks.remove.mockResolvedValue({}); mocks.status.mockResolvedValue({ symbols: [] }); mocks.backfill.mockResolvedValue({ results: [] }); mocks.lab.mockResolvedValue({ profiles: {} }); mocks.day.mockResolvedValue({ rawState: 'NEUTRAL' });
  mocks.latest.mockResolvedValue({ latestAttempt: null, latestValid: null }); mocks.assessments.mockResolvedValue([]); mocks.assessment.mockResolvedValue({ id: 7, evidenceJson: { bootstrap: true, exact: [0.1, 0.02] } }); mocks.publish.mockResolvedValue({ published: 1 });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.headers.role) Object.assign(res.locals, { user: { id: 1, platformRole: String(req.headers.role) } }); next(); });
  app.use('/api/market-data', router);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error instanceof HttpError ? error.statusCode : 500).json({ message: error.message }); });
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/market-data`;
});
afterEach(async () => { await new Promise<void>((resolve,reject) => server.close(e=>e?reject(e):resolve())); });
describe('market-data permissions and API', () => {
  it.each(['SYSTEM_OWNER', 'OPERATOR'])('allows %s immutable assessment reads', async role => {
    const headers = { role };
    expect(await (await fetch(`${base}/volatility-assessments/latest`, { headers })).json()).toEqual({ latestAttempt: null, latestValid: null });
    expect((await fetch(`${base}/volatility-assessments?limit=5&beforeId=10`, { headers })).status).toBe(200);
    expect(mocks.assessments).toHaveBeenCalledWith(5, 10);
    expect(await (await fetch(`${base}/volatility-assessments/7`, { headers })).json()).toEqual({ id: 7, evidenceJson: { bootstrap: true, exact: [0.1, 0.02] } });
    expect(mocks.assessment).toHaveBeenCalledWith(7);
    for (const path of ['/volatility-assessments?limit=101', '/volatility-assessments?beforeId=-1', '/volatility-assessments/nope']) expect((await fetch(base + path, { headers })).status).toBe(400);
    mocks.assessment.mockRejectedValueOnce(new HttpError(404, 'Not found'));
    expect((await fetch(`${base}/volatility-assessments/8`, { headers })).status).toBe(404);
  });
  it.each([undefined, 'ACCOUNT_USER'])('denies assessment reads and manual runs for %s', async role => {
    const headers = role ? { role } : {};
    for (const path of ['/volatility-assessments', '/volatility-assessments/latest', '/volatility-assessments/7']) expect((await fetch(base + path, { headers })).status).toBe(role ? 403 : 401);
    expect((await fetch(`${base}/volatility-assessments/run`, { method: 'POST', headers })).status).toBe(role ? 403 : 401);
    expect(mocks.publish).not.toHaveBeenCalled(); expect(mocks.assessments).not.toHaveBeenCalled();
  });
  it('restricts manual catch-up to owner and accepts no date/profile/override input', async () => {
    expect((await fetch(`${base}/volatility-assessments/run`, { method: 'POST', headers: { role: 'OPERATOR' } })).status).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(await (await fetch(`${base}/volatility-assessments/run`, { method: 'POST', headers: { role: 'SYSTEM_OWNER' } })).json()).toEqual({ published: 1 });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect((await fetch(`${base}/volatility-assessments/run`, { method: 'POST', headers: { role: 'SYSTEM_OWNER', 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'LOOSE' }) })).status).toBe(400);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    for (const method of ['PUT', 'DELETE']) expect((await fetch(`${base}/volatility-assessments/7`, { method, headers: { role: 'SYSTEM_OWNER' } })).status).toBe(404);
  });
});
