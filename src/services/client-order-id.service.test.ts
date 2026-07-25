import { describe, expect, it } from 'vitest';

import { buildClientOrderId } from './client-order-id.service.js';

const input = {
  symbol: 'SPY',
  side: 'buy' as const,
  orderType: 'market' as const,
  timeInForce: 'day' as const,
  extendedHours: false,
  subscriptionKey: 'spy_dip_core',
  tradingAccountId: 1,
  tradingAccountSubscriptionId: 10,
};

describe('client order id account identity', () => {
  it('embeds stable account and environment identity in new ids', () => {
    const paper = buildClientOrderId(input, {
      tradingAccountId: 1,
      environment: 'PAPER',
    });
    const live = buildClientOrderId(input, {
      tradingAccountId: 2,
      environment: 'LIVE',
    });

    expect(paper).toContain('-ta1-paper-');
    expect(live).toContain('-ta2-live-');
    expect(paper).not.toBe(live);
    expect(paper.length).toBeLessThanOrEqual(128);
    expect(live.length).toBeLessThanOrEqual(128);
  });
});
