import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildClientOrderId: vi.fn(),
  createOrderIntent: vi.fn(),
  ensureEntryDecisionCanLink: vi.fn(),
  evaluateOrderRisk: vi.fn(),
  linkEntryDecisionToOrderIntent: vi.fn(),
  logRiskGateBlockedOrder: vi.fn(),
  resolveRuntimeAccountSubscriptionSizing: vi.fn(),
  resolveSubscriptionOrderInput: vi.fn(),
  resolveDefaultTradingAccountId: vi.fn(),
  updateOrderIntentStatus: vi.fn(),
}));

vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderByClientOrderId: vi.fn(),
  placeAlpacaOrder: vi.fn(),
}));

vi.mock('./adaptive-polling.service.js', () => ({
  adaptivePollingCoordinator: {
    forceAfterBrokerOrderCreated: vi.fn(),
  },
}));

vi.mock('./client-order-id.service.js', () => ({
  buildClientOrderId: mocks.buildClientOrderId,
}));

vi.mock('./entry-decision.service.js', () => ({
  ensureEntryDecisionCanLink: mocks.ensureEntryDecisionCanLink,
  linkEntryDecisionToOrderIntent: mocks.linkEntryDecisionToOrderIntent,
}));

vi.mock('./order-audit.service.js', () => ({
  createOrderIntent: mocks.createOrderIntent,
  updateOrderIntentStatus: mocks.updateOrderIntentStatus,
}));

vi.mock('./risk-gate.service.js', () => ({
  evaluateOrderRisk: mocks.evaluateOrderRisk,
  logRiskGateBlockedOrder: mocks.logRiskGateBlockedOrder,
}));

vi.mock('./account-subscription-runtime-sizing.service.js', () => ({
  resolveRuntimeAccountSubscriptionSizing:
    mocks.resolveRuntimeAccountSubscriptionSizing,
}));

vi.mock('./subscription.service.js', () => ({
  resolveSubscriptionOrderInput: mocks.resolveSubscriptionOrderInput,
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

import { submitOrder } from './place-order.service.js';

const resolvedInput = {
  subscriptionKey: 'spy_dip_core',
  subscriptionId: 22,
  symbol: 'SPY',
  side: 'buy' as const,
  signalType: 'entry' as const,
  orderType: 'market' as const,
  timeInForce: 'day' as const,
  notional: 100,
  extendedHours: false,
};

const runtimeSizedInput = {
  subscriptionKey: 'spy_dip_core',
  subscriptionId: 22,
  symbol: 'SPY',
  side: 'buy' as const,
  signalType: 'entry' as const,
  orderType: 'market' as const,
  timeInForce: 'day' as const,
  qty: 3,
  extendedHours: false,
};

describe('place order service entry decision attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSubscriptionOrderInput.mockResolvedValue(resolvedInput);
    mocks.resolveRuntimeAccountSubscriptionSizing.mockResolvedValue({
      tradingAccountSubscriptionId: 44,
      qty: 3,
      estimatedNotional: 1500,
      snapshot: {},
    });
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.buildClientOrderId.mockReturnValue('client-101');
    mocks.createOrderIntent.mockResolvedValue({ id: 55 });
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: true,
      details: {},
    });
  });

  it('preflights and links entry decisions before marking an allowed intent pending', async () => {
    const result = await submitOrder(
      {
        subscriptionKey: 'spy_dip_core',
        signalType: 'entry',
        extendedHours: false,
      },
      {
        entryDecisionKey: 'decision-101',
      }
    );

    expect(mocks.ensureEntryDecisionCanLink).toHaveBeenCalledWith(
      'decision-101'
    );
    expect(mocks.resolveRuntimeAccountSubscriptionSizing).toHaveBeenCalledWith({
      tradingAccountId: 1,
      subscriptionId: 22,
      symbol: 'SPY',
    });
    expect(mocks.buildClientOrderId).toHaveBeenCalledWith(runtimeSizedInput);
    expect(mocks.createOrderIntent).toHaveBeenCalledWith(
      runtimeSizedInput,
      'api',
      'client-101',
      1
    );
    expect(mocks.evaluateOrderRisk).toHaveBeenCalledWith(runtimeSizedInput);
    expect(mocks.linkEntryDecisionToOrderIntent).toHaveBeenCalledWith({
      decisionKey: 'decision-101',
      orderIntentId: 55,
      tradingAccountId: 1,
    });
    expect(mocks.updateOrderIntentStatus).toHaveBeenCalledWith(55, 'pending');
    expect(result).toEqual({
      ok: true,
      intentId: 55,
      status: 'pending',
      entryDecisionKey: 'decision-101',
    });
  });

  it('keeps risk-blocked intents linked to their entry decision', async () => {
    const riskResult = {
      allowed: false as const,
      statusCode: 409,
      reason: 'Daily entry order limit reached.',
      details: {
        rule: 'maxDailyEntryOrders',
      },
    };
    mocks.evaluateOrderRisk.mockResolvedValue(riskResult);

    await expect(
      submitOrder(
        {
          subscriptionKey: 'spy_dip_core',
          signalType: 'entry',
          extendedHours: false,
        },
        {
          entryDecisionKey: 'decision-101',
        }
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Daily entry order limit reached.',
    });

    expect(mocks.linkEntryDecisionToOrderIntent).toHaveBeenCalledWith({
      decisionKey: 'decision-101',
      orderIntentId: 55,
      tradingAccountId: 1,
    });
    expect(mocks.updateOrderIntentStatus).toHaveBeenCalledWith(
      55,
      'blocked',
      'Daily entry order limit reached.'
    );
    expect(mocks.logRiskGateBlockedOrder).toHaveBeenCalledWith({
      orderIntentId: 55,
      tradingAccountId: 1,
      input: runtimeSizedInput,
      result: riskResult,
    });
  });

  it('preserves current FIXED_QTY 1 behavior when runtime sizing returns one share', async () => {
    mocks.resolveRuntimeAccountSubscriptionSizing.mockResolvedValue({
      tradingAccountSubscriptionId: 44,
      qty: 1,
      estimatedNotional: null,
      snapshot: {},
    });

    await submitOrder({
      subscriptionKey: 'spy_dip_core',
      signalType: 'entry',
      extendedHours: false,
    });

    const createdInput = mocks.createOrderIntent.mock.calls[0]?.[0];

    expect(createdInput).toEqual(
      expect.objectContaining({
        qty: 1,
      })
    );
    expect(createdInput).not.toHaveProperty('notional');
  });

  it('does not apply entry runtime sizing to exit subscription orders', async () => {
    const exitInput = {
      ...resolvedInput,
      side: 'sell' as const,
      signalType: 'exit' as const,
      qty: 1,
      notional: undefined,
    };
    mocks.resolveSubscriptionOrderInput.mockResolvedValue(exitInput);

    await submitOrder({
      subscriptionKey: 'spy_dip_core',
      signalType: 'exit',
      extendedHours: false,
    });

    expect(mocks.resolveRuntimeAccountSubscriptionSizing).not.toHaveBeenCalled();
    expect(mocks.createOrderIntent).toHaveBeenCalledWith(
      exitInput,
      'api',
      'client-101',
      1
    );
  });
});
