import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { VERIFIED_NYSE_CLOSURES } from './market-calendar-bootstrap.definition.js';
import type { CalendarException } from './market-calendar.js';

export const verifiedClosureRows: readonly (CalendarException & { name: string })[] = VERIFIED_NYSE_CLOSURES.closedDates.map(sessionDate => ({
  sessionDate, name: sessionDate === '2025-01-09' ? 'NYSE National Day of Mourning - Jimmy Carter' : 'NYSE verified full-day closure',
  type: 'CLOSED', closeTimeMinutesEt: null,
}));
const canonicalName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
export function planCalendarBootstrap(existing: readonly CalendarException[]) {
  const missing: typeof verifiedClosureRows[number][] = [];
  const skipped: string[] = [];
  const conflicts: { sessionDate: string; expected: typeof verifiedClosureRows[number]; existing: CalendarException }[] = [];
  for (const expected of verifiedClosureRows) {
    const row = existing.find(row => row.sessionDate === expected.sessionDate);
    if (!row) missing.push(expected);
    else if (row.type === expected.type && row.closeTimeMinutesEt === null && canonicalName(row.name ?? '') === canonicalName(expected.name)) skipped.push(row.sessionDate);
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
