import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { VERIFIED_NYSE_CALENDAR } from './market-calendar-bootstrap.definition.js';
import type { CalendarException } from './market-calendar.js';

const verifiedFullClosureRows: readonly (CalendarException & { name: string })[] = VERIFIED_NYSE_CALENDAR.closedDates.map(sessionDate => ({
  sessionDate, name: sessionDate === '2025-01-09' ? 'NYSE National Day of Mourning - Jimmy Carter' : 'NYSE verified full-day closure',
  type: 'CLOSED', closeTimeMinutesEt: null,
}));
export const verifiedCalendarRows: readonly (CalendarException & { name: string })[] = [...verifiedFullClosureRows,
  ...VERIFIED_NYSE_CALENDAR.earlyCloseDates.map(sessionDate => ({ sessionDate, name: 'NYSE verified early close', type: 'EARLY_CLOSE' as const, closeTimeMinutesEt: 780 })),
].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
/** Kept for existing callers that use this historical export as the verified calendar fixture. */
export const verifiedClosureRows = verifiedCalendarRows;
/** Runtime calendar authority is sessionDate + type + closeTimeMinutesEt; the descriptive name is informational and never a conflict. */
export function planCalendarBootstrap(existing: readonly CalendarException[]) {
  const missing: typeof verifiedCalendarRows[number][] = [];
  const skipped: string[] = [];
  const conflicts: { sessionDate: string; expected: typeof verifiedCalendarRows[number]; existing: CalendarException }[] = [];
  for (const expected of verifiedCalendarRows) {
    const row = existing.find(row => row.sessionDate === expected.sessionDate);
    if (!row) missing.push(expected);
    else if (row.type === expected.type && row.closeTimeMinutesEt === expected.closeTimeMinutesEt) skipped.push(row.sessionDate);
    else conflicts.push({ sessionDate: expected.sessionDate, expected, existing: row });
  }
  return { missing, skipped, conflicts };
}
/** Explicit operator command only. Preflight every row; conflicts mean zero writes.
 * Table lock also excludes concurrent ordinary UI writes while comparing/inserting.
 */
export async function bootstrapMarketCalendar(apply = false, db: PrismaClient = prisma) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`LOCK TABLE "MarketCalendarException" IN SHARE ROW EXCLUSIVE MODE`;
    const rows = await tx.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } });
    const plan = planCalendarBootstrap(rows.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) })));
    if (plan.conflicts.length || !apply) return { applied: false, inserted: 0, skipped: plan.skipped.length, conflicts: plan.conflicts, wouldInsert: plan.missing.length };
    if (plan.missing.length) await tx.marketCalendarException.createMany({ data: plan.missing.map(row => ({ ...row, sessionDate: new Date(row.sessionDate) })) });
    return { applied: true, inserted: plan.missing.length, skipped: plan.skipped.length, conflicts: [], wouldInsert: 0 };
  });
}
