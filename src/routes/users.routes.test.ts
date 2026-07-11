import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listUsers: vi.fn() }));
vi.mock('../services/users.service.js', () => ({
  listUsers: mocks.listUsers,
  createUserInvitation: vi.fn(),
  getUserById: vi.fn(),
  getUserTradingAccountMemberships: vi.fn(),
  regenerateUserSetupLink: vi.fn(),
  replaceUserTradingAccountMemberships: vi.fn(),
  updateUser: vi.fn(),
}));

import { createApp } from '../app/app.js';

const ADMIN_KEY = 'users-route-admin-key';
let server: Server | undefined;

async function request(path: string, init?: RequestInit) {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

describe('users routes', () => {
  beforeEach(() => {
    process.env.AI_TRADER_ADMIN_API_KEY = ADMIN_KEY;
    mocks.listUsers.mockResolvedValue([]);
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    vi.clearAllMocks();
  });

  it('requires system-owner authentication on /api/users', async () => {
    const unauthorized = await request('/api/users');
    expect(unauthorized.status).toBe(401);
  });

  it('mounts /api/users and removes the legacy API', async () => {
    const users = await request('/api/users', {
      headers: { 'ai-trader-api-key': ADMIN_KEY },
    });
    expect(users.status).toBe(200);
    expect(await users.json()).toEqual([]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const legacy = await request('/api/admin-users', {
      headers: { 'ai-trader-api-key': ADMIN_KEY },
    });
    expect(legacy.status).toBe(404);
  });

  it('removes the old per-account access endpoint', async () => {
    const response = await request('/api/users/2/trading-account-access/3', {
      method: 'PUT',
      headers: { 'ai-trader-api-key': ADMIN_KEY, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });
});
