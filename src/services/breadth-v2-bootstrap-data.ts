import { Prisma, type PrismaClient } from '@prisma/client';
import { addDays, datesBetween, marketSession, type CalendarException } from './market-calendar.js';
import { constituentHash } from './security-universe-import.service.js';
import { BREADTH_V2_BOOTSTRAP, BreadthV2BootstrapAccumulator } from './breadth-v2-bootstrap.js';
import type { ResearchBar } from './breadth-v2-measurement-calculation.js';

type Db = PrismaClient | Prisma.TransactionClient;
type TargetSet = { breadthUniverseRevisionId: number; universeCount: number; evidenceJson: Prisma.JsonValue };
const iso = (date: Date) => date.toISOString().slice(0, 10);
const BATCH_SIZE = 25;

/** A bounded-memory read of persisted canonical bars for one target observation's frozen population. */
export async function replayBreadthV2Bootstrap(db: Db, target: TargetSet, replayThrough: string) {
  const from = BREADTH_V2_BOOTSTRAP.replayFrom;
  if (replayThrough < from) throw new Error('Bootstrap replay has no historical sessions.');
  const revision = await db.breadthUniverseRevision.findUnique({ where: { id: target.breadthUniverseRevisionId } });
  const membership = await db.breadthUniverseRevisionMember.findMany({ where: { revisionId: target.breadthUniverseRevisionId }, include: { security: { select: { symbol: true } } } });
  if (!revision || !membership.length || revision.memberCount !== membership.length || target.universeCount !== membership.length || new Set(membership.map(row => row.securityId)).size !== membership.length) throw new Error('Bootstrap target revision integrity failure.');
  const members = membership.map(row => ({ securityId: row.securityId, symbol: row.security.symbol })).sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
  if (new Set(members.map(row => row.symbol)).size !== members.length) throw new Error('Bootstrap target revision symbol integrity failure.');
  const populationHash = constituentHash(members.map(row => row.symbol));
  const source = target.evidenceJson;
  if (!source || typeof source !== 'object' || Array.isArray(source) || source.constituentHash !== populationHash || source.revisionId !== revision.id || source.memberCount !== members.length) throw new Error('Bootstrap target observation population provenance differs from the frozen revision.');
  const warmupFrom = addDays(from, -75);
  const calendarRows = await db.marketCalendarException.findMany({ where: { sessionDate: { gte: new Date(warmupFrom), lte: new Date(replayThrough) } }, orderBy: { sessionDate: 'asc' } });
  const exceptions: CalendarException[] = calendarRows.map(row => ({ sessionDate: iso(row.sessionDate), type: row.type, closeTimeMinutesEt: row.closeTimeMinutesEt }));
  const sessions = datesBetween(warmupFrom, replayThrough).filter(date => marketSession(date, exceptions));
  if (sessions.filter(date => date < from).length < 20) throw new Error('Twenty reviewed warmup sessions unavailable.');
  const accumulator = new BreadthV2BootstrapAccumulator(sessions, from, replayThrough, revision.id, populationHash);
  for (let offset = 0; offset < members.length; offset += BATCH_SIZE) {
    const batch = members.slice(offset, offset + BATCH_SIZE);
    const rows = await db.marketBar.findMany({ where: { securityId: { in: batch.map(row => row.securityId) }, timeframe: 'DAY_1', barStartAt: { gte: new Date(warmupFrom), lt: new Date(addDays(replayThrough, 1)) } }, select: { securityId: true, barStartAt: true, provider: true, adjustmentMode: true, close: true, splitFactor: true, receivedAt: true }, orderBy: [{ securityId: 'asc' }, { barStartAt: 'asc' }] });
    const bySecurity = new Map<number, typeof rows>();
    for (const row of rows) { const found = bySecurity.get(row.securityId) ?? []; found.push(row); bySecurity.set(row.securityId, found); }
    for (const member of batch) {
      const bars = new Map<string, ResearchBar>();
      const evidence: string[] = [];
      for (const row of bySecurity.get(member.securityId) ?? []) {
        if (row.provider !== 'TIINGO') continue;
        const date = iso(row.barStartAt);
        if (row.barStartAt.toISOString().slice(11) !== '00:00:00.000Z' || row.adjustmentMode !== 'UNADJUSTED' || !row.close.isFinite() || row.close.lte(0) || !row.splitFactor || !row.splitFactor.isFinite() || row.splitFactor.lte(0)) throw new Error(`Invalid historical Tiingo DAY_1 evidence for ${member.symbol} ${date}.`);
        if (bars.has(date)) throw new Error(`Duplicate historical Tiingo DAY_1 evidence for ${member.symbol} ${date}.`);
        const close = row.close.toString(), splitFactor = row.splitFactor.toString();
        bars.set(date, { close, splitFactor });
        evidence.push(`${date}:${close}:${splitFactor}:${row.receivedAt.toISOString()}`);
      }
      accumulator.addMember(member, bars, evidence);
    }
  }
  return accumulator.finish();
}
