import { createHash } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { fetchCommonStockUniverse, fetchGroupedDailyBars } from '../integrations/massive/breadth-reference.client.js';
import { addDays, datesBetween, marketSession, type CalendarException } from '../services/market-calendar.js';
import {
  BASELINE_BREADTH_BANDS, BREADTH_DEFINITION, calculateBreadthSeries, computeDailyBreadthObservation, summarizeBreadth,
  type BreadthBandsByHorizon, type BreadthDay, type DailyBreadthObservation,
} from '../services/breadth-calculation.js';
import { volatilityResearchExceptions } from './volatility-research-calendar.js';
import { cachedFetch, DEFAULT_BREADTH_CACHE_DIR, mapWithConcurrency, readCached } from './breadth-research-cache.js';

/** Research only. Never writes MarketRegimeDimensionAssessment or any trading model.
 * The only database access is a read-only MarketCalendarException lookup; every other
 * input is fetched fresh from Massive (through a resumable local disk cache) and never
 * persisted to Postgres. No Alpaca dependency. */

// Observed via a live feasibility probe on 2026-09-17: ~5,256 CS/active tickers at the
// provider's 1000-per-page maximum. This is an estimate only; the actual page count is
// whatever the provider returns on the day the fetch runs.
const ASSUMED_UNIVERSE_PAGES_PER_SESSION = 6;

export type FetchGrouped = (date: string) => Promise<ReadonlyMap<string, number>>;
export type FetchUniverse = (date: string) => Promise<readonly string[]>;
type MinimalDb = { $transaction: typeof prisma.$transaction };

export type BreadthResearchOptions = {
  from: string; to: string;
  db?: MinimalDb;
  fetchGrouped?: FetchGrouped;
  fetchUniverse?: FetchUniverse;
  cacheDir?: string;
  fetchFromProvider?: boolean;
  refresh?: boolean;
  concurrency?: number;
  bandsByHorizon?: BreadthBandsByHorizon;
};

function previousSession(date: string, exceptions: readonly CalendarException[]) {
  for (let i = 1; i <= 370; i++) {
    const session = marketSession(addDays(date, -i), exceptions);
    if (session) return session;
  }
  throw new Error('No previous eligible session within the calendar lookback horizon.');
}

async function loadCalendarExceptions(db: MinimalDb): Promise<CalendarException[]> {
  const stored = await db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return tx.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } });
  }, { isolationLevel: 'RepeatableRead', timeout: 30_000 });
  return volatilityResearchExceptions(stored.map(row => ({ ...row, sessionDate: row.sessionDate.toISOString().slice(0, 10) })));
}

async function sessionPlan(options: Pick<BreadthResearchOptions, 'from' | 'to' | 'db'>) {
  const exceptions = await loadCalendarExceptions(options.db ?? prisma);
  const sessions = datesBetween(options.from, options.to).filter(date => marketSession(date, exceptions));
  if (!sessions.length) throw new Error('No expected trading sessions in the requested range.');
  const priorBoundary = previousSession(sessions[0]!, exceptions).date;
  const groupedDates = [priorBoundary, ...sessions];
  return { exceptions, sessions, groupedDates };
}

export type BreadthResearchEstimate = {
  requestedRange: { from: string; to: string }; expectedSessions: number;
  cachedGroupedSessions: number; cachedUniverseSessions: number;
  newGroupedSessions: number; newUniverseSessions: number;
  missingGroupedDates: string[]; missingUniverseDates: string[];
  estimatedNewGroupedRequests: number; estimatedNewUniverseRequests: number; estimatedTotalRequests: number;
  assumedUniversePagesPerSession: number;
};
export async function estimateBreadthResearch(options: BreadthResearchOptions): Promise<BreadthResearchEstimate> {
  const cacheDir = options.cacheDir ?? DEFAULT_BREADTH_CACHE_DIR;
  const { sessions, groupedDates } = await sessionPlan(options);
  const groupedCached = await Promise.all(groupedDates.map(date => readCached(cacheDir, 'grouped', date)));
  const universeCached = await Promise.all(sessions.map(date => readCached(cacheDir, 'universe', date)));
  const missingGroupedDates = groupedDates.filter((_, i) => !groupedCached[i]);
  const missingUniverseDates = sessions.filter((_, i) => !universeCached[i]);
  const cachedGroupedSessions = groupedCached.filter(Boolean).length;
  const cachedUniverseSessions = universeCached.filter(Boolean).length;
  const newGroupedSessions = groupedDates.length - cachedGroupedSessions;
  const newUniverseSessions = sessions.length - cachedUniverseSessions;
  const estimatedNewUniverseRequests = newUniverseSessions * ASSUMED_UNIVERSE_PAGES_PER_SESSION;
  return {
    requestedRange: { from: options.from, to: options.to }, expectedSessions: sessions.length,
    cachedGroupedSessions, cachedUniverseSessions, newGroupedSessions, newUniverseSessions,
    missingGroupedDates, missingUniverseDates,
    estimatedNewGroupedRequests: newGroupedSessions, estimatedNewUniverseRequests,
    estimatedTotalRequests: newGroupedSessions + estimatedNewUniverseRequests,
    assumedUniversePagesPerSession: ASSUMED_UNIVERSE_PAGES_PER_SESSION,
  };
}

