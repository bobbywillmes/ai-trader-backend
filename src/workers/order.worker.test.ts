import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processPendingOrders } from './order.worker.js';

const mocks = vi.hoisted(() => ({
  orderIntentFindMany: vi.fn(),
  orderIntentUpdateMany: vi.fn(),
  orderIntentUpdate: vi.fn(),
  brokerOrderFindFirst: vi.fn(),
  submitOrderToBroker: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
  evaluateEntrySessionGuard: vi.fn(),
  createSystemEvent: vi.fn(),
  syncTrailingStopOrderStatus: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    orderIntent: {
      findMany: mocks.orderIntentFindMany,
      updateMany: mocks.orderIntentUpdateMany,
      update: mocks.orderIntentUpdate,
    },
    brokerOrder: {
      findFirst: mocks.brokerOrderFindFirst,
    },
  },
}));

vi.mock('../services/place-order.service.js', () => ({
  submitOrderToBroker: mocks.submitOrderToBroker,
}));

vi.mock('../services/config.service.js', () => ({
  getRuntimeTradingConfig: mocks.getRuntimeTradingConfig,
}));

vi.mock('../services/entry-session-guard.service.js', () => ({
  evaluateEntrySessionGuard: mocks.evaluateEntrySessionGuard,
  entrySessionDetailsAsJson: (decision: { details: unknown }) => decision.details,
  isEntrySessionBlocked: (decision: { allowed: boolean }) => !decision.allowed,
}));

vi.mock('../services/system-event.service.js', () => ({
  createSystemEvent: mocks.createSystemEvent,
}));

vi.mock('../services/orders.service.js', () => ({
  getNormalizedOpenOrders: vi.fn(),
}));

vi.mock('../services/position-exit-state.service.js', () => ({
  syncTrailingStopOrderStatus: mocks.syncTrailingStopOrderStatus,
}));

const baseIntent = {
  id: 101,
  source: 'api',
  symbol: 'SPY',
  side: 'buy',
  orderType: 'market',
  timeInForce: 'day',
  qty: null,
  notional: 100,
  limitPrice: null,
  extendedHours: false,
  clientOrderId: 'client-101',
  status: 'pending',
  blockReason: null,
  rawRequestJson: {
    symbol: 'SPY',
    side: 'buy',
    orderType: 'market',
    timeInForce: 'day',
    notional: 100,
    extendedHours: false,
    signalType: 'entry',
  },
  subscriptionId: null,
  subscriptionKey: null,
  trackedPositionId: null,
};

describe('order worker entry-session recheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orderIntentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.brokerOrderFindFirst.mockResolvedValue(null);
    mocks.getRuntimeTradingConfig.mockResolvedValue({});
    mocks.evaluateEntrySessionGuard.mockResolvedValue({
      allowed: true,
      degraded: false,
      details: { status: 'allowed' },
    });
    mocks.submitOrderToBroker.mockResolvedValue({
      duplicate: false,
      order: {
        id: 'broker-1',
        client_order_id: 'client-101',
        symbol: 'SPY',
        side: 'buy',
        status: 'new',
      },
    });
  });

  it('blocks an entry intent at worker-time without submitting to Alpaca', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([baseIntent]);
    mocks.evaluateEntrySessionGuard.mockResolvedValue({
      allowed: false,
      statusCode: 409,
      reason: 'Pre-close entry cutoff is active. New entries are blocked.',
      details: {
        rule: 'entry_close_buffer_active',
        status: 'close_buffer',
        evaluatedAt: '2026-06-18T19:30:00.000Z',
      },
    });

    await processPendingOrders();

    expect(mocks.submitOrderToBroker).not.toHaveBeenCalled();
    expect(mocks.orderIntentUpdate).toHaveBeenCalledWith({
      where: { id: 101 },
      data: {
        status: 'blocked',
        blockReason: 'Pre-close entry cutoff is active. New entries are blocked.',
      },
    });
    expect(mocks.createSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order_intent.blocked.entry_session',
        entityType: 'orderIntent',
        entityId: '101',
      })
    );
  });

  it('submits non-entry orders without the entry-session recheck', async () => {
    const exitIntent = {
      ...baseIntent,
      id: 102,
      side: 'sell',
      qty: 1,
      notional: null,
      rawRequestJson: {
        symbol: 'SPY',
        side: 'sell',
        orderType: 'market',
        timeInForce: 'day',
        qty: 1,
        extendedHours: false,
        signalType: 'exit',
      },
    };

    mocks.orderIntentFindMany.mockResolvedValue([exitIntent]);

    await processPendingOrders();

    expect(mocks.evaluateEntrySessionGuard).not.toHaveBeenCalled();
    expect(mocks.submitOrderToBroker).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'SPY',
        side: 'sell',
        clientOrderId: 'client-101',
      })
    );
  });
});
