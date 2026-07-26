import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('./client.js', () => ({ alpacaRequestForAccount: request }));

import { cancelAlpacaOrder, cancelAllAlpacaOrders } from './orders.adapter.js';

describe('Alpaca cancellation risk classification', () => {
  beforeEach(() => request.mockReset().mockResolvedValue(undefined));

  it('requires callers to opt a verified exposure-preventing cancel into risk reduction', async () => {
    await cancelAlpacaOrder(1, 'entry-buy', 'order_cancel', 'RISK_REDUCING_WRITE');
    expect(request).toHaveBeenCalledWith(1, '/v2/orders/entry-buy', expect.objectContaining({
      metadata: expect.objectContaining({ operationClass: 'RISK_REDUCING_WRITE' }),
    }));
  });

  it('classifies an unverified or protective single cancel conservatively', async () => {
    await cancelAlpacaOrder(2, 'protective-sell');
    expect(request).toHaveBeenCalledWith(2, '/v2/orders/protective-sell', expect.objectContaining({
      metadata: expect.objectContaining({ operationClass: 'ENTRY_WRITE' }),
    }));
  });

  it('never labels cancel-all as blindly risk reducing', async () => {
    request.mockResolvedValue([]);
    await cancelAllAlpacaOrders(2);
    expect(request).toHaveBeenCalledWith(2, '/v2/orders', expect.objectContaining({
      metadata: expect.objectContaining({ operationClass: 'ENTRY_WRITE' }),
    }));
  });
});
