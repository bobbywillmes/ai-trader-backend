import type { MarketBar, Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { barEligibility, etDate, etInstant, marketSession, validDate, type CalendarException } from './market-calendar.js';

export const MARKET_DAILY_AUTHORITY_VERSION = 'SESSION_BOUNDARIES_V2';
export const TIINGO_DAY_1_ELIGIBLE_MINUTES_ET = 20 * 60 + 15;
export type DailyProvider = 'MASSIVE' | 'TIINGO';
export function dailySessionEligible(date: string, now: Date, exceptions: readonly CalendarException[]): boolean {
  if (!marketSession(date, exceptions)) return false;
  return marketDailyAuthority(date).provider === 'TIINGO' ? now >= etInstant(date, TIINGO_DAY_1_ELIGIBLE_MINUTES_ET)
    : barEligibility('DAY_1', etInstant(date, 0), now, exceptions).status === 'ELIGIBLE';
}
export function marketDailyAuthority(sessionDate: string, cutoverSession: string | null | undefined = env.MARKET_DAILY_TIINGO_CUTOVER_SESSION,
  massiveResumeSession: string | null | undefined = env.MARKET_DAILY_MASSIVE_RESUME_SESSION) {
  if (!validDate(sessionDate)) throw new Error('Invalid daily market session date.');
  if (cutoverSession != null && !validDate(cutoverSession)) throw new Error('Invalid MARKET_DAILY_TIINGO_CUTOVER_SESSION; expected YYYY-MM-DD.');
  if (massiveResumeSession != null && !validDate(massiveResumeSession)) throw new Error('Invalid MARKET_DAILY_MASSIVE_RESUME_SESSION; expected YYYY-MM-DD.');
  if (massiveResumeSession != null && cutoverSession == null) throw new Error('MARKET_DAILY_MASSIVE_RESUME_SESSION requires MARKET_DAILY_TIINGO_CUTOVER_SESSION.');
  if (massiveResumeSession != null && cutoverSession != null && massiveResumeSession <= cutoverSession)
    throw new Error('MARKET_DAILY_MASSIVE_RESUME_SESSION must be later than MARKET_DAILY_TIINGO_CUTOVER_SESSION.');
  const tiingo = cutoverSession != null && sessionDate >= cutoverSession && (massiveResumeSession == null || sessionDate < massiveResumeSession);
  return { provider: tiingo ? 'TIINGO' as const : 'MASSIVE' as const,
    authorityVersion: MARKET_DAILY_AUTHORITY_VERSION, cutoverSession: cutoverSession ?? null, massiveResumeSession: massiveResumeSession ?? null };
}
export function dailyAuthoritySegments(from: string, through: string) {
  if (!validDate(from) || !validDate(through) || from > through) throw new Error('Invalid daily authority segment range.');
  const authority = marketDailyAuthority(through);
  const starts = [from, authority.cutoverSession, authority.massiveResumeSession]
    .filter((date): date is string => date !== null && date >= from && date <= through).sort();
  const uniqueStarts = [...new Set(starts)];
  return uniqueStarts.map((start, index) => ({ provider: marketDailyAuthority(start).provider, from: start,
    through: index + 1 < uniqueStarts.length ? addDate(uniqueStarts[index + 1]!, -1) : through }));
}
/** Provider-specific storage timestamps represent the same logical NY market session. */
export function canonicalDailySessionDate(barStartAt: Date, provider: DailyProvider): string {
  if (Object.prototype.toString.call(barStartAt) !== '[object Date]' || !Number.isFinite(barStartAt.getTime())) throw new Error('Invalid DAY_1 timestamp.');
  if (provider === 'TIINGO') {
    if (barStartAt.toISOString().slice(11) !== '00:00:00.000Z') throw new Error('Invalid Tiingo DAY_1 UTC-midnight timestamp.');
    return barStartAt.toISOString().slice(0, 10);
  }
  const date = etDate(barStartAt);
  if (barStartAt.getTime() !== etInstant(date, 0).getTime()) throw new Error('Invalid Massive DAY_1 New York-midnight timestamp.');
  return date;
}
export type CanonicalDailyRow = MarketBar & { sessionDate: string };
export function validateCanonicalDailyRows(rows: readonly MarketBar[], from: string, through: string): CanonicalDailyRow[] {
  if (!validDate(from) || !validDate(through) || from > through) throw new Error('Invalid canonical DAY_1 range.');
  const seen = new Set<string>();
  const result: CanonicalDailyRow[] = [];
  for (const row of rows) {
    if (row.timeframe !== 'DAY_1' || row.adjustmentMode !== 'UNADJUSTED' || (row.provider !== 'MASSIVE' && row.provider !== 'TIINGO')) throw new Error('Invalid canonical DAY_1 identity.');
    const sessionDate = canonicalDailySessionDate(row.barStartAt, row.provider);
    if (sessionDate < from || sessionDate > through) continue;
    const key = `${row.securityId}:${sessionDate}`;
    if (seen.has(key)) throw new Error(`Duplicate canonical DAY_1 logical session ${key}.`);
    seen.add(key);
    if (row.provider !== marketDailyAuthority(sessionDate).provider) throw new Error(`Canonical DAY_1 provider conflict ${key}: ${row.provider}.`);
    result.push({ ...row, sessionDate });
  }
  return result.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.securityId - b.securityId);
}
type DailyReaderTx = Pick<Prisma.TransactionClient, 'marketBar' | 'setting'>;
export async function readCanonicalDailyBars(tx: DailyReaderTx, securityIds: readonly number[], from: string, through: string): Promise<CanonicalDailyRow[]> {
  if (dailyAuthoritySegments(from, through).some(segment => segment.provider === 'TIINGO')
    && (await tx.setting.findUnique({ where: { key: 'tiingoDailyIngestionPaused' } }))?.value === 'true')
    throw new Error('Tiingo DAY_1 consumption is paused after retention purge.');
  const rows = await tx.marketBar.findMany({ where: { securityId: { in: [...securityIds] }, timeframe: 'DAY_1',
    barStartAt: { gte: new Date(`${from}T00:00:00Z`), lt: new Date(`${nextDate(through)}T00:00:00Z`) } }, orderBy: [{ barStartAt: 'asc' }, { id: 'asc' }] });
  return validateCanonicalDailyRows(rows, from, through);
}
function addDate(date: string, days: number) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10); }
function nextDate(date: string) { return addDate(date, 1); }
export function dailyProviderProvenance(rows: readonly CanonicalDailyRow[], from: string, through: string) {
  const relevant = rows.filter(row => row.sessionDate >= from && row.sessionDate <= through).sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  const segments: { provider: DailyProvider; from: string; through: string; count: number }[] = [];
  for (const row of relevant) {
    const last = segments.at(-1);
    if (last?.provider === row.provider) { last.through = row.sessionDate; last.count++; }
    else segments.push({ provider: row.provider as DailyProvider, from: row.sessionDate, through: row.sessionDate, count: 1 });
  }
  const authority = marketDailyAuthority(through);
  return { authorityVersion: MARKET_DAILY_AUTHORITY_VERSION, cutoverSession: authority.cutoverSession, massiveResumeSession: authority.massiveResumeSession,
    providersPresent: [...new Set(relevant.map(row => row.provider))], providerSegments: segments };
}
