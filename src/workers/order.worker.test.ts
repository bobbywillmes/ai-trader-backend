import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  processPendingOrders,
  processPendingOrdersForAccount,
  recoverStaleSubmittingIntentsForAccount,
  syncSubmittedOrders,
  syncSubmittedOrdersAcrossAccounts,
} from './order.worker.js';
import { assertAccountCoordinatorHealthy } from '../services/worker-coordinator-result.service.js';

const mocks = vi.hoisted(() => ({
  orderIntentFindMany: vi.fn(),
  orderIntentUpdateMany: vi.fn(),
  orderIntentUpdate: vi.fn(),
  brokerOrderFindFirst: vi.fn(),
  brokerOrderUpdateMany: vi.fn(),
  brokerOrderCreate: vi.fn(),
  securityFindUniqueOrThrow: vi.fn(),
  prismaTransaction: vi.fn(),
  getAlpacaOrderByClientOrderId: vi.fn(),
  submitOrderToBroker: vi.fn(),
  getNormalizedOpenOrders: vi.fn(),
  getRuntimeTradingConfig: vi.fn(),
  evaluateEntrySessionGuard: vi.fn(),
  evaluateOrderRisk: vi.fn(),
  logRiskGateBlockedOrder: vi.fn(),
  createSystemEvent: vi.fn(),
  syncTrailingStopOrderStatus: vi.fn(),
  linkEntryDecisionToBrokerOrder: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
  adaptiveGetDecision: vi.fn(),
  adaptiveRecordAttempt: vi.fn(),
  adaptiveRecordSuccess: vi.fn(),
  adaptiveRecordFailure: vi.fn(),
  adaptiveRecordRateLimitDeferred: vi.fn(),
  recordOrderIntentRiskEvaluation: vi.fn(),
  resolveSubscriptionOrderInput: vi.fn(),
  enumerateLifecycleAccounts: vi.fn(),
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
      updateMany: mocks.brokerOrderUpdateMany,
      create: mocks.brokerOrderCreate,
    },
    security: { findUniqueOrThrow: mocks.securityFindUniqueOrThrow },
    $transaction: mocks.prismaTransaction,
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

vi.mock('../services/risk-gate.service.js', () => ({
  evaluateOrderRisk: mocks.evaluateOrderRisk,
  logRiskGateBlockedOrder: mocks.logRiskGateBlockedOrder,
}));

vi.mock('../services/order-audit.service.js', () => ({
  recordOrderIntentRiskEvaluation: mocks.recordOrderIntentRiskEvaluation,
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

vi.mock('../services/trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

vi.mock('../services/subscription.service.js', () => ({
  resolveSubscriptionOrderInput: mocks.resolveSubscriptionOrderInput,
}));

vi.mock('../services/lifecycle-account-eligibility.service.js', () => ({
  enumerateLifecycleAccounts: mocks.enumerateLifecycleAccounts,
}));

vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderByClientOrderId: mocks.getAlpacaOrderByClientOrderId,
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
    tradingAccountSubscriptionId: 44,
    subscriptionKey: 'spy_dip_core',
    signalType: 'entry',
  },
  subscriptionId: 22,
  subscriptionKey: 'spy_dip_core',
  trackedPositionId: null,
  tradingAccountId: 1,
  tradingAccountSubscriptionId: 44,
};

describe('order worker entry-session recheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.enumerateLifecycleAccounts.mockResolvedValue([]);
    mocks.resolveSubscriptionOrderInput.mockResolvedValue({
      tradingAccountId: 1,
      tradingAccountSubscriptionId: 44,
    });
    mocks.orderIntentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.brokerOrderFindFirst.mockResolvedValue(null);
    mocks.getRuntimeTradingConfig.mockResolvedValue({});
    mocks.evaluateEntrySessionGuard.mockResolvedValue({
      allowed: true,
      degraded: false,
      details: { status: 'allowed' },
    });
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: true,
      details: { orderType: 'entry' },
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
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: false,
      statusCode: 409,
      reason: 'Pre-close entry cutoff is active. New entries are blocked.',
      details: {
        rule: 'entry_close_buffer_active',
        status: 'close_buffer',
        evaluatedAt: '2026-06-18T19:30:00.000Z',
      },
    });

    await processPendingOrdersForAccount(1);

    expect(mocks.orderIntentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'pending',
          tradingAccountId: 1,
        }),
      })
    );
    expect(mocks.submitOrderToBroker).not.toHaveBeenCalled();
    expect(mocks.orderIntentUpdate).toHaveBeenCalledWith({
      where: { id: 101 },
      data: {
        status: 'blocked',
        blockReason: 'Pre-close entry cutoff is active. New entries are blocked.',
      },
    });
    expect(mocks.logRiskGateBlockedOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderIntentId: 101,
        tradingAccountId: 1,
        result: expect.objectContaining({
          details: expect.objectContaining({ rule: 'entry_close_buffer_active' }),
        }),
      })
    );
    expect(mocks.evaluateOrderRisk).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'SPY', side: 'buy' }),
      expect.objectContaining({
        tradingAccountId: 1,
        excludeOrderIntentId: 101,
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
        tradingAccountSubscriptionId: 44,
        subscriptionKey: 'spy_dip_core',
        signalType: 'exit',
      },
    };

    mocks.orderIntentFindMany.mockResolvedValue([exitIntent]);

    await processPendingOrdersForAccount(1);

    expect(mocks.evaluateOrderRisk).not.toHaveBeenCalled();
    expect(mocks.submitOrderToBroker).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'SPY',
        side: 'sell',
        clientOrderId: 'client-101',
      }),
      {
        tradingAccountId: 1,
      }
    );
  });

  it('links entry decisions to newly created broker order records', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([baseIntent]);
    mocks.brokerOrderFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 501 });

    await processPendingOrdersForAccount(1);

    expect(mocks.linkEntryDecisionToBrokerOrder).toHaveBeenCalledWith({
        orderIntentId: 101,
        brokerOrderRecordId: 501,
        tradingAccountId: 1,
      });
  });

  it('links entry decisions to existing broker order records on idempotent retries', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([baseIntent]);
    mocks.brokerOrderFindFirst.mockResolvedValue({ id: 501 });

    await processPendingOrdersForAccount(1);

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
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.adaptiveGetDecision.mockResolvedValue({
      due: true,
      mode: 'market_open_active',
      effectiveIntervalMs: 10_000,
      nextDueAt: null,
      reason: 'startup_due',
    });
    mocks.getNormalizedOpenOrders.mockResolvedValue([]);
    mocks.brokerOrderUpdateMany.mockResolvedValue({ count: 1 });
    mocks.orderIntentUpdate.mockResolvedValue({});
    mocks.createSystemEvent.mockResolvedValue({});
    mocks.syncTrailingStopOrderStatus.mockResolvedValue({ count: 1 });
  });

  it('returns healthy idle without an Alpaca request when no submitted intents exist', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([]);

    const result = await syncSubmittedOrders();

    expect(mocks.orderIntentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'submitted',
          tradingAccountId: 1,
        },
      })
    );
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

  it('passes the submitted-order account to trailing status synchronization', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        ...baseIntent,
        tradingAccountId: 2,
        status: 'submitted',
        brokerOrders: [
          {
            id: 501,
            tradingAccountId: 2,
            brokerOrderId: 'shared-broker-order',
            clientOrderId: 'shared-client-order',
            status: 'new',
            orderIntentId: 101,
            symbol: 'SPY',
            side: 'sell',
          },
        ],
      },
    ]);
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(2);
    mocks.getNormalizedOpenOrders.mockResolvedValue([
      {
        id: 'shared-broker-order',
        clientOrderId: 'shared-client-order',
        symbol: 'SPY',
        side: 'sell',
        status: 'accepted',
      },
    ]);

    const result = await syncSubmittedOrders();

    expect(mocks.syncTrailingStopOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        tradingAccountId: 2,
        clientOrderId: 'shared-client-order',
        brokerOrderId: 'shared-broker-order',
        orderStatus: 'accepted',
      })
    );
    expect(result).toMatchObject({ synced: 1, polled: true });
  });
});

