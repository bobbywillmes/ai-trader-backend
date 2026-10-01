/** Phase 9A production authority is deliberately fixed. This module is the sole direct-data entrypoint for consumers. */
export const PRODUCTION_REALTIME_AUTHORITY = 'MASSIVE' as const;
export {
  getTickerLatestPrice, getTickerPriceConfirmationMarketData, getTickerAggregateBars,
  getTickerDailyCandles, getIndexPerformance, getIndexIntraday,
  parseIndexChartRange,
} from './massive-market-data.service.js';
export type {
  TickerLatestPrice, TickerPriceConfirmationMarketData, TickerAggregateBar,
  DailyMarketCandle, IndexPerformanceResponse, IndexIntradayResponse,
} from './massive-market-data.service.js';
