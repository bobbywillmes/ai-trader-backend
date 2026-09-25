import { addDays, COMPLETION_GRACE_MINUTES, etDate, isFullMarketSession, marketSession, type CalendarException } from './market-calendar.js';
import { VERIFIED_NYSE_CALENDAR } from './market-calendar-bootstrap.definition.js';
import { PARTICIPATION_BASELINE_SESSIONS } from './participation-v1.definition.js';

export const participationDueAt = (close: Date) => new Date(+close + COMPLETION_GRACE_MINUTES.DAY_1 * 60_000);
export function calendarIssue(date: string, exceptions: readonly CalendarException[]): string | null {
  if (date < VERIFIED_NYSE_CALENDAR.from || date > VERIFIED_NYSE_CALENDAR.to) return 'OUTSIDE_REVIEWED_HORIZON';
  const rows = exceptions.filter(e => e.sessionDate === date);
  if (rows.length > 1) return 'DUPLICATE_EXCEPTION';
  const expected = VERIFIED_NYSE_CALENDAR.closedDates.some(d => d === date) ? 'CLOSED'
    : VERIFIED_NYSE_CALENDAR.earlyCloseDates.includes(date) ? 'EARLY_CLOSE' : null;
  if (expected && (!rows[0] || rows[0].type !== expected || rows[0].closeTimeMinutesEt !== (expected === 'CLOSED' ? null : 780))) return 'MISSING_OR_CONFLICTING_REVIEWED_EXCEPTION';
  try { marketSession(date, exceptions); } catch { return 'INVALID_EXCEPTION'; }
  return null;
}
/** Selection cannot skip a date whose full-session identity cannot be trusted. */
export function selectParticipationSession(date: string, direction: 1 | -1, exceptions: readonly CalendarException[], now?: Date) {
  for (let i = 0; i < 370; i++, date = addDays(date, direction)) {
    if (calendarIssue(date, exceptions)) throw new Error('PARTICIPATION_V1 target calendar authority unavailable; operator review required.');
    if (isFullMarketSession(date, exceptions)) {
      const session = marketSession(date, exceptions)!;
      if (!now || participationDueAt(session.closeAt) <= now) return session;
    }
  }
  throw new Error('PARTICIPATION_V1 target calendar horizon exhausted.');
}
export function latestParticipationSession(now: Date, exceptions: readonly CalendarException[]) {
  return selectParticipationSession(etDate(now), -1, exceptions, now);
}
export function planParticipationWindow(date: string, exceptions: readonly CalendarException[]) {
  const baselineDates: string[] = [], excludedEarlyCloseDates: string[] = [];
  const failures: { sessionDate: string; code: string }[] = [];
  const inspect = (d: string) => { const issue = calendarIssue(d, exceptions); if (issue) failures.push({ sessionDate: d, code: issue }); };
  inspect(date);
  let cursor = addDays(date, -1);
  for (let i = 0; i < 370 && cursor >= VERIFIED_NYSE_CALENDAR.from && baselineDates.length < PARTICIPATION_BASELINE_SESSIONS; i++, cursor = addDays(cursor, -1)) {
    inspect(cursor);
    if (exceptions.some(e => e.sessionDate === cursor && e.type === 'EARLY_CLOSE')) excludedEarlyCloseDates.push(cursor);
    try { if (isFullMarketSession(cursor, exceptions)) baselineDates.unshift(cursor); } catch { /* Recorded above. */ }
  }
  let next: ReturnType<typeof marketSession> = null;
  for (let i = 1; i <= 370; i++) {
    const d = addDays(date, i); inspect(d);
    if (d > VERIFIED_NYSE_CALENDAR.to) break;
    if (exceptions.some(e => e.sessionDate === d && e.type === 'EARLY_CLOSE')) excludedEarlyCloseDates.push(d);
    try { if (isFullMarketSession(d, exceptions)) { next = marketSession(d, exceptions); break; } } catch { /* Recorded above. */ }
  }
  if (!next && !failures.length) failures.push({ sessionDate: date, code: 'NEXT_FULL_SESSION_UNAVAILABLE' });
  const from = baselineDates[0] ?? date, through = next?.date ?? date;
  return { baselineDates, next, proposedValidUntil: next ? participationDueAt(next.closeAt) : null,
    calendar: { reviewedFrom: VERIFIED_NYSE_CALENDAR.from, reviewedThrough: VERIFIED_NYSE_CALENDAR.to,
      from, through, excludedEarlyCloseDates: excludedEarlyCloseDates.sort(),
      exceptions: exceptions.filter(e => e.sessionDate >= from && e.sessionDate <= through)
        .map(e => ({ sessionDate: e.sessionDate, type: e.type, closeTimeMinutesEt: e.closeTimeMinutesEt })).sort((a, b) => a.sessionDate.localeCompare(b.sessionDate)),
      failures: failures.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate)) } };
}
