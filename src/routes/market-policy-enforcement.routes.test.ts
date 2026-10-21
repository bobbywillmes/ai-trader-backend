import { PlatformRole } from '@prisma/client';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../errors/http-error.js';

const mocks = vi.hoisted(() => {
  const ok = (status: number) => vi.fn((_req: Request, res: Response) => res.status(status).json({ ok: true }));
  return {
    getMarketPolicyEnforcementRuntimeRolloutController: ok(200),
    getMarketPolicyBrokerEnforcementReadinessController: ok(200),
    listMarketPolicyEnforcementRuntimeRolloutEventsController: ok(200),
    activateMarketPolicyEnforcementRuntimeRolloutController: ok(200),
    deactivateMarketPolicyEnforcementRuntimeRolloutController: ok(200),
  };
});
vi.mock('../controllers/market-policy-enforcement.controller.js', () => mocks);

const { default: router } = await import('./market-policy-enforcement.routes.js');

let server: Server | undefined;

async function requestAs(platformRole: PlatformRole, method: 'GET' | 'POST', path: string) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.user = { id: 1, email: 'user@example.com', platformRole, enabled: true, createdAt: new Date('2026-10-18T00:00:00.000Z'), updatedAt: new Date('2026-10-18T00:00:00.000Z') }; next(); });
  app.use('/api/market-policy-enforcement', router);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error instanceof HttpError ? error.statusCode : 500).json({});
  });
  server = app.listen(0);
  await new Promise<void>(resolve => server?.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return fetch(`http://127.0.0.1:${address.port}/api/market-policy-enforcement${path}`, method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: '{}' } : { method });
}

describe('market-policy enforcement runtime rollout RBAC', () => {
  afterEach(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()));
    server = undefined;
    vi.clearAllMocks();
  });

  it('lets administrative readers see rollout status', async () => {
    expect((await requestAs(PlatformRole.OPERATOR, 'GET', '/runtime-rollout')).status).toBe(200);
    expect(mocks.getMarketPolicyEnforcementRuntimeRolloutController).toHaveBeenCalledOnce();
  });

  it.each([
    ['GET', '/runtime-rollout/events', mocks.listMarketPolicyEnforcementRuntimeRolloutEventsController],
    ['POST', '/runtime-rollout/activate', mocks.activateMarketPolicyEnforcementRuntimeRolloutController],
    ['POST', '/runtime-rollout/deactivate', mocks.deactivateMarketPolicyEnforcementRuntimeRolloutController],
    ['GET', '/broker-time-readiness', mocks.getMarketPolicyBrokerEnforcementReadinessController],
  ] as const)('permits only SYSTEM_OWNER to reach %s %s', async (method, path, controller) => {
    for (const role of [PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER]) {
      expect((await requestAs(role, method, path)).status).toBe(403);
      await new Promise<void>(resolve => server?.close(() => resolve())); server = undefined;
    }
    expect(controller).not.toHaveBeenCalled();
    expect((await requestAs(PlatformRole.SYSTEM_OWNER, method, path)).status).toBe(200);
    expect(controller).toHaveBeenCalledOnce();
  });
});
