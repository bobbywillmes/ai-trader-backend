import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateOrderRisk } from './risk-gate.service.js';
import type { RuntimeTradingConfig } from './config.service.js';

const mocks = vi.hoisted(() => ({
  securityFindUnique: vi.fn(),
  subscriptionFindUnique: vi.fn(),
  trackedPositionFindMany: vi.fn(),
  orderIntentFindMany: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
  getNormalizedAccount: vi.fn(),
  evaluateEntrySessionGuard: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    security: { findUnique: mocks.securityFindUnique },
    subscription: { findUnique: mocks.subscriptionFindUnique },
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

describe('risk gate entry session integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
