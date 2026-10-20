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
  transitionOrderIntentStatusFrom: vi.fn(),
  recordOrderIntentRiskEvaluation: vi.fn(),
  tradingAccountFindUniqueOrThrow: vi.fn(),
  getAlpacaOrderByClientOrderId: vi.fn(),
  submitAlpacaEntryOrder: vi.fn(),
  captureBrokerOpportunity: vi.fn(),
  appendBrokerEvent: vi.fn(),
  transaction: vi.fn(),
  acquireEntryExposureClaim: vi.fn(),
  requireEntryExposureClaim: vi.fn(),
  requireExecutableEntryExposureClaim: vi.fn(),
  releaseUnsubmittedEntryExposureClaim: vi.fn(),
  prepareEntryBrokerDispatch: vi.fn(),
  authorizeDispatch: vi.fn(),
  localDispatchEvidenceCount: vi.fn(),
  claimEventCreate: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    tradingAccount: {
      findUniqueOrThrow: mocks.tradingAccountFindUniqueOrThrow,
    },
    marketPolicyBrokerDispatchConsumption: { count: mocks.localDispatchEvidenceCount },
    marketPolicyBrokerUnenforcedDispatch: { count: mocks.localDispatchEvidenceCount },
    orderIntentBrokerOpportunityEvent: { count: mocks.localDispatchEvidenceCount },
    brokerOrder: { count: mocks.localDispatchEvidenceCount },
    entryExposureClaimEvent: { create: mocks.claimEventCreate },
  },
}));

vi.mock('./market-policy-broker-dispatch.service.js', () => ({
  prepareEntryBrokerDispatch: mocks.prepareEntryBrokerDispatch,
}));

vi.mock('./entry-exposure-claim.service.js', () => ({
  acquireEntryExposureClaim: mocks.acquireEntryExposureClaim,
  requireEntryExposureClaim: mocks.requireEntryExposureClaim,
  requireExecutableEntryExposureClaim: mocks.requireExecutableEntryExposureClaim,
  releaseUnsubmittedEntryExposureClaim: mocks.releaseUnsubmittedEntryExposureClaim,
}));

vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderByClientOrderId: mocks.getAlpacaOrderByClientOrderId,
  submitAlpacaEntryOrder: mocks.submitAlpacaEntryOrder,
}));

vi.mock('./order-intent-broker-opportunity.service.js',()=>({
  bestEffortCaptureOrderIntentBrokerPostOpportunity:mocks.captureBrokerOpportunity,
  bestEffortAppendBrokerOpportunityEvent:mocks.appendBrokerEvent,
  createBrokerObservationBudget:()=>({startedAtMs:0,deadlineAtMs:250}),
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
  transitionOrderIntentStatusFrom: mocks.transitionOrderIntentStatusFrom,
  recordOrderIntentRiskEvaluation: mocks.recordOrderIntentRiskEvaluation,
}));

vi.mock('./risk-gate.service.js', () => ({
  evaluateOrderRisk: mocks.evaluateOrderRisk,
  logRiskGateBlockedOrder: mocks.logRiskGateBlockedOrder,
}));

vi.mock('./account-subscription-runtime-sizing.service.js', () => ({
  resolveRuntimeAccountSubscriptionSizing:
    mocks.resolveRuntimeAccountSubscriptionSizing,
}));

