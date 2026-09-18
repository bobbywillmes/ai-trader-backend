import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { fetchCommonStockUniverse, fetchGroupedDailyBars } from '../integrations/massive/breadth-reference.client.js';
import { addDays, barEligibility, datesBetween, etDate, etInstant, marketSession, type CalendarException } from './market-calendar.js';
import { BREADTH_V1_EVIDENCE_SCHEMA_VERSION, BREADTH_V1_UNIVERSE_DEFINITION_VERSION, computeDailyBreadthV1Observation } from './breadth-v1-calculation.js';
import { withBreadthObservationLock } from './breadth-observation-lock.service.js';

/** Live BREADTH_V1 observation ingestion. Massive only, never Alpaca. Bounded catch-up: at
 * most `MAX_SESSIONS_PER_RUN` missing sessions per invocation, so a recurring worker can
 * never fan out into the full historical bootstrap by accident. If MarketBreadthObservation
 * has never been bootstrapped, this refuses to infer a five-year fetch and reports
 * `bootstrapRequired: true` instead — the operator must run the bootstrap import first. */

const MAX_SESSIONS_PER_RUN = 5;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

function previousSession(date: string, exceptions: readonly CalendarException[]) {
  for (let i = 1; i <= 370; i++) {
    const session = marketSession(addDays(date, -i), exceptions);
    if (session) return session;
  }
  throw new Error('No previous eligible session within the calendar lookback horizon.');
}
function sortedRelevantEntries(universe: readonly string[], grouped: ReadonlyMap<string, number>): [string, number][] {
  return [...universe].filter(ticker => grouped.get(ticker) !== undefined).sort().map(ticker => [ticker, grouped.get(ticker)!]);
}

export type BreadthIngestionBlockReason = 'ZERO_DIRECTIONAL_BREADTH' | 'PROVIDER_FAILURE';
export type BreadthObservationIngestionResult = {
  bootstrapRequired: boolean; notDue: boolean; inserted: number; attempted: number;
  blocked: { sessionDate: string; reasonCode: BreadthIngestionBlockReason; message: string } | null;
};
type Options = { db?: PrismaClient; now?: Date; fetchGrouped?: typeof fetchGroupedDailyBars; fetchUniverse?: typeof fetchCommonStockUniverse };

export async function ingestDueBreadthObservations(options: Options = {}): Promise<BreadthObservationIngestionResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const fetchGrouped = options.fetchGrouped ?? fetchGroupedDailyBars;
  const fetchUniverse = options.fetchUniverse ?? fetchCommonStockUniverse;
  return withBreadthObservationLock(async () => {
    const bootstrapCount = await db.marketBreadthObservation.count();
    if (bootstrapCount === 0) return { bootstrapRequired: true, notDue: false, inserted: 0, attempted: 0, blocked: null };
    const latestObservation = await db.marketBreadthObservation.findFirst({ orderBy: { sessionDate: 'desc' } });
    const exceptionRows = await db.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } });
    const exceptions: CalendarException[] = exceptionRows.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) }));
    const today = etDate(now);
    const from = addDays(latestObservation!.sessionDate.toISOString().slice(0, 10), 1);
    const eligibleDates = from > today ? [] : datesBetween(from, today)
      .filter(date => marketSession(date, exceptions) && barEligibility('DAY_1', etInstant(date, 0), now, exceptions).status === 'ELIGIBLE');
    if (!eligibleDates.length) return { bootstrapRequired: false, notDue: true, inserted: 0, attempted: 0, blocked: null };

    let inserted = 0, attempted = 0;
    const groupedCache = new Map<string, ReadonlyMap<string, number>>();
    async function resolveGrouped(date: string): Promise<ReadonlyMap<string, number>> {
      const cached = groupedCache.get(date);
      if (cached) return cached;
      const bars = await fetchGrouped(date);
      groupedCache.set(date, bars);
      return bars;
    }

    for (const date of eligibleDates.slice(0, MAX_SESSIONS_PER_RUN)) {
      attempted++;
      const prior = previousSession(date, exceptions).date;
      try {
        const [currentBars, priorBars, universe] = await Promise.all([resolveGrouped(date), resolveGrouped(prior), fetchUniverse(date)]);
        const observation = computeDailyBreadthV1Observation(universe, currentBars, priorBars);
        if (observation.status !== 'VALID') {
          return { bootstrapRequired: false, notDue: false, inserted, attempted, blocked: { sessionDate: date, reasonCode: 'ZERO_DIRECTIONAL_BREADTH', message: `Zero directional names for ${date}; no fabricated observation was written.` } };
        }
        const session = marketSession(date, exceptions)!;
        const universeHash = hash([...universe].sort());
        const currentGroupedHash = hash(sortedRelevantEntries(universe, currentBars));
        const priorGroupedHash = hash(sortedRelevantEntries(universe, priorBars));
        const canonicalInputHash = hash({
          sessionDate: date, previousSessionDate: prior, universeHash, currentGroupedHash, priorGroupedHash,
          provider: 'MASSIVE', universeDefinitionVersion: BREADTH_V1_UNIVERSE_DEFINITION_VERSION, evidenceSchemaVersion: BREADTH_V1_EVIDENCE_SCHEMA_VERSION,
        });
        await db.marketBreadthObservation.create({ data: {
          sessionDate: new Date(date), previousSessionDate: new Date(prior), provider: 'MASSIVE',
          universeDefinitionVersion: BREADTH_V1_UNIVERSE_DEFINITION_VERSION, evidenceSchemaVersion: BREADTH_V1_EVIDENCE_SCHEMA_VERSION,
          universeCount: observation.universeCount, currentBarCount: observation.currentBarsFound, priorBarCount: observation.priorBarsFound,
          advancingCount: observation.advancingCount, decliningCount: observation.decliningCount, unchangedCount: observation.unchangedCount,
          directionalCount: observation.directionalCount, excludedCount: observation.excludedCount,
          advanceShare: observation.advanceShare!, netBreadth: observation.netBreadth!, dataThroughAt: session.closeAt,
          canonicalInputHash, evidenceJson: json({ source: 'LIVE_INGESTION', provenance: { universeHash, currentGroupedHash, priorGroupedHash } }),
          startedAt: now, completedAt: new Date(),
        } });
        inserted++;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue; // A concurrent writer already inserted this date.
        const message = error instanceof Error ? error.message : 'Unknown ingestion failure.';
        return { bootstrapRequired: false, notDue: false, inserted, attempted, blocked: { sessionDate: date, reasonCode: 'PROVIDER_FAILURE', message } };
      }
    }
    return { bootstrapRequired: false, notDue: false, inserted, attempted, blocked: null };
  });
}

export async function latestBreadthObservation() {
  return prisma.marketBreadthObservation.findFirst({ orderBy: { sessionDate: 'desc' } });
}
export async function listBreadthObservations(limit: number, beforeId?: number) {
  return prisma.marketBreadthObservation.findMany({ where: beforeId ? { id: { lt: beforeId } } : {}, orderBy: { id: 'desc' }, take: limit });
}
export async function getBreadthObservation(id: number) {
  return prisma.marketBreadthObservation.findUnique({ where: { id } });
}
