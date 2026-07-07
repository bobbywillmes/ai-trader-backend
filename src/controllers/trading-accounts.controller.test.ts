import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  getTradingAccountForAdmin: vi.fn(),
  listTradingAccountsForAdmin: vi.fn(),
  listTradingAccountsForAdminUser: vi.fn(),
  updateTradingAccountForAdmin: vi.fn(),
  getTradingAccountRiskSettingsForAdmin: vi.fn(),
  updateTradingAccountRiskSettingsForAdmin: vi.fn(),
  getTradingAccountRiskHealth: vi.fn(),
  previewTradingAccountEntryRisk: vi.fn(),
  revokeTradingAccountCredential: vi.fn(),
  upsertTradingAccountApiKeyCredential: vi.fn(),
  verifyTradingAccountCredential: vi.fn(),
  createTradingAccountAllocationForAdmin: vi.fn(),
  listTradingAccountAllocationsForAdmin: vi.fn(),
  updateTradingAccountAllocationForAdmin: vi.fn(),
  createTradingAccountSubscriptionForAdmin: vi.fn(),
  getTradingAccountSubscriptionForAdmin: vi.fn(),
  listTradingAccountSubscriptionsForAdmin: vi.fn(),
  updateTradingAccountSubscriptionForAdmin: vi.fn(),
  getAccountSubscriptionPriceHistoryForAdmin: vi.fn(),
  listAccountSubscriptionMarketContextForAdmin: vi.fn(),
}));

vi.mock('../services/trading-account-credential.service.js', () => ({
  revokeTradingAccountCredential: mocks.revokeTradingAccountCredential,
  upsertTradingAccountApiKeyCredential:
    mocks.upsertTradingAccountApiKeyCredential,
}));

vi.mock('../services/trading-account-credential-verification.service.js', () => ({
  verifyTradingAccountCredential: mocks.verifyTradingAccountCredential,
}));

vi.mock('../services/trading-account.service.js', () => ({
  getTradingAccountForAdmin: mocks.getTradingAccountForAdmin,
  listTradingAccountsForAdmin: mocks.listTradingAccountsForAdmin,
  listTradingAccountsForAdminUser: mocks.listTradingAccountsForAdminUser,
  updateTradingAccountForAdmin: mocks.updateTradingAccountForAdmin,
}));

vi.mock('../services/trading-account-risk-settings.service.js', () => ({
  getTradingAccountRiskSettingsForAdmin:
    mocks.getTradingAccountRiskSettingsForAdmin,
  updateTradingAccountRiskSettingsForAdmin:
    mocks.updateTradingAccountRiskSettingsForAdmin,
}));

vi.mock('../services/trading-account-entry-risk-preview.service.js', () => ({
  previewTradingAccountEntryRisk: mocks.previewTradingAccountEntryRisk,
}));

vi.mock('../services/trading-account-risk-health.service.js', () => ({
  getTradingAccountRiskHealth: mocks.getTradingAccountRiskHealth,
}));

vi.mock('../services/trading-account-allocation.service.js', () => ({
  createTradingAccountAllocationForAdmin:
    mocks.createTradingAccountAllocationForAdmin,
  listTradingAccountAllocationsForAdmin:
    mocks.listTradingAccountAllocationsForAdmin,
  updateTradingAccountAllocationForAdmin:
    mocks.updateTradingAccountAllocationForAdmin,
}));

vi.mock('../services/trading-account-subscription.service.js', () => ({
  createTradingAccountSubscriptionForAdmin:
    mocks.createTradingAccountSubscriptionForAdmin,
  getTradingAccountSubscriptionForAdmin:
    mocks.getTradingAccountSubscriptionForAdmin,
  listTradingAccountSubscriptionsForAdmin:
    mocks.listTradingAccountSubscriptionsForAdmin,
  updateTradingAccountSubscriptionForAdmin:
    mocks.updateTradingAccountSubscriptionForAdmin,
}));