describe('pending order multi-account coordinator', () => {
  function pendingAccount(
    id: number,
    overrides: Record<string, unknown> = {}
  ) {
    return {
      tradingAccountId: id,
      displayName: `Account ${id}`,
      broker: 'ALPACA',
      environment: id === 1 ? 'PAPER' : 'LIVE',
      status: 'ACTIVE',
      credentialStatus: 'ACTIVE',
      eligible: true,
      reason: 'usable_credentials_with_work',
      exposureSummary: {
        pendingIntents: 1,
        submittingIntents: 0,
        submittedIntents: 0,
        nonterminalOrders: 0,
        activePositions: 0,
        unresolvedActivities: 0,
        hasLifecycleWork: true,
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orderIntentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.resolveSubscriptionOrderInput.mockResolvedValue({
      tradingAccountId: 1,
      tradingAccountSubscriptionId: 44,
    });
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: true,
      details: { orderType: 'entry' },
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
    mocks.brokerOrderFindFirst.mockResolvedValue({ id: 501 });
  });

  it('applies the pending batch independently in stable account order', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      pendingAccount(1),
      pendingAccount(2),
    ]);
    mocks.orderIntentFindMany.mockResolvedValue([]);

    const result = await processPendingOrders();

    expect(
      mocks.orderIntentFindMany.mock.calls.map((call) => ({
        account: call[0].where.tradingAccountId,
        take: call[0].take,
      }))
    ).toEqual([
      { account: 1, take: 5 },
      { account: 2, take: 5 },
    ]);
    expect(result.processedAccounts).toBe(2);
  });

  it('continues to a later account after an account query failure', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      pendingAccount(1),
      pendingAccount(2),
    ]);
    mocks.orderIntentFindMany
      .mockRejectedValueOnce(new Error('Paper queue failure'))
      .mockResolvedValueOnce([]);

    const result = await processPendingOrders();

    expect(result.results.map((item) => item.outcome)).toEqual([
      'FAILED',
      'PROCESSED',
    ]);
    expect(mocks.orderIntentFindMany).toHaveBeenCalledTimes(2);
  });

  it('leaves credentialless pending work unclaimed and makes no broker call', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      pendingAccount(2, {
        eligible: false,
        credentialStatus: null,
        reason: 'credentials_unavailable_with_exposure',
      }),
    ]);

    const result = await processPendingOrders();

    expect(result.credentialUnavailableAccounts).toBe(1);
    expect(mocks.orderIntentFindMany).not.toHaveBeenCalled();
    expect(mocks.orderIntentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.submitOrderToBroker).not.toHaveBeenCalled();
  });

  it('reports an account and worker tick failed when all pending intents fail', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([pendingAccount(1)]);
    mocks.orderIntentFindMany.mockResolvedValue([
      { ...baseIntent, rawRequestJson: { invalid: true } },
    ]);

    const result = await processPendingOrders();

    expect(result.results[0]).toMatchObject({
      outcome: 'FAILED',
      result: { found: 1, claimed: 1, submitted: 0, blocked: 0, failed: 1 },
    });
    expect(() =>
      assertAccountCoordinatorHealthy('pending_submission', result.results)
    ).toThrow(/pending_submission completed with account failures/);
  });

  it('finishes successful work in the same account but reports a mixed run failed', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([pendingAccount(1)]);
    mocks.orderIntentFindMany.mockResolvedValue([
      { ...baseIntent, rawRequestJson: { invalid: true } },
      { ...baseIntent, id: 102, clientOrderId: 'client-102' },
    ]);

    const result = await processPendingOrders();

    expect(result.results[0]).toMatchObject({
      outcome: 'FAILED',
      result: { found: 2, claimed: 2, submitted: 1, blocked: 0, failed: 1 },
    });
    expect(mocks.submitOrderToBroker).toHaveBeenCalledTimes(1);
  });

  it('treats risk-blocked intents as healthy domain outcomes', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([pendingAccount(1)]);
    mocks.orderIntentFindMany.mockResolvedValue([baseIntent]);
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: false,
      reason: 'Risk limit reached.',
      details: { rule: 'risk_limit' },
    });

    const result = await processPendingOrders();

    expect(result.results[0]).toMatchObject({
      outcome: 'PROCESSED',
      result: { found: 1, claimed: 1, submitted: 0, blocked: 1, failed: 0 },
    });
    expect(() =>
      assertAccountCoordinatorHealthy('pending_submission', result.results)
    ).not.toThrow();
  });

  it('continues to the next account after an item failure', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      pendingAccount(1),
      pendingAccount(2),
    ]);
    mocks.orderIntentFindMany
      .mockResolvedValueOnce([
        { ...baseIntent, rawRequestJson: { invalid: true } },
      ])
      .mockResolvedValueOnce([
        {
          ...baseIntent,
          id: 202,
          tradingAccountId: 2,
          tradingAccountSubscriptionId: 55,
          clientOrderId: 'client-202',
        },
      ]);
    mocks.resolveSubscriptionOrderInput.mockResolvedValue({
      tradingAccountId: 2,
      tradingAccountSubscriptionId: 55,
    });

    const result = await processPendingOrders();

    expect(result.results.map((item) => item.outcome)).toEqual([
      'FAILED',
      'PROCESSED',
    ]);
    expect(mocks.orderIntentFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.submitOrderToBroker).toHaveBeenCalledTimes(1);
  });
});

