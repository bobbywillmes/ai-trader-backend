import type { Server } from 'node:http';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformRole } from '@prisma/client';
import { HttpError } from '../errors/http-error.js';

const mocks = vi.hoisted(() => ({
  createTradingAccountController: vi.fn(),
  activateTradingAccountController: vi.fn(),
  deactivateTradingAccountController: vi.fn(),
  stageLiveEntryCanaryController: vi.fn(),
  armLiveEntriesController: vi.fn(),
  disarmLiveEntriesController: vi.fn(),
  runTradingAccountReadinessAssessmentController: vi.fn(),
  runTradingAccountReconciliationController: vi.fn(),
  grantLiveWriteApprovalController: vi.fn((_req: Request, res: Response) =>
    res.status(200).json({ ok: true }),
  ),
}));

vi.mock('../controllers/trading-accounts.controller.js', () => ({
  getTradingAccountWorkerHealthController: vi.fn(),
  createTradingAccountController: mocks.createTradingAccountController,
  activateTradingAccountController: mocks.activateTradingAccountController,
  deactivateTradingAccountController: mocks.deactivateTradingAccountController,
  stageLiveEntryCanaryController: mocks.stageLiveEntryCanaryController,
  armLiveEntriesController: mocks.armLiveEntriesController,
  disarmLiveEntriesController: mocks.disarmLiveEntriesController,
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
  runTradingAccountReadinessAssessmentController:
    mocks.runTradingAccountReadinessAssessmentController,
  getLatestTradingAccountReadinessAssessmentController: vi.fn(),
  listTradingAccountReadinessAssessmentsController: vi.fn(),
  getTradingAccountReadinessAssessmentController: vi.fn(),
  getLiveWriteApprovalsController: vi.fn(),
  grantLiveWriteApprovalController: mocks.grantLiveWriteApprovalController,
  revokeLiveWriteApprovalController: vi.fn(),
}));

vi.mock('../controllers/reconciliation.controller.js', () => ({
  runTradingAccountReconciliationController:
    mocks.runTradingAccountReconciliationController,
}));

import tradingAccountsRouter from './trading-accounts.routes.js';

let server: Server | undefined;

async function postAs(
  platformRole: PlatformRole,
  path = '/api/trading-accounts',
  body: unknown = {
    accountHolderUserId: 1,
    displayName: 'Bobby Paper',
    environment: 'PAPER',
  },
) {
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
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ message: error.message });
        return;
      }
      res.status(500).json({ message: 'Unexpected error.' });
    },
  );

  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test address');

  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
      await expect(response.json()).resolves.toEqual({
        message: 'System owner access required.',
      });
      expect(mocks.createTradingAccountController).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/trading-accounts/:id/activate RBAC', () => {
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    vi.clearAllMocks();
  });

  it('allows only a System Owner to activate a Live Trading Account', async () => {
    mocks.activateTradingAccountController.mockImplementation((_req, res) =>
      res.status(200).json({ outcome: 'activated' }),
    );
    const body = {
      readinessAssessmentId: 1,
      reason: 'First activation',
      typedConfirmation: 'ACTIVATE LIVE ACCOUNT',
      expectedUpdatedAt: new Date().toISOString(),
    };
    const owner = await postAs(
      PlatformRole.SYSTEM_OWNER,
      '/api/trading-accounts/1/activate',
      body,
    );
    expect(owner.status).toBe(200);
    expect(mocks.activateTradingAccountController).toHaveBeenCalledOnce();
  });

  it.each([PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER])(
    'rejects a %s',
    async (role) => {
      const response = await postAs(
        role,
        '/api/trading-accounts/1/activate',
        {},
      );
      expect(response.status).toBe(403);
      expect(mocks.activateTradingAccountController).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/trading-accounts/:id/deactivate RBAC', () => {
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    vi.clearAllMocks();
  });

  it('allows a System Owner to deactivate a Trading Account', async () => {
    mocks.deactivateTradingAccountController.mockImplementation((_req, res) => {
      res.status(200).json({ after: { status: 'PAUSED' } });
    });
    const response = await postAs(
      PlatformRole.SYSTEM_OWNER,
      '/api/trading-accounts/1/deactivate',
      { reason: 'Emergency pause' },
    );
    expect(response.status).toBe(200);
    expect(mocks.deactivateTradingAccountController).toHaveBeenCalledOnce();
  });

  it.each([PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER])(
    'rejects a %s from deactivating a Trading Account',
    async (platformRole) => {
      const response = await postAs(
        platformRole,
        '/api/trading-accounts/1/deactivate',
        { reason: 'Attempted pause' },
      );
      expect(response.status).toBe(403);
      expect(mocks.deactivateTradingAccountController).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/trading-accounts/:id/readiness-assessments RBAC', () => {
  it('allows only System Owners to run an assessment', async () => {
    mocks.runTradingAccountReadinessAssessmentController.mockImplementation(
      (_req: Request, res: Response) =>
        res.status(201).json({ assessment: { id: 1 } }),
    );
    const denied = await postAs(
      PlatformRole.OPERATOR,
      '/api/trading-accounts/1/readiness-assessments',
      { purpose: 'LIVE_ACTIVATION' },
    );
    expect(denied.status).toBe(403);

    const allowed = await postAs(
      PlatformRole.SYSTEM_OWNER,
      '/api/trading-accounts/1/readiness-assessments',
      { purpose: 'LIVE_ACTIVATION' },
    );
    expect(allowed.status).toBe(201);
  });
});

describe('POST /api/trading-accounts/:id/reconciliation/run RBAC', () => {
  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    vi.clearAllMocks();
  });

  it('authorizes a System Owner before invoking account reconciliation', async () => {
    mocks.runTradingAccountReconciliationController.mockImplementation(
      (_req: Request, res: Response) => res.status(200).json({ ok: true }),
    );
    const response = await postAs(
      PlatformRole.SYSTEM_OWNER,
      '/api/trading-accounts/2/reconciliation/run',
      { persistEvents: false },
    );
    expect(response.status).toBe(200);
    expect(
      mocks.runTradingAccountReconciliationController,
    ).toHaveBeenCalledOnce();
  });

  it.each([PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER])(
    'rejects %s before reconciliation work',
    async (platformRole) => {
      const response = await postAs(
        platformRole,
        '/api/trading-accounts/2/reconciliation/run',
        { persistEvents: true },
      );
      expect(response.status).toBe(403);
      expect(
        mocks.runTradingAccountReconciliationController,
      ).not.toHaveBeenCalled();
    },
  );
});

describe('Live write approval RBAC', () => {
  afterEach(() => {
    mocks.grantLiveWriteApprovalController.mockClear();
  });

  it('allows only SYSTEM_OWNER to reach a grant mutation', async () => {
    const owner = await postAs(
      PlatformRole.SYSTEM_OWNER,
      '/api/trading-accounts/2/live-write-approvals/RISK_REDUCING/grant',
      {},
    );
    expect(owner.status).toBe(200);
    expect(mocks.grantLiveWriteApprovalController).toHaveBeenCalledTimes(1);

    for (const role of [PlatformRole.OPERATOR, PlatformRole.ACCOUNT_USER]) {
      const response = await postAs(
        role,
        '/api/trading-accounts/2/live-write-approvals/RISK_REDUCING/grant',
        {},
      );
      expect(response.status).toBe(403);
    }
    expect(mocks.grantLiveWriteApprovalController).toHaveBeenCalledTimes(1);
  });
});
