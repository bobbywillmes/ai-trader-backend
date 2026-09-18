/** Research-only defaults. No production algorithm or trading configuration. */
export const TREND_SYMBOLS = ['SPY', 'RSP'] as const;
export type TrendSymbol = typeof TREND_SYMBOLS[number];
export const TREND_RESEARCH_START = '2012-01-01';
export const TREND_PRE_ROLL_SESSIONS = 250;
export const TREND_PRE_ROLL_CALENDAR_DAYS = 550;
export const MAX_BACKFILL_DAYS = 370;
export const DAILY_SYNC_RETRY_MS = 60 * 60_000;