vi.mock('../services/account-subscription-market-context.service.js', async () => {
  const actual =
    await vi.importActual<
      typeof import('../services/account-subscription-market-context.service.js')
    >('../services/account-subscription-market-context.service.js');

  return {
    ...actual,
    getAccountSubscriptionPriceHistoryForAdmin:
      mocks.getAccountSubscriptionPriceHistoryForAdmin,
    listAccountSubscriptionMarketContextForAdmin:
      mocks.listAccountSubscriptionMarketContextForAdmin,
  };
});

import {
  createTradingAccountAllocationController,
  createTradingAccountSubscriptionController,
  getTradingAccountRiskHealthController,
  getTradingAccountRiskSettingsController,
  getTradingAccountSubscriptionPriceHistoryController,
  getTradingAccountSubscriptionController,
  getTradingAccountController,
  listTradingAccountAllocationsController,
  listTradingAccountSubscriptionMarketContextController,
  listTradingAccountSubscriptionsController,
  listTradingAccountsController,
  previewTradingAccountEntryRiskController,
  revokeTradingAccountCredentialController,
  updateTradingAccountController,
  updateTradingAccountAllocationController,
  updateTradingAccountRiskSettingsController,
  updateTradingAccountSubscriptionController,
  upsertTradingAccountCredentialController,
  verifyTradingAccountCredentialController,
} from './trading-accounts.controller.js';

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };

  res.status.mockReturnValue(res);

  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe('trading accounts controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTradingAccountsForAdmin.mockResolvedValue([{ id: 1 }]);
    mocks.listTradingAccountsForAdminUser.mockResolvedValue([{ id: 1 }]);
    mocks.getTradingAccountForAdmin.mockResolvedValue({ id: 1 });
    mocks.getTradingAccountRiskSettingsForAdmin.mockResolvedValue({
      id: 50,
      tradingAccountId: 1,
      enabled: true,
    });
    mocks.updateTradingAccountRiskSettingsForAdmin.mockResolvedValue({
      id: 50,
      tradingAccountId: 1,
      enabled: true,
    });
    mocks.getTradingAccountRiskHealth.mockResolvedValue({
      tradingAccountId: 1,
      status: 'READY',
      readyForEntries: true,
    });
    mocks.previewTradingAccountEntryRisk.mockResolvedValue({
      ok: true,
      wouldCreateOrderIntent: false,
      wouldSubmitBrokerOrder: false,
    });
    mocks.revokeTradingAccountCredential.mockResolvedValue({ revoked: true });
    mocks.updateTradingAccountForAdmin.mockResolvedValue({ id: 1 });
    mocks.upsertTradingAccountApiKeyCredential.mockResolvedValue({ id: 10 });
    mocks.verifyTradingAccountCredential.mockResolvedValue({
      ok: true,
      account: { id: 1 },
    });
    mocks.listTradingAccountAllocationsForAdmin.mockResolvedValue([{ id: 10 }]);
    mocks.createTradingAccountAllocationForAdmin.mockResolvedValue({ id: 10 });
    mocks.updateTradingAccountAllocationForAdmin.mockResolvedValue({ id: 10 });
    mocks.listTradingAccountSubscriptionsForAdmin.mockResolvedValue([{ id: 20 }]);
    mocks.getTradingAccountSubscriptionForAdmin.mockResolvedValue({ id: 20 });
    mocks.createTradingAccountSubscriptionForAdmin.mockResolvedValue({ id: 20 });
    mocks.updateTradingAccountSubscriptionForAdmin.mockResolvedValue({ id: 20 });
    mocks.listAccountSubscriptionMarketContextForAdmin.mockResolvedValue({
      tradingAccountId: 1,
      generatedAt: '2026-06-30T16:00:00.000Z',
      items: [{ accountSubscriptionId: 20 }],
    });
    mocks.getAccountSubscriptionPriceHistoryForAdmin.mockResolvedValue({
      tradingAccountId: 1,
      accountSubscriptionId: 20,
      subscriptionId: 30,
      symbol: 'DIA',
      range: '1y',
      generatedAt: '2026-06-30T16:00:00.000Z',
      candles: [],
      summary: {
        latestClose: null,
        latestCloseAt: null,
        week52High: null,
        week52Low: null,
      },
    });
  });

  it('returns trading account list responses', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listTradingAccountsController(
      {} as Request,
      {
        ...res,
        locals: {
          adminUser: {
            id: 42,
            role: 'account_viewer',
          },
        },
      } as unknown as Response,
      next
    );

    expect(mocks.listTradingAccountsForAdminUser).toHaveBeenCalledWith({
      adminUserId: 42,
      isOwner: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ accounts: [{ id: 1 }] });
    expect(next).not.toHaveBeenCalled();
  });

  it('treats owner trading account list requests as unrestricted', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listTradingAccountsController(
      {} as Request,
      {
        ...res,
        locals: {
          adminUser: {
            id: 1,
            role: 'owner',
          },
        },
      } as unknown as Response,
      next
    );

    expect(mocks.listTradingAccountsForAdminUser).toHaveBeenCalledWith({
      adminUserId: 1,
      isOwner: true,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns trading account detail by id', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountController(
      {
        params: {
          id: '1',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountForAdmin).toHaveBeenCalledWith(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ account: { id: 1 } });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid trading account ids', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountController(
      {
        params: {
          id: 'nope',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account id.',
      })
    );
  });

  it('returns not found for missing trading accounts', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.getTradingAccountForAdmin.mockResolvedValue(null);

    await getTradingAccountController(
      {
        params: {
          id: '404',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountForAdmin).toHaveBeenCalledWith(404);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('updates trading accounts with validated safe fields', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountController(
      {
        params: {
          id: '1',
        },
        body: {
          displayName: 'Updated Paper',
          status: 'PAUSED',
          tradingEnabled: false,
          killSwitchEnabled: true,
          estimatedTradingCapital: '25000',
          pausedReason: 'credential rotation',
          notes: null,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountForAdmin).toHaveBeenCalledWith(1, {
      displayName: 'Updated Paper',
      status: 'PAUSED',
      tradingEnabled: false,
      killSwitchEnabled: true,
      estimatedTradingCapital: 25_000,
      pausedReason: 'credential rotation',
      notes: null,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ account: { id: 1 } });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects broker and environment updates', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountController(
      {
        params: {
          id: '1',
        },
        body: {
          broker: 'ALPACA',
          environment: 'LIVE',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account update request.',
      })
    );
  });

  it('rejects empty trading account updates', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountController(
      {
        params: {
          id: '1',
        },
        body: {},
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account update request.',
      })
    );
  });

  it('returns not found when updating a missing trading account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.updateTradingAccountForAdmin.mockResolvedValue(null);

    await updateTradingAccountController(
      {
        params: {
          id: '404',
        },
        body: {
          displayName: 'Missing Account',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountForAdmin).toHaveBeenCalledWith(404, {
      displayName: 'Missing Account',
    });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('returns trading account risk settings', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountRiskSettingsController(
      {
        params: {
          id: '1',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountRiskSettingsForAdmin).toHaveBeenCalledWith(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      riskSettings: {
        id: 50,
        tradingAccountId: 1,
        enabled: true,
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns not found when reading risk settings for a missing account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.getTradingAccountRiskSettingsForAdmin.mockResolvedValue(null);

    await getTradingAccountRiskSettingsController(
      {
        params: {
          id: '404',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('returns trading account risk health', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountRiskHealthController(
      {
        params: {
          id: '1',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountRiskHealth).toHaveBeenCalledWith(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      riskHealth: {
        tradingAccountId: 1,
        status: 'READY',
        readyForEntries: true,
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid trading account ids on risk health requests', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountRiskHealthController(
      {
        params: {
          id: 'nope',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountRiskHealth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account id.',
      })
    );
  });

  it('returns not found when risk health targets a missing trading account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.getTradingAccountRiskHealth.mockResolvedValue(null);

    await getTradingAccountRiskHealthController(
      {
        params: {
          id: '404',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountRiskHealth).toHaveBeenCalledWith(404);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('returns entry risk previews for trading account subscription keys', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await previewTradingAccountEntryRiskController(
      {
        params: {
          id: '1',
        },
        body: {
          subscriptionKey: ' dia_dip_core ',
          ignoreSession: false,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.previewTradingAccountEntryRisk).toHaveBeenCalledWith(1, {
      subscriptionKey: 'dia_dip_core',
      ignoreSession: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      preview: {
        ok: true,
        wouldCreateOrderIntent: false,
        wouldSubmitBrokerOrder: false,
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid entry risk preview requests', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await previewTradingAccountEntryRiskController(
      {
        params: {
          id: '1',
        },
        body: {},
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.previewTradingAccountEntryRisk).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid entry risk preview request.',
      })
    );
  });

  it('returns not found when entry risk preview targets a missing trading account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.previewTradingAccountEntryRisk.mockResolvedValue(null);

    await previewTradingAccountEntryRiskController(
      {
        params: {
          id: '404',
        },
        body: {
          subscriptionKey: 'dia_dip_core',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.previewTradingAccountEntryRisk).toHaveBeenCalledWith(404, {
      subscriptionKey: 'dia_dip_core',
    });
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('updates trading account risk settings with validated fields', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountRiskSettingsController(
      {
        params: {
          id: '1',
        },
        body: {
          enabled: false,
          maxDailyEntryOrders: '3',
          maxDailyEntryNotional: '5000',
          maxOpenPositions: '4',
          maxTotalOpenNotional: '15000',
          maxSymbolOpenNotional: '2500',
          maxSubscriptionOpenNotional: null,
          notes: ' Account cap ',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountRiskSettingsForAdmin).toHaveBeenCalledWith(
      1,
      {
        enabled: false,
        maxDailyEntryOrders: 3,
        maxDailyEntryNotional: 5_000,
        maxOpenPositions: 4,
        maxTotalOpenNotional: 15_000,
        maxSymbolOpenNotional: 2_500,
        maxSubscriptionOpenNotional: null,
        notes: 'Account cap',
      }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      riskSettings: {
        id: 50,
        tradingAccountId: 1,
        enabled: true,
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid trading account risk settings updates', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountRiskSettingsController(
      {
        params: {
          id: '1',
        },
        body: {
          maxDailyEntryOrders: 0,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountRiskSettingsForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account risk settings request.',
      })
    );
  });

  it('rejects empty trading account risk settings updates', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountRiskSettingsController(
      {
        params: {
          id: '1',
        },
        body: {},
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountRiskSettingsForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account risk settings request.',
      })
    );
  });

  it('returns not found when updating risk settings for a missing account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.updateTradingAccountRiskSettingsForAdmin.mockResolvedValue(null);

    await updateTradingAccountRiskSettingsController(
      {
        params: {
          id: '404',
        },
        body: {
          enabled: true,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('lists trading account allocations', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listTradingAccountAllocationsController(
      {
        params: {
          id: '1',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.listTradingAccountAllocationsForAdmin).toHaveBeenCalledWith(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ allocations: [{ id: 10 }] });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns not found when listing allocations for a missing account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.listTradingAccountAllocationsForAdmin.mockResolvedValue(null);

    await listTradingAccountAllocationsController(
      {
        params: {
          id: '404',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('creates trading account allocations with validated fields', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await createTradingAccountAllocationController(
      {
        params: {
          id: '1',
        },
        body: {
          key: ' Momentum ',
          name: 'Momentum',
          enabled: false,
          maxAllocatedNotional: '10000',
          maxOpenPositions: '4',
          maxPositionNotional: '2500',
          notes: null,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.createTradingAccountAllocationForAdmin).toHaveBeenCalledWith(1, {
      key: 'momentum',
      name: 'Momentum',
      enabled: false,
      maxAllocatedNotional: 10_000,
      maxOpenPositions: 4,
      maxPositionNotional: 2_500,
      notes: null,
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ allocation: { id: 10 } });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid allocation create requests', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await createTradingAccountAllocationController(
      {
        params: {
          id: '1',
        },
        body: {
          key: 'bad key',
          name: 'Bad Key',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.createTradingAccountAllocationForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account allocation request.',
      })
    );
  });

  it('returns not found when creating allocations for a missing account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.createTradingAccountAllocationForAdmin.mockResolvedValue(null);

    await createTradingAccountAllocationController(
      {
        params: {
          id: '404',
        },
        body: {
          key: 'momentum',
          name: 'Momentum',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('updates trading account allocations with validated safe fields', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountAllocationController(
      {
        params: {
          id: '1',
          allocationId: '10',
        },
        body: {
          key: ' Swing ',
          name: 'Swing',
          enabled: false,
          maxAllocatedNotional: null,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountAllocationForAdmin).toHaveBeenCalledWith(
      1,
      10,
      {
        key: 'swing',
        name: 'Swing',
        enabled: false,
        maxAllocatedNotional: null,
      }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ allocation: { id: 10 } });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid allocation ids on update', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountAllocationController(
      {
        params: {
          id: '1',
          allocationId: 'nope',
        },
        body: {
          name: 'Swing',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountAllocationForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account allocation id.',
      })
    );
  });

  it('rejects empty allocation updates', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountAllocationController(
      {
        params: {
          id: '1',
          allocationId: '10',
        },
        body: {},
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountAllocationForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account allocation request.',
      })
    );
  });

  it('returns not found when updating a missing allocation', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.updateTradingAccountAllocationForAdmin.mockResolvedValue(null);

    await updateTradingAccountAllocationController(
      {
        params: {
          id: '1',
          allocationId: '404',
        },
        body: {
          name: 'Missing',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account allocation not found.',
      })
    );
  });

  it('lists trading account subscriptions', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listTradingAccountSubscriptionsController(
      {
        params: {
          id: '1',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.listTradingAccountSubscriptionsForAdmin).toHaveBeenCalledWith(
      1
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      accountSubscriptions: [{ id: 20 }],
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns not found when listing account subscriptions for a missing account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.listTradingAccountSubscriptionsForAdmin.mockResolvedValue(null);

    await listTradingAccountSubscriptionsController(
      {
        params: {
          id: '404',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('returns trading account subscription detail by account scope', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountSubscriptionController(
      {
        params: {
          id: '1',
          accountSubscriptionId: '20',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountSubscriptionForAdmin).toHaveBeenCalledWith(
      1,
      20
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      accountSubscription: { id: 20 },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid account subscription ids on detail requests', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountSubscriptionController(
      {
        params: {
          id: '1',
          accountSubscriptionId: 'nope',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.getTradingAccountSubscriptionForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account subscription id.',
      })
    );
  });

  it('returns not found when reading a missing account subscription', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.getTradingAccountSubscriptionForAdmin.mockResolvedValue(null);

    await getTradingAccountSubscriptionController(
      {
        params: {
          id: '1',
          accountSubscriptionId: '404',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account subscription not found.',
      })
    );
  });

  it('lists account subscription market context with simple query filters', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listTradingAccountSubscriptionMarketContextController(
      {
        params: {
          id: '1',
        },
        query: {
          status: 'all',
          symbols: ' spy, DIA ,,',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(
      mocks.listAccountSubscriptionMarketContextForAdmin
    ).toHaveBeenCalledWith(1, {
      status: 'all',
      symbols: ['SPY', 'DIA'],
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      tradingAccountId: 1,
      generatedAt: '2026-06-30T16:00:00.000Z',
      items: [{ accountSubscriptionId: 20 }],
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('defaults account subscription market context filters conservatively', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await listTradingAccountSubscriptionMarketContextController(
      {
        params: {
          id: '1',
        },
        query: {
          status: 'bad',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(
      mocks.listAccountSubscriptionMarketContextForAdmin
    ).toHaveBeenCalledWith(1, {
      status: 'active',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns not found when market context targets a missing trading account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.listAccountSubscriptionMarketContextForAdmin.mockResolvedValue(null);

    await listTradingAccountSubscriptionMarketContextController(
      {
        params: {
          id: '404',
        },
        query: {},
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('returns account subscription price history with parsed range', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountSubscriptionPriceHistoryController(
      {
        params: {
          id: '1',
          accountSubscriptionId: '20',
        },
        query: {
          range: '3m',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(
      mocks.getAccountSubscriptionPriceHistoryForAdmin
    ).toHaveBeenCalledWith(1, 20, {
      range: '3m',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      tradingAccountId: 1,
      accountSubscriptionId: 20,
      subscriptionId: 30,
      symbol: 'DIA',
      range: '1y',
      generatedAt: '2026-06-30T16:00:00.000Z',
      candles: [],
      summary: {
        latestClose: null,
        latestCloseAt: null,
        week52High: null,
        week52Low: null,
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('defaults invalid price history ranges to 1y', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountSubscriptionPriceHistoryController(
      {
        params: {
          id: '1',
          accountSubscriptionId: '20',
        },
        query: {
          range: 'bad',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(
      mocks.getAccountSubscriptionPriceHistoryForAdmin
    ).toHaveBeenCalledWith(1, 20, {
      range: '1y',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid account subscription ids on price history requests', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await getTradingAccountSubscriptionPriceHistoryController(
      {
        params: {
          id: '1',
          accountSubscriptionId: 'nope',
        },
        query: {},
      } as unknown as Request,
      res,
      next
    );

    expect(
      mocks.getAccountSubscriptionPriceHistoryForAdmin
    ).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account subscription id.',
      })
    );
  });

  it('returns not found when price history targets a missing account subscription', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.getAccountSubscriptionPriceHistoryForAdmin.mockResolvedValue(null);

    await getTradingAccountSubscriptionPriceHistoryController(
      {
        params: {
          id: '1',
          accountSubscriptionId: '404',
        },
        query: {},
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account subscription not found.',
      })
    );
  });

  it('creates trading account subscriptions with validated fields', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await createTradingAccountSubscriptionController(
      {
        params: {
          id: '1',
        },
        body: {
          subscriptionId: '30',
          allocationId: '10',
          enabled: false,
          entriesEnabled: true,
          exitsEnabled: false,
          sizingType: 'MAX_NOTIONAL',
          maxPositionNotional: '5000',
          minPositionNotional: '0',
          maxQty: '10',
          notes: null,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.createTradingAccountSubscriptionForAdmin).toHaveBeenCalledWith(
      1,
      {
        subscriptionId: 30,
        allocationId: 10,
        enabled: false,
        entriesEnabled: true,
        exitsEnabled: false,
        sizingType: 'MAX_NOTIONAL',
        maxPositionNotional: 5_000,
        minPositionNotional: 0,
        maxQty: 10,
        notes: null,
      }
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      accountSubscription: { id: 20 },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid account subscription create requests', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await createTradingAccountSubscriptionController(
      {
        params: {
          id: '1',
        },
        body: {
          subscriptionId: '30',
          sizingType: 'FIXED_QTY',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.createTradingAccountSubscriptionForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account subscription request.',
      })
    );
  });

  it('returns not found when creating account subscriptions for a missing account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.createTradingAccountSubscriptionForAdmin.mockResolvedValue(null);

    await createTradingAccountSubscriptionController(
      {
        params: {
          id: '404',
        },
        body: {
          subscriptionId: 30,
          fixedQty: 1,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('updates trading account subscriptions with validated safe fields', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountSubscriptionController(
      {
        params: {
          id: '1',
          accountSubscriptionId: '20',
        },
        body: {
          allocationId: null,
          enabled: false,
          entriesEnabled: false,
          exitsEnabled: true,
          sizingType: 'FIXED_QTY',
          fixedQty: '2',
          minPositionNotional: '0',
          maxQty: '5',
          notes: null,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountSubscriptionForAdmin).toHaveBeenCalledWith(
      1,
      20,
      {
        allocationId: null,
        enabled: false,
        entriesEnabled: false,
        exitsEnabled: true,
        sizingType: 'FIXED_QTY',
        fixedQty: 2,
        minPositionNotional: 0,
        maxQty: 5,
        notes: null,
      }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      accountSubscription: { id: 20 },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid account subscription update requests', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await updateTradingAccountSubscriptionController(
      {
        params: {
          id: '1',
          accountSubscriptionId: '20',
        },
        body: {},
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.updateTradingAccountSubscriptionForAdmin).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account subscription request.',
      })
    );
  });

  it('returns not found when updating a missing account subscription', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.updateTradingAccountSubscriptionForAdmin.mockResolvedValue(null);

    await updateTradingAccountSubscriptionController(
      {
        params: {
          id: '1',
          accountSubscriptionId: '404',
        },
        body: {
          enabled: false,
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account subscription not found.',
      })
    );
  });

  it('upserts trading account credentials and returns a safe account response', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.getTradingAccountForAdmin.mockResolvedValue({
      id: 1,
      credential: {
        exists: true,
        status: 'NEEDS_VERIFICATION',
        authType: 'API_KEY',
        keyFingerprint: 'sha256:fingerprint',
      },
    });

    await upsertTradingAccountCredentialController(
      {
        params: {
          id: '1',
        },
        body: {
          authType: 'API_KEY',
          apiKey: 'plain-key',
          apiSecret: 'plain-secret',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.upsertTradingAccountApiKeyCredential).toHaveBeenCalledWith(1, {
      authType: 'API_KEY',
      apiKey: 'plain-key',
      apiSecret: 'plain-secret',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(JSON.stringify(res.json.mock.calls[0]?.[0])).not.toContain(
      'plain-secret'
    );
    expect(res.json).toHaveBeenCalledWith({
      account: {
        id: 1,
        credential: {
          exists: true,
          status: 'NEEDS_VERIFICATION',
          authType: 'API_KEY',
          keyFingerprint: 'sha256:fingerprint',
        },
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('defaults credential upsert authType to API_KEY', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await upsertTradingAccountCredentialController(
      {
        params: {
          id: '1',
        },
        body: {
          apiKey: 'plain-key',
          apiSecret: 'plain-secret',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.upsertTradingAccountApiKeyCredential).toHaveBeenCalledWith(1, {
      authType: 'API_KEY',
      apiKey: 'plain-key',
      apiSecret: 'plain-secret',
    });
  });

  it('rejects unsupported credential auth types', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await upsertTradingAccountCredentialController(
      {
        params: {
          id: '1',
        },
        body: {
          authType: 'OAUTH',
          apiKey: 'plain-key',
          apiSecret: 'plain-secret',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.upsertTradingAccountApiKeyCredential).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Invalid trading account credential request.',
      })
    );
  });

  it('returns not found when credential upsert targets a missing account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.upsertTradingAccountApiKeyCredential.mockResolvedValue(null);

    await upsertTradingAccountCredentialController(
      {
        params: {
          id: '404',
        },
        body: {
          apiKey: 'plain-key',
          apiSecret: 'plain-secret',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('verifies trading account credentials', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;

    await verifyTradingAccountCredentialController(
      {
        params: {
          id: '1',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.verifyTradingAccountCredential).toHaveBeenCalledWith(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ account: { id: 1 } });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns a safe credential verification failure response', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.verifyTradingAccountCredential.mockResolvedValue({
      ok: false,
      message: 'Broker credential verification failed.',
      account: { id: 1 },
    });

    await verifyTradingAccountCredentialController(
      {
        params: {
          id: '1',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'CredentialVerificationFailed',
      message: 'Broker credential verification failed.',
      account: { id: 1 },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns not found when verification targets a missing trading account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.verifyTradingAccountCredential.mockResolvedValue(null);

    await verifyTradingAccountCredentialController(
      {
        params: {
          id: '404',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });

  it('revokes trading account credentials and returns a safe account response', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.getTradingAccountForAdmin.mockResolvedValue({
      id: 1,
      credential: {
        exists: true,
        status: 'REVOKED',
        authType: 'API_KEY',
      },
    });

    await revokeTradingAccountCredentialController(
      {
        params: {
          id: '1',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(mocks.revokeTradingAccountCredential).toHaveBeenCalledWith(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      revoked: true,
      account: {
        id: 1,
        credential: {
          exists: true,
          status: 'REVOKED',
          authType: 'API_KEY',
        },
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns not found when revoking credentials for a missing account', async () => {
    const res = response();
    const next = vi.fn() as NextFunction;
    mocks.revokeTradingAccountCredential.mockResolvedValue(null);

    await revokeTradingAccountCredentialController(
      {
        params: {
          id: '404',
        },
      } as unknown as Request,
      res,
      next
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Trading account not found.',
      })
    );
  });
});