export type BreadthResearchReport = {
  datasetId: string; definition: typeof BREADTH_DEFINITION; bandsByHorizon: BreadthBandsByHorizon;
  requestedRange: { from: string; to: string }; calendarExceptions: CalendarException[];
  actualRequests: { grouped: number; universe: number };
  providerGaps: { date: string; kind: 'universe' | 'grouped'; error: string }[];
  cacheDir: string; days: BreadthDay[]; summary: ReturnType<typeof summarizeBreadth>;
  warnings: string[];
};
export async function runBreadthResearch(options: BreadthResearchOptions): Promise<BreadthResearchReport> {
  const cacheDir = options.cacheDir ?? DEFAULT_BREADTH_CACHE_DIR;
  const concurrency = options.concurrency ?? 6;
  const fetchGrouped = options.fetchGrouped ?? fetchGroupedDailyBars;
  const fetchUniverse = options.fetchUniverse ?? fetchCommonStockUniverse;
  const { exceptions, sessions, groupedDates } = await sessionPlan(options);
  let actualGroupedRequests = 0, actualUniverseRequests = 0;
  const providerGaps: BreadthResearchReport['providerGaps'] = [];

  async function resolveGrouped(date: string): Promise<ReadonlyMap<string, number> | null> {
    if (!options.fetchFromProvider) {
      const cached = await readCached<Record<string, number>>(cacheDir, 'grouped', date);
      if (!cached) return null;
      if (!cached.ok) { providerGaps.push({ date, kind: 'grouped', error: cached.error }); return null; }
      return new Map(Object.entries(cached.value));
    }
    const result = await cachedFetch<Record<string, number>>(cacheDir, 'grouped', date, async () => Object.fromEntries((await fetchGrouped(date)).entries()), { ...(options.refresh !== undefined ? { refresh: options.refresh } : {}) });
    if (!result.fromCache) actualGroupedRequests++;
    if (!result.ok) { providerGaps.push({ date, kind: 'grouped', error: result.error }); return null; }
    return new Map(Object.entries(result.value));
  }
  async function resolveUniverse(date: string): Promise<readonly string[] | null> {
    if (!options.fetchFromProvider) {
      const cached = await readCached<string[]>(cacheDir, 'universe', date);
      if (!cached) return null;
      if (!cached.ok) { providerGaps.push({ date, kind: 'universe', error: cached.error }); return null; }
      return cached.value;
    }
    const result = await cachedFetch<string[]>(cacheDir, 'universe', date, () => fetchUniverse(date) as Promise<string[]>, { ...(options.refresh !== undefined ? { refresh: options.refresh } : {}) });
    if (!result.fromCache) actualUniverseRequests += ASSUMED_UNIVERSE_PAGES_PER_SESSION; // page count is not observable from here; see warnings.
    if (!result.ok) { providerGaps.push({ date, kind: 'universe', error: result.error }); return null; }
    return result.value;
  }

  const groupedEntries = await mapWithConcurrency(groupedDates, concurrency, async date => [date, await resolveGrouped(date)] as const);
  const groupedResults = new Map(groupedEntries);
  const universeEntries = await mapWithConcurrency(sessions, concurrency, async date => [date, await resolveUniverse(date)] as const);
  const universeResults = new Map(universeEntries);

  const observations: (DailyBreadthObservation | null)[] = sessions.map((date, i) => {
    const universe = universeResults.get(date) ?? null;
    const current = groupedResults.get(date) ?? null;
    const prior = groupedResults.get(groupedDates[i]!) ?? null;
    return universe && current && prior ? computeDailyBreadthObservation(universe, current, prior) : null;
  });
  const bandsByHorizon = options.bandsByHorizon ?? BASELINE_BREADTH_BANDS;
  const days = calculateBreadthSeries(sessions, observations, bandsByHorizon);
  const datasetId = createHash('sha256').update(JSON.stringify({ sessions, exceptions, definition: BREADTH_DEFINITION, bandsByHorizon, from: options.from, to: options.to })).digest('hex');
  const warnings = [
    'Candidate behavior report only. No authoritative assessments, MarketRegimeDimensionAssessment rows, or trading writes.',
    'Universe request counts above are an estimate (assumed pages/session); only grouped-daily request counts are exact, since pagination pages are not separately observable from the cache-hit boundary.',
    'Cached bars are Massive-adjusted at fetch time; a split occurring after a date was cached is not retroactively reflected without --refresh.',
  ];
  return {
    datasetId, definition: BREADTH_DEFINITION, bandsByHorizon, requestedRange: { from: options.from, to: options.to }, calendarExceptions: exceptions,
    actualRequests: { grouped: actualGroupedRequests, universe: actualUniverseRequests },
    providerGaps, cacheDir, days, summary: summarizeBreadth(days), warnings,
  };
}
