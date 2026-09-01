import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  account: vi.fn(), localOrder: vi.fn(), updateIntent: vi.fn(), findAttention: vi.fn(), findAttentions: vi.fn(),
  recover: vi.fn(), position: vi.fn(), openOrders: vi.fn(), post: vi.fn(),
  authorize: vi.fn(), event: vi.fn(), attention: vi.fn(), resolveAttention: vi.fn(), lock: vi.fn(),
}));

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test', LIVE_WRITE_DEPLOYMENT_ROLE: 'OBSERVATION_ONLY' } }));
vi.mock('../db/prisma.js', () => ({ prisma: {
  tradingAccount: { findUniqueOrThrow: mocks.account },
  brokerOrder: { findFirst: mocks.localOrder },
  orderIntent: { updateMany: mocks.updateIntent },
  operationalAttention: { findUnique: mocks.findAttention, findMany: mocks.findAttentions },
} }));
vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderByClientOrderId: mocks.recover,
  getOpenAlpacaOrders: mocks.openOrders,
  submitVerifiedAlpacaExitOrder: mocks.post,
}));
vi.mock('../integrations/alpaca/positions.adapter.js', () => ({ getAlpacaPositionBySymbol: mocks.position }));
vi.mock('./live-write-approval.service.js', () => ({ authorizeLiveBrokerWrite: mocks.authorize }));
vi.mock('./system-event.service.js', () => ({ createSystemEvent: mocks.event }));
vi.mock('./operational-attention.service.js', () => ({
  OPERATIONAL_ATTENTION_CODES: {
    UNEXPECTED_SHORT_POSITION: 'UNEXPECTED_SHORT_POSITION', CONFLICTING_EXIT_RESERVATION: 'CONFLICTING_EXIT_RESERVATION',
    EXIT_QUANTITY_MISMATCH: 'EXIT_QUANTITY_MISMATCH', BROKER_EXPOSURE_UNVERIFIABLE: 'BROKER_EXPOSURE_UNVERIFIABLE',
  },
  OPERATIONAL_ATTENTION_SOURCES: { EXIT_VERIFICATION: 'EXIT_VERIFICATION' },
  openOrObserveOperationalAttention: mocks.attention,
  resolveOperationalAttentionAuthoritatively: mocks.resolveAttention,
}));
vi.mock('./trading-account-workflow-lock.service.js', () => ({
  ACCOUNT_WORKFLOW_LOCK_FAMILIES: { EXIT_SUBMISSION: 'exit-submission' },
  withTradingAccountWorkflowLock: mocks.lock,
}));

import { parseExactNonNegativeDecimal, parseExactPositiveDecimal, submitVerifiedExit } from './verified-exit-submission.service.js';

const context = {
  tradingAccountId: 7, trackedPositionId: 11, orderIntentId: 13, securityId: 17,
  symbol: 'SPY', localTrackedQty: '4.000', intendedQty: '4', clientOrderId: 'ai-exit-7-11',
  order: { type: 'market' as const, timeInForce: 'day' as const },
};
const brokerOrder = { id: 'broker-1', client_order_id: context.clientOrderId, symbol: 'SPY', side: 'sell' as const, type: 'market', time_in_force: 'day', status: 'accepted', submitted_at: '2026-08-29T00:00:00Z' };

