import { marketSession, validDate } from '../../services/market-calendar.js';
import { VERIFIED_NYSE_CLOSURES } from '../../services/market-calendar-bootstrap.definition.js';
import { researchCalendar } from '../intraday-stress-calendar.js';
import { hash } from './model.js';

export type SessionPlan = { date: string; openAt: string; closeAt: string; calendarHash: string; calendarFrom: string; calendarTo: string };
export function sessionPlan(date: string): SessionPlan {
  if (!validDate(date) || date < VERIFIED_NYSE_CLOSURES.from || date > VERIFIED_NYSE_CLOSURES.to) throw new Error('Session outside verified calendar coverage');
  const exceptions = researchCalendar([]);
  const session = marketSession(date, exceptions);
  if (!session) throw new Error('Not a regular trading session');
  if ((session.closeAt.getTime() - session.openAt.getTime()) % 900_000) throw new Error('Unsupported partial window');
  return { date, openAt: session.openAt.toISOString(), closeAt: session.closeAt.toISOString(), calendarHash: hash(exceptions),
    calendarFrom: VERIFIED_NYSE_CLOSURES.from, calendarTo: VERIFIED_NYSE_CLOSURES.to };
}
