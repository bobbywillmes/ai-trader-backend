import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tradingAccountFindUnique: vi.fn(),
  allocationFindMany: vi.fn(),
  accountSubscriptionFindMany: vi.fn(),
  trackedPositionFindMany: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
  getTickerLatestPrice: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findUnique: mocks.tradingAccountFindUnique,
    },
    tradingAccountAllocation: {
      findMany: mocks.allocationFindMany,
    },
    tradingAccountSubscription: {
      findMany: mocks.accountSubscriptionFindMany,
    },
    trackedPosition: {
      findMany: mocks.trackedPositionFindMany,
    },
  },
}));

vi.mock('./config.service.js', () => ({
  getRuntimeTradingConfig: mocks.getRuntimeTradingConfig,
}));

vi.mock('./massive-market-data.service.js', () => ({
  getTickerLatestPrice: mocks.getTickerLatestPrice,
}));

import { getTradingAccountRiskHealth } from './trading-account-risk-health.service.js';

const NOW = new Date('2026-07-04T16:00:00.000Z');
const RECENT_SYNC = new Date('2026-07-04T15:00:00.000Z');

function accountRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    displayName: 'Bobby Paper',
    broker: 'ALPACA',
    environment: 'PAPER',
    status: 'ACTIVE',
    tradingEnabled: true,
    killSwitchEnabled: false,
    estimatedTradingCapital: 50_000,
    brokerAccountId: 'broker-account-id',
    brokerAccountStatus: 'ACTIVE',
    lastBrokerSyncAt: RECENT_SYNC,
    lastCash: 8_000,
    lastBuyingPower: 20_000,
    lastEquity: 10_000,
    lastPortfolioValue: 10_000,
    credential: {
      status: 'ACTIVE',
      verifiedAt: RECENT_SYNC,
      revokedAt: null,
    },
    riskSettings: {
      enabled: true,
      maxDailyEntryOrders: 5,
      maxDailyEntryNotional: 5_000,
      maxOpenPositions: 5,
      maxTotalOpenNotional: 10_000,
      maxSymbolOpenNotional: 3_000,
      maxSubscriptionOpenNotional: 3_000,
    },
    ...overrides,
  };
}

function allocationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    key: 'core',
    name: 'Core',
    enabled: true,
    maxAllocatedNotional: 5_000,
    maxOpenPositions: 2,
    maxPositionNotional: 2_500,
    ...overrides,
  };
}

function subscriptionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    tradingAccountId: 1,
    subscriptionId: 30,
    allocationId: 10,
    enabled: true,
    entriesEnabled: true,
    sizingType: 'MAX_NOTIONAL',
    fixedQty: null,
    maxPositionNotional: 1_500,
    minPositionNotional: null,
    maxQty: null,
    notes: null,
    allocation: allocationRecord(),
    subscription: {
      id: 30,
      key: 'dia_dip_core',
      symbol: 'DIA',
      enabled: true,
      strategy: {
        enabled: true,
      },
      exitProfile: {
        enabled: true,
      },
      security: {
        enabled: true,
      },
    },
    ...overrides,
  };
}

function fixedQtySubscriptionRecord(overrides: Record<string, unknown> = {}) {
  return subscriptionRecord({
    id: 21,
    subscriptionId: 31,
    sizingType: 'FIXED_QTY',
    fixedQty: 4,
    maxPositionNotional: null,
    subscription: {
      id: 31,
      key: 'spy_fixed',
      symbol: 'SPY',
      enabled: true,
      strategy: {
        enabled: true,
      },
      exitProfile: {
        enabled: true,
      },
      security: {
        enabled: true,
      },
    },
    ...overrides,
  });
}

function globalConfig(overrides: Record<string, unknown> = {}) {
  return {
    tradingEnabled: true,
    paperMode: true,
    killSwitchEnabled: false,
    maxDailyEntryOrders: 5,
    maxDailyEntryNotional: 10_000,
    maxOpenPositions: 5,
    maxTotalOpenNotional: 25_000,
    maxSymbolOpenNotional: 5_000,
    maxSubscriptionOpenNotional: 5_000,
    entrySessionGuardEnabled: false,
    entryStartMinutesAfterOpen: 15,
    entryCutoffMinutesBeforeClose: 30,
    failClosedOnMarketClockError: true,
    reconciliationWorkerEnabled: false,
    reconciliationWorkerIntervalMinutes: 15,
    ...overrides,
  };
}

