import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  processSubscriptionEntrySignal: vi.fn(),
  processTargetedEntrySignal: vi.fn(),
}));

vi.mock('../services/signal-entry.service.js', () => ({
  processSubscriptionEntrySignal: mocks.processSubscriptionEntrySignal,
  processTargetedEntrySignal: mocks.processTargetedEntrySignal,
}));

import signalsRoutes from './signals.routes.js';
import { requireSignalApiKey } from '../middleware/api-key-auth.js';
import { errorHandler } from '../middleware/error-handler.js';

describe('signal entry route authentication', () => {
  let server: Server | null = null;
  const originalSignalKey = process.env.AI_TRADER_SIGNAL_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_TRADER_SIGNAL_API_KEY = 'test-signal-key';
    mocks.processSubscriptionEntrySignal.mockResolvedValue({
      subscriptionKey: 'intc_dip_core',
      results: [],
    });
    mocks.processTargetedEntrySignal.mockResolvedValue({
      tradingAccountId: 2,
      tradingAccountSubscriptionId: 38,
      accountDisplayName: 'Bobby Paper',
      environment: 'PAPER',
      subscriptionKey: 'intc_dip_core',
      outcome: 'INTENT_CREATED',
      code: 'INTENT_CREATED',
      message: 'Order intent created for the account assignment.',
      orderIntentId: 55,
    });
  });

  afterEach(async () => {
    if (originalSignalKey === undefined) {
      delete process.env.AI_TRADER_SIGNAL_API_KEY;
    } else {
      process.env.AI_TRADER_SIGNAL_API_KEY = originalSignalKey;
    }
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve()))
      );
      server = null;
    }
  });

  async function listen() {
    const app = express();
    app.use(express.json());
    app.use('/api/signals', requireSignalApiKey, signalsRoutes);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a local TCP test server.');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it.each(['/api/signals/entry', '/api/signals/entry/assignment'])(
    'requires signal authentication on %s',
    async (path) => {
      const baseUrl = await listen();
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscriptionKey: 'intc_dip_core' }),
      });

      expect(response.status).toBe(401);
      expect(mocks.processSubscriptionEntrySignal).not.toHaveBeenCalled();
      expect(mocks.processTargetedEntrySignal).not.toHaveBeenCalled();
    }
  );

  it('routes authenticated global and targeted requests separately', async () => {
    const baseUrl = await listen();
    const headers = {
      'content-type': 'application/json',
      'signal-key': 'test-signal-key',
    };

    const global = await fetch(`${baseUrl}/api/signals/entry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ subscriptionKey: 'intc_dip_core' }),
    });
    const targeted = await fetch(`${baseUrl}/api/signals/entry/assignment`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tradingAccountSubscriptionId: 38 }),
    });

    expect(global.status).toBe(200);
    expect(targeted.status).toBe(201);
    expect(mocks.processSubscriptionEntrySignal).toHaveBeenCalledTimes(1);
    expect(mocks.processTargetedEntrySignal).toHaveBeenCalledTimes(1);
  });
});
