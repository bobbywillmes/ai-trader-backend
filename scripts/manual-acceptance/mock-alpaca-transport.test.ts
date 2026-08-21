import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MANUAL_ACCEPTANCE_SENTINEL } from '../../src/services/manual-acceptance-environment.js';
import {
  getTickerLatestPrice,
  normalizeTickerLatestPrice,
} from '../../src/services/massive-market-data.service.js';
import { installMockAlpacaTransport, mockAlpacaState } from './mock-alpaca-transport.js';

describe('manual acceptance Alpaca transport boundary', () => {
  const originalFetch = globalThis.fetch;
  const originalSentinel = process.env.MANUAL_ACCEPTANCE_HARNESS;

  beforeEach(() => {
    process.env.MANUAL_ACCEPTANCE_HARNESS = MANUAL_ACCEPTANCE_SENTINEL;
    installMockAlpacaTransport();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    if (originalSentinel === undefined) delete process.env.MANUAL_ACCEPTANCE_HARNESS;
    else process.env.MANUAL_ACCEPTANCE_HARNESS = originalSentinel;
  });

  it('answers an exact Alpaca host without using the original transport', async () => {
    const response = await fetch('https://api.alpaca.markets/v2/account');
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({ id: 'manual-acceptance-live-account' });
  });

  it('materializes one deterministic fill and broker position after the sole order POST', async () => {
    const orderResponse = await fetch('https://api.alpaca.markets/v2/orders', {
      method: 'POST',
      body: JSON.stringify({
        client_order_id: 'ai-accept-run9-rev1',
        symbol: 'RSP',
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
        qty: '4',
      }),
    });
    const order = await orderResponse.json() as { id: string };
    const activities = await fetch('https://api.alpaca.markets/v2/account/activities/FILL');
    const positions = await fetch('https://api.alpaca.markets/v2/positions');
    const lookup = await fetch(`https://api.alpaca.markets/v2/orders/${order.id}`);

    await expect(activities.json()).resolves.toEqual([
      expect.objectContaining({
        activity_type: 'FILL',
        order_id: order.id,
        symbol: 'RSP',
        qty: '4',
        cum_qty: '4',
        leaves_qty: '0',
      }),
    ]);
    await expect(positions.json()).resolves.toEqual([
      expect.objectContaining({ symbol: 'RSP', qty: '4', side: 'long' }),
    ]);
    await expect(lookup.json()).resolves.toEqual(
      expect.objectContaining({ id: order.id, status: 'filled', filled_qty: '4' }),
    );
    expect(mockAlpacaState().postCount).toBe(1);
  });

  it.each([
    'https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/RSP',
    'https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/RSP?_=1787072400000',
  ])('returns a parseable deterministic RSP latest price for %s', async (url) => {
    const before = mockAlpacaState();
    const response = await fetch(url);
    const payload = await response.json() as { ticker: Parameters<typeof normalizeTickerLatestPrice>[1] };

    expect(response.ok).toBe(true);
    expect(normalizeTickerLatestPrice('RSP', payload.ticker)).toEqual({
      symbol: 'RSP',
      latestPrice: 250,
      latestPriceAt: '2026-08-18T17:00:00.000Z',
      latestPriceSource: 'lastTrade',
    });
    expect(mockAlpacaState()).toMatchObject({
      totalRequests: before.totalRequests + 1,
      getCount: before.getCount + 1,
      postCount: before.postCount,
    });
    expect(mockAlpacaState().recentRequests.at(-1)).toMatchObject({
      host: 'api.massive.com',
      method: 'GET',
      path: new URL(url).pathname + new URL(url).search,
    });
  });

  it('serves the real latest-price client used by MAX_NOTIONAL runtime sizing', async () => {
    const before = mockAlpacaState();

    await expect(getTickerLatestPrice('RSP')).resolves.toEqual({
      symbol: 'RSP',
      latestPrice: 250,
      latestPriceAt: '2026-08-18T17:00:00.000Z',
      latestPriceSource: 'lastTrade',
    });
    expect(mockAlpacaState()).toMatchObject({
      totalRequests: before.totalRequests + 1,
      getCount: before.getCount + 1,
      postCount: before.postCount,
    });
    expect(mockAlpacaState().recentRequests.at(-1)).toMatchObject({
      host: 'api.massive.com',
      method: 'GET',
      path: expect.stringMatching(/^\/v2\/snapshot\/locale\/us\/markets\/stocks\/tickers\/RSP\?_=/),
    });
  });

  it('denies non-GET access to the permitted Massive snapshot', async () => {
    const before = mockAlpacaState();

    await expect(fetch(
      'https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/RSP',
      { method: 'POST' },
    )).rejects.toThrow('Manual acceptance Massive mock has no route');
    expect(mockAlpacaState().postCount).toBe(before.postCount);
  });

  it.each([
    'https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/SPY',
    'https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/RSP/details',
    'https://api.massive.com/v2/reference/news',
    'https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/RSP?unexpected=true',
    'https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/RSP?_=1&_=2',
  ])('denies an unapproved Massive request to %s', async (url) => {
    await expect(fetch(url)).rejects.toThrow('Manual acceptance Massive mock has no route');
  });

  it.each([
    'http://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/RSP',
    'https://api.massive.com.evil.invalid/v2/snapshot/locale/us/markets/stocks/tickers/RSP',
    'https://massive.com/v2/snapshot/locale/us/markets/stocks/tickers/RSP',
  ])('denies an unsafe Massive destination at %s', async (url) => {
    await expect(fetch(url)).rejects.toThrow('Manual acceptance network deny');
  });

  it.each([
    'https://api.alpaca.markets.evil.invalid/v2/account',
    'http://api.alpaca.markets/v2/account',
    'https://example.com/v2/account',
  ])('denies outbound transport to %s', async (url) => {
    await expect(fetch(url)).rejects.toThrow('Manual acceptance network deny');
  });

  it('returns a 09:30 to 16:00 New York calendar session', async () => {
    const response = await fetch('https://api.alpaca.markets/v2/calendar?start=2026-08-18&end=2026-08-18');
    await expect(response.json()).resolves.toEqual([
      { date: '2026-08-18', open: '09:30', close: '16:00' },
    ]);
  });

  it.each([
    {
      label: 'before open',
      now: '2026-08-18T12:00:00.000Z',
      expected: {
        is_open: false,
        next_open: '2026-08-18T13:30:00.000Z',
        next_close: '2026-08-18T20:00:00.000Z',
      },
    },
    {
      label: 'during session',
      now: '2026-08-18T17:00:00.000Z',
      expected: {
        is_open: true,
        next_open: '2026-08-19T13:30:00.000Z',
        next_close: '2026-08-18T20:00:00.000Z',
      },
    },
    {
      label: 'after close',
      now: '2026-08-18T21:00:00.000Z',
      expected: {
        is_open: false,
        next_open: '2026-08-19T13:30:00.000Z',
        next_close: '2026-08-19T20:00:00.000Z',
      },
    },
  ])('returns coherent $label clock boundaries', async ({ now, expected }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));

    const response = await fetch('https://api.alpaca.markets/v2/clock');
    await expect(response.json()).resolves.toEqual({ timestamp: now, ...expected });
  });
});
