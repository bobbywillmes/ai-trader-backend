import { env } from '../config/env.js';
import { validDate } from './market-calendar.js';

export const INTRADAY_AUTHORITY_VERSION = 'SESSION_CUTOVER_V1';
export function intradayAuthority(sessionDate: string, cutoverSession: string | undefined = env.INTRADAY_STRESS_TIINGO_CUTOVER_SESSION) {
  if (!validDate(sessionDate)) throw new Error('Invalid intraday session date.');
  if (cutoverSession !== undefined && !validDate(cutoverSession)) throw new Error('Invalid INTRADAY_STRESS_TIINGO_CUTOVER_SESSION; expected YYYY-MM-DD.');
  return { provider: cutoverSession !== undefined && sessionDate >= cutoverSession ? 'TIINGO' as const : 'MASSIVE' as const,
    authorityVersion: INTRADAY_AUTHORITY_VERSION, cutoverSession: cutoverSession ?? null };
}
