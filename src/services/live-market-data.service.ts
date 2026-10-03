/** Phase 9A production authority is deliberately fixed. This module is the sole direct-data entrypoint for consumers. */
export const PRODUCTION_REALTIME_AUTHORITY = 'MASSIVE' as const;
/** Explicit read-only verification entrypoints. Existing production exports below remain Massive-backed. */
export { verifyReferencePrice, verifyRegularSessionMinutes } from './live-market-data-capabilities.js';
export type { ReferencePriceEvidence, RegularSessionMinuteEvidence, CapabilityProvider } from './live-market-data.contracts.js';
export {
  getTickerLatestPrice, getTickerPriceConfirmationMarketData, getTickerAggregateBars,
  getTickerDailyCandles, getIndexPerformance,
} from './massive-market-data.service.js';
export type {
  TickerLatestPrice, TickerPriceConfirmationMarketData, TickerAggregateBar,
  DailyMarketCandle, IndexPerformanceResponse,
} from './massive-market-data.service.js';
