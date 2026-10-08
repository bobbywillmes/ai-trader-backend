import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ summary: vi.fn() }));
vi.mock('../services/market-intelligence.service.js', () => ({ getMarketIntelligenceSummary: mocks.summary }));
import router from './market-data.routes.js';
import { HttpError } from '../errors/http-error.js';
let server: Server; let base: string;
beforeEach(async () => {
  mocks.summary.mockReset(); mocks.summary.mockResolvedValue({ evaluatedAt: '2026-10-08T12:00:00.000Z', dimensions: {}, breadthV2: {} });
  const app = express();
  app.use((req, res, next) => { if (req.headers.role) Object.assign(res.locals, { user: { id: 1, platformRole: String(req.headers.role) } }); next(); });
  app.use('/api/market-data', router);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error instanceof HttpError ? error.statusCode : 500).json({ message: error.message }); });
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/market-data/intelligence/summary`;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
describe('market intelligence summary permissions', () => {
  it.each(['SYSTEM_OWNER', 'OPERATOR'])('allows %s to read independent observations', async role => { const response = await fetch(base, { headers: { role } }); expect(response.status).toBe(200); expect((await response.json() as { evaluatedAt: string }).evaluatedAt).toBe('2026-10-08T12:00:00.000Z'); });
  it.each([undefined, 'ACCOUNT_USER'])('denies %s', async role => { const response = await fetch(base, { headers: role ? { role } : {} }); expect(response.status).toBe(role ? 403 : 401); expect(mocks.summary).not.toHaveBeenCalled(); });
});
