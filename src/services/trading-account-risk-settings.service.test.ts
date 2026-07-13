import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tradingAccountFindUnique: vi.fn(),
  tradingAccountRiskSettingsUpsert: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findUnique: mocks.tradingAccountFindUnique,
    },
    tradingAccountRiskSettings: {
      upsert: mocks.tradingAccountRiskSettingsUpsert,
    },
  },
}));

vi.mock('./config.service.js', () => ({
  getRuntimeTradingConfig: mocks.getRuntimeTradingConfig,
}));

import {
  getTradingAccountRiskSettingsForAdmin,
  updateTradingAccountRiskSettingsForAdmin,
} from './trading-account-risk-settings.service.js';

function riskSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    tradingAccountId: 1,
    enabled: true,
    maxDailyEntryOrders: 5,
    maxDailyEntryNotional: 10_000,
    maxOpenPositions: 5,
    maxTotalOpenNotional: 25_000,
    maxSymbolOpenNotional: 5_000,
    maxSubscriptionOpenNotional: 5_000,
    notes: null,
    createdAt: new Date('2026-07-02T16:00:00.000Z'),
    updatedAt: new Date('2026-07-02T16:00:00.000Z'),
    ...overrides,
  };
}

describe('trading account risk settings service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      maxDeployableNotional: 50_000,
    });
    mocks.tradingAccountRiskSettingsUpsert.mockResolvedValue(riskSettings());
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      maxDailyEntryOrders: 7,
      maxDailyEntryNotional: 12_000,
      maxOpenPositions: 6,
      maxTotalOpenNotional: 30_000,
      maxSymbolOpenNotional: 6_000,
      maxSubscriptionOpenNotional: 6_000,
    });
  });

  it('gets or creates default risk settings for an existing account', async () => {
    await expect(getTradingAccountRiskSettingsForAdmin(1)).resolves.toEqual({
      ...riskSettings(),
      effectiveEntryLimits: expect.objectContaining({
        tradingAccountId: 1,
        limits: expect.objectContaining({
          maxDailyEntryOrders: { value: 5, source: 'ACCOUNT' },
        }),
      }),
    });

    expect(mocks.tradingAccountFindUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true, maxDeployableNotional: true },
    });
    expect(mocks.tradingAccountRiskSettingsUpsert).toHaveBeenCalledWith({
      where: { tradingAccountId: 1 },
      update: {},
      create: {
        tradingAccountId: 1,
      },
      select: expect.any(Object),
    });
  });

  it('returns null when getting risk settings for a missing account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(getTradingAccountRiskSettingsForAdmin(404)).resolves.toBeNull();
    expect(mocks.tradingAccountRiskSettingsUpsert).not.toHaveBeenCalled();
  });

  it('updates safe mutable risk settings fields', async () => {
    mocks.tradingAccountRiskSettingsUpsert.mockResolvedValue(
      riskSettings({
        enabled: false,
        maxDailyEntryOrders: 3,
        maxSubscriptionOpenNotional: null,
        notes: 'Account cap',
      })
    );

    const result = await updateTradingAccountRiskSettingsForAdmin(1, {
      enabled: false,
      maxDailyEntryOrders: 3,
      maxDailyEntryNotional: 5_000,
      maxOpenPositions: 4,
      maxTotalOpenNotional: 15_000,
      maxSymbolOpenNotional: 2_500,
      maxSubscriptionOpenNotional: null,
      notes: 'Account cap',
    });

    expect(mocks.tradingAccountRiskSettingsUpsert).toHaveBeenCalledWith({
      where: { tradingAccountId: 1 },
      update: {
        enabled: false,
        maxDailyEntryOrders: 3,
        maxDailyEntryNotional: 5_000,
        maxOpenPositions: 4,
        maxTotalOpenNotional: 15_000,
        maxSymbolOpenNotional: 2_500,
        maxSubscriptionOpenNotional: null,
        notes: 'Account cap',
      },
      create: {
        tradingAccountId: 1,
        enabled: false,
        maxDailyEntryOrders: 3,
        maxDailyEntryNotional: 5_000,
        maxOpenPositions: 4,
        maxTotalOpenNotional: 15_000,
        maxSymbolOpenNotional: 2_500,
        maxSubscriptionOpenNotional: null,
        notes: 'Account cap',
      },
      select: expect.any(Object),
    });
    expect(result).toEqual(
      expect.objectContaining({
        id: 10,
        tradingAccountId: 1,
        enabled: false,
        maxDailyEntryOrders: 3,
        maxSubscriptionOpenNotional: null,
        notes: 'Account cap',
        effectiveEntryLimits: expect.objectContaining({
          accountRiskSettingsEnabled: false,
          limits: expect.objectContaining({
            maxDailyEntryOrders: {
              value: 7,
              source: 'LEGACY_GLOBAL_FALLBACK',
            },
          }),
        }),
      })
    );
  });

  it('returns null when updating risk settings for a missing account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(
      updateTradingAccountRiskSettingsForAdmin(404, {
        enabled: true,
      })
    ).resolves.toBeNull();
    expect(mocks.tradingAccountRiskSettingsUpsert).not.toHaveBeenCalled();
  });
});
