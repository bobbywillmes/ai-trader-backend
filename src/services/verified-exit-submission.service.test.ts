import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  account: vi.fn(), localOrder: vi.fn(), updateIntent: vi.fn(), findAttention: vi.fn(), findAttentions: vi.fn(),
  recover: vi.fn(), position: vi.fn(), openOrders: vi.fn(), post: vi.fn(),
  authorize: vi.fn(), event: vi.fn(), attention: vi.fn(), lock: vi.fn(),
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
  resolveOperationalAttentionAuthoritatively: vi.fn(),
}));
vi.mock('./trading-account-workflow-lock.service.js', () => ({
  ACCOUNT_WORKFLOW_LOCK_FAMILIES: { EXIT_SUBMISSION: 'exit-submission' },
  withTradingAccountWorkflowLock: mocks.lock,
}));

import { parseExactPositiveDecimal, submitVerifiedExit } from './verified-exit-submission.service.js';

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
});
