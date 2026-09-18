import type { CalendarException } from '../services/market-calendar.js';

/** Reviewed research input only. Never persisted or imported by production workers.
 * Full-day closures, not inferred from missing prices. Early closes remain sessions;
 * absent an operator early-close entry, completion is conservatively after 16:30 ET.
 */
export { VERIFIED_NYSE_CLOSURES as VOLATILITY_RESEARCH_CALENDAR } from '../services/market-calendar-bootstrap.definition.js';
import { VERIFIED_NYSE_CLOSURES as VOLATILITY_RESEARCH_CALENDAR } from '../services/market-calendar-bootstrap.definition.js';

export function volatilityResearchExceptions(stored: readonly CalendarException[]): CalendarException[] {
  const merged = new Map<string, CalendarException>(VOLATILITY_RESEARCH_CALENDAR.closedDates.map(sessionDate => [sessionDate,
    { sessionDate, name: 'NYSE published full-day closure (research only)', type: 'CLOSED', closeTimeMinutesEt: null }]));
  for (const exception of stored) {
    if (merged.has(exception.sessionDate) && exception.type !== 'CLOSED') throw new Error(`Research/operator calendar conflict on ${exception.sessionDate}.`);
    merged.set(exception.sessionDate, exception);
  }
  return [...merged.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}
