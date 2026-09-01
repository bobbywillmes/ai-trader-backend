import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recover: vi.fn(),
  transaction: vi.fn(),
  updateIntent: vi.fn(),
  findIntent: vi.fn(),
  findOrder: vi.fn(),
  updatePosition: vi.fn(),
}));
const tx = {
  orderIntent: { updateMany: mocks.updateIntent, findFirst: mocks.findIntent },
  brokerOrder: { findFirst: mocks.findOrder },
  trackedPosition: { updateMany: mocks.updatePosition },
};
vi.mock('../db/prisma.js', () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderByClientOrderId: mocks.recover,
}));

import { recoverDeterministicallyAbsentStaleCloseIntents } from './stale-close-intent-recovery.service.js';

const intent = {
  id: 273,
  tradingAccountId: 7,
  trackedPositionId: 79,
  source: 'close-position',
  status: 'submitting',
  clientOrderId: 'ai-exit-close-7-79',
};

describe('stale close intent deterministic recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.recover.mockResolvedValue(null);
    mocks.updateIntent.mockResolvedValue({ count: 1 });
    mocks.findIntent.mockResolvedValue(null);
    mocks.findOrder.mockResolvedValue(null);
    mocks.updatePosition.mockResolvedValue({ count: 1 });
  });

  it('terminalizes a stale close and reopens its position only after stable-ID absence is proven', async () => {
    await expect(recoverDeterministicallyAbsentStaleCloseIntents([intent])).resolves.toEqual(new Set([273]));
    expect(mocks.recover).toHaveBeenCalledWith(7, 'ai-exit-close-7-79', 'pending_order_idempotency_check');
    expect(mocks.updateIntent).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 273, status: 'submitting' },
      data: { status: 'failed', blockReason: 'RECONCILIATION:DETERMINISTIC_BROKER_ABSENCE_CONFIRMED' },
    }));
    expect(mocks.updatePosition).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 79, status: 'closing' },
      data: expect.objectContaining({ status: 'open' }),
    }));
  });

  it.each([
    ['broker order found', { brokerOrder: { id: 'delivered' } }],
    ['lookup failed', { lookupError: new Error('unavailable') }],
  ])('retains the pending attempt when %s', async (_label, state) => {
    if ('lookupError' in state) mocks.recover.mockRejectedValue(state.lookupError);
    else mocks.recover.mockResolvedValue(state.brokerOrder);
    await expect(recoverDeterministicallyAbsentStaleCloseIntents([intent])).resolves.toEqual(new Set());
    expect(mocks.updateIntent).not.toHaveBeenCalled();
    expect(mocks.updatePosition).not.toHaveBeenCalled();
  });

  it('does not reopen the position while another active intent or broker order exists', async () => {
    mocks.findIntent.mockResolvedValue({ id: 274 });
    await recoverDeterministicallyAbsentStaleCloseIntents([intent]);
    expect(mocks.updatePosition).not.toHaveBeenCalled();
  });
});
