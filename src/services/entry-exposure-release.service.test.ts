import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOrderById: vi.fn(),
  getOrderByClientOrderId: vi.fn(),
  getPosition: vi.fn(),
  getCompleteOpenOrders: vi.fn(),
  transaction: vi.fn(),
  claimFindUnique: vi.fn(),
  claimUpdate: vi.fn(),
  claimUpdateMany: vi.fn(),
  eventFindFirst: vi.fn(),
  eventCreate: vi.fn(),
  brokerOrderFindFirst: vi.fn(),
  brokerOrderCount: vi.fn(),
  activityFindMany: vi.fn(),
  positionCount: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderById: mocks.getOrderById,
  getAlpacaOrderByClientOrderId: mocks.getOrderByClientOrderId,
  getCompleteOpenAlpacaBuyOrdersForSymbol: mocks.getCompleteOpenOrders,
}));
vi.mock('../integrations/alpaca/positions.adapter.js', () => ({
  getAlpacaPositionBySymbol: mocks.getPosition,
}));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    entryExposureClaim: { findUnique: mocks.claimFindUnique, update: mocks.claimUpdate, updateMany: mocks.claimUpdateMany },
    entryExposureClaimEvent: { findFirst: mocks.eventFindFirst, create: mocks.eventCreate },
    brokerOrder: { findFirst: mocks.brokerOrderFindFirst, count: mocks.brokerOrderCount },
    brokerActivity: { findMany: mocks.activityFindMany },
    trackedPosition: { count: mocks.positionCount },
  },
}));

import { releaseConfirmedTerminalEntryClaim } from './entry-exposure-claim.service.js';

const claim = {
  id: 9, tradingAccountId: 1, securityId: 2, orderIntentId: 3,
  trackedPositionId: 4, status: 'POSITION_CLOSING', releasedAt: null,
  security: { symbol: 'SPY' },
  orderIntent: { clientOrderId: 'stable-3', blockReason: null },
};
const brokerOrder = (overrides: Record<string, unknown>) => ({
  id: 'broker-3', client_order_id: 'stable-3', symbol: 'SPY', side: 'buy',
  status: 'new', submitted_at: '2026-10-17T00:00:00Z', type: 'limit', time_in_force: 'day',
  ...overrides,
});

describe('authoritative entry claim release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimFindUnique.mockResolvedValue(claim);
    mocks.brokerOrderFindFirst.mockResolvedValue({ brokerOrderId: 'broker-3' });
    mocks.getPosition.mockResolvedValue(null);
    mocks.getCompleteOpenOrders.mockResolvedValue([]);
    mocks.eventFindFirst.mockResolvedValue(null);
    mocks.claimUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...claim, ...data }));
    mocks.claimUpdateMany.mockResolvedValue({ count: 1 });
    mocks.eventCreate.mockResolvedValue({ id: 1 });
    mocks.activityFindMany.mockResolvedValue([]);
    mocks.positionCount.mockResolvedValue(0);
    mocks.brokerOrderCount.mockResolvedValue(0);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: mocks.queryRaw,
      entryExposureClaim: { findUnique: mocks.claimFindUnique, update: mocks.claimUpdate, updateMany: mocks.claimUpdateMany },
      entryExposureClaimEvent: { findFirst: mocks.eventFindFirst, create: mocks.eventCreate },
      brokerOrder: { count: mocks.brokerOrderCount },
      brokerActivity: { findMany: mocks.activityFindMany },
      trackedPosition: { count: mocks.positionCount },
    }));
  });

  it('retains ownership when a partially filled BUY still has executable quantity', async () => {
    mocks.getOrderById.mockResolvedValue(brokerOrder({ status: 'partially_filled', filled_qty: '2', qty: '10' }));
    await expect(releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'expired' })).resolves.toBeNull();
    expect(mocks.claimUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ status: 'UNRESOLVED' }) }));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('retains ownership when terminal cumulative fills are missing locally', async () => {
    mocks.getOrderById.mockResolvedValue(brokerOrder({ status: 'expired', filled_qty: '2', qty: '10' }));
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'expired' });
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'AUTHORITATIVE_RELEASE_FILLS_INCOMPLETE' }) }));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('preserves a normal fill as awaiting position without attempting release', async () => {
    mocks.claimFindUnique.mockResolvedValue({ ...claim, trackedPositionId: null, trackedPosition: null, status: 'BROKER_ORDER_ACTIVE' });
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'filled' });
    expect(mocks.claimUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'BROKER_ORDER_ACTIVE', releasedAt: null }),
      data: { status: 'FILLED_AWAITING_POSITION' },
    }));
    expect(mocks.getOrderById).not.toHaveBeenCalled();
  });

  it('refuses release while a different executable BUY exists for the symbol', async () => {
    mocks.getOrderById.mockResolvedValue(brokerOrder({ status: 'expired', filled_qty: '0', qty: '10' }));
    mocks.getCompleteOpenOrders.mockResolvedValue([brokerOrder({ id: 'unrelated-buy', client_order_id: 'manual-buy', status: 'new' })]);
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'expired' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'AUTHORITATIVE_RELEASE_BLOCKED' }),
    }));
  });

  it('releases only after terminal broker state, accounted fills, absent position, and locked revalidation', async () => {
    mocks.getOrderById.mockResolvedValue(brokerOrder({ status: 'expired', filled_qty: '2', qty: '10' }));
    mocks.activityFindMany.mockResolvedValue([{ qty: 2 }]);
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'expired' });
    expect(mocks.getPosition).toHaveBeenCalledWith(1, 'SPY', 'reconciliation_check');
    expect(mocks.queryRaw).toHaveBeenCalled();
    expect(mocks.claimUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'RELEASED', releasedAt: expect.any(Date) }),
    }));
  });

  it('resolves prior uncertain delivery when exact complete broker evidence is now terminal', async () => {
    mocks.claimFindUnique.mockResolvedValue({ ...claim, orderIntent: { ...claim.orderIntent, blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:timeout' } });
    mocks.getOrderById.mockResolvedValue(brokerOrder({ status: 'rejected', filled_qty: '0', qty: '10' }));
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'rejected' });
    expect(mocks.claimUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'RELEASED' }) }));
  });
});