describe('submitted order multi-account coordinator', () => {
  const eligibleAccount = (id: number, environment: 'PAPER' | 'LIVE') => ({
    tradingAccountId: id,
    displayName: `Account ${id}`,
    broker: 'ALPACA',
    environment,
    status: 'PAUSED',
    credentialStatus: 'ACTIVE',
    eligible: true,
    reason: 'usable_credentials_with_work',
    exposureSummary: {
      pendingIntents: 0,
      submittingIntents: 0,
      submittedIntents: 1,
      nonterminalOrders: 1,
      activePositions: 0,
      unresolvedActivities: 0,
      hasLifecycleWork: true,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adaptiveGetDecision.mockResolvedValue({
      due: true,
      mode: 'market_open_active',
      effectiveIntervalMs: 10_000,
      nextDueAt: null,
      reason: 'startup_due',
    });
    mocks.orderIntentFindMany.mockResolvedValue([]);
  });

  it('processes eligible accounts sequentially in enumerated ID order', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      eligibleAccount(1, 'PAPER'),
      eligibleAccount(2, 'LIVE'),
    ]);

    const result = await syncSubmittedOrdersAcrossAccounts();

    expect(
      mocks.orderIntentFindMany.mock.calls.map(
        (call) => call[0].where.tradingAccountId
      )
    ).toEqual([1, 2]);
    expect(result.results.map((item) => item.account.tradingAccountId)).toEqual([
      1, 2,
    ]);
  });

  it('does not let the first account failure stop the second account', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      eligibleAccount(1, 'PAPER'),
      eligibleAccount(2, 'LIVE'),
    ]);
    mocks.orderIntentFindMany
      .mockRejectedValueOnce(new Error('Paper unavailable'))
      .mockResolvedValueOnce([]);

    const result = await syncSubmittedOrdersAcrossAccounts();

    expect(result.results.map((item) => item.outcome)).toEqual([
      'FAILED',
      'SKIPPED',
    ]);
    expect(mocks.orderIntentFindMany).toHaveBeenCalledTimes(2);
  });

  it('skips dormant credentials and reports credentialless exposure', async () => {
    const dormant = {
      ...eligibleAccount(1, 'PAPER'),
      eligible: false,
      credentialStatus: null,
      reason: 'credentials_unavailable_dormant',
      exposureSummary: {
        ...eligibleAccount(1, 'PAPER').exposureSummary,
        submittedIntents: 0,
        nonterminalOrders: 0,
        hasLifecycleWork: false,
      },
    };
    const exposed = {
      ...eligibleAccount(2, 'LIVE'),
      eligible: false,
      credentialStatus: null,
      reason: 'credentials_unavailable_with_exposure',
    };
    mocks.enumerateLifecycleAccounts.mockResolvedValue([dormant, exposed]);

    const result = await syncSubmittedOrdersAcrossAccounts();

    expect(result.results.map((item) => item.outcome)).toEqual([
      'SKIPPED',
      'CREDENTIALS_UNAVAILABLE',
    ]);
    expect(mocks.getNormalizedOpenOrders).not.toHaveBeenCalled();
  });

  it('surfaces an item sync exception in account and coordinator health', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      eligibleAccount(1, 'PAPER'),
    ]);
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        ...baseIntent,
        status: 'submitted',
        brokerOrders: [{
          id: 501,
          tradingAccountId: 1,
          brokerOrderId: 'broker-501',
          clientOrderId: 'client-501',
          status: 'new',
          orderIntentId: 101,
          symbol: 'SPY',
          side: 'buy',
        }],
      },
    ]);
    mocks.getNormalizedOpenOrders.mockResolvedValue([{
      id: 'broker-501',
      clientOrderId: 'client-501',
      symbol: 'SPY',
      side: 'buy',
      status: 'accepted',
    }]);
    mocks.syncTrailingStopOrderStatus.mockRejectedValue(
      new Error('Trailing status write failed')
    );

    const result = await syncSubmittedOrdersAcrossAccounts();

    expect(result.results[0]).toMatchObject({
      outcome: 'FAILED',
      result: {
        found: 1,
        failed: 1,
        failures: [{
          orderIntentId: 101,
          brokerOrderRecordId: 501,
          error: 'Trailing status write failed',
        }],
      },
    });
    expect(mocks.adaptiveRecordFailure).toHaveBeenCalledWith(
      'submitted_order_sync',
      1,
      expect.any(Date)
    );
    expect(mocks.adaptiveRecordSuccess).not.toHaveBeenCalled();
    expect(() =>
      assertAccountCoordinatorHealthy('submitted_order_sync', result.results)
    ).toThrow(/submitted_order_sync completed with account failures/);
  });

  it('does not treat an order absent from open broker results as a failure', async () => {
    mocks.enumerateLifecycleAccounts.mockResolvedValue([
      eligibleAccount(1, 'PAPER'),
    ]);
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        ...baseIntent,
        status: 'submitted',
        brokerOrders: [{
          id: 501,
          tradingAccountId: 1,
          brokerOrderId: 'broker-501',
          clientOrderId: 'client-501',
          status: 'new',
          orderIntentId: 101,
          symbol: 'SPY',
          side: 'buy',
        }],
      },
    ]);
    mocks.getNormalizedOpenOrders.mockResolvedValue([]);

    const result = await syncSubmittedOrdersAcrossAccounts();

    expect(result.results[0]).toMatchObject({
      outcome: 'PROCESSED',
      result: { found: 1, synced: 0, failed: 0, failures: [] },
    });
    expect(mocks.adaptiveRecordSuccess).toHaveBeenCalled();
    expect(mocks.adaptiveRecordFailure).not.toHaveBeenCalled();
    expect(() =>
      assertAccountCoordinatorHealthy('submitted_order_sync', result.results)
    ).not.toThrow();
  });
});

