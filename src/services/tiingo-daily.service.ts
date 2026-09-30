import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { HttpError } from '../errors/http-error.js';
import { configuredTiingoRestClient, TiingoRequestError, tiingoSymbol, type TiingoBar } from '../integrations/tiingo/rest.client.js';
import { addDays, datesBetween, etDate, etInstant, marketSession, validDate } from './market-calendar.js';
import { calendarExceptions } from './market-calendar.service.js';
import { runTiingoDailyPool } from './tiingo-daily-pool.js';
import { nextTiingoEmptyObservation } from './tiingo-daily-observation.js';

export const TIINGO_DAY_1_TIMING_VERSION = 'TIINGO_DAY_1_2015_ET_V1';
const lockKey = createHash('sha256').update('ai-trader:tiingo-daily-ingestion-and-purge').digest().readBigInt64BE(0).toString();
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
const summaryKey = 'tiingoDailyLastRun';
const pausedKey = 'tiingoDailyIngestionPaused';
const providerFailureNextAttemptKey = 'tiingoDailyProviderFailureNextAttemptAt';
export async function withTiingoDailyLock<T>(work: () => Promise<T>): Promise<T> {
  const client = await pool.connect(); let held = false; let damaged = false;
  try {
    held = (await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1::bigint) acquired', [lockKey])).rows[0]?.acquired === true;
    if (!held) throw new HttpError(409, 'Tiingo daily ingestion or retention purge is already running.');
    return await work();
  } finally {
    if (held) try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]); } catch { damaged = true; }
    client.release(damaged);
  }
}
export async function closeTiingoDailyLockPool() { await pool.end(); }
export function tiingoDayEligibleAt(date: string): Date {
  if (!validDate(date)) throw new Error('Invalid Tiingo session date.');
  return etInstant(date, 20 * 60 + 15);
}
export function tiingoDayEligible(date: string, now = new Date()): boolean {
  const eligibleAt = tiingoDayEligibleAt(date);
  return date < etDate(now) || (date === etDate(now) && now >= eligibleAt);
}
type Member = { securityId: number; symbol: string };
export async function loadTiingoRevision(revisionId?: number, now = new Date()) {
  const revision = revisionId === undefined
    ? await prisma.breadthUniverseRevision.findFirst({ where: { effectiveFrom: { lte: new Date(etDate(now)) } }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] })
    : await prisma.breadthUniverseRevision.findUnique({ where: { id: revisionId } });
  if (!revision) throw new HttpError(404, 'Frozen Breadth revision unavailable.');
  const rows = await prisma.breadthUniverseRevisionMember.findMany({ where: { revisionId: revision.id }, include: { security: { select: { symbol: true } } } });
  if (rows.length !== revision.memberCount || new Set(rows.map(row => row.securityId)).size !== revision.memberCount) throw new Error('Frozen Breadth revision memberCount integrity failure.');
  const members: Member[] = rows.map(row => ({ securityId: row.securityId, symbol: row.security.symbol })).sort((a, b) => a.symbol.localeCompare(b.symbol));
  for (const member of members) tiingoSymbol(member.symbol);
  return { revision, members };
}
function selectMembers(members: Member[], symbols?: string[]) {
  if (!symbols?.length) return members;
  const requested = new Set(symbols);
  if (requested.size !== symbols.length || members.filter(row => requested.has(row.symbol)).length !== requested.size) throw new HttpError(400, 'Every narrowed symbol must occur once in the frozen revision.');
  return members.filter(row => requested.has(row.symbol));
}
function decimal(value: number, scale: number, precision: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid Tiingo numeric observation.');
  const result = new Prisma.Decimal(value).toDecimalPlaces(scale, Prisma.Decimal.ROUND_DOWN);
  if (result.toFixed(0).replace('-', '').length > precision - scale) throw new Error('Tiingo numeric observation exceeds canonical precision.');
  return result;
}
export function canonicalTiingoBar(bar: TiingoBar) {
  if (bar.splitFactor === undefined || !Number.isFinite(bar.splitFactor) || bar.splitFactor <= 0) throw new Error('Tiingo splitFactor is required and positive.');
  return { open: decimal(bar.open, 10, 24), high: decimal(bar.high, 10, 24), low: decimal(bar.low, 10, 24), close: decimal(bar.close, 10, 24), volume: decimal(bar.volume, 6, 30), splitFactor: decimal(bar.splitFactor, 10, 24) };
}
type Counts = { requested: number; succeeded: number; alreadyPresent: number; missing: number; historicalMissing: number; failed: number; conflict: number; otherProvider: number; splitEvents: number; retries: number; throttled: number; retryScheduled: number; terminalizedNoEodCoverage: number; resolvedPreviouslyMissing: number; details: string[] };
const emptyCounts = (): Counts => ({ requested: 0, succeeded: 0, alreadyPresent: 0, missing: 0, historicalMissing: 0, failed: 0, conflict: 0, otherProvider: 0, splitEvents: 0, retries: 0, throttled: 0, retryScheduled: 0, terminalizedNoEodCoverage: 0, resolvedPreviouslyMissing: 0, details: [] });
function detail(counts: Counts, value: string) { if (counts.details.length < 20) counts.details.push(value); }
export function retryDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof TiingoRequestError) || (error.status !== null && error.status !== 429 && error.status < 500)) return null;
  return Math.min(30_000, error.retryAfterMs ?? 500 * 2 ** attempt);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function persist(member: Member, bar: TiingoBar, receivedAt: Date): Promise<{ result: 'inserted' | 'already' | 'other' | 'conflict' | 'split'; resolved: boolean }> {
  const values = canonicalTiingoBar(bar); const date = bar.barStartAt.toISOString().slice(0, 10);
  if (!tiingoDayEligible(date, receivedAt)) throw new Error('Tiingo day is not yet eligible.');
  return prisma.$transaction(async tx => {
    const identity = { securityId_timeframe_barStartAt: { securityId: member.securityId, timeframe: 'DAY_1' as const, barStartAt: bar.barStartAt } };
    const existing = await tx.marketBar.findUnique({ where: identity });
    if (existing) {
      if (existing.provider !== 'TIINGO') return { result: 'other' as const, resolved: false };
      if (existing.adjustmentMode !== 'UNADJUSTED' || (Object.keys(values) as (keyof typeof values)[]).some(key => !existing[key]?.equals(values[key]))) return { result: 'conflict' as const, resolved: false };
    } else {
      await tx.marketBar.create({ data: { securityId: member.securityId, timeframe: 'DAY_1', barStartAt: bar.barStartAt, ...values, provider: 'TIINGO', adjustmentMode: 'UNADJUSTED', receivedAt } });
    }
    let result: 'inserted' | 'already' | 'split' = existing ? 'already' : 'inserted';
    if (!values.splitFactor.equals(1)) {
      const executionDate = new Date(date); const split = await tx.marketSplitEvent.findUnique({ where: { securityId_executionDate: { securityId: member.securityId, executionDate } } });
      if (split && (!split.splitFactor.equals(values.splitFactor) || split.provider !== 'TIINGO')) throw new Error('Canonical split evidence conflict.');
      if (!split) {
        await tx.marketSplitEvent.create({ data: { securityId: member.securityId, executionDate, splitFactor: values.splitFactor, provider: 'TIINGO', provenance: `TIINGO:EOD:${member.symbol}:${date}`, receivedAt } });
        result = 'split';
      }
    }
    const resolved = await tx.tiingoDailyObservationState.updateMany({ where: { securityId: member.securityId, sessionDate: new Date(date), status: { in: ['RETRYING', 'NO_EOD_COVERAGE'] } }, data: { status: 'RESOLVED', nextAttemptAt: null, resolvedAt: receivedAt, reasonCode: 'BAR_RECEIVED' } });
    return { result, resolved: resolved.count > 0 };
  });
}
async function observationStates(members: Member[], from: string, through: string) {
  const rows = await prisma.tiingoDailyObservationState.findMany({ where: { securityId: { in: members.map(row => row.securityId) }, sessionDate: { gte: new Date(from), lte: new Date(through) } } });
  return new Map(rows.map(row => [`${row.securityId}:${row.sessionDate.toISOString().slice(0, 10)}`, row]));
}
async function coverage(members: Member[], from: string, through: string) {
  const ids = members.map(row => row.securityId);
  const rows = await prisma.marketBar.findMany({ where: { securityId: { in: ids }, timeframe: 'DAY_1', barStartAt: { gte: new Date(from), lte: new Date(through) } }, select: { securityId: true, barStartAt: true, provider: true } });
  const bySymbol = new Map<number, Map<string, 'TIINGO' | 'MASSIVE'>>();
  for (const row of rows) { const found = bySymbol.get(row.securityId) ?? new Map(); found.set(row.barStartAt.toISOString().slice(0, 10), row.provider); bySymbol.set(row.securityId, found); }
  return bySymbol;
}
export async function tiingoDailyBackfill(input: { revisionId: number; from: string; through: string; symbols?: string[]; apply?: boolean; retryTerminal?: boolean; researchHistory?: boolean; now?: Date; fetchDaily?: (symbol: string, from: string, through: string) => Promise<TiingoBar[]> }) {
  const now = input.now ?? new Date();
  if (input.researchHistory && input.retryTerminal) throw new HttpError(400, '--research-history cannot be combined with --retry-terminal.');
  if (!validDate(input.from) || !validDate(input.through) || input.from > input.through || input.through > etDate(now) || datesBetween(input.from, input.through).length > 370) throw new HttpError(400, 'Tiingo backfill requires a valid, bounded range of at most 370 days.');
  const { revision, members: all } = await loadTiingoRevision(input.revisionId, now); const members = selectMembers(all, input.symbols);
  const dates = datesBetween(input.from, input.through).filter(date => tiingoDayEligible(date, now));
  const exceptions = await calendarExceptions(input.from, input.through);
  const sessions = dates.filter(date => marketSession(date, exceptions) !== null);
  const sessionSet = new Set(sessions);
  async function plan() {
    const existing = await coverage(members, input.from, input.through);
    const states = await observationStates(members, input.from, input.through);
    const counts = emptyCounts();
    const stateFor = (member: Member, date: string) => states.get(`${member.securityId}:${date}`);
    let deferredRetries = 0; let noEodCoverage = 0;
    const work = members.map(member => {
      const missingDates: string[] = [];
      const covered = existing.get(member.securityId);
      for (const date of sessions) {
        if (covered?.has(date)) continue;
        const state = stateFor(member, date);
        if (state?.status === 'NO_EOD_COVERAGE') noEodCoverage++;
        if (!state || (state.status === 'RETRYING' && state.nextAttemptAt !== null && state.nextAttemptAt <= now) || (state.status === 'NO_EOD_COVERAGE' && input.retryTerminal === true)) missingDates.push(date);
        else if (state.status === 'RETRYING') deferredRetries++;
      }
      return { member, missingDates };
    });
    const preview = { revisionId: revision.id, effectiveFrom: revision.effectiveFrom.toISOString().slice(0, 10), memberCount: revision.memberCount, selectedSecurities: members.length, from: input.from, through: input.through, acquisitionMode: input.researchHistory ? 'RESEARCH_HISTORY' as const : 'OPERATIONAL' as const, timingVersion: TIINGO_DAY_1_TIMING_VERSION, existingTiingo: [...existing.values()].reduce((n, dates) => n + [...dates.values()].filter(v => v === 'TIINGO').length, 0), existingOtherProvider: [...existing.values()].reduce((n, dates) => n + [...dates.values()].filter(v => v !== 'TIINGO').length, 0), expectedRequests: work.filter(row => row.missingDates.length).length, deferredRetries, noEodCoverage };
    return { counts, stateFor, work, preview };
  }
  if (!input.apply) { const { preview, counts } = await plan(); return { preview, counts }; }
  return withTiingoDailyLock(async () => {
    if ((await prisma.setting.findUnique({ where: { key: pausedKey } }))?.value === 'true') throw new HttpError(409, 'Tiingo ingestion is paused after retention purge.');
    const { counts, stateFor, work, preview } = await plan();
    const client = input.fetchDaily ? null : configuredTiingoRestClient();
    await prisma.systemEvent.create({ data: { type: 'tiingo_daily_run_started', entityType: 'market_data', entityId: String(revision.id), severity: 'INFO', message: 'Tiingo daily ingestion started.', payloadJson: preview } });
    await runTiingoDailyPool(work.filter(row => row.missingDates.length), env.TIINGO_MAX_CONCURRENCY, async ({ member, missingDates }) => {
      counts.requested++;
      let bars: TiingoBar[] | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try { bars = await (input.fetchDaily ?? ((symbol, from, through) => client!.daily(symbol, from, through)))(tiingoSymbol(member.symbol), input.from, input.through); break; }
        catch (error) {
          if (error instanceof TiingoRequestError && error.status === 429) counts.throttled++;
          const delay = retryDelay(error, attempt);
          if (delay === null || attempt === 3) { counts.failed++; detail(counts, `${member.symbol}: ${error instanceof TiingoRequestError ? error.message : 'invalid provider response'}`); break; }
          counts.retries++;
          await sleep(delay);
        }
      }
      if (!bars) return;
      const receivedAt = new Date();
      const returned = new Set<string>();
      let invalidResponse = false;
      for (const bar of bars) {
        const date = bar.barStartAt.toISOString().slice(0, 10);
        if (date < input.from || date > input.through || !tiingoDayEligible(date, now)) continue;
        if (!sessionSet.has(date)) { counts.failed++; invalidResponse = true; detail(counts, `${member.symbol} ${date}: observation outside configured market session`); continue; }
        returned.add(date);
        try {
          const { result, resolved } = await persist(member, bar, receivedAt);
          if (resolved) counts.resolvedPreviouslyMissing++;
          if (result === 'inserted' || result === 'split') counts.succeeded++;
          if (result === 'split') counts.splitEvents++;
          if (result === 'already') counts.alreadyPresent++;
          if (result === 'other') counts.otherProvider++;
          if (result === 'conflict') { counts.conflict++; detail(counts, `${member.symbol} ${date}: immutable Tiingo bar conflict`); }
        } catch { counts.conflict++; detail(counts, `${member.symbol} ${date}: canonical evidence conflict`); }
      }
      if (invalidResponse) return;
      for (const date of missingDates.filter(date => !returned.has(date))) {
        counts.missing++;
        if (input.researchHistory) { counts.historicalMissing++; continue; }
        const previous = stateFor(member, date) ?? null;
        const next = nextTiingoEmptyObservation(previous, now);
        const identity = { securityId_sessionDate: { securityId: member.securityId, sessionDate: new Date(date) } };
        try {
          await prisma.tiingoDailyObservationState.upsert({ where: identity,
            create: { securityId: member.securityId, sessionDate: new Date(date), ...next, firstAttemptAt: now, lastAttemptAt: now, reasonCode: 'PROVIDER_NO_EOD_BAR' },
            update: { ...next, lastAttemptAt: now, reasonCode: 'PROVIDER_NO_EOD_BAR' } });
          if (next.status === 'RETRYING') counts.retryScheduled++;
          else if (previous?.status !== 'NO_EOD_COVERAGE') counts.terminalizedNoEodCoverage++;
        } catch { counts.failed++; detail(counts, `${member.symbol} ${date}: observation state persistence failure`); }
      }
    });
    const summary = { ...preview, counts, completedAt: new Date().toISOString() };
    await prisma.setting.upsert({ where: { key: summaryKey }, create: { key: summaryKey, value: JSON.stringify(summary) }, update: { value: JSON.stringify(summary) } });
    await prisma.systemEvent.create({ data: { type: 'tiingo_daily_run_completed', entityType: 'market_data', entityId: String(revision.id), severity: counts.conflict || counts.failed || counts.otherProvider ? 'ERROR' : counts.terminalizedNoEodCoverage ? 'WARNING' : 'INFO', message: 'Tiingo daily ingestion completed.', payloadJson: summary } });
    return { preview, counts };
  });
}
export async function tiingoDailyStatus(now = new Date()) {
  const { revision, members } = await loadTiingoRevision(undefined, now);
  const date = tiingoDayEligible(etDate(now), now) ? etDate(now) : addDays(etDate(now), -1);
  const exceptions = await calendarExceptions(addDays(date, -7), date);
  let session = date;
  while (!marketSession(session, exceptions)) session = addDays(session, -1);
  const rows = await coverage(members, session, session);
  const states = await observationStates(members, session, session);
  const providers = members.map(member => rows.get(member.securityId)?.get(session));
  const absent = members.filter(member => rows.get(member.securityId)?.get(session) !== 'TIINGO');
  const state = (member: Member) => states.get(`${member.securityId}:${session}`);
  const [latest, paused] = await Promise.all([prisma.setting.findUnique({ where: { key: summaryKey } }), prisma.setting.findUnique({ where: { key: pausedKey } })]);
  return { revisionId: revision.id, memberCount: revision.memberCount, latestEligibleSessionDate: session, tiingoPresent: providers.filter(v => v === 'TIINGO').length, missing: absent.length, untrackedMissing: absent.filter(member => !state(member) && !rows.get(member.securityId)?.get(session)).length, retrying: absent.filter(member => state(member)?.status === 'RETRYING').length, dueRetries: absent.filter(member => state(member)?.status === 'RETRYING' && state(member)!.nextAttemptAt! <= now).length, noEodCoverage: absent.filter(member => state(member)?.status === 'NO_EOD_COVERAGE').length, existingOtherProvider: providers.filter(v => v && v !== 'TIINGO').length, paused: paused?.value === 'true', timingVersion: TIINGO_DAY_1_TIMING_VERSION, latestRun: latest ? JSON.parse(latest.value) : null };
}
export async function syncTiingoDaily(now = new Date(), fetchDaily?: (symbol: string, from: string, through: string) => Promise<TiingoBar[]>) {
  if ((await prisma.setting.findUnique({ where: { key: pausedKey } }))?.value === 'true') return { notDue: true, status: await tiingoDailyStatus(now) };
  const status = await tiingoDailyStatus(now);
  if (!tiingoDayEligible(status.latestEligibleSessionDate, now)) return { notDue: true, status };
  const failureGate = await prisma.setting.findUnique({ where: { key: providerFailureNextAttemptKey } });
  if (failureGate && now < new Date(failureGate.value)) return { notDue: true, status };
  const due = await prisma.tiingoDailyObservationState.findMany({ where: { status: 'RETRYING', nextAttemptAt: { lte: now }, sessionDate: { lt: new Date(status.latestEligibleSessionDate) } }, orderBy: [{ sessionDate: 'asc' }, { securityId: 'asc' }], take: 1000 });
  const membership = await prisma.breadthUniverseRevisionMember.findMany({ where: { securityId: { in: due.map(row => row.securityId) }, revision: { effectiveFrom: { lte: new Date(etDate(now)) } } }, include: { revision: { select: { effectiveFrom: true } }, security: { select: { symbol: true } } } });
  const byDate = new Map<string, { revisionId: number; symbols: string[] }>();
  for (const row of due) {
    const date = row.sessionDate.toISOString().slice(0, 10);
    const candidates = membership.filter(member => member.securityId === row.securityId);
    const selected = candidates.filter(member => member.revision.effectiveFrom <= row.sessionDate).sort((a, b) => b.revision.effectiveFrom.getTime() - a.revision.effectiveFrom.getTime())[0]
      ?? candidates.sort((a, b) => b.revision.effectiveFrom.getTime() - a.revision.effectiveFrom.getTime())[0];
    if (!selected) continue;
    const key = `${selected.revisionId}:${date}`;
    const group = byDate.get(key) ?? { revisionId: selected.revisionId, symbols: [] };
    group.symbols.push(selected.security.symbol);
    byDate.set(key, group);
  }
  const results = [];
  if (status.untrackedMissing || status.dueRetries) results.push(await tiingoDailyBackfill({ revisionId: status.revisionId, from: status.latestEligibleSessionDate, through: status.latestEligibleSessionDate, apply: true, now, ...(fetchDaily ? { fetchDaily } : {}) }));
  for (const [key, group] of byDate) {
    const date = key.slice(key.indexOf(':') + 1);
    results.push(await tiingoDailyBackfill({ revisionId: group.revisionId, from: date, through: date, symbols: group.symbols, apply: true, now, ...(fetchDaily ? { fetchDaily } : {}) }));
  }
  const counts = emptyCounts();
  for (const result of results) for (const key of Object.keys(counts) as (keyof Counts)[]) {
    if (key === 'details') result.counts.details.forEach(value => detail(counts, value));
    else counts[key] += result.counts[key];
  }
  if (counts.failed) await prisma.setting.upsert({ where: { key: providerFailureNextAttemptKey }, create: { key: providerFailureNextAttemptKey, value: new Date(now.getTime() + 60 * 60_000).toISOString() }, update: { value: new Date(now.getTime() + 60 * 60_000).toISOString() } });
  return { notDue: results.length === 0, status: await tiingoDailyStatus(now), result: results.length ? { counts } : undefined };
}
export async function tiingoRetentionPurge(apply = false, confirm?: string) {
  if (apply && confirm !== 'DELETE-TIINGO-DATA') throw new HttpError(400, 'Purge apply requires --confirm=DELETE-TIINGO-DATA.');
  return withTiingoDailyLock(async () => {
    const counts = { marketBars: await prisma.marketBar.count({ where: { provider: 'TIINGO' } }), marketSplitEvents: await prisma.marketSplitEvent.count({ where: { provider: 'TIINGO' } }), marketSplitCoverage: await prisma.marketSplitCoverage.count({ where: { provider: 'TIINGO' } }), observationStates: await prisma.tiingoDailyObservationState.count() };
    if (!apply) return { preview: true, counts };
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('ai_trader.tiingo_retention_purge', 'on', true)`;
      await tx.setting.upsert({ where: { key: pausedKey }, create: { key: pausedKey, value: 'true' }, update: { value: 'true' } });
      await tx.marketSplitCoverage.deleteMany({ where: { provider: 'TIINGO' } });
      await tx.marketSplitEvent.deleteMany({ where: { provider: 'TIINGO' } });
      await tx.marketBar.deleteMany({ where: { provider: 'TIINGO' } });
      await tx.tiingoDailyObservationState.deleteMany();
    });
    return { preview: false, counts };
  });
}
export async function resumeTiingoDailyIngestion(confirm: string) {
  if (confirm !== 'PAID-TIINGO-PLAN-ACTIVE') throw new HttpError(400, 'Explicit paid-plan confirmation is required.');
  return withTiingoDailyLock(async () => {
    await prisma.setting.upsert({ where: { key: pausedKey }, create: { key: pausedKey, value: 'false' }, update: { value: 'false' } });
    return { paused: false };
  });
}
