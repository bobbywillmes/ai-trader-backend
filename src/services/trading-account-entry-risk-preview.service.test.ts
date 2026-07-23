import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../errors/http-error.js';

const mocks = vi.hoisted(() => ({
  tradingAccountFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  tradingAccountSubscriptionFindFirst: vi.fn(),
  tradingAccountSubscriptionFindMany: vi.fn(),
  trackedPositionFindMany: vi.fn(),
  orderIntentFindMany: vi.fn(),
  resolveRuntimeAccountSubscriptionSizing: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
  evaluateEntrySessionGuard: vi.fn(),
  evaluateOrderRisk: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    tradingAccount: {
      findUnique: mocks.tradingAccountFindUnique,
    },
    subscription: {
      findUnique: mocks.subscriptionFindUnique,
    },
    tradingAccountSubscription: {
      findFirst: mocks.tradingAccountSubscriptionFindFirst,
      findMany: mocks.tradingAccountSubscriptionFindMany,
    },
    trackedPosition: {
      findMany: mocks.trackedPositionFindMany,
    },
    orderIntent: {
      findMany: mocks.orderIntentFindMany,
    },
  },
}));

vi.mock('./account-subscription-runtime-sizing.service.js', () => ({
  resolveRuntimeAccountSubscriptionSizing:
    mocks.resolveRuntimeAccountSubscriptionSizing,
}));

vi.mock('./config.service.js', () => ({
  getRuntimeTradingConfig: mocks.getRuntimeTradingConfig,
}));

vi.mock('./entry-session-guard.service.js', () => ({
  evaluateEntrySessionGuard: mocks.evaluateEntrySessionGuard,
  entrySessionDetailsAsJson: (decision: { details: unknown }) => decision.details,
  isEntrySessionBlocked: (decision: { allowed: boolean }) => !decision.allowed,
}));

vi.mock('./risk-gate.service.js', () => ({
  evaluateOrderRisk: mocks.evaluateOrderRisk,
}));

import { previewTradingAccountEntryRisk } from './trading-account-entry-risk-preview.service.js';

function accountRecord() {
  return {
    id: 1,
    displayName: 'Bobby Paper',
    broker: 'ALPACA',
    environment: 'PAPER',
    status: 'ACTIVE',
  };
}

function subscriptionRecord() {
  return {
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
  };
}

function accountSubscriptionRecord(
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 40,
    tradingAccountId: 1,
    subscriptionId: 30,
    allocationId: 7,
    enabled: true,
    entriesEnabled: true,
    exitsEnabled: true,
    sizingType: 'MAX_NOTIONAL',
    fixedQty: null,
    maxPositionNotional: 1_500,
    minPositionNotional: null,
    maxQty: null,
    allocation: {
      id: 7,
      key: 'core_etf',
      name: 'Core ETF',
      enabled: true,
      maxAllocatedNotional: 10_000,
      maxOpenPositions: 3,
      maxPositionNotional: 2_000,
    },
    ...overrides,
  };
}

function sizingResult() {
  return {
    tradingAccountSubscriptionId: 40,
    qty: 3,
    estimatedNotional: 1_425,
    accountSubscription: {
      id: 40,
    },
    snapshot: {
      tradingAccountSubscriptionId: 40,
      sizingType: 'MAX_NOTIONAL',
      fixedQty: null,
      maxPositionNotional: 1_500,
      minPositionNotional: null,
      maxQty: null,
      latestPrice: 475,
      latestPriceAt: '2026-07-02T20:00:00.000Z',
      latestPriceSource: 'lastTrade',
      calculatedQty: 3,
      estimatedNotional: 1_425,
    },
  };
}

