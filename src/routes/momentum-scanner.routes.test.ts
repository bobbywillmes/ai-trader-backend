import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listMomentumScannerHandoffs: vi.fn(),
}));

vi.mock('../services/momentum-scanner-handoff.service.js', () => ({
  getMomentumScannerHandoffById: vi.fn(),
  listMomentumScannerHandoffs: mocks.listMomentumScannerHandoffs,
  markMomentumScannerHandoffAcknowledged: vi.fn(),
  markMomentumScannerHandoffFailed: vi.fn(),
  markMomentumScannerHandoffSent: vi.fn(),
  prepareReadyMomentumScannerHandoffs: vi.fn(),
}));

describe('momentum scanner routes', () => {
  let server: Server | null = null;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://trader:traderpass@localhost:5432/ai_trader',
      ALPACA_API_KEY: 'test-alpaca-key',
      ALPACA_API_SECRET: 'test-alpaca-secret',
      MASSIVE_API_KEY: 'test-massive-key',
      AI_TRADER_SIGNAL_API_KEY: 'test-signal-key-123456',
      AI_TRADER_ADMIN_API_KEY: 'test-admin-key-123456',
    };
  });

  afterEach(async () => {
    process.env = originalEnv;

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      server = null;
    }
  });

  async function listen() {
    const { createApp } = await import('../app/app.js');
    const app = createApp();

    server = app.listen(0);

    await new Promise<void>((resolve) => {
      server?.once('listening', () => resolve());
    });

    const address = server.address();

    if (address === null || typeof address === 'string') {
      throw new Error('Expected local test server address.');
    }

    return `http://127.0.0.1:${address.port}`;
  }

  it('requires admin access before scanner handoff endpoints can be read', async () => {
    const baseUrl = await listen();

    const response = await fetch(`${baseUrl}/api/momentum-scanner/handoffs`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unauthorized',
      message: 'Admin API key or admin session token required.',
    });
    expect(mocks.listMomentumScannerHandoffs).not.toHaveBeenCalled();
  });
});
