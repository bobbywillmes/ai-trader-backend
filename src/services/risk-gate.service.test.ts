import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateOrderRisk } from './risk-gate.service.js';
import type { RuntimeTradingConfig } from './config.service.js';

const mocks = vi.hoisted(() => ({
  securityFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  subscriptionFindFirst: vi.fn(),
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
});
