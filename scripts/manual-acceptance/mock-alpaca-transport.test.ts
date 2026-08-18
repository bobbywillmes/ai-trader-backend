import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MANUAL_ACCEPTANCE_SENTINEL } from '../../src/services/manual-acceptance-environment.js';
import { installMockAlpacaTransport } from './mock-alpaca-transport.js';

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
