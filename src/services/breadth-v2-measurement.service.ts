import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { addDays, datesBetween, etDate, marketSession, type CalendarException } from './market-calendar.js';
import { constituentHash } from './security-universe-import.service.js';
import { TIINGO_DAY_1_TIMING_VERSION, tiingoDayEligible } from './tiingo-daily.service.js';
import { HORIZONS, SPLIT_NORMALIZATION_VERSION, compareRawCloses, finalizeBreadth, type ResearchBar } from './breadth-v2-measurement-calculation.js';

export const BREADTH_V2_MEASUREMENT_VERSION = 'BREADTH_V2_MEASUREMENT_V1';
export const BREADTH_V2_EVIDENCE_SCHEMA_VERSION = 1;
export const BREADTH_V2_EVIDENCE_READINESS = Object.freeze({ version: 'BREADTH_V2_EVIDENCE_READINESS_V1', minimumTargetCoverage: 0.995, minimumHorizonCoverage: 0.95, requireDirectional: true });
const iso = (date: Date) => date.toISOString().slice(0, 10);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const sortSymbol = (a: { symbol: string }, b: { symbol: string }) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
const MAX_CATCH_UP = 5;
type BlockerCode = 'MISSING_UNIVERSE_REVISION' | 'CALENDAR_EVIDENCE_UNAVAILABLE' | 'INSUFFICIENT_TARGET_COVERAGE' | 'INSUFFICIENT_HORIZON_COVERAGE' | 'ZERO_DIRECTIONAL_BREADTH' | 'CALCULATION_FAILED';
type Blocker = { code: BlockerCode; message: string; horizonSessions?: number };
type Readiness = 'READY' | 'NOT_DUE' | 'BLOCKED' | 'ALREADY_PUBLISHED';
type Options = { db?: PrismaClient; now?: Date };

async function publishedMeasurement(db: PrismaClient, revisionId: number, date: string) {
  const row = await db.marketBreadthObservationSet.findUnique({ where: { measurementVersion_breadthUniverseRevisionId_sessionDate: { measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, breadthUniverseRevisionId: revisionId, sessionDate: new Date(date) } }, include: { horizons: { orderBy: { horizonSessions: 'asc' } } } });
  if (!row) return null;
  const fail = () => { throw new Error('Conflicting immutable BREADTH_V2 observation identity or input.'); };
  const evidence = row.evidenceJson as Record<string, unknown>;
  const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
  if (row.measurementVersion !== BREADTH_V2_MEASUREMENT_VERSION || row.provider !== 'TIINGO' || row.breadthUniverseRevisionId !== revisionId || iso(row.sessionDate) !== date || row.evidenceSchemaVersion !== BREADTH_V2_EVIDENCE_SCHEMA_VERSION || !validHash(row.canonicalInputHash) || row.universeCount <= 0 || row.targetBarCount < 0 || row.targetBarCount > row.universeCount || Math.abs(row.targetCoverageRatio.toNumber() - row.targetBarCount / row.universeCount) > 1e-9 || row.horizons.length !== 3 || !evidence || evidence.measurementVersion !== BREADTH_V2_MEASUREMENT_VERSION || evidence.revisionId !== revisionId || evidence.sessionDate !== date || evidence.memberCount !== row.universeCount || typeof evidence.targetCoverageRatio !== 'number' || Math.abs(evidence.targetCoverageRatio - row.targetCoverageRatio.toNumber()) > 1e-9 || (evidence.evidenceReadiness as Record<string, unknown> | undefined)?.version !== BREADTH_V2_EVIDENCE_READINESS.version || (evidence.source as Record<string, unknown> | undefined)?.provider !== 'TIINGO') fail();
  const horizonHashes = evidence.horizonHashes;
  if (!Array.isArray(horizonHashes) || horizonHashes.length !== 3) fail();
  if (hash({ measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, revisionId, constituentHash: evidence.constituentHash, date, horizonHashes }) !== row.canonicalInputHash) fail();
  for (const [index, horizon] of row.horizons.entries()) {
    const detail = horizon.evidenceJson as Record<string, unknown>;
    if (horizon.horizonSessions !== HORIZONS[index] || !validHash(horizon.canonicalInputHash) || (horizonHashes as unknown[])[index] !== horizon.canonicalInputHash || horizon.universeCount !== row.universeCount || horizon.anchorBarCount < 0 || horizon.anchorBarCount > row.universeCount || horizon.eligibleCount < 0 || horizon.excludedCount < 0 || horizon.eligibleCount + horizon.excludedCount !== row.universeCount || horizon.advancingCount < 0 || horizon.decliningCount < 0 || horizon.unchangedCount < 0 || horizon.advancingCount + horizon.decliningCount + horizon.unchangedCount !== horizon.eligibleCount || horizon.directionalCount !== horizon.advancingCount + horizon.decliningCount || Math.abs(horizon.coverageRatio.toNumber() - horizon.eligibleCount / row.universeCount) > 1e-9 || !detail || detail.anchorSessionDate !== iso(horizon.anchorSessionDate) || detail.splitNormalizationVersion !== SPLIT_NORMALIZATION_VERSION) fail();
  }
  return row;
}

