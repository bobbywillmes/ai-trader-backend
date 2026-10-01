/** Provider-neutral direct market evidence. Production authority is selected outside these contracts. */
export type LiveMarketProvider = 'MASSIVE' | 'TIINGO_CONSOLIDATED' | 'TIINGO_IEX';
export type LiveMarketProvenance = {
  provider: LiveMarketProvider;
  sourceType: 'SNAPSHOT' | 'INTRADAY_HISTORY' | 'ADJUSTED_DAILY_HISTORY';
  observedAt: string | null;
  fetchedAt: string;
  extendedHours: boolean;
};
export type LatestReferencePrice = { symbol: string; price: number | null; provenance: LiveMarketProvenance };
export type RealtimeSnapshot = { symbol: string; referencePrice: number | null; previousClose: number | null;
  dayHigh: number | null; dayLow: number | null; dayVolume: number | null; provenance: LiveMarketProvenance };
export type IntradayBar = { time: string; open: number; high: number; low: number; close: number;
  volume: number | null; provenance: LiveMarketProvenance };
export type DailyCandle = { date: string; open: number; high: number; low: number; close: number;
  volume: number | null; adjusted: boolean; provenance: LiveMarketProvenance };
export type PriceConfirmationMarketData = { symbol: string; snapshot: RealtimeSnapshot;
  minuteBars: IntradayBar[]; sessionVwap: number | null; extendedHoursRequested: boolean };