describe('trading account risk health service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tradingAccountFindUnique.mockResolvedValue(accountRecord());
    mocks.allocationFindMany.mockResolvedValue([allocationRecord()]);
    mocks.accountSubscriptionFindMany.mockResolvedValue([subscriptionRecord()]);
    mocks.trackedPositionFindMany.mockImplementation((args) =>
      args.where.tradingAccountId === null ? Promise.resolve([]) : Promise.resolve([])
    );
    mocks.getRuntimeTradingConfig.mockResolvedValue(globalConfig());
    mocks.getTickerLatestPrice.mockResolvedValue({
      symbol: 'SPY',
      latestPrice: 100,
      latestPriceAt: '2026-07-04T15:59:00.000Z',
      latestPriceSource: 'lastTrade',
    });
  });

  it('returns null for a missing trading account', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(null);

    await expect(
      getTradingAccountRiskHealth(404, { now: NOW })
    ).resolves.toBeNull();
  });

  it('marks a paper account ready with warnings when planned budgets exceed broker portfolio value', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(
      accountRecord({
        lastPortfolioValue: 1_000,
        estimatedTradingCapital: 100_000,
      })
    );
    mocks.allocationFindMany.mockResolvedValue([
      allocationRecord({ maxAllocatedNotional: 2_000 }),
    ]);
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      subscriptionRecord({ maxPositionNotional: 1_500 }),
    ]);

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result).toMatchObject({
      status: 'READY_WITH_WARNINGS',
      readyForEntries: true,
      capital: {
        brokerPortfolioValue: 1_000,
        estimatedTradingCapital: 100_000,
        allocationBudgetTotal: 2_000,
        activeSubscriptionBudgetTotal: 1_500,
        allocationBudgetSurplus: -1_000,
        activeSubscriptionBudgetSurplus: -500,
        capitalSource: 'BROKER_PORTFOLIO_VALUE',
      },
    });
    expect(result?.warnings.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'allocation_budget_within_broker_portfolio_value',
        'active_subscription_budget_within_broker_portfolio_value',
      ])
    );
    expect(result?.blockers).toHaveLength(0);
  });

  it('blocks a live account when broker portfolio value is missing', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(
      accountRecord({
        environment: 'LIVE',
        lastPortfolioValue: null,
        lastEquity: null,
      })
    );
    mocks.getRuntimeTradingConfig.mockResolvedValue(
      globalConfig({ paperMode: false })
    );

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result).toMatchObject({
      status: 'BLOCKED',
      readyForEntries: false,
      capital: {
        brokerPortfolioValue: null,
        capitalSource: 'ESTIMATED_TRADING_CAPITAL',
      },
    });
    expect(result?.blockers.map((check) => check.id)).toContain(
      'broker_portfolio_value_available'
    );
  });

  it('blocks a live account when broker portfolio value is stale', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(
      accountRecord({
        environment: 'LIVE',
        lastBrokerSyncAt: new Date('2026-07-03T15:59:59.000Z'),
      })
    );
    mocks.getRuntimeTradingConfig.mockResolvedValue(
      globalConfig({ paperMode: false })
    );

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.blockers.map((check) => check.id)).toContain(
      'broker_portfolio_value_fresh'
    );
  });

  it('blocks a live account when an active subscription is unassigned', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(
      accountRecord({ environment: 'LIVE' })
    );
    mocks.getRuntimeTradingConfig.mockResolvedValue(
      globalConfig({ paperMode: false })
    );
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      subscriptionRecord({
        allocationId: null,
        allocation: null,
      }),
    ]);

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.blockers.map((check) => check.id)).toContain(
      'account_subscription_20_assigned'
    );
  });

  it('blocks a live account when allocation budget exceeds broker portfolio value', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(
      accountRecord({
        environment: 'LIVE',
        lastPortfolioValue: 1_000,
      })
    );
    mocks.getRuntimeTradingConfig.mockResolvedValue(
      globalConfig({ paperMode: false })
    );
    mocks.allocationFindMany.mockResolvedValue([
      allocationRecord({ maxAllocatedNotional: 1_500 }),
    ]);
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      subscriptionRecord({ maxPositionNotional: 500 }),
    ]);

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.blockers.map((check) => check.id)).toContain(
      'allocation_budget_within_broker_portfolio_value'
    );
  });

  it('blocks a live account when active subscription budget exceeds broker portfolio value', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(
      accountRecord({
        environment: 'LIVE',
        lastPortfolioValue: 1_000,
      })
    );
    mocks.getRuntimeTradingConfig.mockResolvedValue(
      globalConfig({ paperMode: false })
    );
    mocks.allocationFindMany.mockResolvedValue([
      allocationRecord({ maxAllocatedNotional: 800 }),
    ]);
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      subscriptionRecord({ maxPositionNotional: 1_500 }),
    ]);

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.blockers.map((check) => check.id)).toContain(
      'active_subscription_budget_within_broker_portfolio_value'
    );
  });

  it('blocks a live account when max simultaneous allocation exposure exceeds broker portfolio value', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(
      accountRecord({
        environment: 'LIVE',
        lastPortfolioValue: 1_000,
      })
    );
    mocks.getRuntimeTradingConfig.mockResolvedValue(
      globalConfig({ paperMode: false })
    );
    mocks.allocationFindMany.mockResolvedValue([
      allocationRecord({
        maxAllocatedNotional: 900,
        maxOpenPositions: 2,
      }),
    ]);
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      subscriptionRecord({ id: 20, maxPositionNotional: 700 }),
      subscriptionRecord({
        id: 21,
        subscriptionId: 31,
        maxPositionNotional: 600,
        subscription: {
          id: 31,
          key: 'spy_core',
          symbol: 'SPY',
          enabled: true,
          strategy: { enabled: true },
          exitProfile: { enabled: true },
          security: { enabled: true },
        },
      }),
    ]);

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.capital.maxSimultaneousAllocationExposure).toBe(1_300);
    expect(result?.blockers.map((check) => check.id)).toContain(
      'max_simultaneous_exposure_within_broker_portfolio_value'
    );
  });

  it('includes MAX_NOTIONAL subscription budgets directly', async () => {
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      subscriptionRecord({ maxPositionNotional: 2_500 }),
    ]);

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.capital.activeSubscriptionBudgetTotal).toBe(2_500);
    expect(mocks.getTickerLatestPrice).not.toHaveBeenCalled();
  });

  it('estimates FIXED_QTY subscription budgets with latest price', async () => {
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      fixedQtySubscriptionRecord({ fixedQty: 4 }),
    ]);
    mocks.getTickerLatestPrice.mockResolvedValue({
      symbol: 'SPY',
      latestPrice: 125,
      latestPriceAt: '2026-07-04T15:59:00.000Z',
      latestPriceSource: 'lastTrade',
    });

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.capital.activeSubscriptionBudgetTotal).toBe(500);
    expect(mocks.getTickerLatestPrice).toHaveBeenCalledWith('SPY');
  });

  it('blocks live FIXED_QTY subscriptions when latest price is unavailable', async () => {
    mocks.tradingAccountFindUnique.mockResolvedValue(
      accountRecord({ environment: 'LIVE' })
    );
    mocks.getRuntimeTradingConfig.mockResolvedValue(
      globalConfig({ paperMode: false })
    );
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      fixedQtySubscriptionRecord({ fixedQty: 4 }),
    ]);
    mocks.getTickerLatestPrice.mockResolvedValue({
      symbol: 'SPY',
      latestPrice: null,
      latestPriceAt: null,
      latestPriceSource: null,
    });

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.blockers.map((check) => check.id)).toContain(
      'account_subscription_21_latest_price'
    );
  });

  it('excludes disabled subscriptions from active subscription budget total', async () => {
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      subscriptionRecord({
        id: 20,
        enabled: false,
        entriesEnabled: true,
        maxPositionNotional: 9_000,
      }),
      subscriptionRecord({
        id: 21,
        subscriptionId: 31,
        enabled: true,
        entriesEnabled: false,
        maxPositionNotional: 8_000,
      }),
      subscriptionRecord({
        id: 22,
        subscriptionId: 32,
        enabled: true,
        entriesEnabled: true,
        maxPositionNotional: 1_200,
      }),
    ]);

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.capital.activeSubscriptionBudgetTotal).toBe(1_200);
  });

  it('excludes disabled allocations from allocation budget but flags active subscriptions assigned to them', async () => {
    const disabledAllocation = allocationRecord({
      id: 11,
      key: 'paused',
      enabled: false,
      maxAllocatedNotional: 50_000,
    });

    mocks.allocationFindMany.mockResolvedValue([
      allocationRecord({ id: 10, maxAllocatedNotional: 2_000 }),
      disabledAllocation,
    ]);
    mocks.accountSubscriptionFindMany.mockResolvedValue([
      subscriptionRecord({
        allocationId: 11,
        allocation: disabledAllocation,
      }),
    ]);

    const result = await getTradingAccountRiskHealth(1, { now: NOW });

    expect(result?.capital.allocationBudgetTotal).toBe(2_000);
    expect(result?.warnings.map((check) => check.id)).toContain(
      'account_subscription_20_allocation_enabled'
    );
  });
});
