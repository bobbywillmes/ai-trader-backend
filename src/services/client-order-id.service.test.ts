import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T12:34:56.000Z'));
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '12345678-1234-4234-8234-123456789abc'
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it('preserves account and environment tokens when subscription identity is long', () => {
    const longInput = {
      ...input,
      subscriptionKey: `strategy_${'account_specific_'.repeat(20)}`,
    };
    const paperOne = buildClientOrderId(longInput, {
      tradingAccountId: 1,
      environment: 'PAPER',
    });
    const paperTwo = buildClientOrderId(longInput, {
      tradingAccountId: 2,
      environment: 'PAPER',
    });
    const liveOne = buildClientOrderId(longInput, {
      tradingAccountId: 1,
      environment: 'LIVE',
    });

    expect(paperOne).toContain('-ta1-paper-');
    expect(paperTwo).toContain('-ta2-paper-');
    expect(liveOne).toContain('-ta1-live-');
    expect(paperOne).not.toBe(paperTwo);
    expect(paperOne).not.toBe(liveOne);
    expect(paperOne).toContain('-skh');

    for (const value of [paperOne, paperTwo, liveOne]) {
      expect(value.length).toBeLessThanOrEqual(128);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('keeps the existing encoded subscription token for normal-length ids', () => {
    const value = buildClientOrderId(input, {
      tradingAccountId: 1,
      environment: 'PAPER',
    });

    expect(value).toContain('-skx7370795f6469705f636f7265-');
    expect(value).toBe(
      'ai-20260725T123456-SPY-buy-market-ta1-paper-skx7370795f6469705f636f7265-12345678'
    );
  });
});