vi.mock('./assignment-entry-evaluation.service.js', () => ({
  evaluateAssignmentEntry: vi.fn(async ({ input }: { input: unknown }) => {
    const resolved = await mocks.resolveSubscriptionOrderInput(input);
    const sizing = await mocks.resolveRuntimeAccountSubscriptionSizing({
      tradingAccountSubscriptionId: resolved.tradingAccountSubscriptionId,
      tradingAccountId: resolved.tradingAccountId,
      subscriptionId: resolved.subscriptionId,
      symbol: resolved.symbol,
    });
    const { notional: _notional, ...withoutNotional } = resolved;
    const sizedInput = { ...withoutNotional, qty: sizing.qty };
    const risk = await mocks.evaluateOrderRisk(sizedInput, {
      tradingAccountId: resolved.tradingAccountId,
      requestedNotionalOverride: sizing.estimatedNotional,
    });
    const code = risk.allowed ? null : risk.details?.rule ?? 'entry_risk_blocked';
    return {
      input: sizedInput,
      sizing,
      risk,
      blockers: risk.allowed ? [] : [{ code }],
      permitsIntentCreation: risk.allowed,
      outcomeCode: risk.allowed ? 'ENTRY_ELIGIBLE' : 'ENTRY_RISK_BLOCKED',
    };
  }),
}));

vi.mock('./subscription.service.js', () => ({
  resolveSubscriptionOrderInput: mocks.resolveSubscriptionOrderInput,
}));

vi.mock('./trading-account.service.js', () => ({
  resolveDefaultTradingAccountId: mocks.resolveDefaultTradingAccountId,
}));

import { submitOrder, submitOrderToBroker } from './place-order.service.js';
import { BrokerWriteDeliveryError } from '../errors/broker-write-delivery-error.js';

class TestHttpError extends Error {
  statusCode: number;
  details: unknown;

  constructor(statusCode: number, message: string, details: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

const resolvedInput = {
  tradingAccountId: 1,
  tradingAccountSubscriptionId: 25,
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
  tradingAccountId: 1,
  tradingAccountSubscriptionId: 25,
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
    mocks.transitionOrderIntentStatusFrom.mockResolvedValue(true);
    mocks.tradingAccountFindUniqueOrThrow.mockResolvedValue({
      environment: 'PAPER',
    });
    mocks.resolveSubscriptionOrderInput.mockResolvedValue(resolvedInput);
    mocks.resolveRuntimeAccountSubscriptionSizing.mockResolvedValue({
      tradingAccountSubscriptionId: 44,
      qty: 3,
      estimatedNotional: 1500,
      snapshot: {
        tradingAccountSubscriptionId: 44,
        sizingType: 'MAX_NOTIONAL',
        calculatedQty: 3,
      },
    });
    mocks.resolveDefaultTradingAccountId.mockResolvedValue(1);
    mocks.buildClientOrderId.mockReturnValue('client-101');
    mocks.createOrderIntent.mockResolvedValue({ id: 55 });
    // No rollout row is visible, so market-policy enforcement is inactive (Phase 3C.0 admission).
    mocks.transaction.mockImplementation((callback) => callback({ $queryRaw: vi.fn(async () => []) }));
    mocks.acquireEntryExposureClaim.mockImplementation(async (args) => ({
      intent: await args.createIntent(), duplicate: false, claimId: 1,
    }));
    mocks.requireEntryExposureClaim.mockResolvedValue({ id: 1 });
    mocks.requireExecutableEntryExposureClaim.mockResolvedValue({ claim: { id: 1 }, intent: { id: 55 } });
    mocks.releaseUnsubmittedEntryExposureClaim.mockResolvedValue({ id: 1 });
    mocks.claimEventCreate.mockResolvedValue({ id: 1 });
    mocks.evaluateOrderRisk.mockResolvedValue({
      allowed: true,
      details: {},
    });
  });