/** Integer comparisons keep the evidence gates exact at their frozen decimal boundaries. */
export function breadthV2EvidenceBlocker(universeCount: number, targetBarCount: number, horizons: readonly { horizonSessions: number; eligibleCount: number; directionalCount: number }[]): Blocker | null {
  if (targetBarCount * 1000 < universeCount * 995) return { code: 'INSUFFICIENT_TARGET_COVERAGE', message: 'Target-session Tiingo coverage is below 99.5%.' };
  for (const row of horizons) {
    if (row.eligibleCount * 100 < universeCount * 95) return { code: 'INSUFFICIENT_HORIZON_COVERAGE', message: 'Comparable horizon coverage is below 95%.', horizonSessions: row.horizonSessions };
    if (!row.directionalCount) return { code: 'ZERO_DIRECTIONAL_BREADTH', message: 'Directional breadth denominator is zero.', horizonSessions: row.horizonSessions };
  }
  return null;
}

function calendar(rows: { sessionDate: Date; type: 'CLOSED' | 'EARLY_CLOSE'; closeTimeMinutesEt: number | null }[]): CalendarException[] {
  return rows.map(row => ({ sessionDate: iso(row.sessionDate), type: row.type, closeTimeMinutesEt: row.closeTimeMinutesEt }));
}

function expectedSessions(target: string, exceptions: readonly CalendarException[]) {
  let from = addDays(target, -45);
  for (;;) {
    const sessions = datesBetween(from, target).filter(date => marketSession(date, exceptions));
    if (sessions.length >= 21) return sessions;
    from = addDays(from, -45);
    if (datesBetween(from, target).length > 370) throw new Error('Calendar evidence unavailable for 20-session breadth lookback.');
  }
}

