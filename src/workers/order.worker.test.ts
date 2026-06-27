import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processPendingOrders, syncSubmittedOrders } from './order.worker.js';

const mocks = vi.hoisted(() => ({
  orderIntentFindMany: vi.fn(),
  orderIntentUpdateMany: vi.fn(),
  orderIntentUpdate: vi.fn(),
  brokerOrderFindFirst: vi.fn(),
  submitOrderToBroker: vi.fn(),
  getNormalizedOpenOrders: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
  evaluateEntrySessionGuard: vi.fn(),
  createSystemEvent: vi.fn(),
  syncTrailingStopOrderStatus: vi.fn(),
  linkEntryDecisionToBrokerOrder: vi.fn(),
  adaptiveGetDecision: vi.fn(),
  adaptiveRecordAttempt: vi.fn(),
  adaptiveRecordSuccess: vi.fn(),
  adaptiveRecordFailure: vi.fn(),
  adaptiveRecordRateLimitDeferred: vi.fn(),
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
  getNormalizedOpenOrders: mocks.getNormalizedOpenOrders,
}));

vi.mock('../services/position-exit-state.service.js', () => ({
  syncTrailingStopOrderStatus: mocks.syncTrailingStopOrderStatus,
}));

vi.mock('../services/adaptive-polling.service.js', () => ({
  adaptivePollingCoordinator: {
    getDecision: mocks.adaptiveGetDecision,
    recordAttempt: mocks.adaptiveRecordAttempt,
    recordSuccess: mocks.adaptiveRecordSuccess,
    recordFailure: mocks.adaptiveRecordFailure,
    recordRateLimitDeferred: mocks.adaptiveRecordRateLimitDeferred,
  },
}));

vi.mock('../services/entry-decision.service.js', () => ({
  linkEntryDecisionToBrokerOrder: mocks.linkEntryDecisionToBrokerOrder,
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
  tradingAccountId: 1,
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
    mocks.adaptiveGetDecision.mockResolvedValue({
      due: true,
      mode: 'market_open_active',
      effectiveIntervalMs: 10_000,
      nextDueAt: null,
      reason: 'startup_due',
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

  it('links entry decisions to newly created broker order records', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([baseIntent]);
    mocks.brokerOrderFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 501 });

    await processPendingOrders();

    expect(mocks.linkEntryDecisionToBrokerOrder).toHaveBeenCalledWith({
        orderIntentId: 101,
        brokerOrderRecordId: 501,
        tradingAccountId: 1,
      });
  });

  it('links entry decisions to existing broker order records on idempotent retries', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([baseIntent]);
    mocks.brokerOrderFindFirst.mockResolvedValue({ id: 501 });

    await processPendingOrders();

    expect(mocks.linkEntryDecisionToBrokerOrder).toHaveBeenCalledWith({
      orderIntentId: 101,
      brokerOrderRecordId: 501,
      tradingAccountId: 1,
    });
    expect(mocks.orderIntentUpdate).toHaveBeenCalledWith({
      where: { id: 101 },
      data: {
        status: 'submitted',
      },
    });
  });
});

describe('submitted order sync adaptive polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adaptiveGetDecision.mockResolvedValue({
      due: true,
      mode: 'market_open_active',
      effectiveIntervalMs: 10_000,
      nextDueAt: null,
      reason: 'startup_due',
    });
    mocks.getNormalizedOpenOrders.mockResolvedValue([]);
  });

  it('returns healthy idle without an Alpaca request when no submitted intents exist', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([]);

    const result = await syncSubmittedOrders();

    expect(result).toMatchObject({
      found: 0,
      polled: false,
      skipped: true,
      skipReason: 'no_local_submitted_orders',
    });
    expect(mocks.adaptiveGetDecision).not.toHaveBeenCalled();
    expect(mocks.getNormalizedOpenOrders).not.toHaveBeenCalled();
  });

  it('skips the Alpaca open-orders request when adaptive polling is not due', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        ...baseIntent,
        status: 'submitted',
        brokerOrders: [
          {
            id: 501,
            brokerOrderId: 'broker-501',
            clientOrderId: 'client-501',
            status: 'new',
            orderIntentId: 101,
          },
        ],
      },
    ]);
    mocks.adaptiveGetDecision.mockResolvedValue({
      due: false,
      mode: 'market_open_active',
      effectiveIntervalMs: 10_000,
      nextDueAt: new Date('2026-06-22T14:00:10.000Z'),
      reason: 'adaptive_poll_not_due',
    });

    const result = await syncSubmittedOrders();

    expect(result).toMatchObject({
      found: 1,
      polled: false,
      skipped: true,
      skipReason: 'adaptive_poll_not_due',
    });
    expect(mocks.getNormalizedOpenOrders).not.toHaveBeenCalled();
  });
});
