import type { Server } from 'node:http';
import express from 'express';
import { Prisma } from '@prisma/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  externalSignalSource: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
  strategySignalBinding: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
  signal: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  signalDelivery: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  strategy: { findUnique: vi.fn() }, systemEvent: { create: vi.fn() },
  session: vi.fn(),
}));
vi.mock('../db/prisma.js', () => ({ prisma: { ...mocks, $transaction: (fn: (db: typeof mocks) => unknown) => fn(mocks) } }));
vi.mock('../services/auth.service.js', () => ({ getUserSessionFromToken: mocks.session }));
import routes from './external-signal-admin.routes.js';
import { requireAdminAccess } from '../middleware/api-key-auth.js';
import { errorHandler } from '../middleware/error-handler.js';

describe('external signal owner management and read routes', () => {
  let server: Server;
  let baseUrl: string;
  const oldAdminKey = process.env.AI_TRADER_ADMIN_API_KEY;
  const headers = { 'ai-trader-api-key': 'admin-test', 'content-type': 'application/json' };
  beforeEach(async () => {
    vi.clearAllMocks(); process.env.AI_TRADER_ADMIN_API_KEY = 'admin-test';
    mocks.session.mockResolvedValue(null);
    for (const delegate of [mocks.externalSignalSource, mocks.strategySignalBinding, mocks.signal, mocks.signalDelivery]) {
      delegate.findMany.mockResolvedValue([]); delegate.findUnique.mockResolvedValue({ id: 1 }); delegate.count.mockResolvedValue(0);
    }
    mocks.externalSignalSource.create.mockResolvedValue({ id: 1, name: 'Test', provider: 'GENERIC_WEBHOOK', enabled: true });
    mocks.externalSignalSource.update.mockResolvedValue({ id: 1 });
    const app = express(); app.use(express.json());
    app.use('/api/external-signal-admin', requireAdminAccess, routes); app.use(errorHandler);
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No TCP address');
    baseUrl = `http://127.0.0.1:${address.port}/api/external-signal-admin`;
  });
  afterEach(async () => {
    if (oldAdminKey === undefined) delete process.env.AI_TRADER_ADMIN_API_KEY;
    else process.env.AI_TRADER_ADMIN_API_KEY = oldAdminKey;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  it.each(['sources', 'bindings', 'signals', 'deliveries'])('requires owner access to %s', async resource => {
    expect((await fetch(`${baseUrl}/${resource}`)).status).toBe(401);
    mocks.session.mockResolvedValue({ user: { id: 1, platformRole: 'ACCOUNT_USER' } });
    expect((await fetch(`${baseUrl}/${resource}`, { headers: { authorization: 'Bearer session' } })).status).toBe(403);
    expect((await fetch(`${baseUrl}/${resource}`, { headers })).status).toBe(200);
  });
  it('allows an owner session and validates pagination bounds', async () => {
    mocks.session.mockResolvedValue({ user: { id: 1, platformRole: 'SYSTEM_OWNER' } });
    expect((await fetch(`${baseUrl}/signals`, { headers: { authorization: 'Bearer session' } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/signals?pageSize=101`, { headers })).status).toBe(400);
    expect((await fetch(`${baseUrl}/signals?from=2026-09-07T00:00:00Z&to=2026-01-01T00:00:00Z`, { headers })).status).toBe(400);
  });
  it('normalizes direct owner creation and returns 409 for a canonical key collision', async () => {
    mocks.strategy.findUnique.mockResolvedValue({ id: 2 });
    const keys = new Set<string>();
    mocks.strategySignalBinding.create.mockImplementation(async ({ data }) => {
      if (keys.has(data.externalStrategyKey)) throw new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: '7' });
      keys.add(data.externalStrategyKey); return { ...data, id: 3 };
    });
    const post = (externalStrategyKey: string) => fetch(`${baseUrl}/bindings`, { method: 'POST', headers,
      body: JSON.stringify({ signalSourceId: 1, strategyId: 2, externalStrategyKey, expectedRevision: 'r1' }) });
    const first = await post('  Mean\tReversion -- V2  ');
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ externalStrategyKey: 'mean-reversion-v2' });
    expect((await post('mean---reversion-v2')).status).toBe(409);
    expect(keys.size).toBe(1);
    expect((await post('mean/reversion')).status).toBe(400);
  });
  it('returns token only from creation and rotation with no-store and safe source selections', async () => {
    const created = await fetch(`${baseUrl}/sources`, { method: 'POST', headers,
      body: JSON.stringify({ name: 'Test', provider: 'GENERIC_WEBHOOK' }) });
    expect(created.status).toBe(201); expect(created.headers.get('cache-control')).toBe('no-store');
    expect((await created.json() as { token: string }).token).toMatch(/^[\w-]{43}$/);
    const rotated = await fetch(`${baseUrl}/sources/1/rotate-token`, { method: 'POST', headers });
    expect((await rotated.json() as { token: string }).token).toMatch(/^[\w-]{43}$/);
    const listed = await fetch(`${baseUrl}/sources`, { headers });
    expect(JSON.stringify(await listed.json())).not.toMatch(/token|hash/i);
    const read = await fetch(`${baseUrl}/sources/1`, { headers });
    expect(JSON.stringify(await read.json())).not.toMatch(/token|hash/i);
    for (const method of ['findMany', 'findUnique', 'create', 'update'] as const) {
      expect(mocks.externalSignalSource[method].mock.calls[0]![0].select).not.toHaveProperty('webhookTokenHash');
    }
  });
  it('sanitizes unexpected management errors that may contain stored hashes', async () => {
    mocks.externalSignalSource.create.mockRejectedValue(new Error('query contained private-token-hash'));
    const response = await fetch(`${baseUrl}/sources`, { method: 'POST', headers,
      body: JSON.stringify({ name: 'Test', provider: 'GENERIC_WEBHOOK' }) });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private-token-hash');
  });
  it('rejects reassignments and exposes no destructive or evidence-write routes', async () => {
    expect((await fetch(`${baseUrl}/bindings/1`, { method: 'PATCH', headers,
      body: JSON.stringify({ strategyId: 2, enabled: true }) })).status).toBe(400);
    for (const [resource, method] of [['sources', 'DELETE'], ['bindings', 'DELETE'], ['signals', 'PATCH'], ['deliveries', 'DELETE'], ['signals', 'POST']] as const) {
      expect((await fetch(`${baseUrl}/${resource}/1`, { method, headers })).status).toBe(404);
    }
  });
  it('maps delivery filters and stable pagination into database queries', async () => {
    mocks.signalDelivery.count.mockResolvedValue(51);
    const response = await fetch(`${baseUrl}/deliveries?signalSourceId=2&signalId=3&status=REJECTED&rejectionCode=INVALID_JSON&page=2&pageSize=10&from=2026-01-01T00:00:00Z`, { headers });
    expect(response.status).toBe(200);
    expect((await response.json() as { pagination: unknown }).pagination).toEqual({ page: 2, pageSize: 10, total: 51, totalPages: 6 });
    expect(mocks.signalDelivery.findMany.mock.calls[0]![0]).toMatchObject({
      skip: 10, take: 10, orderBy: { id: 'desc' },
      where: { signalSourceId: 2, signalId: 3, status: 'REJECTED', rejectionCode: 'INVALID_JSON', receivedAt: { gte: new Date('2026-01-01T00:00:00Z') } },
    });
  });
  it('maps canonical Signal filters and returns 404 for missing evidence', async () => {
    await fetch(`${baseUrl}/signals?signalSourceId=2&strategyId=3&securityId=4&symbol=qqq&event=EXIT_LONG&timeframe=1h`, { headers });
    expect(mocks.signal.findMany.mock.calls[0]![0].where).toMatchObject({ signalSourceId: 2, strategyId: 3, securityId: 4, symbol: 'QQQ', event: 'EXIT_LONG', timeframe: '1h' });
    mocks.signal.findUnique.mockResolvedValue(null);
    expect((await fetch(`${baseUrl}/signals/900`, { headers })).status).toBe(404);
  });
});
