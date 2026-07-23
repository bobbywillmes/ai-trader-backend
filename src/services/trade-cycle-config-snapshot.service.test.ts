import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  securityFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  trackedPositionFindUnique: vi.fn(),
  trackedPositionUpdate: vi.fn(),
  settingFindMany: vi.fn(),
  tradingAccountFindUnique: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    security: {
      findUnique: mocks.securityFindUnique,
    },
    subscription: {
      findUnique: mocks.subscriptionFindUnique,
    },
    trackedPosition: {
      findUnique: mocks.trackedPositionFindUnique,
      update: mocks.trackedPositionUpdate,
    },
    setting: {
      findMany: mocks.settingFindMany,
    },
    tradingAccount: {
      findUnique: mocks.tradingAccountFindUnique,
    },
  },
}));

import {
  buildTradeCycleConfigSnapshot,
  captureTrackedPositionConfigSnapshot,
} from './trade-cycle-config-snapshot.service.js';

describe('trade cycle config snapshot service', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.settingFindMany.mockResolvedValue([
      { key: 'tradingEnabled', value: 'true' },
      { key: 'paperMode', value: 'true' },
      { key: 'killSwitchEnabled', value: 'false' },
      { key: 'maxDailyEntryOrders', value: '5' },
    ]);
  });

  it('builds a snapshot with subscription, strategy, exit profile, security, and runtime risk config', async () => {
    mocks.securityFindUnique.mockResolvedValue({
      id: 11,
      symbol: 'SPY',
      name: 'SPDR S&P 500 ETF Trust',
      assetType: 'ETF',
      sector: null,
      industry: null,
      enabled: true,
    });
    mocks.subscriptionFindUnique.mockResolvedValue({
      id: 22,
      key: 'spy_dip_core',
      name: 'SPY Dip Core',
      symbol: 'SPY',
      broker: 'alpaca',
      brokerMode: 'paper',
      sizingType: 'fixed_qty',
      sizingValue: 1,
      enabled: true,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-02T00:00:00.000Z'),
      strategy: {
        id: 33,
        key: 'dip_n_ride_etf',
        name: 'Dip N Ride - ETF',
        description: 'ETF strategy',
        allowedSymbolsJson: ['SPY'],
        enabled: true,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-02T00:00:00.000Z'),
      },
      exitProfile: {
        id: 44,
        key: 'exit_quick',
        name: 'Quick Exit',
        description: 'Quick test exit',
        targetPct: 0.5,
        stopLossPct: 1,
        trailingStopPct: 0.25,
        maxHoldDays: null,
        exitMode: 'unlock_trailing_stop',
        takeProfitBehavior: 'trail',
        enabled: true,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-02T00:00:00.000Z'),
      },
      security: {},
    });

    const snapshot = await buildTradeCycleConfigSnapshot({
      broker: 'alpaca',
      symbol: 'SPY',
      securityId: 11,
      subscriptionId: 22,
      source: 'position_opened',
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        source: 'position_opened',
        subscriptionResolutionSource: null,
        broker: 'alpaca',
        symbol: 'SPY',
        security: expect.objectContaining({
          id: 11,
          symbol: 'SPY',
          assetType: 'ETF',
        }),
        subscription: expect.objectContaining({
          id: 22,
          key: 'spy_dip_core',
        }),
        strategy: expect.objectContaining({
          id: 33,
          key: 'dip_n_ride_etf',
          name: 'Dip N Ride - ETF',
        }),
        exitProfile: expect.objectContaining({
          id: 44,
          key: 'exit_quick',
          trailingStopPct: 0.25,
        }),
        runtimeRisk: expect.objectContaining({
          tradingEnabled: true,
          paperMode: true,
          killSwitchEnabled: false,
          maxDailyEntryOrders: 5,
        }),
      })
    );
  });

  it('captures a tracked-position snapshot only when one is missing', async () => {
    mocks.trackedPositionFindUnique.mockResolvedValue({
      id: 101,
      broker: 'alpaca',
      symbol: 'SPY',
      securityId: 11,
      subscriptionId: null,
      tradingAccountId: 1,
      configSnapshotJson: null,
    });
    mocks.securityFindUnique.mockResolvedValue({
      id: 11,
      symbol: 'SPY',
      name: 'SPDR S&P 500 ETF Trust',
      assetType: 'ETF',
      sector: null,
      industry: null,
      enabled: true,
    });
    mocks.subscriptionFindUnique.mockResolvedValue(null);
    mocks.tradingAccountFindUnique.mockResolvedValue({
      id: 1,
      maxDeployableNotional: 20_000,
      riskSettings: {
        enabled: true,
        maxDailyEntryOrders: 10,
        maxDailyEntryNotional: null,
        maxOpenPositions: null,
        maxTotalOpenNotional: null,
        maxSymbolOpenNotional: null,
        maxSubscriptionOpenNotional: null,
      },
    });
    mocks.trackedPositionUpdate.mockResolvedValue({});

    await captureTrackedPositionConfigSnapshot({
      trackedPositionId: 101,
      source: 'position_opened',
    });

    expect(mocks.trackedPositionUpdate).toHaveBeenCalledWith({
      where: { id: 101 },
      data: {
        configSnapshotJson: expect.objectContaining({
          source: 'position_opened',
          symbol: 'SPY',
          subscription: null,
          runtimeRisk: expect.objectContaining({
            effectiveEntryLimits: expect.objectContaining({
              tradingAccountId: 1,
              authoritativeTotalExposure: expect.objectContaining({
                value: 20_000,
              }),
            }),
          }),
        }),
        configSnapshotCapturedAt: expect.any(Date),
      },
    });
  });

  it('does not overwrite an existing tracked-position snapshot', async () => {
    const existingSnapshot = {
      schemaVersion: 1,
      capturedAt: '2026-06-16T15:00:00.000Z',
      subscription: { key: 'dia_dip_core' },
    };
    mocks.trackedPositionFindUnique.mockResolvedValue({
      id: 101,
      broker: 'alpaca',
      symbol: 'DIA',
      securityId: 11,
      subscriptionId: 22,
      tradingAccountId: 1,
      configSnapshotJson: existingSnapshot,
    });

    const result = await captureTrackedPositionConfigSnapshot({
      trackedPositionId: 101,
      source: 'subscription_recovered',
      subscriptionResolutionSource: 'unique_observer_fallback',
    });

    expect(result).toEqual(
      expect.objectContaining({
        configSnapshotJson: existingSnapshot,
      })
    );
    expect(mocks.trackedPositionUpdate).not.toHaveBeenCalled();
  });
});
