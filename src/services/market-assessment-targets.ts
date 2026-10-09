import { addDays, barEligibility, datesBetween, etDate, etInstant, marketSession, type CalendarException } from './market-calendar.js';
import { dailySessionEligible } from './market-daily-authority.js';

function latestSession(now: Date, exceptions: readonly CalendarException[], eligible: (date: string) => boolean) {
  const today = etDate(now);
  const date = datesBetween(addDays(today, -370), today).reverse().find(eligible);
  if (!date) return null;
  const session = marketSession(date, exceptions);
  if (!session) throw new Error('Eligible daily assessment target has no market session.');
  return session;
}

/** Target authority shared with the canonical-provider daily publishers. */
export function latestCanonicalDailyAssessmentTarget(now: Date, exceptions: readonly CalendarException[]) {
  return latestSession(now, exceptions, date => dailySessionEligible(date, now, exceptions));
}

/** Target authority shared with the Massive-timed BREADTH_V1 publisher. */
export function latestBreadthV1AssessmentTarget(now: Date, exceptions: readonly CalendarException[]) {
  return latestSession(now, exceptions, date => barEligibility('DAY_1', etInstant(date, 0), now, exceptions).status === 'ELIGIBLE');
}
