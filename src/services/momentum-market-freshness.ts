import { getNewYorkMarketTiming } from './momentum-price-score.js';

export type MarketObservationSource = 'LAST_TRADE' | 'QUOTE' | 'AGGREGATE' | 'SNAPSHOT' | 'UNKNOWN';
export type MarketSession = 'PREMARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED';

const MAX_AGE_SECONDS: Record<MarketSession, number> = {
  PREMARKET: 15 * 60,
  REGULAR: 5 * 60,
  AFTER_HOURS: 15 * 60,
  CLOSED: 0,
};

function newYorkDate(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function evaluateMarketFreshness(input: {
  evaluatedAt: Date;
  marketObservationAt: Date | null;
  marketObservationSource: MarketObservationSource;
  extendedHoursRequested: boolean;
}) {
  const marketSession = getNewYorkMarketTiming(input.evaluatedAt).marketSession;
  const maxAllowedAgeSeconds = MAX_AGE_SECONDS[marketSession];
  const marketObservationAgeSeconds = input.marketObservationAt === null ? null :
    Math.max(0, (input.evaluatedAt.getTime() - input.marketObservationAt.getTime()) / 1_000);
  const currentMarketDate = input.marketObservationAt !== null &&
    newYorkDate(input.marketObservationAt) === newYorkDate(input.evaluatedAt);
  const extendedSession = marketSession === 'PREMARKET' || marketSession === 'AFTER_HOURS';
  const extendedHoursObservationAvailable = extendedSession && currentMarketDate;
  const incompleteReason = marketSession === 'CLOSED'
    ? 'AWAITING_MARKET_SESSION'
    : input.marketObservationAt === null || !currentMarketDate ||
        marketObservationAgeSeconds === null || marketObservationAgeSeconds > maxAllowedAgeSeconds
      ? 'AWAITING_FRESH_PRICE_DATA'
      : null;

  return {
    evaluatedAt: input.evaluatedAt.toISOString(),
    marketObservationAt: input.marketObservationAt?.toISOString() ?? null,
    marketObservationSource: input.marketObservationSource,
    marketObservationAgeSeconds,
    maxAllowedAgeSeconds,
    marketSession,
    extendedHoursRequested: input.extendedHoursRequested,
    extendedHoursObservationAvailable,
    incompleteReason,
  };
}