  it('preflights and links entry decisions before marking an allowed intent pending', async () => {
    const result = await submitOrder(
      {
        tradingAccountSubscriptionId: 25,
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
      tradingAccountSubscriptionId: 25,
      tradingAccountId: 1,
      subscriptionId: 22,
      symbol: 'SPY',
    });
    expect(mocks.buildClientOrderId).toHaveBeenCalledWith(runtimeSizedInput, {
      tradingAccountId: 1,
      environment: 'PAPER',
    });
    expect(mocks.createOrderIntent).toHaveBeenCalledWith(
      runtimeSizedInput,
      'api',
      'client-101',
      1,
      {
        tradingAccountSubscriptionId: 44,
        accountSubscriptionSizing: {
          tradingAccountSubscriptionId: 44,
          sizingType: 'MAX_NOTIONAL',
          calculatedQty: 3,
        },
      },
      expect.anything()
    );
    expect(mocks.evaluateOrderRisk).toHaveBeenCalledWith(runtimeSizedInput, {
      tradingAccountId: 1,
      requestedNotionalOverride: 1500,
    });
    expect(mocks.linkEntryDecisionToOrderIntent).toHaveBeenCalledWith({
      decisionKey: 'decision-101',
      orderIntentId: 55,
      tradingAccountId: 1,
      tradingAccountSubscriptionId: 44,
    });
    expect(mocks.transitionOrderIntentStatusFrom).toHaveBeenCalledWith(55, 'received', 'pending');
    expect(result).toEqual({
      ok: true,
      intentId: 55,
      status: 'pending',
      entryDecisionKey: 'decision-101',
    });
  });

