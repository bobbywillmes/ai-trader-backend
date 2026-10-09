import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../services/auth.service.js', () => ({ getUserSessionFromToken: mocks.session }));
vi.mock('../services/strategy-market-policy.service.js', () => ({
  getStrategyMarketPolicy: vi.fn().mockResolvedValue({ authority: 'SHADOW_ONLY', supportedDimensions: [], policy: null }),
  createStrategyMarketPolicy: vi.fn(), prepareStrategyMarketPolicyRevision: vi.fn(), updateStrategyMarketPolicyRule: vi.fn(),
  validateStrategyMarketPolicyRevision: vi.fn(), activateStrategyMarketPolicyRevision: vi.fn(),
}));
import { createApp } from '../app/app.js';

let server: Server | undefined;
async function request(path: string, method: 'GET' | 'POST' | 'PATCH') {
  server = createApp().listen(0); await new Promise<void>(resolve => server?.once('listening', resolve));
  const address = server!.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  return fetch(`http://127.0.0.1:${address.port}/api/strategies/${path}`, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer test-session' }, ...(method === 'GET' ? {} : { body: '{}' }) });
}
afterEach(async () => { if (server) await new Promise<void>(resolve => server?.close(() => resolve())); server = undefined; });

describe('strategy market policy HTTP authorization', () => {
  it.each([
    ['1/market-policy', 'GET'], ['1/market-policy', 'POST'], ['1/market-policy/revisions', 'POST'],
    ['1/market-policy/revisions/1/dimensions/TREND', 'PATCH'], ['1/market-policy/revisions/1/validation', 'GET'],
    ['1/market-policy/revisions/1/activate', 'POST'],
  ] as const)('rejects unauthenticated %s', async (path, method) => { expect((await request(path, method)).status).toBe(401); });

  it.each(['OPERATOR', 'ACCOUNT_USER'])('does not broaden %s mutation access', async platformRole => {
    mocks.session.mockResolvedValue({ user: { id: 8, platformRole } });
    for (const [path, method] of [
      ['1/market-policy', 'POST'], ['1/market-policy/revisions', 'POST'],
      ['1/market-policy/revisions/1/dimensions/TREND', 'PATCH'], ['1/market-policy/revisions/1/activate', 'POST'],
    ] as const) expect((await request(path, method)).status).toBe(403);
  });
});
