import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapTradingAccountRiskSettings,
  buildTradingAccountRiskSettingsBootstrapPlan,
} from './trading-account-risk-settings-bootstrap.service.js';

describe('trading account risk settings bootstrap', () => {
  it('plans only missing routine fields for every account', () => {
    const result = buildTradingAccountRiskSettingsBootstrapPlan({
      accounts: [
        {
          id: 1,
          displayName: 'Paper',
          riskSettings: {
            id: 10,
            maxDailyEntryOrders: 8,
            maxDailyEntryNotional: null,
            maxOpenPositions: 4,
            maxSymbolOpenNotional: null,
          },
        },
        { id: 2, displayName: 'Live', riskSettings: null },
      ],
      globalLimits: {
        maxDailyEntryOrders: 5,
        maxDailyEntryNotional: 10_000,
        maxOpenPositions: 5,
        maxSymbolOpenNotional: 5_000,
      },
    });

    expect(result).toEqual([
      {
        tradingAccountId: 1,
        displayName: 'Paper',
        createsRiskSettings: false,
        fields: {
          maxDailyEntryNotional: 10_000,
          maxSymbolOpenNotional: 5_000,
        },
        unresolvedFields: [],
      },
      {
        tradingAccountId: 2,
        displayName: 'Live',
        createsRiskSettings: true,
        fields: {
          maxDailyEntryOrders: 5,
          maxDailyEntryNotional: 10_000,
          maxOpenPositions: 5,
          maxSymbolOpenNotional: 5_000,
        },
        unresolvedFields: [],
      },
    ]);
  });

  it('reports explicit null global values as unresolved without planning a write', () => {
    const [plan] = buildTradingAccountRiskSettingsBootstrapPlan({
      accounts: [{ id: 1, displayName: 'Paper', riskSettings: null }],
      globalLimits: {
        maxDailyEntryOrders: 5,
        maxDailyEntryNotional: null,
        maxOpenPositions: 5,
        maxSymbolOpenNotional: null,
      },
    });

    expect(plan).toMatchObject({
      fields: { maxDailyEntryOrders: 5, maxOpenPositions: 5 },
      unresolvedFields: [
        'maxDailyEntryNotional',
        'maxSymbolOpenNotional',
      ],
    });
  });

  it('does not write in dry-run mode', async () => {
    const prisma = {
      setting: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      tradingAccount: {
        findMany: vi.fn().mockResolvedValue([
          { id: 1, displayName: 'Paper', riskSettings: null },
        ]),
      },
      tradingAccountRiskSettings: {
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
    };

    const result = await bootstrapTradingAccountRiskSettings(
      prisma as never,
      { apply: false }
    );

    expect(result.mode).toBe('DRY_RUN');
    expect(result.changedAccountCount).toBe(1);
    expect(prisma.tradingAccountRiskSettings.upsert).not.toHaveBeenCalled();
    expect(prisma.tradingAccountRiskSettings.updateMany).not.toHaveBeenCalled();
  });

  it('uses null-guarded updates and never writes unrelated fields', async () => {
    const prisma = {
      setting: {
        findMany: vi.fn().mockResolvedValue([
          { key: 'maxDailyEntryOrders', value: '9' },
        ]),
      },
      tradingAccount: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 1,
            displayName: 'Paper',
            riskSettings: {
              id: 10,
              maxDailyEntryOrders: null,
              maxDailyEntryNotional: 20_000,
              maxOpenPositions: 8,
              maxSymbolOpenNotional: 7_000,
            },
          },
        ]),
      },
      tradingAccountRiskSettings: {
        upsert: vi.fn().mockResolvedValue({ id: 10 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await bootstrapTradingAccountRiskSettings(prisma as never, { apply: true });

    expect(prisma.tradingAccountRiskSettings.upsert).toHaveBeenCalledWith({
      where: { tradingAccountId: 1 },
      update: {},
      create: { tradingAccountId: 1 },
    });
    expect(prisma.tradingAccountRiskSettings.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.tradingAccountRiskSettings.updateMany).toHaveBeenCalledWith({
      where: { tradingAccountId: 1, maxDailyEntryOrders: null },
      data: { maxDailyEntryOrders: 9 },
    });
  });
});
