import { calendarExceptions } from './market-calendar.service.js';
import { etDate } from './market-calendar.js';
import { verifyReferencePrice } from './live-market-data.service.js';
import {
  evaluateTradingReferencePrice,
  type TradingReferencePrice,
} from './trading-reference-price.policy.js';

export type TradingReferencePriceDependencies = {
  calendar?: typeof calendarExceptions;
  verify?: typeof verifyReferencePrice;
};

/**
 * The sole production entrypoint for actionable trading reference prices.
 * Tiingo consolidated is authoritative and there is deliberately no fallback.
 */
export async function getTradingReferencePrice(
  symbol: string,
  now = new Date(),
  dependencies: TradingReferencePriceDependencies = {}
): Promise<TradingReferencePrice> {
  const normalized = symbol.trim().toUpperCase();
  const calendar = dependencies.calendar ?? calendarExceptions;
  const verify = dependencies.verify ?? verifyReferencePrice;
  const date = etDate(now);
  const [exceptions, evidence] = await Promise.all([
    calendar(date, date),
    verify(normalized, 'TIINGO_CONSOLIDATED', now),
  ]);

  return evaluateTradingReferencePrice(normalized, evidence, now, exceptions);
}