describe('verified exit submission boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lock.mockImplementation(async ({ execute }) => ({ outcome: 'ACQUIRED_AND_COMPLETED', value: await execute(), scope: 'ai-trader:exit-submission:7' }));
    mocks.account.mockResolvedValue({ environment: 'PAPER' });
    mocks.localOrder.mockResolvedValue(null);
    mocks.recover.mockResolvedValue(null);
    mocks.position.mockResolvedValue({ asset_id: 'asset-spy', symbol: 'SPY', side: 'long', qty: '4.0000', qty_available: '4' });
    mocks.openOrders.mockResolvedValue([]);
    mocks.authorize.mockResolvedValue(undefined);
    mocks.post.mockResolvedValue(brokerOrder);
    mocks.event.mockResolvedValue({ id: 101 });
    mocks.attention.mockResolvedValue({});
    mocks.updateIntent.mockResolvedValue({ count: 1 });
    mocks.findAttention.mockResolvedValue(null);
    mocks.findAttentions.mockResolvedValue([]);
  });

  it('compares decimal quantities precisely without floating point equality', () => {
    expect(parseExactPositiveDecimal('4.000')?.canonical).toBe('4');
    expect(parseExactPositiveDecimal('0.100000000000000001')?.canonical).toBe('0.100000000000000001');
    expect(parseExactPositiveDecimal('NaN')).toBeNull();
    expect(parseExactNonNegativeDecimal('0')?.canonical).toBe('0');
    expect(parseExactNonNegativeDecimal('0.000')?.canonical).toBe('0');
    expect(parseExactNonNegativeDecimal('-1')).toBeNull();
  });

  it('recovers by stable ID before broker state inspection or POST', async () => {
    mocks.recover.mockResolvedValue(brokerOrder);
    await expect(submitVerifiedExit(context)).resolves.toMatchObject({ outcome: 'RECOVERED_BROKER' });
    expect(mocks.position).not.toHaveBeenCalled();
    expect(mocks.openOrders).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('submits one exact full-position sell_to_close after final authorization', async () => {
    await expect(submitVerifiedExit(context)).resolves.toMatchObject({ outcome: 'SUBMITTED' });
    expect(mocks.authorize).toHaveBeenCalledWith(7, 'RISK_REDUCING_WRITE');
    expect(mocks.post).toHaveBeenCalledWith(7, expect.objectContaining({
      symbol: 'SPY', side: 'sell', position_intent: 'sell_to_close', qty: '4', client_order_id: context.clientOrderId,
    }), 'position_close');
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.post.mock.invocationCallOrder[0]!);
  });

  it.each([
    ['position absent', null, [], 'POSITION_NOT_FOUND'],
    ['short position', { asset_id: 'a', symbol: 'SPY', side: 'short', qty: '4', qty_available: '4' }, [], 'UNEXPECTED_SHORT_POSITION'],
    ['held fewer', { asset_id: 'a', symbol: 'SPY', side: 'long', qty: '2', qty_available: '2' }, [], 'QUANTITY_MISMATCH'],
    ['held more', { asset_id: 'a', symbol: 'SPY', side: 'long', qty: '6', qty_available: '6' }, [], 'QUANTITY_MISMATCH'],
    ['reserved', { asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4', qty_available: '2' }, [], 'RESERVED_QUANTITY'],
    ['missing availability', { asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4' }, [], 'BROKER_STATE_UNAVAILABLE'],
    ['ambiguous availability', { asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4', qty_available: 'NaN' }, [], 'BROKER_STATE_UNAVAILABLE'],
  ])('blocks %s without POST', async (_label, position, orders, code) => {
    mocks.position.mockResolvedValue(position);
    mocks.openOrders.mockResolvedValue(orders);
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ verificationOutcome: code }) });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.attention).toHaveBeenCalledTimes(1);
  });

  it.each(['limit', 'stop', 'stop_limit', 'trailing_stop'])('blocks an unrelated active %s sell using remaining unfilled quantity', async (type) => {
    mocks.position.mockResolvedValue({ asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4', qty_available: '2' });
    mocks.openOrders.mockResolvedValue([{ ...brokerOrder, id: `other-${type}`, client_order_id: `other-${type}`, type, qty: '3', filled_qty: '1', status: 'partially_filled' }]);
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ details: expect.objectContaining({ verificationOutcome: 'CONFLICTING_OPEN_SELL_ORDER', conflictingActiveSellOrders: [expect.objectContaining({ remainingQty: '2' })] }) });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('classifies a full external limit reservation when available quantity is zero', async () => {
    mocks.position.mockResolvedValue({ asset_id: 'asset-iwm', symbol: 'IWM', side: 'long', qty: '8', qty_available: '0' });
    mocks.openOrders.mockResolvedValue([{
      ...brokerOrder, id: 'external-iwm', client_order_id: 'external-iwm', symbol: 'IWM',
      type: 'limit', qty: '8', filled_qty: '0', limit_price: '400', status: 'new',
    }]);
    const iwmContext = { ...context, symbol: 'IWM', localTrackedQty: '8', intendedQty: '8' };

    await expect(submitVerifiedExit(iwmContext)).rejects.toMatchObject({
      message: "Close blocked: IWM's 8 shares are reserved by an open $400.00 limit sell. Cancel or complete that order, then retry. No additional sell was submitted.",
      details: expect.objectContaining({
        verificationOutcome: 'CONFLICTING_OPEN_SELL_ORDER', brokerHeldQty: '8', brokerAvailableQty: '0',
        conflictingActiveSellOrders: [expect.objectContaining({ limitPrice: '400', remainingQty: '8' })],
        nextAction: expect.stringContaining('Review or cancel'),
      }),
    });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.attention).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CONFLICTING_EXIT_RESERVATION', severity: 'ERROR',
      title: 'Exit blocked by existing sell order', message: expect.stringContaining('$400.00 limit sell'),
      details: expect.objectContaining({ brokerHeldQty: '8', brokerAvailableQty: '0' }),
    }));
  });

  it('aggregates multiple active reservations and preserves type-specific evidence', async () => {
    mocks.position.mockResolvedValue({ asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4', qty_available: '1' });
    mocks.openOrders.mockResolvedValue([
      { ...brokerOrder, id: 'trail', client_order_id: 'trail', type: 'trailing_stop', qty: '2', filled_qty: '0', trail_percent: '2.5', status: 'accepted' },
      { ...brokerOrder, id: 'stop', client_order_id: 'stop', type: 'stop_limit', qty: '2', filled_qty: '1', stop_price: '490', limit_price: '489.50', status: 'partially_filled' },
    ]);
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ details: expect.objectContaining({
      verificationOutcome: 'CONFLICTING_OPEN_SELL_ORDER',
      conflictingActiveSellOrders: [
        expect.objectContaining({ type: 'trailing_stop', trailPercent: '2.5', remainingQty: '2' }),
        expect.objectContaining({ type: 'stop_limit', stopPrice: '490', limitPrice: '489.50', qty: '2', filledQty: '1', remainingQty: '1' }),
      ],
    }) });
    expect(mocks.attention).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('2 open sell orders') }));
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 'NaN', '-1'])('rejects malformed or negative available quantity %s', async (qtyAvailable) => {
    mocks.position.mockResolvedValue({ asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4', qty_available: qtyAvailable });
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ details: expect.objectContaining({ verificationOutcome: 'BROKER_STATE_UNAVAILABLE' }) });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('fails closed when available quantity exceeds held quantity', async () => {
    mocks.position.mockResolvedValue({ asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4', qty_available: '5' });
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ details: expect.objectContaining({ failureClassification: 'AVAILABLE_QUANTITY_EXCEEDS_HELD' }) });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('ignores terminal sell orders under the shared status taxonomy', async () => {
    mocks.openOrders.mockResolvedValue([{ ...brokerOrder, id: 'old', client_order_id: 'old', qty: '4', filled_qty: '0', status: 'canceled' }]);
    await submitVerifiedExit(context);
    expect(mocks.post).toHaveBeenCalledOnce();
  });

  it('fails closed on position, open-order, and lock failures', async () => {
    mocks.position.mockRejectedValueOnce(new Error('secret=redacted upstream failure'));
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ statusCode: 409 });
    mocks.position.mockResolvedValue({ asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4', qty_available: '4' });
    mocks.openOrders.mockRejectedValueOnce(new Error('orders unavailable'));
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ statusCode: 409 });
    mocks.lock.mockResolvedValueOnce({ outcome: 'NOT_ACQUIRED', scope: 'exit' });
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('refreshes an existing blocked episode without duplicate immutable events', async () => {
    mocks.position.mockResolvedValue(null);
    mocks.findAttention.mockResolvedValue({ id: 88 });
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.event).not.toHaveBeenCalled();
    expect(mocks.attention).toHaveBeenCalledOnce();
  });

  it('fails closed with a structured pre-submit result when attention refresh fails', async () => {
    mocks.position.mockResolvedValue({ asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4', qty_available: '0' });
    mocks.openOrders.mockResolvedValue([{ ...brokerOrder, id: 'external', client_order_id: 'external', type: 'limit', qty: '4', filled_qty: '0', limit_price: '500', status: 'new' }]);
    mocks.findAttention.mockResolvedValue({ id: 88 });
    mocks.attention.mockRejectedValue(new Error('active attention persistence unavailable'));

    await expect(submitVerifiedExit(context)).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('safely blocked before broker submission'),
      details: expect.objectContaining({
        verificationOutcome: 'CONFLICTING_OPEN_SELL_ORDER',
        authorizationResult: 'NOT_ATTEMPTED',
        attentionPersistenceFailed: true,
      }),
    });
    expect(mocks.updateIntent.mock.invocationCallOrder[0]).toBeLessThan(mocks.attention.mock.invocationCallOrder[0]!);
    expect(mocks.updateIntent).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'blocked' }) }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ type: 'exit.verification_attention_persistence_failed' }));
  });

  it('uses account-and-position fingerprinting and critical severity for Live conflicts', async () => {
    mocks.account.mockResolvedValue({ environment: 'LIVE' });
    mocks.position.mockResolvedValue({ asset_id: 'a', symbol: 'SPY', side: 'long', qty: '4', qty_available: '0' });
    mocks.openOrders.mockResolvedValue([{ ...brokerOrder, id: 'other', client_order_id: 'other', type: 'stop', qty: '4', filled_qty: '0', stop_price: '480', status: 'new' }]);
    await expect(submitVerifiedExit(context)).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.attention).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'CRITICAL', fingerprint: 'exit-safety:7:11:CONFLICTING_OPEN_SELL_ORDER',
    }));
  });

  it('resolves the matching active exit-verification episode after fresh successful verification', async () => {
    mocks.findAttentions.mockResolvedValue([{ id: 77, revision: 3, fingerprint: 'exit-safety:7:11:CONFLICTING_OPEN_SELL_ORDER' }]);
    await submitVerifiedExit(context);
    expect(mocks.resolveAttention).toHaveBeenCalledWith(expect.objectContaining({
      id: 77, expectedRevision: 3,
      evidence: expect.objectContaining({ brokerHeldQty: '4', brokerAvailableQty: '4' }),
    }));
  });
});