describe('stale submitting intent recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orderIntentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.createSystemEvent.mockResolvedValue({});
    mocks.securityFindUniqueOrThrow.mockResolvedValue({ id: 9 });
    mocks.prismaTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          brokerOrder: {
            findFirst: mocks.brokerOrderFindFirst,
            create: mocks.brokerOrderCreate,
          },
          orderIntent: { updateMany: mocks.orderIntentUpdateMany },
        })
    );
  });

  it('materializes a broker order created before local persistence', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        ...baseIntent,
        status: 'submitting',
        brokerOrders: [],
        updatedAt: new Date('2026-06-22T13:00:00.000Z'),
      },
    ]);
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue({
      id: 'broker-recovered',
      client_order_id: 'client-101',
      symbol: 'SPY',
      side: 'buy',
      status: 'accepted',
    });
    mocks.brokerOrderFindFirst.mockResolvedValue(null);

    const result = await recoverStaleSubmittingIntentsForAccount(
      1,
      new Date('2026-06-22T14:00:00.000Z')
    );

    expect(mocks.getAlpacaOrderByClientOrderId).toHaveBeenCalledWith(
      1,
      'client-101',
      'pending_order_idempotency_check'
    );
    expect(mocks.brokerOrderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tradingAccountId: 1,
          brokerOrderId: 'broker-recovered',
        }),
      })
    );
    expect(result).toMatchObject({ linked: 1, retryable: 0 });
  });

  it('requeues an entry only after account-specific broker lookup confirms absence', async () => {
    mocks.orderIntentFindMany.mockResolvedValue([
      {
        ...baseIntent,
        status: 'submitting',
        brokerOrders: [],
        updatedAt: new Date('2026-06-22T13:00:00.000Z'),
      },
    ]);
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(null);

    const result = await recoverStaleSubmittingIntentsForAccount(
      1,
      new Date('2026-06-22T14:00:00.000Z')
    );

    expect(mocks.orderIntentUpdateMany).toHaveBeenCalledWith({
      where: { id: 101, status: 'submitting' },
      data: {
        status: 'pending',
        blockReason:
          'Recovered stale submitting intent after broker lookup found no order.',
      },
    });
    expect(result).toMatchObject({ linked: 0, retryable: 1 });
  });
});
