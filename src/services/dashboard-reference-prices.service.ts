import { verifyReferencePrice } from './live-market-data.service.js';
import type { ReferencePriceEvidence } from './live-market-data.contracts.js';

export const DASHBOARD_PRICE_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM'] as const;

export async function getDashboardReferencePrices(
  verify: typeof verifyReferencePrice = verifyReferencePrice,
): Promise<{ symbols: ReferencePriceEvidence[] }> {
  const symbols = await Promise.all(DASHBOARD_PRICE_SYMBOLS.map(async (symbol) => {
    try {
      return await verify(symbol, 'TIINGO_CONSOLIDATED');
    } catch {
      return { symbol, provider: 'TIINGO_CONSOLIDATED', price: null, basis: null,
        observedAt: null, fetchedAt: new Date().toISOString(), freshness: 'UNKNOWN',
        available: false, unavailableReason: 'PROVIDER_ERROR', providerError: 'REQUEST_FAILED' } as ReferencePriceEvidence;
    }
  }));
  return { symbols };
}
