import type { CalendarException } from '../services/market-calendar.js';
import { VERIFIED_NYSE_CLOSURES } from '../services/market-calendar-bootstrap.definition.js';
import { volatilityResearchExceptions } from './volatility-research-calendar.js';

/** Adopted from production calendar bootstrap authority (market-calendar-bootstrap.definition.ts),
 * not a research-only duplicate: these NYSE early closes were verified here during
 * INTRADAY_STRESS_V1 research and have since been promoted into production. */
export const EARLY_CLOSE_DATES: readonly string[] = VERIFIED_NYSE_CLOSURES.earlyCloseDates;
export function researchCalendar(stored: readonly CalendarException[]): CalendarException[] {
  const map = new Map(volatilityResearchExceptions(stored).map(x => [x.sessionDate, x]));
  for (const sessionDate of EARLY_CLOSE_DATES) {
    const row = map.get(sessionDate);
    if (row && (row.type !== 'EARLY_CLOSE' || row.closeTimeMinutesEt !== VERIFIED_NYSE_CLOSURES.earlyCloseTimeMinutesEt)) throw new Error(`Research/operator early-close conflict: ${sessionDate}`);
    map.set(sessionDate, row ?? { sessionDate, type: 'EARLY_CLOSE', closeTimeMinutesEt: VERIFIED_NYSE_CLOSURES.earlyCloseTimeMinutesEt, name: 'NYSE verified 1:00 PM early close (adopted from production)' });
  }
  return [...map.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}
