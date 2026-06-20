import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  alpacaRequest: vi.fn(),
}));

vi.mock('./client.js', () => ({
  alpacaRequest: mocks.alpacaRequest,
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
    mocks.alpacaRequest.mockResolvedValue({});
  });

  it('uses normalized endpoint keys instead of dynamic broker identifiers', async () => {
    await getAlpacaOrderById('order-abc-123', 'protective_order_sync');
    await getAlpacaOrderByClientOrderId(
      'client-abc-123',
      'pending_order_idempotency_check'
    );
    await closeAlpacaPosition('SPY', 'position_close');

    expect(mocks.alpacaRequest).toHaveBeenNthCalledWith(
      1,
      '/v2/orders/order-abc-123',
      expect.objectContaining({
        metadata: expect.objectContaining({
          endpoint: 'GET /v2/orders/:orderId',
        }),
      })
    );
    expect(mocks.alpacaRequest).toHaveBeenNthCalledWith(
      2,
      '/v2/orders:by_client_order_id?client_order_id=client-abc-123',
      expect.objectContaining({
        metadata: expect.objectContaining({
          endpoint: 'GET /v2/orders:by_client_order_id',
        }),
      })
    );
    expect(mocks.alpacaRequest).toHaveBeenNthCalledWith(
      3,
      '/v2/positions/SPY',
      expect.objectContaining({
        metadata: expect.objectContaining({
          endpoint: 'DELETE /v2/positions/:symbol',
        }),
      })
    );
  });

  it('attributes shared reads to the caller operation', async () => {
    await getOpenAlpacaOrders('submitted_order_sync');
    await getAlpacaPositions('reconciliation_check');
    await getAlpacaAccount('account_snapshot');
    await getAlpacaAccountActivities({
      activityType: 'FILL',
      operation: 'manual_admin_action',
    });

    expect(mocks.alpacaRequest).toHaveBeenNthCalledWith(
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
    expect(mocks.alpacaRequest).toHaveBeenNthCalledWith(
      2,
      '/v2/positions',
      expect.objectContaining({
        metadata: expect.objectContaining({
          operation: 'reconciliation_check',
          endpoint: 'GET /v2/positions',
        }),
      })
    );
    expect(mocks.alpacaRequest).toHaveBeenNthCalledWith(
      3,
      '/v2/account',
      expect.objectContaining({
        metadata: expect.objectContaining({
          operation: 'account_snapshot',
          endpoint: 'GET /v2/account',
        }),
      })
    );
    expect(mocks.alpacaRequest).toHaveBeenNthCalledWith(
      4,
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
    await getOpenAlpacaOrders('submitted_order_sync');

    expect(mocks.alpacaRequest).toHaveBeenNthCalledWith(
      1,
      '/v2/orders',
      expect.objectContaining({
        metadata: expect.objectContaining({
          requestClass: 'critical_write',
          deferDuringRateLimit: false,
        }),
      })
    );
    expect(mocks.alpacaRequest).toHaveBeenNthCalledWith(
      2,
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
