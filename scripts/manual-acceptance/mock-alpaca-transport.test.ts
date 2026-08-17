import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