export async function computeBreadthV2Measurement(date: string, options: Options = {}) {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const base = { measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, sessionDate: date, revisionId: null as number | null, memberCount: null as number | null, constituentHash: null as string | null, targetBarCount: 0, targetCoverageRatio: null as number | null, horizons: [] as Array<Record<string, unknown>>, readiness: 'BLOCKED' as Readiness, blocker: null as Blocker | null, canonicalInputHash: null as string | null, dataThroughAt: null as Date | null };
  if (!tiingoDayEligible(date, now)) return { ...base, readiness: 'NOT_DUE' as const };
  const revision = await db.breadthUniverseRevision.findFirst({ where: { effectiveFrom: { lte: new Date(date) } }, orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] });
  if (!revision) return { ...base, blocker: { code: 'MISSING_UNIVERSE_REVISION', message: `No frozen Breadth revision applies to ${date}.` } as Blocker };
  const existing = await publishedMeasurement(db, revision.id, date);
  if (existing) return { ...base, revisionId: revision.id, memberCount: existing.universeCount, constituentHash: (existing.evidenceJson as Record<string, unknown>).constituentHash as string, targetBarCount: existing.targetBarCount, targetCoverageRatio: existing.targetCoverageRatio.toNumber(), horizons: existing.horizons.map(row => ({ horizonSessions: row.horizonSessions, anchorSessionDate: iso(row.anchorSessionDate), anchorBarCount: row.anchorBarCount, universeCount: row.universeCount, eligibleCount: row.eligibleCount, excludedCount: row.excludedCount, advancingCount: row.advancingCount, decliningCount: row.decliningCount, unchangedCount: row.unchangedCount, directionalCount: row.directionalCount, coverageRatio: row.coverageRatio.toNumber(), advanceShare: row.advanceShare.toNumber(), netBreadth: row.netBreadth.toNumber(), canonicalInputHash: row.canonicalInputHash, exclusions: (row.evidenceJson as Record<string, unknown>).exclusions })), canonicalInputHash: existing.canonicalInputHash, dataThroughAt: existing.dataThroughAt, readiness: 'ALREADY_PUBLISHED' as const, blocker: null, existingId: existing.id };
  const membership = await db.breadthUniverseRevisionMember.findMany({ where: { revisionId: revision.id }, include: { security: { select: { symbol: true } } } });
  if (!membership.length || membership.length !== revision.memberCount || new Set(membership.map(row => row.securityId)).size !== revision.memberCount) throw new Error('Frozen Breadth revision memberCount integrity failure.');
  const members = membership.map(row => ({ securityId: row.securityId, symbol: row.security.symbol })).sort(sortSymbol);
  if (new Set(members.map(row => row.symbol)).size !== members.length) throw new Error('Frozen Breadth revision symbol integrity failure.');
  const populationHash = constituentHash(members.map(row => row.symbol));
  const common = { ...base, revisionId: revision.id, memberCount: members.length, constituentHash: populationHash };
  const exceptionRows = await db.marketCalendarException.findMany({ where: { sessionDate: { gte: new Date(addDays(date, -370)), lte: new Date(date) } }, orderBy: { sessionDate: 'asc' } });
  const exceptions = calendar(exceptionRows);
  let sessions: string[];
  try { sessions = expectedSessions(date, exceptions); }
  catch { return { ...common, blocker: { code: 'CALENDAR_EVIDENCE_UNAVAILABLE', message: 'Twenty previous reviewed market sessions are unavailable.' } as Blocker }; }
  if (sessions.at(-1) !== date) return { ...common, blocker: { code: 'CALENDAR_EVIDENCE_UNAVAILABLE', message: 'Target is not a reviewed market session.' } as Blocker };
  const first = sessions.at(-21)!;
  const window = sessions.slice(-21);
  const bySecurity = new Map<number, Map<string, ResearchBar>>();
  const inputs = new Map<number, Map<string, string>>();
  let latestReceiptAt: Date | null = null;
  for (let offset = 0; offset < members.length; offset += 100) {
    const batch = members.slice(offset, offset + 100);
    const rows = await db.marketBar.findMany({ where: { securityId: { in: batch.map(row => row.securityId) }, timeframe: 'DAY_1', barStartAt: { gte: new Date(first), lt: new Date(addDays(date, 1)) } }, select: { securityId: true, barStartAt: true, provider: true, adjustmentMode: true, close: true, splitFactor: true, receivedAt: true }, orderBy: [{ securityId: 'asc' }, { barStartAt: 'asc' }] });
    for (const row of rows) {
      if (row.provider !== 'TIINGO') continue;
      const day = iso(row.barStartAt);
      if (row.barStartAt.toISOString().slice(11) !== '00:00:00.000Z' || row.adjustmentMode !== 'UNADJUSTED' || !row.close.isFinite() || row.close.lte(0) || !row.splitFactor || !row.splitFactor.isFinite() || row.splitFactor.lte(0)) throw new Error(`Invalid canonical Tiingo DAY_1 evidence for security ${row.securityId} ${day}.`);
      const bars = bySecurity.get(row.securityId) ?? new Map();
      if (bars.has(day)) throw new Error(`Duplicate logical Tiingo DAY_1 evidence for security ${row.securityId} ${day}.`);
      bars.set(day, { close: row.close.toString(), splitFactor: row.splitFactor.toString() });
      bySecurity.set(row.securityId, bars);
      const evidence = inputs.get(row.securityId) ?? new Map();
      evidence.set(day, `${row.close.toString()}:${row.splitFactor.toString()}:${row.receivedAt.toISOString()}`);
      inputs.set(row.securityId, evidence);
      if (!latestReceiptAt || row.receivedAt > latestReceiptAt) latestReceiptAt = row.receivedAt;
    }
  }
  const targetBarCount = members.filter(member => bySecurity.get(member.securityId)?.has(date)).length;
  const targetCoverageRatio = targetBarCount / members.length;
  const horizons = HORIZONS.map(horizon => {
    const anchor = window[20 - horizon]!;
    const anchorBarCount = members.filter(member => bySecurity.get(member.securityId)?.has(anchor)).length;
    let advancing = 0, declining = 0, unchanged = 0;
    const exclusions = { missingTarget: 0, missingAnchor: 0, missingIntermediateSplitEvidence: 0 };
    const orderedInputs: string[] = [];
    for (const member of members) {
      const bars = bySecurity.get(member.securityId) ?? new Map();
      const evidence = inputs.get(member.securityId) ?? new Map();
      orderedInputs.push(`${member.symbol}:${member.securityId}:${window.slice(20 - horizon).map(d => `${d}=${evidence.get(d) ?? 'MISSING'}`).join('|')}`);
      if (!bars.has(date)) { exclusions.missingTarget++; continue; }
      if (!bars.has(anchor)) { exclusions.missingAnchor++; continue; }
      const comparison = compareRawCloses(window, 20 - horizon, 20, bars);
      if (!comparison) { exclusions.missingIntermediateSplitEvidence++; continue; }
      if (comparison.direction === 'ADVANCING') advancing++;
      else if (comparison.direction === 'DECLINING') declining++;
      else unchanged++;
    }
    const counts = finalizeBreadth(members.length, advancing, declining, unchanged);
    const canonicalInputHash = hash({ measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, revisionId: revision.id, constituentHash: populationHash, date, horizon, anchor, orderedInputs });
    return { horizonSessions: horizon, anchorSessionDate: anchor, anchorBarCount, ...counts, exclusions, canonicalInputHash };
  });
  const canonicalInputHash = hash({ measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, revisionId: revision.id, constituentHash: populationHash, date, horizonHashes: horizons.map(row => row.canonicalInputHash) });
  const blocker = breadthV2EvidenceBlocker(members.length, targetBarCount, horizons);
  return { ...common, targetBarCount, targetCoverageRatio, horizons, canonicalInputHash, dataThroughAt: latestReceiptAt, readiness: blocker ? 'BLOCKED' as const : 'READY' as const, blocker };
}

