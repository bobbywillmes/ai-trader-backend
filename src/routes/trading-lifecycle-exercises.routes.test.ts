import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformRole } from '@prisma/client';
import { HttpError } from '../errors/http-error.js';

const mocks = vi.hoisted(() => ({
  candidates: vi.fn((_req, res) => res.status(200).json({ candidates: [] })),
  preview: vi.fn((_req, res) => res.status(201).json({ exercise: { id: 1 } })),
  launch: vi.fn((_req, res) => res.status(200).json({ exercise: { id: 1 } })),
}));

vi.mock('../controllers/trading-lifecycle-exercises.controller.js', () => ({
  listSubscriptionEntryCandidatesController: mocks.candidates,
  previewSubscriptionEntryLifecycleExerciseController: mocks.preview,
  launchLifecycleExerciseController: mocks.launch,
  cancelLifecycleExerciseController: vi.fn(),
  getLifecycleExerciseController: vi.fn(),
  listLifecycleExercisesController: vi.fn(),
  previewLifecycleExerciseController: vi.fn(),
  reconcileLifecycleExerciseTargetController: vi.fn(),
}));

import router from './trading-lifecycle-exercises.routes.js';

let server: Server | undefined;
async function requestAs(role: PlatformRole, method: string, path: string) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.user = {
      id: 1, email: 'owner@example.com', platformRole: role, enabled: true,
      createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z'),
    };
    next();
  });
  app.use('/api/trading-lifecycle-exercises', router);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) res.status(error.statusCode).json({ message: error.message });
    else res.status(500).json({ message: 'Unexpected error.' });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
  });
}

describe('Subscription-entry Lifecycle Exercise RBAC', () => {
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    vi.clearAllMocks();
  });

  it.each([
    ['GET', '/api/trading-lifecycle-exercises/subscription-entry/candidates?subscriptionId=7', 'candidates'],
    ['POST', '/api/trading-lifecycle-exercises/subscription-entry/preview', 'preview'],
    ['POST', '/api/trading-lifecycle-exercises/1/launch', 'launch'],
  ] as const)('rejects non-owners from %s %s', async (method, path, mockName) => {
    const response = await requestAs(PlatformRole.OPERATOR, method, path);
    expect(response.status).toBe(403);
    expect(mocks[mockName]).not.toHaveBeenCalled();
  });

  it('allows System Owners to list candidates and create explicit previews', async () => {
    expect((await requestAs(PlatformRole.SYSTEM_OWNER, 'GET', '/api/trading-lifecycle-exercises/subscription-entry/candidates?subscriptionId=7')).status).toBe(200);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect((await requestAs(PlatformRole.SYSTEM_OWNER, 'POST', '/api/trading-lifecycle-exercises/subscription-entry/preview')).status).toBe(201);
  });
});
