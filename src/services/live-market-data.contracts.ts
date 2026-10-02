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

/** Read-only Phase 9B.1 evidence. These types do not select production authority. */
export type CapabilityProvider = 'MASSIVE' | 'TIINGO_CONSOLIDATED';
export type CapabilityUnavailableReason = 'PROVIDER_ERROR' | 'MALFORMED_RESPONSE' | 'NO_PRICE' |
  'PREVIOUS_CLOSE_ONLY' | 'MISSING_TIMESTAMP' | 'FUTURE_TIMESTAMP' | 'STALE_OBSERVATION' |
  'NO_MINUTES' | 'INCOMPLETE_MINUTES' | 'INVALID_MINUTE';
export type ReferencePriceEvidence = {
  symbol: string; provider: CapabilityProvider; price: number | null;
  basis: 'LAST_TRADE' | 'MINUTE_CLOSE' | 'DAY_CLOSE' | 'PREVIOUS_CLOSE' |
    'TIINGO_TNGO_LAST' | 'TIINGO_LQ_REF_PRICE' | null;
  observedAt: string | null; fetchedAt: string;
  freshness: 'FRESH' | 'STALE' | 'UNKNOWN' | 'FUTURE';
  available: boolean; unavailableReason: CapabilityUnavailableReason | null;
};
export type RegularMinute = { time: string; open: number; high: number; low: number; close: number; volume: number };
export type RegularSessionMinuteEvidence = {
  symbol: string; provider: CapabilityProvider; sessionDate: string;
  session: 'AMERICA_NEW_YORK_REGULAR_0930_1559'; adjustmentMode: 'UNADJUSTED';
  minutes: RegularMinute[]; expectedMinuteCount: number; observedMinuteCount: number;
  complete: boolean; observedThrough: string | null; cutoff: string;
  fetchedAt: string; unavailableReason: CapabilityUnavailableReason | null;
};
