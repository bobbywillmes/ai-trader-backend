import type { CalendarException } from '../services/market-calendar.js';
import { volatilityResearchExceptions } from './volatility-research-calendar.js';

import { VERIFIED_NYSE_EARLY_CLOSE_DATES } from '../services/market-calendar-bootstrap.definition.js';
export const EARLY_CLOSE_DATES = VERIFIED_NYSE_EARLY_CLOSE_DATES;
export function researchCalendar(stored: readonly CalendarException[]): CalendarException[] {
  const map = new Map(volatilityResearchExceptions(stored).map(x => [x.sessionDate, x]));
  for (const sessionDate of EARLY_CLOSE_DATES) {
    const row = map.get(sessionDate);
    if (row && (row.type !== 'EARLY_CLOSE' || row.closeTimeMinutesEt !== 780)) throw new Error(`Research/operator early-close conflict: ${sessionDate}`);
    map.set(sessionDate, row ?? { sessionDate, type: 'EARLY_CLOSE', closeTimeMinutesEt: 780, name: 'NYSE published early close (research only)' });
  }
  return [...map.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}
