import type { CalendarException } from '../services/market-calendar.js';

/** Reviewed research input only. Never persisted or imported by production workers.
 * Full-day closures, not inferred from missing prices. Early closes remain sessions;
 * absent an operator early-close entry, completion is conservatively after 16:30 ET.
 */
export const VOLATILITY_RESEARCH_CALENDAR = {
  from: '2021-01-01', to: '2026-12-31',
  sources: [
    'https://ir.theice.com/press/news-details/2020/NYSE-Group-Announces-2021-2022-and-2023-Holiday-and-Early-Closings-Calendar/default.aspx',
    'https://ir.theice.com/press/news-details/2021/NYSE-Group-Announces-2022-2023-and-2024-Holiday-and-Early-Closings-Calendar/default.aspx',
    'https://ir.theice.com/press/news-details/2023/NYSE-Group-Announces-2024-2025-and-2026-Holiday-and-Early-Closings-Calendar/default.aspx',
    'https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx',
  ],
  closedDates: [
    '2021-01-01', '2021-01-18', '2021-02-15', '2021-04-02', '2021-05-31', '2021-07-05', '2021-09-06', '2021-11-25', '2021-12-24',
    '2022-01-17', '2022-02-21', '2022-04-15', '2022-05-30', '2022-06-20', '2022-07-04', '2022-09-05', '2022-11-24', '2022-12-26',
    '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07', '2023-05-29', '2023-06-19', '2023-07-04', '2023-09-04', '2023-11-23', '2023-12-25',
    '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
    '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  ],
} as const;

export function volatilityResearchExceptions(stored: readonly CalendarException[]): CalendarException[] {
  const merged = new Map<string, CalendarException>(VOLATILITY_RESEARCH_CALENDAR.closedDates.map(sessionDate => [sessionDate,
    { sessionDate, name: 'NYSE published full-day closure (research only)', type: 'CLOSED', closeTimeMinutesEt: null }]));
  for (const exception of stored) {
    if (merged.has(exception.sessionDate) && exception.type !== 'CLOSED') throw new Error(`Research/operator calendar conflict on ${exception.sessionDate}.`);
    merged.set(exception.sessionDate, exception);
  }
  return [...merged.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}
