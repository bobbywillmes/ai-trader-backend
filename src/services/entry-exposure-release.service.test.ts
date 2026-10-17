import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOrderById: vi.fn(),
  getOrderByClientOrderId: vi.fn(),
  getPosition: vi.fn(),
  transaction: vi.fn(),
  claimFindUnique: vi.fn(),
  claimUpdate: vi.fn(),
  eventFindFirst: vi.fn(),
  brokerOrderFindFirst: vi.fn(),
  brokerOrderCount: vi.fn(),
  activityFindMany: vi.fn(),
  positionCount: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('../integrations/alpaca/orders.adapter.js', () => ({
  getAlpacaOrderById: mocks.getOrderById,
  getAlpacaOrderByClientOrderId: mocks.getOrderByClientOrderId,
}));
vi.mock('../integrations/alpaca/positions.adapter.js', () => ({
  getAlpacaPositionBySymbol: mocks.getPosition,
}));
vi.mock('../db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    entryExposureClaim: { findUnique: mocks.claimFindUnique, update: mocks.claimUpdate },
    entryExposureClaimEvent: { findFirst: mocks.eventFindFirst },
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

describe('authoritative entry claim release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimFindUnique.mockResolvedValue(claim);
    mocks.brokerOrderFindFirst.mockResolvedValue({ brokerOrderId: 'broker-3' });
    mocks.getPosition.mockResolvedValue(null);
    mocks.eventFindFirst.mockResolvedValue(null);
    mocks.claimUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...claim, ...data }));
    mocks.activityFindMany.mockResolvedValue([]);
    mocks.positionCount.mockResolvedValue(0);
    mocks.brokerOrderCount.mockResolvedValue(0);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRaw: mocks.queryRaw,
      entryExposureClaim: { findUnique: mocks.claimFindUnique, update: mocks.claimUpdate },
      entryExposureClaimEvent: { findFirst: mocks.eventFindFirst },
      brokerOrder: { count: mocks.brokerOrderCount },
      trackedPosition: { count: mocks.positionCount },
    }));
  });

  it('retains ownership when a partially filled BUY still has executable quantity', async () => {
    mocks.getOrderById.mockResolvedValue({ id: 'broker-3', status: 'partially_filled', filled_qty: '2', qty: '10' });
    await expect(releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'expired' })).resolves.toBeNull();
    expect(mocks.claimUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'UNRESOLVED' }) }));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('retains ownership when terminal cumulative fills are missing locally', async () => {
    mocks.getOrderById.mockResolvedValue({ id: 'broker-3', status: 'expired', filled_qty: '2', qty: '10' });
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'expired' });
    expect(mocks.claimUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'UNRESOLVED' }) }));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('releases only after terminal broker state, accounted fills, absent position, and locked revalidation', async () => {
    mocks.getOrderById.mockResolvedValue({ id: 'broker-3', status: 'expired', filled_qty: '2', qty: '10' });
    mocks.activityFindMany.mockResolvedValue([{ qty: 2 }]);
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'expired' });
    expect(mocks.getPosition).toHaveBeenCalledWith(1, 'SPY', 'reconciliation_check');
    expect(mocks.queryRaw).toHaveBeenCalled();
    expect(mocks.claimUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'RELEASED', releasedAt: expect.any(Date) }),
    }));
  });

  it('retains ownership on uncertain delivery even when broker currently reports terminal', async () => {
    mocks.claimFindUnique.mockResolvedValue({ ...claim, orderIntent: { ...claim.orderIntent, blockReason: 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:timeout' } });
    mocks.getOrderById.mockResolvedValue({ id: 'broker-3', status: 'rejected', filled_qty: '0', qty: '10' });
    await releaseConfirmedTerminalEntryClaim({ orderIntentId: 3, brokerStatus: 'rejected' });
    expect(mocks.claimUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'UNRESOLVED' }) }));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
