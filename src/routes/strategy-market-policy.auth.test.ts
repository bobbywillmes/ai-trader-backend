import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('../services/auth.service.js', () => ({ getUserSessionFromToken: mocks.session }));
vi.mock('../services/strategy-market-policy.service.js', () => ({
  getStrategyMarketPolicy: vi.fn().mockResolvedValue({ authority: 'SHADOW_ONLY', supportedDimensions: [], policy: null }),
  createStrategyMarketPolicy: vi.fn(), prepareStrategyMarketPolicyRevision: vi.fn(), saveStrategyMarketPolicyRevision: vi.fn(),
  validateStrategyMarketPolicyRevision: vi.fn(), activateStrategyMarketPolicyRevision: vi.fn(),
}));
vi.mock('../services/strategy-market-eligibility.service.js', () => ({
  getCurrentStrategyEligibility: vi.fn().mockResolvedValue({ assessment: null }),
  listStrategyEligibilityDecisions: vi.fn().mockResolvedValue([]),
  getStrategyEligibilityDecision: vi.fn().mockResolvedValue({ id: 1 }),
  listCurrentStrategyEligibility: vi.fn().mockResolvedValue([]),
}));
import { createApp } from '../app/app.js';

let server: Server | undefined;
async function request(path: string, method: 'GET' | 'POST' | 'PUT') {
  server = createApp().listen(0); await new Promise<void>(resolve => server?.once('listening', resolve));
  const address = server!.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  return fetch(`http://127.0.0.1:${address.port}/api/strategies/${path}`, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer test-session' }, ...(method === 'GET' ? {} : { body: '{}' }) });
}
afterEach(async () => { if (server) await new Promise<void>(resolve => server?.close(() => resolve())); server = undefined; });

describe('strategy market policy HTTP authorization', () => {
  it.each([
    ['1/market-policy', 'GET'], ['1/market-policy', 'POST'], ['1/market-policy/revisions', 'POST'],
    ['1/market-policy/revisions/1', 'PUT'], ['1/market-policy/revisions/1/validation', 'GET'],
    ['1/market-policy/revisions/1/activate', 'POST'],
  ] as const)('rejects unauthenticated %s', async (path, method) => { expect((await request(path, method)).status).toBe(401); });

  it.each(['OPERATOR', 'ACCOUNT_USER'])('does not broaden %s mutation access', async platformRole => {
    mocks.session.mockResolvedValue({ user: { id: 8, platformRole } });
    for (const [path, method] of [
      ['1/market-policy', 'POST'], ['1/market-policy/revisions', 'POST'],
      ['1/market-policy/revisions/1', 'PUT'], ['1/market-policy/revisions/1/activate', 'POST'],
    ] as const) expect((await request(path, method)).status).toBe(403);
  });

  it.each([
    ['1/market-policy'],
    ['1/market-policy/revisions/1/validation'],
    ['1/market-eligibility/current'],
    ['1/market-eligibility/decisions'],
    ['1/market-eligibility/decisions/1'],
  ] as const)('allows only operational roles to read %s', async path => {
    for (const [platformRole, expected] of [['SYSTEM_OWNER', 200], ['OPERATOR', 200], ['ACCOUNT_USER', 403]] as const) {
      mocks.session.mockResolvedValue({ user: { id: 8, platformRole } });
      expect((await request(path, 'GET')).status).toBe(expected);
    }
  });
});
