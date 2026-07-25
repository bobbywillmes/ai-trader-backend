import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  alpacaRequestForAccount: vi.fn(),
}));

vi.mock('./client.js', () => ({
  alpacaRequestForAccount: mocks.alpacaRequestForAccount,
}));

import {
  getAlpacaOrderByClientOrderId,
  getAlpacaOrderById,
  getOpenAlpacaOrders,
  placeAlpacaOrder,
} from './orders.adapter.js';
import { closeAlpacaPosition, getAlpacaPositions } from './positions.adapter.js';
import { getAlpacaAccount } from './account.adapter.js';
import { getAlpacaAccountActivities } from './activities.adapter.js';

describe('Alpaca adapter request metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.alpacaRequestForAccount.mockResolvedValue({});
  });

  it('uses normalized endpoint keys instead of dynamic broker identifiers', async () => {
    await getAlpacaOrderById(1, 'order-abc-123', 'protective_order_sync');
    await getAlpacaOrderByClientOrderId(
      1,
      'client-abc-123',
      'pending_order_idempotency_check'
    );
    await closeAlpacaPosition(1, 'SPY', 'position_close');

    expect(mocks.alpacaRequestForAccount).toHaveBeenNthCalledWith(
      1,
      1,
      '/v2/orders/order-abc-123',
      expect.objectContaining({
        metadata: expect.objectContaining({
          endpoint: 'GET /v2/orders/:orderId',
        }),
      })
    );
    expect(mocks.alpacaRequestForAccount).toHaveBeenNthCalledWith(
      2,
      1,
      '/v2/orders:by_client_order_id?client_order_id=client-abc-123',
      expect.objectContaining({
        metadata: expect.objectContaining({
          endpoint: 'GET /v2/orders:by_client_order_id',
        }),
      })
    );
    expect(mocks.alpacaRequestForAccount).toHaveBeenNthCalledWith(
      3,
      1,
      '/v2/positions/SPY',
      expect.objectContaining({
        metadata: expect.objectContaining({
          endpoint: 'DELETE /v2/positions/:symbol',
        }),
      })
    );
  });

  it('attributes shared reads to the caller operation', async () => {
    await getOpenAlpacaOrders(1, 'submitted_order_sync');
    await getAlpacaPositions(1, 'reconciliation_check');
    await getAlpacaAccount(1, 'account_snapshot');
    await getAlpacaAccountActivities({
      tradingAccountId: 1,
      activityType: 'FILL',
      operation: 'manual_admin_action',
    });

    expect(mocks.alpacaRequestForAccount).toHaveBeenNthCalledWith(
      1,
      1,
      '/v2/orders?status=open&direction=desc',
      expect.objectContaining({
        metadata: expect.objectContaining({
          operation: 'submitted_order_sync',
          endpoint: 'GET /v2/orders',
          requestClass: 'synchronization_read',
        }),
      })
    );
    expect(mocks.alpacaRequestForAccount).toHaveBeenNthCalledWith(
      2,
      1,
      '/v2/positions',
      expect.objectContaining({
        metadata: expect.objectContaining({
          operation: 'reconciliation_check',
          endpoint: 'GET /v2/positions',
        }),
      })
    );
    expect(mocks.alpacaRequestForAccount).toHaveBeenNthCalledWith(
      3,
      1,
      '/v2/account',
      expect.objectContaining({
        metadata: expect.objectContaining({
          operation: 'account_snapshot',
          endpoint: 'GET /v2/account',
        }),
      })
    );
    expect(mocks.alpacaRequestForAccount).toHaveBeenNthCalledWith(
      4,
      1,
      '/v2/account/activities/FILL',
      expect.objectContaining({
        metadata: expect.objectContaining({
          operation: 'manual_admin_action',
          endpoint: 'GET /v2/account/activities/:activityType',
          requestClass: 'informational_read',
        }),
      })
    );
  });

  it('classifies critical writes separately from deferable reads', async () => {
    await placeAlpacaOrder(
      1,
      {
        symbol: 'SPY',
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
        qty: '1',
        client_order_id: 'client-1',
      },
      'pending_order_submission'
    );
    await getOpenAlpacaOrders(1, 'submitted_order_sync');

    expect(mocks.alpacaRequestForAccount).toHaveBeenNthCalledWith(
      1,
      1,
      '/v2/orders',
      expect.objectContaining({
        metadata: expect.objectContaining({
          requestClass: 'critical_write',
          deferDuringRateLimit: false,
        }),
      })
    );
    expect(mocks.alpacaRequestForAccount).toHaveBeenNthCalledWith(
      2,
      1,
      '/v2/orders?status=open&direction=desc',
      expect.objectContaining({
        metadata: expect.objectContaining({
          requestClass: 'synchronization_read',
          deferDuringRateLimit: true,
        }),
      })
    );
  });
});
