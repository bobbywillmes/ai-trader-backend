import { describe, expect, it, vi } from 'vitest';
import { captureTradingReferencePrices, formatTradingReferencePriceAcceptance } from './trading-reference-price-acceptance.js';
import type { CapabilityProvider, ReferencePriceEvidence } from '../services/live-market-data.contracts.js';

const at = new Date('2026-10-02T16:00:00.000Z');
const evidence = (symbol: string, provider: CapabilityProvider, patch: Partial<ReferencePriceEvidence> = {}): ReferencePriceEvidence => ({
  symbol, provider, price: 100, basis: provider === 'MASSIVE' ? 'LAST_TRADE' : 'TIINGO_TNGO_LAST',
  observedAt: '2026-10-02T15:59:00.000Z', fetchedAt: at.toISOString(), freshness: 'FRESH', available: true,
  unavailableReason: null, providerError: null, ...patch,
});
describe('manual trading reference-price capture', () => {
  it('aggregates bases, policy rejections and aligned comparisons', async () => {
    const verify = vi.fn(async (symbol: string, provider: CapabilityProvider) => evidence(symbol, provider,
      provider === 'TIINGO_CONSOLIDATED' && symbol === 'QQQ' ? { basis: 'TIINGO_LQ_REF_PRICE', price: 101 } : {}));
    const report = await captureTradingReferencePrices(['SPY', 'QQQ'], 'MIDDAY', [], verify, () => at);
    expect(report.summary).toMatchObject({ symbolCount: 2, tiingoTradingUsableCount: 1,
      basisCounts: { TIINGO_TNGO_LAST: 1, TIINGO_LQ_REF_PRICE: 1 }, rejectionReasons: { UNACCEPTED_BASIS: 1 }, alignedComparisonCount: 2 });
    expect(report.symbols[1]?.comparison).toMatchObject({ absoluteDifference: 1, basisPointDifference: 100 });
    expect(formatTradingReferencePriceAcceptance(report)).toContain('UNACCEPTED_BASIS=1');
  });
  it('contains one symbol failure without losing independent comparisons', async () => {
    const verify = vi.fn(async (symbol: string, provider: CapabilityProvider) => {
      if (symbol === 'QQQ' && provider === 'TIINGO_CONSOLIDATED') throw new Error('secret upstream body');
      return evidence(symbol, provider);
    });
    const report = await captureTradingReferencePrices(['SPY', 'QQQ', 'DIA'], 'AFTER_OPEN', [], verify, () => at);
    expect(verify).toHaveBeenCalledTimes(6);
    expect(report.summary.tiingoTradingUsableCount).toBe(2);
    expect(report.symbols[1]?.tiingo.tradingPolicy.rejectionReason).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(report)).not.toContain('secret upstream body');
  });
  it('withholds basis points for timestamp mismatch while retaining an absolute diagnostic', async () => {
    const report = await captureTradingReferencePrices(['SPY'], 'MIDDAY', [], async (symbol, provider) => evidence(symbol, provider,
      provider === 'MASSIVE' ? { price: 99, observedAt: '2026-10-02T15:50:00.000Z' } : {}), () => at);
    expect(report.symbols[0]?.comparison).toMatchObject({ alignment: 'UNALIGNED', absoluteDifference: 1, basisPointDifference: null });
  });
});
