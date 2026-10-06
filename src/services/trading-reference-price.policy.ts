import { etDate, etMinutesOfDay, marketSession, type CalendarException } from './market-calendar.js';
import type { ReferencePriceEvidence } from './live-market-data.contracts.js';

export const TRADING_PRICE_MAX_AGE_MS = 5 * 60_000;
export const TRADING_PRICE_FUTURE_TOLERANCE_MS = 30_000;
export type TradingPricePhase = 'PREMARKET' | 'REGULAR' | 'POSTMARKET' | 'OVERNIGHT' | 'CLOSED';
export type TradingPriceRejection = 'PROVIDER_MISMATCH' | 'SYMBOL_MISMATCH' | 'PROVIDER_ERROR' |
  'MALFORMED_EVIDENCE' | 'INVALID_PRICE' | 'MISSING_OBSERVATION_TIMESTAMP' | 'MISSING_FETCH_TIMESTAMP' |
  'UNACCEPTED_BASIS' | 'OUTSIDE_TRADING_PRICE_SESSION' | 'OBSERVATION_OUTSIDE_TRADING_SESSION' |
  'FUTURE_OBSERVATION' | 'STALE_OBSERVATION';
export type TradingReferencePrice = Pick<ReferencePriceEvidence, 'symbol' | 'provider' | 'basis' | 'price' | 'observedAt' | 'fetchedAt'> & {
  ageMs: number | null; clockSkewMs: number | null; sessionPhase: TradingPricePhase;
  usable: boolean; rejectionReason: TradingPriceRejection | null;
};

function timestamp(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function tradingPricePhase(now: Date, exceptions: readonly CalendarException[]): TradingPricePhase {
  const session = marketSession(etDate(now), exceptions);
  if (!session) return 'CLOSED';
  if (now >= session.openAt && now < session.closeAt) return 'REGULAR';
  const minute = etMinutesOfDay(now);
  if (minute >= 240 && now < session.openAt) return 'PREMARKET';
  if (now >= session.closeAt && minute < 1200) return 'POSTMARKET';
  return 'OVERNIGHT';
}

/** Pure trading eligibility. Evaluate at decision time, independent of fetch-time display freshness. */
export function evaluateTradingReferencePrice(symbol: string, evidence: ReferencePriceEvidence, now: Date,
  exceptions: readonly CalendarException[]): TradingReferencePrice {
  const expected = symbol.trim().toUpperCase();
  const phase = tradingPricePhase(now, exceptions);
  const observed = timestamp(evidence.observedAt);
  const fetched = timestamp(evidence.fetchedAt);
  const session = marketSession(etDate(now), exceptions);
  const ageMs = observed === null ? null : now.getTime() - observed;
  const clockSkewMs = ageMs !== null && ageMs < 0 ? -ageMs : null;
  const rejectionReason: TradingPriceRejection | null = phase !== 'REGULAR' ? 'OUTSIDE_TRADING_PRICE_SESSION'
    : evidence.provider !== 'TIINGO_CONSOLIDATED' ? 'PROVIDER_MISMATCH'
    : evidence.symbol !== expected ? 'SYMBOL_MISMATCH'
      : evidence.providerError !== null || evidence.unavailableReason === 'PROVIDER_ERROR' ? 'PROVIDER_ERROR'
        : evidence.unavailableReason === 'MALFORMED_RESPONSE' ? 'MALFORMED_EVIDENCE'
          : typeof evidence.price !== 'number' || !Number.isFinite(evidence.price) || evidence.price <= 0 ? 'INVALID_PRICE'
          : observed === null ? 'MISSING_OBSERVATION_TIMESTAMP'
            : fetched === null ? 'MISSING_FETCH_TIMESTAMP'
              : evidence.basis !== 'TIINGO_TNGO_LAST' ? 'UNACCEPTED_BASIS'
                : session && (observed < session.openAt.getTime() || observed >= session.closeAt.getTime())
                    ? 'OBSERVATION_OUTSIDE_TRADING_SESSION'
                    : ageMs! < -TRADING_PRICE_FUTURE_TOLERANCE_MS ? 'FUTURE_OBSERVATION'
                    : ageMs! > TRADING_PRICE_MAX_AGE_MS ? 'STALE_OBSERVATION' : null;
  return { symbol: evidence.symbol, provider: evidence.provider, basis: evidence.basis, price: evidence.price,
    observedAt: evidence.observedAt, fetchedAt: evidence.fetchedAt, ageMs, clockSkewMs,
    sessionPhase: phase, usable: rejectionReason === null, rejectionReason };
}
