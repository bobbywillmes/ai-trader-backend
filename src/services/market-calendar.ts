/** US equity regular sessions. Calendar exceptions are prospective operator configuration. */
export const MARKET_TIME_ZONE = 'America/New_York';
export const SESSION_OPEN_MINUTES = 570;
export const SESSION_CLOSE_MINUTES = 960;
export const COMPLETION_GRACE_MINUTES = { DAY_1: 30, MINUTE_15: 5 } as const;
export type CalendarException = { sessionDate: string; name?: string; type: 'CLOSED' | 'EARLY_CLOSE'; closeTimeMinutesEt: number | null };
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: MARKET_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function etDate(date: Date): string { return dateFormatter.format(date); }
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
export function datesBetween(from: string, to: string): string[] {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('Invalid calendar range.');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days > 6_000) throw new Error('Calendar range exceeds 6000 days.');
  return Array.from({ length: days + 1 }, (_, i) => addDays(from, i));
}
export function isWeekend(date: string): boolean { return [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()); }
/** Session dates use the offset at local noon; US DST changes happen outside session hours. */
export function etInstant(date: string, minutes: number): Date {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const [h, m] = timeFormatter.format(noonUtc).split(':').map(Number);
  const offsetMinutes = h! * 60 + m! - 720;
  return new Date(Date.parse(`${date}T00:00:00Z`) + (minutes - offsetMinutes) * 60_000);
}
export function marketSession(date: string, exceptions: readonly CalendarException[] = []) {
  if (!validDate(date)) throw new Error('Invalid session date.');
  const exception = exceptions.find(row => row.sessionDate === date);
  if (isWeekend(date) || exception?.type === 'CLOSED') return null;
  const closeMinutes = exception?.type === 'EARLY_CLOSE' ? exception.closeTimeMinutesEt : SESSION_CLOSE_MINUTES;
  if (closeMinutes === null || closeMinutes <= SESSION_OPEN_MINUTES || closeMinutes > SESSION_CLOSE_MINUTES) throw new Error('Invalid session close.');
  return { date, openAt: etInstant(date, SESSION_OPEN_MINUTES), closeAt: etInstant(date, closeMinutes), closeMinutes };
}
/** Full regular session only; DAY_1 eligibility intentionally also permits early closes. */
export function isFullMarketSession(date: string, exceptions: readonly CalendarException[] = []): boolean {
  const session = marketSession(date, exceptions);
  return session !== null && session.closeMinutes === SESSION_CLOSE_MINUTES &&
    !exceptions.some(row => row.sessionDate === date && row.type === 'EARLY_CLOSE');
}
export function barEligibility(timeframe: 'DAY_1' | 'MINUTE_15', start: Date, now: Date, exceptions: readonly CalendarException[] = []) {
  const session = marketSession(etDate(start), exceptions);
  if (!session) return { status: 'CLOSED' as const, eligibleAt: null };
  const end = timeframe === 'DAY_1' ? session.closeAt : new Date(start.getTime() + 15 * 60_000);
  if (timeframe === 'MINUTE_15' && (start < session.openAt || end > session.closeAt)) return { status: 'CLOSED' as const, eligibleAt: null };
  const eligibleAt = new Date(end.getTime() + COMPLETION_GRACE_MINUTES[timeframe] * 60_000);
  return { status: now >= eligibleAt ? 'ELIGIBLE' as const : 'NOT_YET_ELIGIBLE' as const, eligibleAt };
}