/** Both preview and publication begin with the same reviewed, Tiingo-eligible session. */
export function latestEligibleTiingoSession(now: Date, exceptions: readonly CalendarException[], lookbackDays = 45): string | null {
  const today = etDate(now);
  return datesBetween(addDays(today, -lookbackDays), today).reverse().find(date => marketSession(date, exceptions) && tiingoDayEligible(date, now)) ?? null;
}

async function latestTarget(db: PrismaClient, now: Date) {
  const today = etDate(now);
  const rows = await db.marketCalendarException.findMany({ where: { sessionDate: { gte: new Date(addDays(today, -45)), lte: new Date(today) } }, orderBy: { sessionDate: 'asc' } });
  return latestEligibleTiingoSession(now, calendar(rows));
}

async function observationTargets(db: PrismaClient, now: Date) {
  const latest = await latestTarget(db, now);
  if (!latest) return { latest: null, dates: [] as string[] };
  const previous = await db.marketBreadthObservationSet.findFirst({ where: { measurementVersion: BREADTH_V2_MEASUREMENT_VERSION }, orderBy: { sessionDate: 'desc' } });
  if (previous && iso(previous.sessionDate) >= latest) return { latest, dates: [] as string[] };
  if (!previous) return { latest, dates: [latest] };
  const exceptions = calendar(await db.marketCalendarException.findMany({ where: { sessionDate: { gte: previous.sessionDate, lte: new Date(latest) } }, orderBy: { sessionDate: 'asc' } }));
  return { latest, dates: datesBetween(addDays(iso(previous.sessionDate), 1), latest).filter(date => marketSession(date, exceptions)).slice(0, MAX_CATCH_UP) };
}

