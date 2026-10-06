/** Provider-neutral verification entrypoints plus the remaining explicitly Massive-backed legacy consumers. */
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
