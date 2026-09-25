/** Research-only defaults. No production algorithm or trading configuration. */
export const TREND_SYMBOLS = ['SPY', 'RSP'] as const;
export type TrendSymbol = typeof TREND_SYMBOLS[number];
export const TREND_RESEARCH_START = '2012-01-01';
export const TREND_PRE_ROLL_SESSIONS = 250;
export const TREND_PRE_ROLL_CALENDAR_DAYS = 550;
export { MAX_BACKFILL_DAYS, DAILY_SYNC_RETRY_MS } from './market-daily-evidence.definition.js';
