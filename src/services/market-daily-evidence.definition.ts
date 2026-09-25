/** Account-independent acquisition identity; distinct from every calculation panel. */
export const MARKET_DAILY_EVIDENCE_SYMBOLS = Object.freeze(['SPY', 'QQQ', 'DIA', 'IWM', 'RSP'] as const);
export type DailyEvidenceSymbol = typeof MARKET_DAILY_EVIDENCE_SYMBOLS[number];
export const MAX_BACKFILL_DAYS = 370;
export const DAILY_SYNC_RETRY_MS = 60 * 60_000;