  it('rejects prohibited LIVE policy results before creating an intent or client order id', async () => {
    const { evaluateAssignmentEntry } = await import('./assignment-entry-evaluation.service.js');
    vi.mocked(evaluateAssignmentEntry).mockResolvedValueOnce({
      input: runtimeSizedInput,
      sizing: {
        tradingAccountSubscriptionId: 44,
        qty: 3,
        estimatedNotional: 1500,
        snapshot: { tradingAccountSubscriptionId: 44 },
      },
      risk: {
        allowed: false,
        statusCode: 403,
        reason: 'LIVE entry writes are blocked.',
        details: { rule: 'live_entry_policy_blocked' },
      },
      blockers: [{ code: 'live_entry_policy_blocked' }],
      permitsIntentCreation: false,
      outcomeCode: 'LIVE_ENTRY_POLICY_BLOCKED',
    } as never);

    await expect(submitOrder({
      tradingAccountSubscriptionId: 25,
      signalType: 'entry',
      extendedHours: false,
    })).rejects.toMatchObject({
      statusCode: 403,
      details: { rule: 'live_entry_policy_blocked' },
    });

    expect(mocks.createOrderIntent).not.toHaveBeenCalled();
    expect(mocks.buildClientOrderId).not.toHaveBeenCalled();
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
        tradingAccountSubscriptionId: 25,
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
      tradingAccountSubscriptionId: 44,
    });
    expect(mocks.transitionOrderIntentStatusFrom).toHaveBeenCalledWith(
      55, 'received',
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
      snapshot: {
        tradingAccountSubscriptionId: 44,
        sizingType: 'FIXED_QTY',
        calculatedQty: 1,
      },
    });

    await submitOrder({
      tradingAccountSubscriptionId: 25,
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

  it('passes MAX_NOTIONAL estimated notional to risk while creating a qty-only intent', async () => {
    const riskResult = {
      allowed: false as const,
      statusCode: 409,
      reason: 'Allocation per-position notional limit would be exceeded.',
      details: {
        rule: 'allocation_max_position_notional_exceeded',
        requestedNotional: 1500,
      },
    };
    mocks.evaluateOrderRisk.mockResolvedValue(riskResult);

    await expect(
    submitOrder({
      tradingAccountSubscriptionId: 25,
      subscriptionKey: 'spy_dip_core',
        signalType: 'entry',
        extendedHours: false,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Allocation per-position notional limit would be exceeded.',
      details: expect.objectContaining({
        rule: 'allocation_max_position_notional_exceeded',
      }),
    });

    expect(mocks.createOrderIntent).toHaveBeenCalledWith(
      runtimeSizedInput,
      'api',
      'client-101',
      1,
      {
        tradingAccountSubscriptionId: 44,
        accountSubscriptionSizing: {
          tradingAccountSubscriptionId: 44,
          sizingType: 'MAX_NOTIONAL',
          calculatedQty: 3,
        },
      },
      expect.anything()
    );
    expect(mocks.evaluateOrderRisk).toHaveBeenCalledWith(runtimeSizedInput, {
      tradingAccountId: 1,
      requestedNotionalOverride: 1500,
    });

    const createdInput = mocks.createOrderIntent.mock.calls[0]?.[0];

    expect(createdInput).toEqual(
      expect.objectContaining({
        qty: 3,
      })
    );
    expect(createdInput).not.toHaveProperty('notional');
  });

  it('rejects generic exit submission before creating an OrderIntent', async () => {
    const exitInput = {
      ...resolvedInput,
      side: 'sell' as const,
      signalType: 'exit' as const,
      qty: 1,
      notional: undefined,
    };
    mocks.resolveSubscriptionOrderInput.mockResolvedValue(exitInput);

    await expect(submitOrder({
      tradingAccountSubscriptionId: 25,
      subscriptionKey: 'spy_dip_core',
      signalType: 'exit',
      extendedHours: false,
    })).rejects.toThrow('verified tracked-position exit boundary');

    expect(mocks.resolveRuntimeAccountSubscriptionSizing).not.toHaveBeenCalled();
    expect(mocks.createOrderIntent).not.toHaveBeenCalled();
  });

  it.each([
    'account_subscription_missing',
    'account_subscription_disabled',
    'account_subscription_entries_disabled',
    'invalid_fixed_qty_sizing',
    'latest_price_unavailable',
    'max_notional_below_share_price',
    'min_position_notional_not_met',
  ])(
    'rejects %s before creating an order intent',
    async (runtimeSizingCode) => {
      mocks.resolveRuntimeAccountSubscriptionSizing.mockRejectedValue(
        new TestHttpError(409, runtimeSizingCode, {
          code: runtimeSizingCode,
          rule: runtimeSizingCode,
        })
      );

      await expect(
    submitOrder({
      tradingAccountSubscriptionId: 25,
      subscriptionKey: 'spy_dip_core',
          signalType: 'entry',
          extendedHours: false,
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: runtimeSizingCode,
        details: expect.objectContaining({
          code: runtimeSizingCode,
        }),
      });

      expect(mocks.createOrderIntent).not.toHaveBeenCalled();
      expect(mocks.evaluateOrderRisk).not.toHaveBeenCalled();
      expect(mocks.buildClientOrderId).not.toHaveBeenCalled();
    }
  );
});

describe('broker opportunity boundary',()=>{
  const input={...runtimeSizedInput,clientOrderId:'stable-client-101'};
  const brokerOrder={id:'alpaca-101',client_order_id:'stable-client-101',symbol:'SPY',side:'buy',status:'accepted'};
  beforeEach(()=>{vi.clearAllMocks();mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(null);mocks.captureBrokerOpportunity.mockResolvedValue({id:91});mocks.appendBrokerEvent.mockResolvedValue(true);mocks.submitAlpacaEntryOrder.mockResolvedValue(brokerOrder);mocks.localDispatchEvidenceCount.mockResolvedValue(0);mocks.authorizeDispatch.mockResolvedValue(undefined);mocks.prepareEntryBrokerDispatch.mockResolvedValue({enforcement:'NOT_APPLICABLE',applicability:'NEVER_AUTHORIZED',decisionId:null,dispatchExpiresAt:null,authorizeDispatch:mocks.authorizeDispatch});});
  it('preserves the exact payload and stable ID with observation enabled or unavailable',async()=>{const expected={symbol:'SPY',side:'buy',type:'market',time_in_force:'day',qty:'3',client_order_id:'stable-client-101'};await submitOrderToBroker(input,{tradingAccountId:1,orderIntentId:55});expect(mocks.submitAlpacaEntryOrder).toHaveBeenLastCalledWith(1,expected,expect.objectContaining({orderIntentId:55,clientOrderId:'stable-client-101'}));mocks.captureBrokerOpportunity.mockResolvedValueOnce(null);await submitOrderToBroker(input,{tradingAccountId:1,orderIntentId:55});expect(mocks.submitAlpacaEntryOrder).toHaveBeenLastCalledWith(1,expected,expect.anything());expect(mocks.submitAlpacaEntryOrder.mock.calls[0]![1]).toEqual(mocks.submitAlpacaEntryOrder.mock.calls[1]![1]);});
  it('does not capture after a successful or inconclusive lookup',async()=>{mocks.getAlpacaOrderByClientOrderId.mockResolvedValueOnce(brokerOrder);await expect(submitOrderToBroker(input,{tradingAccountId:1,orderIntentId:55})).resolves.toMatchObject({duplicate:true});expect(mocks.captureBrokerOpportunity).not.toHaveBeenCalled();const lookupError=new Error('lookup inconclusive');mocks.getAlpacaOrderByClientOrderId.mockRejectedValueOnce(lookupError);await expect(submitOrderToBroker(input,{tradingAccountId:1,orderIntentId:55})).rejects.toBe(lookupError);expect(mocks.captureBrokerOpportunity).not.toHaveBeenCalled();});
  it.each([['BROKER_REJECTED','BROKER_REJECTED'],['DELIVERY_UNCERTAIN','DELIVERY_UNCERTAIN'],['NOT_SENT_BLOCKED','DEFINITELY_NOT_SENT'],['NOT_SENT_RETRYABLE','DEFERRED']] as const)('preserves %s errors while recording %s',async(classification,eventType)=>{const error=new BrokerWriteDeliveryError({classification,message:'injected'});mocks.submitAlpacaEntryOrder.mockRejectedValueOnce(error);await expect(submitOrderToBroker(input,{tradingAccountId:1,orderIntentId:55})).rejects.toBe(error);expect(mocks.appendBrokerEvent).toHaveBeenCalledWith(expect.objectContaining({opportunityId:91,eventType}),undefined,expect.anything());});
  it('records dispatch before adapter invocation and response/materialization after success',async()=>{const order:string[]=[];mocks.appendBrokerEvent.mockImplementation(async({eventType}:{eventType:string})=>{order.push(eventType);return true;});mocks.submitAlpacaEntryOrder.mockImplementation(async()=>{order.push('POST');return brokerOrder;});await submitOrderToBroker(input,{tradingAccountId:1,orderIntentId:55});expect(order).toEqual(['ADAPTER_DISPATCH_REACHED','POST','BROKER_RESPONSE_CONFIRMED','BROKER_ORDER_MATERIALIZED']);});
  it('uses one cumulative pre-POST budget and submits unchanged when capture fails',async()=>{mocks.captureBrokerOpportunity.mockResolvedValueOnce(null);const result=await submitOrderToBroker(input,{tradingAccountId:1,orderIntentId:55});const captureBudget=mocks.captureBrokerOpportunity.mock.calls[0]![2];const dispatchBudget=mocks.appendBrokerEvent.mock.calls.find(([event])=>event.eventType==='ADAPTER_DISPATCH_REACHED')![2];expect(dispatchBudget).toBe(captureBudget);expect(result).toMatchObject({duplicate:false,order:brokerOrder});expect(mocks.submitAlpacaEntryOrder).toHaveBeenCalledWith(1,expect.objectContaining({client_order_id:'stable-client-101',qty:'3'}),expect.anything());});
  it('keeps an accepted broker result when all post-response evidence persistence fails',async()=>{mocks.appendBrokerEvent.mockResolvedValue(false);const result=await submitOrderToBroker(input,{tradingAccountId:1,orderIntentId:55});expect(result).toEqual({duplicate:false,order:brokerOrder});expect(mocks.submitAlpacaEntryOrder).toHaveBeenCalledTimes(1);const postCalls=mocks.appendBrokerEvent.mock.calls.filter(([event])=>event.eventType==='BROKER_RESPONSE_CONFIRMED'||event.eventType==='BROKER_ORDER_MATERIALIZED');expect(postCalls).toHaveLength(2);expect(postCalls[0]![2]).toBe(postCalls[1]![2]);});
});

describe('broker-time enforcement boundary (Phase 3C.3)', () => {
  const input = { ...runtimeSizedInput, clientOrderId: 'stable-client-101' };
  const brokerOrder = { id: 'alpaca-101', client_order_id: 'stable-client-101', symbol: 'SPY', side: 'buy', status: 'accepted' };
  const call = (boundary = { phase: 'UNCLASSIFIED' as string }) => submitOrderToBroker(input, { tradingAccountId: 1, orderIntentId: 55, boundary: boundary as never });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValue(null);
    mocks.captureBrokerOpportunity.mockResolvedValue({ id: 91 });
    mocks.appendBrokerEvent.mockResolvedValue(true);
    mocks.submitAlpacaEntryOrder.mockResolvedValue(brokerOrder);
    mocks.localDispatchEvidenceCount.mockResolvedValue(0);
    mocks.authorizeDispatch.mockResolvedValue(undefined);
    mocks.prepareEntryBrokerDispatch.mockResolvedValue({ enforcement: 'FROZEN_OBLIGATION', applicability: 'FROZEN_OBLIGATION', decisionId: 7, dispatchExpiresAt: new Date(), authorizeDispatch: mocks.authorizeDispatch });
  });

  it('runs the guard only after confirmed absence and consumes it as the last step before the adapter', async () => {
    const order: string[] = [];
    mocks.getAlpacaOrderByClientOrderId.mockImplementation(async () => { order.push('LOOKUP'); return null; });
    mocks.prepareEntryBrokerDispatch.mockImplementation(async () => { order.push('PREPARE'); return { enforcement: 'FROZEN_OBLIGATION', decisionId: 7, authorizeDispatch: async (id: number | null) => { order.push(`CONSUME:${id}`); } }; });
    mocks.captureBrokerOpportunity.mockImplementation(async () => { order.push('CAPTURE'); return { id: 91 }; });
    mocks.appendBrokerEvent.mockImplementation(async ({ eventType }: { eventType: string }) => { order.push(eventType); return true; });
    mocks.submitAlpacaEntryOrder.mockImplementation(async () => { order.push('POST'); return brokerOrder; });
    mocks.claimEventCreate.mockImplementation(async ({ data }: { data: { eventType: string } }) => { order.push(data.eventType); return { id: 1 }; });
    const boundary = { phase: 'UNCLASSIFIED' };
    await call(boundary);
    expect(order).toEqual(['LOOKUP', 'PREPARE', 'CAPTURE', 'CONSUME:91', 'ADAPTER_INVOCATION_STARTED', 'ADAPTER_DISPATCH_REACHED', 'POST', 'BROKER_RESPONSE_CONFIRMED', 'BROKER_ORDER_MATERIALIZED']);
    expect(mocks.claimEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ claimId: 1, eventType: 'ADAPTER_INVOCATION_STARTED', evidenceJson: expect.objectContaining({ protocol: 'ADAPTER_MARKER_V1', orderIntentId: 55, clientOrderId: 'stable-client-101' }) }) });
    expect(mocks.prepareEntryBrokerDispatch).toHaveBeenCalledWith({ orderIntentId: 55, tradingAccountId: 1, symbol: 'SPY', clientOrderId: 'stable-client-101' });
    expect(boundary.phase).toBe('BROKER_RESPONDED');
  });

  it('never POSTs when the guard refuses during preparation or at consumption, and stays NOT_DISPATCHED', async () => {
    const refusal = new Error('refused');
    mocks.prepareEntryBrokerDispatch.mockRejectedValueOnce(refusal);
    const prepared = { phase: 'UNCLASSIFIED' };
    await expect(call(prepared)).rejects.toBe(refusal);
    expect(prepared.phase).toBe('NOT_DISPATCHED');
    mocks.authorizeDispatch.mockRejectedValueOnce(refusal);
    const consumed = { phase: 'UNCLASSIFIED' };
    await expect(call(consumed)).rejects.toBe(refusal);
    expect(consumed.phase).toBe('NOT_DISPATCHED');
    expect(mocks.submitAlpacaEntryOrder).not.toHaveBeenCalled();
    expect(mocks.appendBrokerEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ADAPTER_DISPATCH_REACHED' }), undefined, expect.anything());
  });

  it('recovers an exact existing broker order without re-gating and isolates an identity mismatch', async () => {
    mocks.getAlpacaOrderByClientOrderId.mockResolvedValueOnce(brokerOrder);
    const found = { phase: 'UNCLASSIFIED' };
    await expect(call(found)).resolves.toMatchObject({ duplicate: true, order: brokerOrder });
    expect(found.phase).toBe('EXISTING_ORDER_FOUND');
    for (const mismatch of [{ symbol: 'QQQ' }, { side: 'sell' }, { client_order_id: 'other' }]) {
      mocks.getAlpacaOrderByClientOrderId.mockResolvedValueOnce({ ...brokerOrder, ...mismatch });
      const boundary = { phase: 'UNCLASSIFIED' };
      await expect(call(boundary)).rejects.toMatchObject({ statusCode: 409, details: { code: 'EXISTING_BROKER_ORDER_IDENTITY_MISMATCH' } });
      expect(boundary.phase).toBe('EXISTING_ORDER_FOUND');
    }
    expect(mocks.prepareEntryBrokerDispatch).not.toHaveBeenCalled();
    expect(mocks.submitAlpacaEntryOrder).not.toHaveBeenCalled();
  });

  it('does not treat a lookup miss as proof of absence when local dispatch evidence exists, nor a failed lookup as absence', async () => {
    mocks.localDispatchEvidenceCount.mockResolvedValueOnce(1);
    const evidence = { phase: 'UNCLASSIFIED' };
    await expect(call(evidence)).rejects.toMatchObject({ details: { code: 'PRIOR_ENTRY_DISPATCH_EVIDENCE' } });
    expect(evidence.phase).toBe('UNCLASSIFIED');
    mocks.getAlpacaOrderByClientOrderId.mockRejectedValueOnce(new Error('transient lookup failure'));
    const lookup = { phase: 'UNCLASSIFIED' };
    await expect(call(lookup)).rejects.toThrow('transient lookup failure');
    expect(lookup.phase).toBe('UNCLASSIFIED');
    expect(mocks.prepareEntryBrokerDispatch).not.toHaveBeenCalled();
    expect(mocks.submitAlpacaEntryOrder).not.toHaveBeenCalled();
  });

  it('never invokes the adapter when the adapter-invocation marker cannot be written', async () => {
    mocks.claimEventCreate.mockRejectedValueOnce(new Error('injected connection loss'));
    const boundary = { phase: 'UNCLASSIFIED' };
    await expect(call(boundary)).rejects.toThrow('injected connection loss');
    expect(boundary.phase).toBe('NOT_DISPATCHED');
    expect(mocks.submitAlpacaEntryOrder).not.toHaveBeenCalled();
  });

  it('marks dispatch started only after consumption, so an adapter failure stays delivery-uncertain', async () => {
    const error = new BrokerWriteDeliveryError({ classification: 'DELIVERY_UNCERTAIN', message: 'timeout' });
    mocks.submitAlpacaEntryOrder.mockRejectedValueOnce(error);
    const boundary = { phase: 'UNCLASSIFIED' };
    await expect(call(boundary)).rejects.toBe(error);
    expect(boundary.phase).toBe('DISPATCH_STARTED');
  });
});