export async function breadthV2ObservationStatus(options: Options = {}) {
  const db = options.db ?? prisma; const now = options.now ?? new Date();
  const plan = await observationTargets(db, now);
  const date = plan.dates[0] ?? plan.latest;
  if (!date) return { measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, sessionDate: null, readiness: 'NOT_DUE' as const, blocker: null };
  try { return await computeBreadthV2Measurement(date, { db, now }); }
  catch (error) {
    return { measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, sessionDate: date, readiness: 'BLOCKED' as const, blocker: { code: 'CALCULATION_FAILED' as const, message: error instanceof Error ? error.message : 'Unknown calculation failure.' } };
  }
}

export async function runBreadthV2Observations(options: Options = {}) {
  const db = options.db ?? prisma; const now = options.now ?? new Date();
  const plan = await observationTargets(db, now);
  const latest = plan.latest;
  if (!latest) return { latestEligibleSession: null, inserted: 0, attempted: 0, notDue: true, blocked: null, results: [] };
  if (plan.dates.length === 0) {
    const current = await computeBreadthV2Measurement(latest, { db, now });
    return { latestEligibleSession: latest, inserted: 0, attempted: 1, notDue: false, blocked: null, results: current.readiness === 'ALREADY_PUBLISHED' && 'existingId' in current ? [{ sessionDate: latest, id: current.existingId, alreadyPublished: true }] : [] };
  }
  const dates = plan.dates;
  const results = []; let inserted = 0;
  for (const date of dates) {
    let preview;
    try { preview = await computeBreadthV2Measurement(date, { db, now }); }
    catch (error) { return { latestEligibleSession: latest, inserted, attempted: results.length + 1, notDue: false, blocked: { sessionDate: date, code: 'CALCULATION_FAILED', message: error instanceof Error ? error.message : 'Unknown calculation failure.' }, results }; }
    if (preview.readiness !== 'READY') return { latestEligibleSession: latest, inserted, attempted: results.length + 1, notDue: preview.readiness === 'NOT_DUE', blocked: preview.blocker && { sessionDate: date, ...preview.blocker }, results };
    const completedAt = now;
    try {
      const created = await db.$transaction(async tx => {
        const locked = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('breadth-v2-measurement')) AS acquired`;
        if (!locked[0]?.acquired) throw new HttpError(409, 'BREADTH_V2 measurement is already running.');
        const current = await computeBreadthV2Measurement(date, { db: tx as unknown as PrismaClient, now });
        if (current.readiness !== 'READY' || current.canonicalInputHash !== preview.canonicalInputHash) throw new Error('BREADTH_V2 evidence changed before publication.');
        const row = await tx.marketBreadthObservationSet.create({ data: {
          breadthUniverseRevisionId: current.revisionId!, sessionDate: new Date(date), provider: 'TIINGO', measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, evidenceSchemaVersion: BREADTH_V2_EVIDENCE_SCHEMA_VERSION,
          universeCount: current.memberCount!, targetBarCount: current.targetBarCount, targetCoverageRatio: current.targetCoverageRatio!, dataThroughAt: current.dataThroughAt!, canonicalInputHash: current.canonicalInputHash!,
          evidenceJson: json({ measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, evidenceReadiness: BREADTH_V2_EVIDENCE_READINESS, revisionId: current.revisionId, memberCount: current.memberCount, constituentHash: current.constituentHash, sessionDate: date, targetCoverageRatio: current.targetCoverageRatio, timingVersion: TIINGO_DAY_1_TIMING_VERSION, source: { provider: 'TIINGO', timeframe: 'DAY_1', adjustmentMode: 'UNADJUSTED' }, weighting: 'ONE_SECURITY_ONE_VOTE', gapPolicy: 'STRICT', splitNormalizationVersion: SPLIT_NORMALIZATION_VERSION, horizonHashes: current.horizons.map(h => h.canonicalInputHash) }),
          startedAt: now, completedAt, horizons: { create: current.horizons.map(h => ({ horizonSessions: h.horizonSessions as number, anchorSessionDate: new Date(h.anchorSessionDate as string), universeCount: h.universeCount as number, anchorBarCount: h.anchorBarCount as number, eligibleCount: h.eligibleCount as number, excludedCount: h.excludedCount as number, advancingCount: h.advancingCount as number, decliningCount: h.decliningCount as number, unchangedCount: h.unchangedCount as number, directionalCount: h.directionalCount as number, coverageRatio: h.coverageRatio as number, advanceShare: h.advanceShare as number, netBreadth: h.netBreadth as number, canonicalInputHash: h.canonicalInputHash as string, evidenceJson: json({ exclusions: h.exclusions, anchorSessionDate: h.anchorSessionDate, splitNormalizationVersion: SPLIT_NORMALIZATION_VERSION }) })) },
        } });
        await tx.systemEvent.create({ data: { type: 'breadth_v2_observation_published', entityType: 'market_breadth_observation_set', entityId: String(row.id), severity: 'INFO', message: `BREADTH_V2 measurement published for ${date}.`, payloadJson: { observationSetId: row.id, sessionDate: date, measurementVersion: BREADTH_V2_MEASUREMENT_VERSION } } });
        return row;
      }, { timeout: 120_000 });
      results.push({ sessionDate: date, id: created.id }); inserted++;
    } catch (error) {
      return { latestEligibleSession: latest, inserted, attempted: results.length + 1, notDue: false, blocked: { sessionDate: date, code: 'CALCULATION_FAILED', message: error instanceof Error ? error.message : 'Unknown publication failure.' }, results };
    }
  }
  return { latestEligibleSession: latest, inserted, attempted: dates.length, notDue: dates.length === 0, blocked: null, results };
}

export async function latestBreadthV2Observation(db: PrismaClient = prisma) { return db.marketBreadthObservationSet.findFirst({ orderBy: [{ sessionDate: 'desc' }, { id: 'desc' }], include: { horizons: { orderBy: { horizonSessions: 'asc' } } } }); }
export async function listBreadthV2Observations(limit: number, beforeId?: number, db: PrismaClient = prisma) { return db.marketBreadthObservationSet.findMany({ ...(beforeId ? { where: { id: { lt: beforeId } } } : {}), take: limit, orderBy: { id: 'desc' }, include: { horizons: { orderBy: { horizonSessions: 'asc' } } } }); }
export async function getBreadthV2Observation(id: number, db: PrismaClient = prisma) { return db.marketBreadthObservationSet.findUnique({ where: { id }, include: { horizons: { orderBy: { horizonSessions: 'asc' } } } }); }
