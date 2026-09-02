import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { PlatformRole } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../errors/http-error.js';

const mocks = vi.hoisted(() => ({
  diagnose: vi.fn((_req, res) => res.status(201).json({ case: { id: 1 } })),
  list: vi.fn((_req, res) => res.status(200).json({ cases: [] })),
  get: vi.fn((_req, res) => res.status(200).json({ case: { id: 1 } })),
  apply: vi.fn((_req, res) => res.status(200).json({ execution: { id: 1 } })),
  preview: vi.fn((_req, res) => res.status(201).json({ case: { id: 2 } })),
  decideAction: vi.fn((_req, res) => res.status(200).json({ action: { id: 3 } })),
  applyAction: vi.fn((_req, res) => res.status(200).json({ execution: { id: 4 } })),
}));
vi.mock('../controllers/lifecycle-repairs.controller.js', () => ({
  diagnoseLifecycleRepairController: mocks.diagnose,
  listLifecycleRepairsController: mocks.list,
  getLifecycleRepairController: mocks.get,
  applyLifecycleRepairController: mocks.apply,
  previewHistoricalEntryLifecycleController: mocks.preview,
  decideLifecycleRepairActionController: mocks.decideAction,
  applyLifecycleRepairActionController: mocks.applyAction,
}));
import router from './lifecycle-repairs.routes.js';

let server: Server | undefined;
async function requestAs(role: PlatformRole, method: string, path: string) {
  const app = express(); app.use(express.json());
  app.use((_req, res, next) => { res.locals.user = { id: 1, email: 'owner@example.com', platformRole: role, enabled: true, createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z') }; next(); });
  app.use('/api/lifecycle-repairs', router);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(error instanceof HttpError ? error.statusCode : 500).json({ message: error instanceof Error ? error.message : 'Unexpected error.' }));
  server = app.listen(0); await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  return fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
}

describe('Lifecycle Repair Workbench RBAC', () => {
  afterEach(async () => { await new Promise<void>((resolve) => server?.close(() => resolve())); server = undefined; vi.clearAllMocks(); });
  it.each([['GET', '/api/lifecycle-repairs', 'list'], ['POST', '/api/lifecycle-repairs/diagnose', 'diagnose'], ['POST', '/api/lifecycle-repairs/historical-entry/preview', 'preview'], ['POST', '/api/lifecycle-repairs/actions/1/decision', 'decideAction'], ['POST', '/api/lifecycle-repairs/actions/1/apply', 'applyAction'], ['GET', '/api/lifecycle-repairs/1', 'get'], ['POST', '/api/lifecycle-repairs/1/apply', 'apply']] as const)('rejects non-owners from %s %s', async (method, path, name) => {
    expect((await requestAs(PlatformRole.OPERATOR, method, path)).status).toBe(403);
    expect(mocks[name]).not.toHaveBeenCalled();
  });
  it('allows System Owners into the typed workbench routes', async () => {
    expect((await requestAs(PlatformRole.SYSTEM_OWNER, 'GET', '/api/lifecycle-repairs')).status).toBe(200);
  });
});
