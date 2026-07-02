import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateOrderRisk } from './risk-gate.service.js';
import type { RuntimeTradingConfig } from './config.service.js';

const mocks = vi.hoisted(() => ({
  securityFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  tradingAccountRiskSettingsFindUnique: vi.fn(),
  trackedPositionFindMany: vi.fn(),
  orderIntentFindMany: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
  getNormalizedAccount: vi.fn(),
  evaluateEntrySessionGuard: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    security: { findUnique: mocks.securityFindUnique },
    subscription: {
      findUnique: mocks.subscriptionFindUnique,
      findFirst: mocks.subscriptionFindFirst,
    },
    tradingAccountRiskSettings: {
      findUnique: mocks.tradingAccountRiskSettingsFindUnique,
    },
    trackedPosition: { findMany: mocks.trackedPositionFindMany },
    orderIntent: { findMany: mocks.orderIntentFindMany },
  },
}));

vi.mock('./config.service.js', () => ({
  getRuntimeTradingConfig: mocks.getRuntimeTradingConfig,
}));

vi.mock('./account.service.js', () => ({
  getNormalizedAccount: mocks.getNormalizedAccount,
}));

vi.mock('./system-event.service.js', () => ({
  createSystemEvent: vi.fn(),
}));

vi.mock('./entry-session-guard.service.js', () => ({
  evaluateEntrySessionGuard: mocks.evaluateEntrySessionGuard,
  entrySessionDetailsAsJson: (decision: { details: unknown }) => decision.details,
  isEntrySessionBlocked: (decision: { allowed: boolean }) => !decision.allowed,
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

const config: RuntimeTradingConfig = {
  tradingEnabled: true,
  paperMode: true,
  killSwitchEnabled: false,
  maxDailyEntryOrders: 5,
  maxDailyEntryNotional: 10_000,
  maxOpenPositions: 5,
  maxTotalOpenNotional: 25_000,
  maxSymbolOpenNotional: 5_000,
  maxSubscriptionOpenNotional: 5_000,
  entrySessionGuardEnabled: true,
  entryStartMinutesAfterOpen: 15,
  entryCutoffMinutesBeforeClose: 30,
  failClosedOnMarketClockError: true,
  reconciliationWorkerEnabled: false,
  reconciliationWorkerIntervalMinutes: 15,
};

function subscriptionRecord() {
  return {
    id: 22,
    key: 'spy_dip_core',
    symbol: 'SPY',
    enabled: true,
    strategy: {
      key: 'dip_n_ride',
      enabled: true,
    },
    exitProfile: {
      key: 'standard',
      enabled: true,
    },
    security: {
      symbol: 'SPY',
      enabled: true,
    },
  };
}

function accountRiskSettings(
  overrides: Partial<{
    enabled: boolean;
    maxDailyEntryOrders: number | null;
    maxDailyEntryNotional: number | null;
    maxOpenPositions: number | null;
    maxTotalOpenNotional: number | null;
    maxSymbolOpenNotional: number | null;
    maxSubscriptionOpenNotional: number | null;
  }> = {}
) {
  return {
    enabled: true,
    maxDailyEntryOrders: null,
    maxDailyEntryNotional: null,
    maxOpenPositions: null,
    maxTotalOpenNotional: null,
    maxSymbolOpenNotional: null,
    maxSubscriptionOpenNotional: null,
    ...overrides,
  };
}

function activePosition(
  overrides: Partial<{
    id: number;
    symbol: string;
    subscriptionId: number | null;
    marketValue: number;
    costBasis: number;
    status: string;
  }> = {}
) {
  return {
    id: 100,
    symbol: 'QQQ',
    subscriptionId: 23,
    marketValue: 1_000,
    costBasis: 900,
    status: 'open',
    ...overrides,
  };
}

describe('risk gate entry session integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.getRuntimeTradingConfig.mockResolvedValue(config);
    mocks.securityFindUnique.mockResolvedValue({
      symbol: 'SPY',
      enabled: true,
    });
    mocks.getNormalizedAccount.mockResolvedValue({
      broker: 'alpaca',
      mode: 'paper',
      tradingBlocked: false,
    });
    mocks.trackedPositionFindMany.mockResolvedValue([]);
    mocks.orderIntentFindMany.mockResolvedValue([]);
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(null);
    mocks.evaluateEntrySessionGuard.mockResolvedValue({
      allowed: true,
      degraded: false,
      details: {
        status: 'allowed',
      },
    });
  });

  it('checks the entry-session guard for entry orders', async () => {
    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 100,
      extendedHours: false,
      signalType: 'entry',
    });

    expect(result.allowed).toBe(true);
    expect(mocks.evaluateEntrySessionGuard).toHaveBeenCalledOnce();
    expect(mocks.trackedPositionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tradingAccountId: 1,
        }),
      })
    );
    expect(mocks.orderIntentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tradingAccountId: 1,
        }),
      })
    );
  });

  it('bypasses the entry-session guard for non-entry orders', async () => {
    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'sell',
      orderType: 'market',
      timeInForce: 'day',
      qty: 1,
      extendedHours: false,
      signalType: 'exit',
    });

    expect(result.allowed).toBe(true);
    expect(mocks.evaluateEntrySessionGuard).not.toHaveBeenCalled();
  });

  it('uses requested notional override for qty-only market entry risk checks', async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 12,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      {
        requestedNotionalOverride: 6_000,
      }
    );

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Symbol exposure limit would be exceeded for SPY.',
      details: expect.objectContaining({
        rule: 'maxSymbolOpenNotional',
        requestedNotional: 6_000,
      }),
    });
  });

  it('counts account subscription sizing snapshots for pending entry notional usage', async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        id: 55,
        symbol: 'QQQ',
        subscriptionId: 23,
        notional: null,
        qty: 3,
        limitPrice: null,
        rawRequestJson: {
          accountSubscriptionSizing: {
            estimatedNotional: 8_000,
          },
        },
        status: 'pending',
      },
    ]);

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 4,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      {
        requestedNotionalOverride: 3_000,
      }
    );

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Daily entry notional limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'maxDailyEntryNotional',
        dailyEntryNotional: 8_000,
        requestedNotional: 3_000,
        projectedDailyEntryNotional: 11_000,
      }),
    });
  });

  it('skips account risk caps when account risk settings are disabled', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryOrders: null,
      maxDailyEntryNotional: null,
      maxOpenPositions: null,
      maxTotalOpenNotional: null,
      maxSymbolOpenNotional: null,
      maxSubscriptionOpenNotional: null,
    });
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({
        enabled: false,
        maxDailyEntryOrders: 1,
      })
    );
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        id: 55,
        symbol: 'QQQ',
        subscriptionId: 23,
        notional: 100,
        qty: null,
        limitPrice: null,
        rawRequestJson: {},
        status: 'pending',
      },
    ]);

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 100,
      extendedHours: false,
      signalType: 'entry',
    });

    expect(result.allowed).toBe(true);
  });

  it('keeps global caps active when account risk settings are missing', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryOrders: 1,
    });
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(null);
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        id: 55,
        symbol: 'QQQ',
        subscriptionId: 23,
        notional: 100,
        qty: null,
        limitPrice: null,
        rawRequestJson: {},
        status: 'pending',
      },
    ]);

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 100,
      extendedHours: false,
      signalType: 'entry',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Daily entry order limit reached.',
      details: expect.objectContaining({
        rule: 'maxDailyEntryOrders',
      }),
    });
  });

  it('blocks when account max daily entry orders would be exceeded', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryOrders: 5,
    });
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({
        maxDailyEntryOrders: 1,
      })
    );
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        id: 55,
        symbol: 'QQQ',
        subscriptionId: 23,
        notional: 100,
        qty: null,
        limitPrice: null,
        rawRequestJson: {},
        status: 'pending',
      },
    ]);

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 100,
      extendedHours: false,
      signalType: 'entry',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Account daily entry order limit reached.',
      details: expect.objectContaining({
        rule: 'account_max_daily_entry_orders_exceeded',
        tradingAccountId: 1,
        maxDailyEntryOrders: 1,
        dailyEntryOrderCount: 1,
      }),
    });
  });

  it('blocks account daily entry notional using runtime estimated notional', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryNotional: 50_000,
      maxSymbolOpenNotional: 50_000,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({
        maxDailyEntryNotional: 10_000,
      })
    );
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        id: 55,
        symbol: 'QQQ',
        subscriptionId: 23,
        notional: null,
        qty: 3,
        limitPrice: null,
        rawRequestJson: {
          accountSubscriptionSizing: {
            estimatedNotional: 8_000,
          },
        },
        status: 'pending',
      },
    ]);

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 4,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      {
        requestedNotionalOverride: 3_000,
      }
    );

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Account daily entry notional limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'account_max_daily_entry_notional_exceeded',
        dailyEntryNotional: 8_000,
        requestedNotional: 3_000,
        projectedDailyEntryNotional: 11_000,
      }),
    });
  });

  it('blocks when account max open positions would be exceeded', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxOpenPositions: 5,
    });
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({
        maxOpenPositions: 1,
      })
    );
    mocks.trackedPositionFindMany.mockResolvedValue([activePosition()]);

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 100,
      extendedHours: false,
      signalType: 'entry',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Account maximum open position limit reached.',
      details: expect.objectContaining({
        rule: 'account_max_open_positions_exceeded',
        maxOpenPositions: 1,
        activePositionCount: 1,
      }),
    });
  });

  it('blocks when account total open notional would be exceeded', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxTotalOpenNotional: 50_000,
    });
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({
        maxTotalOpenNotional: 2_000,
      })
    );
    mocks.trackedPositionFindMany.mockResolvedValue([
      activePosition({ marketValue: 1_500, costBasis: 1_400 }),
    ]);

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 600,
      extendedHours: false,
      signalType: 'entry',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Account total open notional limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'account_max_total_open_notional_exceeded',
        totalOpenNotional: 1_500,
        requestedNotional: 600,
        projectedTotalOpenNotional: 2_100,
      }),
    });
  });

  it('blocks when account symbol open notional would be exceeded', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxSymbolOpenNotional: 50_000,
    });
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({
        maxSymbolOpenNotional: 500,
      })
    );

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 600,
      extendedHours: false,
      signalType: 'entry',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Account symbol exposure limit would be exceeded for SPY.',
      details: expect.objectContaining({
        rule: 'account_max_symbol_open_notional_exceeded',
        symbol: 'SPY',
        symbolOpenNotional: 0,
        requestedNotional: 600,
        projectedSymbolOpenNotional: 600,
      }),
    });
  });

  it('blocks when account subscription open notional would be exceeded', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({
        maxSubscriptionOpenNotional: 2_000,
      })
    );
    mocks.trackedPositionFindMany.mockResolvedValue([
      activePosition({
        symbol: 'QQQ',
        subscriptionId: 22,
        marketValue: 1_500,
        costBasis: 1_400,
      }),
    ]);

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 600,
      extendedHours: false,
      signalType: 'entry',
      subscriptionId: 22,
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Account subscription exposure limit would be exceeded for 22.',
      details: expect.objectContaining({
        rule: 'account_max_subscription_open_notional_exceeded',
        subscriptionId: 22,
        subscriptionOpenNotional: 1_500,
        requestedNotional: 600,
        projectedSubscriptionOpenNotional: 2_100,
      }),
    });
  });
});