describe('trading account entry risk preview service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tradingAccountFindUnique.mockResolvedValue(accountRecord());
    mocks.subscriptionFindUnique.mockResolvedValue(subscriptionRecord());
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord()
    );
    mocks.tradingAccountSubscriptionFindMany.mockResolvedValue([
      { id: 40, subscriptionId: 30 },
      { id: 41, subscriptionId: 31 },
      { id: 42, subscriptionId: 32 },
    ]);
    mocks.trackedPositionFindMany.mockResolvedValue([]);
    mocks.orderIntentFindMany.mockResolvedValue([]);
    mocks.resolveRuntimeAccountSubscriptionSizing.mockResolvedValue(
      sizingResult()
    );
    mocks.getRuntimeTradingConfig.mockResolvedValue({
      entrySessionGuardEnabled: true,
    });
    mocks.evaluateEntrySessionGuard.mockResolvedValue({
      allowed: false,
      statusCode: 409,
      reason: 'Regular market is closed. New entries are blocked.',
      details: {
        rule: 'market_closed',
        marketOpen: false,
        status: 'market_closed',
      },
    });
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: true,
      details: {
        orderType: 'entry',
        effectiveEntryLimits: {
          tradingAccountId: 1,
          limits: {
            maxDailyEntryOrders: { value: 10, source: 'ACCOUNT' },
            maxDailyEntryNotional: {
              value: 25_000,
              source: 'LEGACY_GLOBAL_FALLBACK',
            },
          },
        },
        usage: {
          openPositionNotional: 2_000,
          pendingEntryNotional: 500,
          currentAccountExposure: 2_500,
          projectedAccountExposure: 3_925,
        },
      },
    });
  });

  it('returns an allowed dry-run preview with sizing, risk, allocation, and informational session context', async () => {
    const result = await previewTradingAccountEntryRisk(1, {
      subscriptionKey: 'dia_dip_core',
    });

    expect(result).toMatchObject({
      ok: true,
      wouldSubmitIfSessionAllowed: true,
      tradingAccount: {
        id: 1,
        displayName: 'Bobby Paper',
      },
      subscription: {
        id: 30,
        key: 'dia_dip_core',
        symbol: 'DIA',
        enabled: true,
      },
      accountSubscription: {
        id: 40,
        enabled: true,
        entriesEnabled: true,
        allocationId: 7,
        sizingType: 'MAX_NOTIONAL',
      },
      allocation: {
        id: 7,
        key: 'core_etf',
        maxOpenPositions: 3,
      },
      allocationRisk: {
        checked: true,
        ok: true,
        code: null,
        layer: 'allocation',
        details: {
          limits: {
            maxAllocatedNotional: 10_000,
            maxOpenPositions: 3,
          maxPositionNotional: 2_000,
          },
          allocationAccountSubscriptionIds: [40, 41, 42],
          allocationSubscriptionIds: [30, 31, 32],
          requestedNotional: 1_425,
          usage: {
            activePositionCount: 0,
            openNotional: 0,
            pendingEntryOrderCount: 0,
            pendingEntryNotional: 0,
            currentAllocatedNotional: 0,
            projectedAllocatedNotional: 1_425,
          },
        },
      },
      sizing: {
        ok: true,
        latestPrice: 475,
        calculatedQty: 3,
        estimatedNotional: 1_425,
      },
      risk: {
        ok: true,
      },
      effectiveEntryLimits: {
        tradingAccountId: 1,
        limits: {
          maxDailyEntryOrders: { value: 10, source: 'ACCOUNT' },
          maxDailyEntryNotional: {
            value: 25_000,
            source: 'LEGACY_GLOBAL_FALLBACK',
          },
        },
      },
      accountUsage: {
        openPositionNotional: 2_000,
        pendingEntryNotional: 500,
        projectedAccountExposure: 3_925,
      },
      blockingLayer: null,
      blockingCode: null,
      session: {
        checked: true,
        marketOpen: false,
        entryWindowOpen: false,
        wouldBlockRealEntryNow: true,
        code: 'market_closed',
      },
      wouldCreateOrderIntent: false,
      wouldSubmitBrokerOrder: false,
    });
    expect(mocks.evaluateOrderRisk).toHaveBeenCalledWith(
      {
        tradingAccountId: 1,
        tradingAccountSubscriptionId: 40,
        subscriptionKey: 'dia_dip_core',
        subscriptionId: 30,
        symbol: 'DIA',
        side: 'buy',
        orderType: 'market',
        timeInForce: 'day',
        qty: 3,
        extendedHours: false,
        signalType: 'entry',
      },
      {
        tradingAccountId: 1,
        enforceEntrySessionGuard: false,
        requestedNotionalOverride: 1_425,
      }
    );
  });

  it('keeps session blocks informational when ignoreSession defaults to true', async () => {
    await previewTradingAccountEntryRisk(1, {
      subscriptionKey: 'dia_dip_core',
    });

    expect(mocks.evaluateOrderRisk).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        enforceEntrySessionGuard: false,
      })
    );
  });

  it('reports MAX_NOTIONAL sizing failure without calling the risk gate', async () => {
    mocks.resolveRuntimeAccountSubscriptionSizing.mockRejectedValue(
      new HttpError(409, 'max_notional_below_share_price', {
        code: 'max_notional_below_share_price',
        rule: 'max_notional_below_share_price',
        latestPrice: 475,
        maxPositionNotional: 400,
      })
    );

    const result = await previewTradingAccountEntryRisk(1, {
      subscriptionKey: 'dia_dip_core',
    });

    expect(result).toMatchObject({
      ok: false,
      sizing: {
        ok: false,
        code: 'max_notional_below_share_price',
        latestPrice: 475,
        maxPositionNotional: 1_500,
      },
      risk: {
        ok: false,
        code: 'max_notional_below_share_price',
        layer: 'unknown',
      },
    });
    expect(mocks.evaluateOrderRisk).not.toHaveBeenCalled();
  });

  it('classifies disabled account subscription entries as subscription layer blockers', async () => {
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({ entriesEnabled: false })
    );
    mocks.resolveRuntimeAccountSubscriptionSizing.mockRejectedValue(
      new HttpError(403, 'account_subscription_entries_disabled', {
        code: 'account_subscription_entries_disabled',
        rule: 'account_subscription_entries_disabled',
      })
    );

    const result = await previewTradingAccountEntryRisk(1, {
      subscriptionKey: 'dia_dip_core',
    });

    expect(result).toMatchObject({
      ok: false,
      accountSubscription: {
        entriesEnabled: false,
      },
      risk: {
        ok: false,
        code: 'account_subscription_entries_disabled',
        layer: 'subscription',
      },
    });
  });

  it('classifies account risk blocks from the risk gate', async () => {
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: false,
      statusCode: 409,
      reason: 'Account maximum open position limit reached.',
      details: {
        rule: 'account_max_open_positions_exceeded',
        maxOpenPositions: 1,
        activePositionCount: 1,
      },
    });

    const result = await previewTradingAccountEntryRisk(1, {
      subscriptionKey: 'dia_dip_core',
    });

    expect(result).toMatchObject({
      ok: false,
      risk: {
        ok: false,
        code: 'account_max_open_positions_exceeded',
        layer: 'account',
        message: 'Account maximum open position limit reached.',
      },
    });
  });

  it('classifies allocation risk blocks from the risk gate', async () => {
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: false,
      statusCode: 409,
      reason: 'Allocation maximum open position limit reached.',
      details: {
        rule: 'allocation_max_open_positions_exceeded',
        allocationId: 7,
      },
    });

    const result = await previewTradingAccountEntryRisk(1, {
      subscriptionKey: 'dia_dip_core',
    });

    expect(result).toMatchObject({
      ok: false,
      risk: {
        ok: false,
        code: 'allocation_max_open_positions_exceeded',
        layer: 'allocation',
        message: 'Allocation maximum open position limit reached.',
      },
    });
  });

  it('checks parent allocation max position notional independently of the main risk result', async () => {
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({
        allocation: {
          id: 7,
          key: 'core_etf',
          name: 'Core ETF',
          enabled: true,
          maxAllocatedNotional: 10_000,
          maxOpenPositions: 3,
          maxPositionNotional: 1_000,
        },
      })
    );

    const result = await previewTradingAccountEntryRisk(1, {
      subscriptionKey: 'dia_dip_core',
    });

    expect(result).toMatchObject({
      ok: false,
      wouldSubmitIfSessionAllowed: false,
      allocationRisk: {
        checked: true,
        ok: false,
        code: 'allocation_max_position_notional_exceeded',
        layer: 'allocation',
        message: 'Allocation per-position notional limit would be exceeded.',
        details: {
          limit: 1_000,
          requestedNotional: 1_425,
        },
      },
    });
  });

  it('checks parent allocation max open positions from allocation-scoped positions', async () => {
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        id: 201,
        symbol: 'SPY',
        subscriptionId: 30,
        tradingAccountSubscriptionId: null,
        marketValue: 1_000,
        costBasis: 950,
        status: 'open',
      },
      {
        id: 202,
        symbol: 'QQQ',
        subscriptionId: 31,
        tradingAccountSubscriptionId: null,
        marketValue: 1_500,
        costBasis: 1_450,
        status: 'open',
      },
      {
        id: 203,
        symbol: 'IWM',
        subscriptionId: 32,
        tradingAccountSubscriptionId: null,
        marketValue: 900,
        costBasis: 850,
        status: 'closing',
      },
    ]);

    const result = await previewTradingAccountEntryRisk(1, {
      subscriptionKey: 'dia_dip_core',
    });

    expect(result).toMatchObject({
      ok: false,
      wouldSubmitIfSessionAllowed: false,
      allocationRisk: {
        checked: true,
        ok: false,
        code: 'allocation_max_open_positions_exceeded',
        layer: 'allocation',
        details: {
          limit: 3,
          current: 3,
          projected: 4,
          usage: {
            activePositionCount: 3,
            activeSymbols: ['SPY', 'QQQ', 'IWM'],
            openNotional: 3_400,
          },
        },
      },
    });
  });

  it('checks parent allocation max allocated notional from open and pending exposure', async () => {
    mocks.tradingAccountSubscriptionFindFirst.mockResolvedValue(
      accountSubscriptionRecord({
        allocation: {
          id: 7,
          key: 'core_etf',
          name: 'Core ETF',
          enabled: true,
          maxAllocatedNotional: 2_500,
          maxOpenPositions: null,
          maxPositionNotional: 2_000,
        },
      })
    );
    mocks.trackedPositionFindMany.mockResolvedValue([
      {
        id: 201,
        symbol: 'SPY',
        subscriptionId: 30,
        tradingAccountSubscriptionId: null,
        marketValue: 800,
        costBasis: 750,
        status: 'open',
      },
    ]);
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        id: 301,
        symbol: 'QQQ',
        subscriptionId: 31,
        tradingAccountSubscriptionId: null,
        notional: null,
        qty: null,
        limitPrice: null,
        rawRequestJson: {
          accountSubscriptionSizing: {
            estimatedNotional: 500,
          },
        },
        status: 'pending',
      },
    ]);

    const result = await previewTradingAccountEntryRisk(1, {
      subscriptionKey: 'dia_dip_core',
    });

    expect(result).toMatchObject({
      ok: false,
      wouldSubmitIfSessionAllowed: false,
      allocationRisk: {
        checked: true,
        ok: false,
        code: 'allocation_max_allocated_notional_exceeded',
        layer: 'allocation',
        details: {
          limit: 2_500,
          current: 1_300,
          projected: 2_725,
          usage: {
            openNotional: 800,
            pendingEntryNotional: 500,
            currentAllocatedNotional: 1_300,
            projectedAllocatedNotional: 2_725,
          },
        },
      },
    });
  });
});
