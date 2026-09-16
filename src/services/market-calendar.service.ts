import { prisma } from '../db/prisma.js';
import type { PrismaClient } from '@prisma/client';
import type { CalendarException } from './market-calendar.js';

export async function calendarExceptions(from: string, to: string, db: PrismaClient = prisma): Promise<CalendarException[]> {
  const rows = await db.marketCalendarException.findMany({ where: { sessionDate: { gte: new Date(from), lte: new Date(to) } }, orderBy: { sessionDate: 'asc' } });
  return rows.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) }));
}
export async function listCalendar(year: number) {
  return prisma.marketCalendarException.findMany({ where: { sessionDate: { gte: new Date(`${year}-01-01`), lt: new Date(`${year + 1}-01-01`) } }, orderBy: { sessionDate: 'asc' } });
}
export async function saveCalendar(input: CalendarException & { name: string }, id?: number) {
  const data = { ...input, sessionDate: new Date(input.sessionDate) };
  return id === undefined ? prisma.marketCalendarException.create({ data }) : prisma.marketCalendarException.update({ where: { id }, data });
}
export async function deleteCalendar(id: number) { return prisma.marketCalendarException.delete({ where: { id } }); }
