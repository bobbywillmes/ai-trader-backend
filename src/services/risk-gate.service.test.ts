import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateOrderRisk as evaluateOrderRiskService,
} from './risk-gate.service.js';
import type { ResolvedPlaceOrderInput } from '../validators/place-order.schema.js';
import type { RuntimeTradingConfig } from './config.service.js';

const mocks = vi.hoisted(() => ({
  securityFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  tradingAccountFindUnique: vi.fn(),
  tradingAccountRiskSettingsFindUnique: vi.fn(),
  tradingAccountSubscriptionFindFirst: vi.fn(),
  trackedPositionFindMany: vi.fn(),
  orderIntentFindMany: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
  getNormalizedAccount: vi.fn(),
  evaluateEntrySessionGuard: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
  getTradingAccountEntryRiskUsage: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: { findUnique: mocks.tradingAccountFindUnique },
    security: { findUnique: mocks.securityFindUnique },
    subscription: {
      findUnique: mocks.subscriptionFindUnique,
      findFirst: mocks.subscriptionFindFirst,
    },
    tradingAccountRiskSettings: {
      findUnique: mocks.tradingAccountRiskSettingsFindUnique,
    },
    tradingAccountSubscription: {
      findFirst: mocks.tradingAccountSubscriptionFindFirst,
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

vi.mock('./trading-account-entry-risk-usage.service.js', () => ({
  getTradingAccountEntryRiskUsage: mocks.getTradingAccountEntryRiskUsage,
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

function evaluateOrderRisk(
  input: ResolvedPlaceOrderInput,
  options: Parameters<typeof evaluateOrderRiskService>[1] = {}
) {
  return evaluateOrderRiskService(
    {
      subscriptionId: 22,
      tradingAccountSubscriptionId: 44,
      ...input,
    },
    { tradingAccountId: 1, ...options }
  );
}

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

function riskUsage(overrides: Record<string, unknown> = {}) {
  return {
    dailyWindow: {
      timeZone: 'America/New_York',
      date: '2026-07-15',
      start: new Date('2026-07-15T04:00:00.000Z'),
      nextStart: new Date('2026-07-16T04:00:00.000Z'),
    },
    activePositions: [],
    dailyEntryOrders: [],
    pendingEntryOrders: [],
    dailyEntryOrderCount: 0,
    dailyEntryNotional: 0,
    activePositionCount: 0,
    pendingEntryPositionCount: 0,
    currentAccountPositionSlots: 0,
    openPositionNotional: 0,
    pendingEntryNotional: 0,
    currentAccountExposure: 0,
    symbolOpenNotional: 0,
    symbolPendingEntryNotional: 0,
    currentSymbolExposure: 0,
    activeSymbols: [],
    pendingSymbols: [],
    pendingEntryNotionalBySubscriptionId: new Map(),
    ...overrides,
  };
}

function resolvedAccountSubscription() {
  return {
    id: 44,
    subscriptionId: 22,
    allocationId: 7,
    enabled: true,
    entriesEnabled: true,
    reservedNotional: 20_000,
    allocation: {
      id: 7,
      key: 'core_etf',
      name: 'Core ETF',
      enabled: true,
      maxAllocatedNotional: 100_000,
      maxOpenPositions: 20,
      maxPositionNotional: 20_000,
    },
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
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(riskUsage());
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(null);
    mocks.tradingAccountFindUnique.mockResolvedValue({
      maxDeployableNotional: 100_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue(
      resolvedAccountSubscription()
    );
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
    expect(mocks.getTradingAccountEntryRiskUsage).toHaveBeenCalledWith({
      tradingAccountId: 1,
      symbol: 'SPY',
    });
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
      reason: 'Account symbol exposure limit would be exceeded for SPY.',
      details: expect.objectContaining({
        rule: 'account_max_symbol_open_notional_exceeded',
        source: 'LEGACY_GLOBAL_FALLBACK',
        requestedNotional: 6_000,
      }),
    });
  });

  it('counts account subscription sizing snapshots for pending entry notional usage', async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({
        dailyEntryOrderCount: 1,
        dailyEntryNotional: 8_000,
        pendingEntryPositionCount: 1,
        currentAccountPositionSlots: 1,
        pendingEntryNotional: 8_000,
        currentAccountExposure: 8_000,
      })
    );

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
        current: 8_000,
        requested: 3_000,
        projected: 11_000,
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
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({ dailyEntryOrderCount: 1 })
    );

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
      reason: 'Account daily entry order limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'account_max_daily_entry_orders_exceeded',
        source: 'LEGACY_GLOBAL_FALLBACK',
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
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({ dailyEntryOrderCount: 1 })
    );

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
      reason: 'Account daily entry order limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'account_max_daily_entry_orders_exceeded',
        tradingAccountId: 1,
        source: 'ACCOUNT',
        current: 1,
        projected: 2,
        limit: 1,
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
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({
        dailyEntryOrderCount: 1,
        dailyEntryNotional: 8_000,
        pendingEntryPositionCount: 1,
        currentAccountPositionSlots: 1,
        pendingEntryNotional: 8_000,
        currentAccountExposure: 8_000,
      })
    );

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
        source: 'ACCOUNT',
        current: 8_000,
        requested: 3_000,
        projected: 11_000,
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
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({
        activePositions: [activePosition()],
        activePositionCount: 1,
        currentAccountPositionSlots: 1,
        openPositionNotional: 1_000,
        currentAccountExposure: 1_000,
        activeSymbols: ['QQQ'],
      })
    );

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
      reason: 'Account maximum position capacity would be exceeded.',
      details: expect.objectContaining({
        rule: 'account_max_open_positions_exceeded',
        limit: 1,
        activePositionCount: 1,
      }),
    });
  });

  it('counts unmaterialized pending entries against account position capacity', async () => {
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({ maxOpenPositions: 1 })
    );
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({
        pendingEntryPositionCount: 1,
        currentAccountPositionSlots: 1,
        pendingEntryNotional: 400,
        currentAccountExposure: 400,
      })
    );

    const result = await evaluateOrderRisk({
      symbol: 'SPY', side: 'buy', orderType: 'market', timeInForce: 'day',
      notional: 100, extendedHours: false, signalType: 'entry',
    });

    expect(result).toMatchObject({
      allowed: false,
      details: expect.objectContaining({
        rule: 'account_max_open_positions_exceeded',
        pendingEntryPositionCount: 1,
        projected: 2,
      }),
    });
  });

  it('includes active, pending, and proposed notional in deployable exposure', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      maxDeployableNotional: 5_000,
    });
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({
        openPositionNotional: 3_000,
        pendingEntryNotional: 1_500,
        currentAccountExposure: 4_500,
      })
    );

    const result = await evaluateOrderRisk({
      symbol: 'SPY', side: 'buy', orderType: 'market', timeInForce: 'day',
      notional: 600, extendedHours: false, signalType: 'entry',
    });

    expect(result).toMatchObject({
      allowed: false,
      details: expect.objectContaining({
        rule: 'account_max_deployable_notional_exceeded',
        openPositionNotional: 3_000,
        pendingEntryNotional: 1_500,
        requestedNotional: 600,
        projectedAccountExposure: 5_100,
        maxDeployableNotional: 5_000,
      }),
    });
  });

  it('does not enforce superseded account total open notional for normal entries', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxTotalOpenNotional: 50_000,
    });
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({
        maxTotalOpenNotional: 2_000,
      })
    );
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue(
      resolvedAccountSubscription()
    );
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({ openPositionNotional: 1_500, currentAccountExposure: 1_500 })
    );

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

    expect(result.allowed).toBe(true);
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
        openSymbolNotional: 0,
        requestedNotional: 600,
        projectedSymbolExposure: 600,
      }),
    });
  });

  it('includes pending same-symbol exposure in the effective symbol limit', async () => {
    mocks.tradingAccountRiskSettingsFindUnique.mockResolvedValue(
      accountRiskSettings({ maxSymbolOpenNotional: 1_000 })
    );
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({
        symbolOpenNotional: 200,
        symbolPendingEntryNotional: 600,
        currentSymbolExposure: 800,
        pendingEntryPositionCount: 1,
        currentAccountPositionSlots: 1,
        pendingEntryNotional: 600,
        currentAccountExposure: 600,
      })
    );

    const result = await evaluateOrderRisk({
      symbol: 'SPY', side: 'buy', orderType: 'market', timeInForce: 'day',
      notional: 300, extendedHours: false, signalType: 'entry',
    });

    expect(result).toMatchObject({
      allowed: false,
      details: expect.objectContaining({
        rule: 'account_max_symbol_open_notional_exceeded',
        source: 'ACCOUNT',
        openSymbolNotional: 200,
        pendingSymbolNotional: 600,
        projectedSymbolExposure: 1_100,
      }),
    });
  });

  it('does not enforce superseded account subscription notional for resolved subscription entries', async () => {
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
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue(
      resolvedAccountSubscription()
    );
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({ openPositionNotional: 1_500, currentAccountExposure: 1_500 })
    );

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

    expect(result.allowed).toBe(true);
  });

  it('includes assigned allocation exposure details on allowed entry risk results', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryNotional: 50_000,
      maxTotalOpenNotional: 50_000,
      maxSymbolOpenNotional: 50_000,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: true,
        maxAllocatedNotional: 5_000,
        maxOpenPositions: 3,
        maxPositionNotional: 1_500,
      },
    });
    mocks.trackedPositionFindMany.mockResolvedValue([
        activePosition({
          id: 201,
          symbol: 'QQQ',
          marketValue: 1_200,
          costBasis: 1_100,
        }),
      ]);
    mocks.orderIntentFindMany.mockResolvedValue([
        {
          id: 301,
          symbol: 'DIA',
          tradingAccountSubscriptionId: 45,
          notional: null,
          qty: 2,
          limitPrice: null,
          rawRequestJson: {
            accountSubscriptionSizing: {
              estimatedNotional: 900,
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
        qty: 3,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      {
        requestedNotionalOverride: 1_000,
      }
    );

    expect(result).toMatchObject({
      allowed: true,
      details: expect.objectContaining({
        allocationRisk: {
          tradingAccountSubscriptionId: 44,
          allocationId: 7,
          allocationKey: 'core_etf',
          allocationName: 'Core ETF',
          enabled: true,
          limits: {
            maxAllocatedNotional: 5_000,
            maxOpenPositions: 3,
            maxPositionNotional: 1_500,
          },
          requestedNotional: 1_000,
          usage: {
            activePositionCount: 1,
            activeSymbols: ['QQQ'],
            openNotional: 1_200,
            pendingEntryOrderCount: 1,
            pendingEntryNotional: 900,
            currentAllocatedNotional: 2_100,
            projectedAllocatedNotional: 3_100,
          },
        },
      }),
    });
    expect(mocks.trackedPositionFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.orderIntentFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.tradingAccountSubscriptionFindFirst).toHaveBeenCalledWith({
      where: {
        id: 44,
        tradingAccountId: 1,
        subscriptionId: 22,
      },
      select: expect.any(Object),
    });
  });

  it('skips allocation exposure details when the account subscription is unassigned', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryNotional: 50_000,
      maxTotalOpenNotional: 50_000,
      maxSymbolOpenNotional: 50_000,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: null,
      allocation: null,
    });

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 3,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      {
        requestedNotionalOverride: 1_000,
      }
    );

    expect(result).toMatchObject({
      allowed: true,
      details: expect.objectContaining({
        allocationRisk: null,
      }),
    });
    expect(mocks.trackedPositionFindMany).not.toHaveBeenCalled();
    expect(mocks.orderIntentFindMany).not.toHaveBeenCalled();
  });

  it('keeps global caps ahead of allocation checks', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryOrders: 1,
      maxDailyEntryNotional: 50_000,
      maxTotalOpenNotional: 50_000,
      maxSymbolOpenNotional: 50_000,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
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
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({ dailyEntryOrderCount: 1 })
    );
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: false,
        maxAllocatedNotional: null,
        maxOpenPositions: null,
        maxPositionNotional: null,
      },
    });

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 100,
      extendedHours: false,
      signalType: 'entry',
      subscriptionId: 22,
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Account daily entry order limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'account_max_daily_entry_orders_exceeded',
        source: 'LEGACY_GLOBAL_FALLBACK',
      }),
    });
  });

  it('keeps account caps ahead of allocation checks', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryOrders: 5,
      maxDailyEntryNotional: 50_000,
      maxTotalOpenNotional: 50_000,
      maxSymbolOpenNotional: 50_000,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
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
    mocks.getTradingAccountEntryRiskUsage.mockResolvedValue(
      riskUsage({ dailyEntryOrderCount: 1 })
    );
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: false,
        maxAllocatedNotional: null,
        maxOpenPositions: null,
        maxPositionNotional: null,
      },
    });

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      notional: 100,
      extendedHours: false,
      signalType: 'entry',
      subscriptionId: 22,
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Account daily entry order limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'account_max_daily_entry_orders_exceeded',
      }),
    });
  });

  it('blocks entries assigned to disabled allocations', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryNotional: 50_000,
      maxTotalOpenNotional: 50_000,
      maxSymbolOpenNotional: 50_000,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: false,
        maxAllocatedNotional: null,
        maxOpenPositions: null,
        maxPositionNotional: null,
      },
    });

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 3,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      {
        requestedNotionalOverride: 1_000,
      }
    );

    expect(result).toMatchObject({
      allowed: false,
      statusCode: 403,
      reason: 'Allocation bucket is disabled for new entries.',
      details: expect.objectContaining({
        rule: 'allocation_disabled',
        allocationId: 7,
        allocationKey: 'core_etf',
        allocationName: 'Core ETF',
        tradingAccountSubscriptionId: 44,
        enabled: false,
      }),
    });
  });

  it('blocks when allocation max position notional would be exceeded', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryNotional: 50_000,
      maxTotalOpenNotional: 50_000,
      maxSymbolOpenNotional: 50_000,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: true,
        maxAllocatedNotional: null,
        maxOpenPositions: null,
        maxPositionNotional: 1_000,
      },
    });

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 3,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      {
        requestedNotionalOverride: 1_200,
      }
    );

    expect(result).toMatchObject({
      allowed: false,
      statusCode: 409,
      reason: 'Allocation per-position notional limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'allocation_max_position_notional_exceeded',
        allocationId: 7,
        allocationKey: 'core_etf',
        allocationName: 'Core ETF',
        tradingAccountSubscriptionId: 44,
        limit: 1_000,
        requestedNotional: 1_200,
      }),
    });
  });

  it('blocks when allocation max open positions would be exceeded', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryNotional: 50_000,
      maxTotalOpenNotional: 50_000,
      maxSymbolOpenNotional: 50_000,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: true,
        maxAllocatedNotional: null,
        maxOpenPositions: 3,
        maxPositionNotional: null,
      },
    });
    mocks.trackedPositionFindMany.mockResolvedValue([
        activePosition({ id: 201, symbol: 'QQQ' }),
        activePosition({ id: 202, symbol: 'DIA' }),
        activePosition({ id: 203, symbol: 'IWM' }),
      ]);

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 3,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      {
        requestedNotionalOverride: 1_000,
      }
    );

    expect(result).toMatchObject({
      allowed: false,
      statusCode: 409,
      reason: 'Allocation maximum open position limit reached.',
      details: expect.objectContaining({
        rule: 'allocation_max_open_positions_exceeded',
        allocationId: 7,
        allocationKey: 'core_etf',
        allocationName: 'Core ETF',
        tradingAccountSubscriptionId: 44,
        limit: 3,
        current: 3,
        projected: 4,
        activeSymbols: ['QQQ', 'DIA', 'IWM'],
      }),
    });
  });

  it('blocks when allocation max allocated notional would be exceeded', async () => {
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      ...config,
      maxDailyEntryNotional: 50_000,
      maxTotalOpenNotional: 50_000,
      maxSymbolOpenNotional: 50_000,
      maxSubscriptionOpenNotional: 50_000,
    });
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: true,
        maxAllocatedNotional: 5_000,
        maxOpenPositions: null,
        maxPositionNotional: null,
      },
    });
    mocks.trackedPositionFindMany.mockResolvedValue([
        activePosition({
          id: 201,
          symbol: 'QQQ',
          marketValue: 3_500,
          costBasis: 3_400,
        }),
      ]);
    mocks.orderIntentFindMany.mockResolvedValue([
        {
          id: 301,
          symbol: 'DIA',
          tradingAccountSubscriptionId: 45,
          notional: 800,
          qty: null,
          limitPrice: null,
          rawRequestJson: {},
          status: 'pending',
        },
      ]);

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 3,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      {
        requestedNotionalOverride: 1_000,
      }
    );

    expect(result).toMatchObject({
      allowed: false,
      statusCode: 409,
      reason: 'Allocation allocated notional limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'allocation_max_allocated_notional_exceeded',
        allocationId: 7,
        allocationKey: 'core_etf',
        allocationName: 'Core ETF',
        tradingAccountSubscriptionId: 44,
        limit: 5_000,
        current: 4_300,
        projected: 5_300,
        requestedNotional: 1_000,
        openNotional: 3_500,
        pendingEntryNotional: 800,
      }),
    });
  });

  it('fails closed when the trading account deployable ceiling is missing', async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountFindUnique.mockResolvedValue({
      maxDeployableNotional: null,
    });

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
      qty: 1,
      extendedHours: false,
      signalType: 'entry',
      subscriptionId: 22,
    });

    expect(result).toMatchObject({
      allowed: false,
      details: { rule: 'account_max_deployable_notional_required' },
    });
  });

  it('fails closed for a legacy entry-enabled unassigned subscription', async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: null,
      enabled: true,
      entriesEnabled: true,
      reservedNotional: 1_000,
      allocation: null,
    });

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 1,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      { requestedNotionalOverride: 500 }
    );

    expect(result).toMatchObject({
      allowed: false,
      details: { rule: 'account_subscription_allocation_required' },
    });
  });

  it('fails closed when the assigned allocation limits are incomplete', async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      enabled: true,
      entriesEnabled: true,
      reservedNotional: 1_000,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: true,
        maxAllocatedNotional: 5_000,
        maxOpenPositions: null,
        maxPositionNotional: 1_500,
      },
    });

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 1,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      { requestedNotionalOverride: 500 }
    );

    expect(result).toMatchObject({
      allowed: false,
      details: { rule: 'allocation_limits_incomplete' },
    });
  });

  it('fails closed when an entry-enabled subscription has no reservation', async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      enabled: true,
      entriesEnabled: true,
      reservedNotional: null,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: true,
        maxAllocatedNotional: 5_000,
        maxOpenPositions: 3,
        maxPositionNotional: 1_500,
      },
    });

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 1,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      { requestedNotionalOverride: 500 }
    );

    expect(result).toMatchObject({
      allowed: false,
      details: { rule: 'account_subscription_reservation_required' },
    });
  });

  it('blocks FIXED_QTY proposed notional above its reservation', async () => {
    mocks.subscriptionFindFirst.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue({
      id: 44,
      subscriptionId: 22,
      allocationId: 7,
      enabled: true,
      entriesEnabled: true,
      reservedNotional: 1_000,
      allocation: {
        id: 7,
        key: 'core_etf',
        name: 'Core ETF',
        enabled: true,
        maxAllocatedNotional: 5_000,
        maxOpenPositions: 3,
        maxPositionNotional: 1_500,
      },
    });

    const result = await evaluateOrderRisk(
      {
        symbol: 'SPY',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 3,
        extendedHours: false,
        signalType: 'entry',
        subscriptionId: 22,
      },
      { requestedNotionalOverride: 1_200 }
    );

    expect(result).toMatchObject({
      allowed: false,
      reason: 'Proposed entry notional exceeds the account subscription reservation.',
      details: {
        rule: 'account_subscription_reserved_notional_exceeded',
        requestedNotional: 1_200,
        reservedNotional: 1_000,
      },
    });
  });

  it('keeps sell-side exit operations independent of entry hierarchy configuration', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue({
      maxDeployableNotional: null,
    });

    const result = await evaluateOrderRisk({
      symbol: 'SPY',
      side: 'sell',
      orderType: 'market',
      timeInForce: 'day',
      qty: 1,
      extendedHours: false,
      signalType: 'exit',
    });

    expect(result).toMatchObject({
      allowed: true,
      details: { orderType: 'non_entry' },
    });
    expect(mocks.tradingAccountFindUnique).not.toHaveBeenCalled();
  });
});
