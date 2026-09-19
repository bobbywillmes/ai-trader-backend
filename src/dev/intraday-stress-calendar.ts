import type { CalendarException } from '../services/market-calendar.js';
import { volatilityResearchExceptions } from './volatility-research-calendar.js';

/** Research-only additions from the NYSE releases cited in the report; never persisted. */
export const EARLY_CLOSE_DATES = ['2021-11-26', '2022-11-25', '2023-07-03', '2023-11-24',
  '2024-07-03', '2024-11-29', '2024-12-24', '2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24'];
export function researchCalendar(stored: readonly CalendarException[]): CalendarException[] {
  const map = new Map(volatilityResearchExceptions(stored).map(x => [x.sessionDate, x]));
  for (const sessionDate of EARLY_CLOSE_DATES) {
    const row = map.get(sessionDate);
    if (row && (row.type !== 'EARLY_CLOSE' || row.closeTimeMinutesEt !== 780)) throw new Error(`Research/operator early-close conflict: ${sessionDate}`);
    map.set(sessionDate, row ?? { sessionDate, type: 'EARLY_CLOSE', closeTimeMinutesEt: 780, name: 'NYSE published early close (research only)' });
  }
  return [...map.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}
