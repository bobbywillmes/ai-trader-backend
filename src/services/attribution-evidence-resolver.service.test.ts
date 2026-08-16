import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activityFindMany: vi.fn(), assignmentFindMany: vi.fn(), assignmentFindUnique: vi.fn(),
  getOrder: vi.fn(),
}));
vi.mock('../db/prisma.js', () => ({ prisma: {
  brokerActivity: { findMany: mocks.activityFindMany },
  tradingAccountSubscription: { findMany: mocks.assignmentFindMany, findUnique: mocks.assignmentFindUnique },
} }));
vi.mock('../integrations/alpaca/orders.adapter.js', () => ({ getAlpacaOrderById: mocks.getOrder }));

import { resolveExactBrokerOrderAttribution } from './attribution-evidence-resolver.service.js';

const orderId = '17ab373f-cf57-43bc-a30c-d320a099c656';
const clientOrderId = 'ai-entry-tas4-fc7fee7e1652deb4f9d502c49f99baaaaadec24f3b3112f504977ca594b85e92';
const args = { tradingAccountId: 1, broker: 'alpaca', symbol: 'AAPL', side: 'long', qty: 3, avgEntryPrice: 303.18, openedAt: new Date('2026-08-12T13:48:30.321Z'), mode: 'paper', policy: 'ALLOW_EXACT_ORDER_ID_READ' as const };
function activity(id: number, qty: number, overrides: Record<string, unknown> = {}) { return { id, activityId: `activity-${id}`, orderId, qty, price: 303.18, transactionTime: new Date('2026-08-12T13:48:24Z'), brokerOrderRecordId: null, trackedPositionId: null, ...overrides }; }
function assignment(overrides: Record<string, unknown> = {}) { return { id: 4, tradingAccountId: 1, subscriptionId: 38, enabled: true, exitsEnabled: true, subscription: { id: 38, key: 'aapl_dip_core', symbol: 'AAPL', enabled: true, exitProfileId: 8, security: { symbol: 'AAPL' }, strategy: { enabled: true }, exitProfile: { key: 'exit_stock_dip_core_target', enabled: true } }, ...overrides }; }

describe('exact broker-order attribution evidence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activityFindMany.mockResolvedValue([activity(214, 2), activity(215, 1)]);
    mocks.assignmentFindMany.mockResolvedValue([
      { id: 4, subscriptionId: 38, subscription: { key: 'aapl_dip_core', exitProfile: { key: 'exit_stock_dip_core_target' } } },
      { id: 6, subscriptionId: 42, subscription: { key: 'aapl_momentum_core', exitProfile: { key: 'exit_stock_momentum_trailing' } } },
    ]);
    mocks.assignmentFindUnique.mockResolvedValue(assignment());
    mocks.getOrder.mockResolvedValue({ id: orderId, client_order_id: clientOrderId, symbol: 'AAPL', side: 'buy' });
  });

  it('classifies the position 73 partial-fill evidence as deterministic and rejects TAS 6', async () => {
    const result = await resolveExactBrokerOrderAttribution(args);
    expect(result).toMatchObject({ confidence: 'DETERMINISTIC', brokerOrderId: orderId, clientOrderId, fillQty: 3, weightedAveragePrice: 303.18, assignment: { id: 4, subscriptionId: 38, exitProfileId: 8 }, rejectedAlternatives: [{ assignmentId: 6 }] });
  });

  it('keeps deterministic identity when exits are disabled but emits a warning', async () => {
    mocks.assignmentFindUnique.mockResolvedValue(assignment({ exitsEnabled: false }));
    await expect(resolveExactBrokerOrderAttribution(args)).resolves.toMatchObject({ confidence: 'DETERMINISTIC', warnings: [{ code: 'ASSIGNMENT_EXITS_DISABLED' }] });
  });

  it.each([
    ['assignment_not_found', null],
    ['assignment_wrong_trading_account', assignment({ tradingAccountId: 2 })],
    ['assignment_lifecycle_configuration_disabled', assignment({ enabled: false })],
    ['assignment_lifecycle_configuration_disabled', assignment({ subscription: { ...assignment().subscription, enabled: false } })],
    ['assignment_lifecycle_configuration_disabled', assignment({ subscription: { ...assignment().subscription, strategy: { enabled: false } } })],
    ['assignment_lifecycle_configuration_disabled', assignment({ subscription: { ...assignment().subscription, exitProfile: { key: 'exit_stock_dip_core_target', enabled: false } } })],
    ['assignment_symbol_or_security_mismatch', assignment({ subscription: { ...assignment().subscription, security: { symbol: 'MSFT' } } })],
  ])('fails closed with %s for invalid assignment state', async (reason, value) => {
    mocks.assignmentFindUnique.mockResolvedValue(value);
    await expect(resolveExactBrokerOrderAttribution(args)).resolves.toMatchObject({ confidence: 'INSUFFICIENT', reason });
  });

  it('refuses multiple broker order UUIDs as ambiguous', async () => {
    mocks.activityFindMany.mockResolvedValue([activity(214, 2), activity(215, 1, { orderId: 'other-order' })]);
    await expect(resolveExactBrokerOrderAttribution(args)).resolves.toMatchObject({ confidence: 'AMBIGUOUS', reason: 'multiple_broker_order_ids' });
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['broker_order_uuid_mismatch', { id: 'wrong', client_order_id: clientOrderId, symbol: 'AAPL', side: 'buy' }],
    ['malformed_or_unsupported_client_order_id', { id: orderId, client_order_id: 'bad-tas4', symbol: 'AAPL', side: 'buy' }],
    ['broker_order_symbol_or_side_mismatch', { id: orderId, client_order_id: clientOrderId, symbol: 'MSFT', side: 'buy' }],
    ['broker_order_symbol_or_side_mismatch', { id: orderId, client_order_id: clientOrderId, symbol: 'AAPL', side: 'sell' }],
    ['broker_order_not_found', null],
  ])('fails closed with %s for invalid broker evidence', async (reason, value) => {
    mocks.getOrder.mockResolvedValue(value);
    await expect(resolveExactBrokerOrderAttribution(args)).resolves.toMatchObject({ confidence: 'INSUFFICIENT', reason });
  });

  it('fails closed on broker timeout/network/rate-limit errors', async () => {
    mocks.getOrder.mockRejectedValue(new Error('timeout'));
    await expect(resolveExactBrokerOrderAttribution(args)).resolves.toMatchObject({ confidence: 'INSUFFICIENT', reason: 'broker_order_read_failed' });
  });

  it('rejects quantity and weighted-price mismatches', async () => {
    mocks.activityFindMany.mockResolvedValue([activity(214, 2)]);
    await expect(resolveExactBrokerOrderAttribution(args)).resolves.toMatchObject({ reason: 'fill_quantity_mismatch' });
    mocks.activityFindMany.mockResolvedValue([activity(214, 2), activity(215, 1, { price: 304 })]);
    await expect(resolveExactBrokerOrderAttribution(args)).resolves.toMatchObject({ reason: 'fill_weighted_price_mismatch' });
  });

  it('does not call the broker under LOCAL_ONLY policy', async () => {
    await expect(resolveExactBrokerOrderAttribution({ ...args, policy: 'LOCAL_ONLY' })).resolves.toMatchObject({ confidence: 'INSUFFICIENT', reason: 'exact_broker_order_read_required' });
    expect(mocks.getOrder).not.toHaveBeenCalled();
  });
});
