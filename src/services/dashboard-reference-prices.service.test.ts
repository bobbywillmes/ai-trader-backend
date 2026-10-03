import { describe, expect, it, vi } from 'vitest';
import { getDashboardReferencePrices } from './dashboard-reference-prices.service.js';
import type { ReferencePriceEvidence } from './live-market-data.contracts.js';
import type { CapabilityProvider } from './live-market-data.contracts.js';

const evidence = (symbol: string, available = true): ReferencePriceEvidence => ({
  symbol, provider: 'TIINGO_CONSOLIDATED', price: available ? 100 : 99,
  basis: 'TIINGO_TNGO_LAST', observedAt: '2026-10-02T19:00:00.000Z',
  fetchedAt: '2026-10-02T19:00:01.000Z', freshness: available ? 'FRESH' : 'STALE',
  available, unavailableReason: available ? null : 'STALE_OBSERVATION', providerError: null,
});

describe('dashboard reference prices', () => {
  it('requests four independent normalized Tiingo observations', async () => {
    const verify = vi.fn(async (symbol: string, _provider: CapabilityProvider) => evidence(symbol));
    const result = await getDashboardReferencePrices(verify);
    expect(result.symbols).toEqual(['SPY', 'QQQ', 'DIA', 'IWM'].map(symbol => evidence(symbol)));
    expect(verify.mock.calls).toHaveLength(4);
    expect(verify.mock.calls.every(call => call[1] === 'TIINGO_CONSOLIDATED')).toBe(true);
  });

  it('keeps other symbols when one is stale or throws', async () => {
    const stale = await getDashboardReferencePrices(async symbol => evidence(symbol, symbol !== 'QQQ'));
    expect(stale.symbols.map(row => row.available)).toEqual([true, false, true, true]);
    const failed = await getDashboardReferencePrices(async symbol => {
      if (symbol === 'QQQ') throw new Error('provider failed');
      return evidence(symbol);
    });
    expect(failed.symbols.map(row => row.available)).toEqual([true, false, true, true]);
    expect(failed.symbols[1]).toMatchObject({ price: null, unavailableReason: 'PROVIDER_ERROR' });
  });

  it('passes through four unavailable normalized observations without fallback', async () => {
    const result = await getDashboardReferencePrices(async symbol => evidence(symbol, false));
    expect(result.symbols.every(row => !row.available && row.provider === 'TIINGO_CONSOLIDATED')).toBe(true);
  });
});
