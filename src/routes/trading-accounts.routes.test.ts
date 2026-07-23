import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformRole } from '@prisma/client';
import { HttpError } from '../errors/http-error.js';

const mocks = vi.hoisted(() => ({ createTradingAccountController: vi.fn() }));

vi.mock('../controllers/trading-accounts.controller.js', () => ({
  createTradingAccountController: mocks.createTradingAccountController,
  createTradingAccountAllocationController: vi.fn(),
  createTradingAccountSubscriptionController: vi.fn(),
  deleteTradingAccountSubscriptionController: vi.fn(),
  getTradingAccountRiskHealthController: vi.fn(),
  getTradingAccountSubscriptionPriceHistoryController: vi.fn(),
  getTradingAccountSubscriptionController: vi.fn(),
  getTradingAccountController: vi.fn(),
  listTradingAccountOpenOrdersController: vi.fn(),
  listTradingAccountOpenPositionsController: vi.fn(),
  listTradingAccountTradeCyclesController: vi.fn(),
  getTradingAccountRiskSettingsController: vi.fn(),
  listTradingAccountsController: vi.fn(),
  listTradingAccountAllocationsController: vi.fn(),
  listTradingAccountSubscriptionMarketContextController: vi.fn(),
  listTradingAccountSubscriptionsController: vi.fn(),
  previewTradingAccountEntryRiskController: vi.fn(),
  updateTradingAccountController: vi.fn(),
  updateTradingAccountAllocationController: vi.fn(),
  updateTradingAccountRiskSettingsController: vi.fn(),
  updateTradingAccountSubscriptionController: vi.fn(),
  upsertTradingAccountCredentialController: vi.fn(),
  revokeTradingAccountCredentialController: vi.fn(),
  verifyTradingAccountCredentialController: vi.fn(),
}));

import tradingAccountsRouter from './trading-accounts.routes.js';

let server: Server | undefined;

async function postAs(platformRole: PlatformRole) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.user = {
      id: 1,
      email: 'owner@example.com',
      platformRole,
      enabled: true,
      createdAt: new Date('2026-07-18T00:00:00.000Z'),
      updatedAt: new Date('2026-07-18T00:00:00.000Z'),
    };
    next();
  });
  app.use('/api/trading-accounts', tradingAccountsRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ message: error.message });
      return;
    }
    res.status(500).json({ message: 'Unexpected error.' });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');

  return fetch(`http://127.0.0.1:${address.port}/api/trading-accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountHolderUserId: 1, displayName: 'Bobby Paper', environment: 'PAPER' }),
  });
}

describe('POST /api/trading-accounts RBAC', () => {
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    vi.clearAllMocks();
  });

  it('allows a System Owner to create a Trading Account', async () => {
    mocks.createTradingAccountController.mockImplementation((_req, res) => {
      res.status(201).json({ account: { id: 10 } });
    });
    const response = await postAs(PlatformRole.SYSTEM_OWNER);
    expect(response.status).toBe(201);
    expect(mocks.createTradingAccountController).toHaveBeenCalledOnce();
  });

  it.each([PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER])(
    'rejects a %s from creating a Trading Account',
    async (platformRole) => {
      const response = await postAs(platformRole);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ message: 'System owner access required.' });
      expect(mocks.createTradingAccountController).not.toHaveBeenCalled();
    }
  );
});
