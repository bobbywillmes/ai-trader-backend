import { describe, expect, it, vi } from 'vitest';
import { captureDashboardPriceAcceptance, formatDashboardPriceAcceptance } from './dashboard-price-acceptance.js';
import type { CapabilityProvider, ReferencePriceEvidence } from '../services/live-market-data.contracts.js';

const at = '2026-10-02T16:00:00.000Z';
const evidence = (symbol: string, provider: CapabilityProvider, patch: Partial<ReferencePriceEvidence> = {}): ReferencePriceEvidence => ({
  symbol, provider, price: 100, basis: provider === 'MASSIVE' ? 'LAST_TRADE' : 'TIINGO_TNGO_LAST',
  observedAt: '2026-10-02T15:59:00.000Z', fetchedAt: at, freshness: 'FRESH', available: true,
  unavailableReason: null, providerError: null, ...patch,
});
const clock = () => new Date(at);

describe('dashboard price acceptance capture', () => {
  it('collects both explicit providers for all four symbols and counts bases', async () => {
    const verify = vi.fn(async (symbol: string, provider: CapabilityProvider) => evidence(symbol, provider,
      provider === 'TIINGO_CONSOLIDATED' && symbol === 'DIA' ? { basis: 'TIINGO_LQ_REF_PRICE' } : {}));
    const report = await captureDashboardPriceAcceptance('MIDDAY', verify, clock);
    expect(verify).toHaveBeenCalledTimes(8);
    expect(report.symbols.map(row => row.symbol)).toEqual(['SPY', 'QQQ', 'DIA', 'IWM']);
    expect(report.summary).toMatchObject({ allFourTiingoAvailable: true, tiingoAvailableCount: 4,
      basisCounts: { TIINGO_TNGO_LAST: 3, TIINGO_LQ_REF_PRICE: 1 } });
    expect(report.symbols[0]?.tiingo.observationAgeMs).toBe(60_000);
    expect(report.symbols[0]?.comparison).toMatchObject({ absoluteDifference: 0, basisPoints: 0, observationTimeDeltaMs: 0 });
    expect(formatDashboardPriceAcceptance(report)).toContain('Tiingo available: 4/4');
  });
  it.each([
    ['stale', { freshness: 'STALE', available: false, unavailableReason: 'STALE_OBSERVATION' }],
    ['future', { freshness: 'FUTURE', available: false, unavailableReason: 'FUTURE_TIMESTAMP', observedAt: '2026-10-02T16:01:00.000Z' }],
    ['missing time', { freshness: 'UNKNOWN', available: false, unavailableReason: 'MISSING_TIMESTAMP', observedAt: null }],
    ['provider failure', { available: false, unavailableReason: 'PROVIDER_ERROR', providerError: 'HTTP_429', price: null }],
  ] as const)('preserves one %s Tiingo failure without fallback', async (_label, patch) => {
    const verify = vi.fn(async (symbol: string, provider: CapabilityProvider) => evidence(symbol, provider,
      symbol === 'QQQ' && provider === 'TIINGO_CONSOLIDATED' ? patch as Partial<ReferencePriceEvidence> : {}));
    const report = await captureDashboardPriceAcceptance('AFTER_OPEN', verify, clock);
    expect(report.summary.tiingoAvailableCount).toBe(3);
    expect(report.summary.tiingoUnavailableSymbols).toEqual([{ symbol: 'QQQ', reason: patch.unavailableReason,
      providerError: 'providerError' in patch ? patch.providerError : null }]);
    expect(report.symbols[1]?.comparison.absoluteDifference).toBeNull();
    expect(verify.mock.calls.filter(call => call[0] === 'QQQ')).toEqual([['QQQ', 'MASSIVE'], ['QQQ', 'TIINGO_CONSOLIDATED']]);
    expect(report.summary.tiingoStaleCount).toBe(_label === 'stale' ? 1 : 0);
  });
  it('contains a thrown provider request to one symbol and leaves the other seven requests intact', async () => {
    const verify = vi.fn(async (symbol: string, provider: CapabilityProvider) => {
      if (symbol === 'DIA' && provider === 'TIINGO_CONSOLIDATED') throw new Error('secret upstream body');
      return evidence(symbol, provider);
    });
    const report = await captureDashboardPriceAcceptance('POSTMARKET', verify, clock);
    expect(verify).toHaveBeenCalledTimes(8);
    expect(report.summary.tiingoUnavailableCount).toBe(1);
    expect(report.symbols[2]?.tiingo).toMatchObject({ provider: 'TIINGO_CONSOLIDATED', providerError: 'REQUEST_FAILED' });
    expect(JSON.stringify(report)).not.toContain('secret upstream body');
  });
});
