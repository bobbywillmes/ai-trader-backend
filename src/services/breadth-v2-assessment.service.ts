import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type MarketRegimeDimensionAssessment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { addDays, datesBetween, marketSession, type CalendarException } from './market-calendar.js';
import { latestEligibleTiingoSession, BREADTH_V2_MEASUREMENT_VERSION, BREADTH_V2_EVIDENCE_SCHEMA_VERSION } from './breadth-v2-measurement.service.js';
import { tiingoDayEligibleAt, TIINGO_DAY_1_TIMING_VERSION } from './tiingo-daily.service.js';
import { BREADTH_V2_TERTILE_V1, advanceFrozenBreadthV2, classifyFrozenBreadthV2Shares } from './breadth-v2.definition.js';
import { replayBreadthV2Bootstrap } from './breadth-v2-bootstrap-data.js';
import { constituentHash } from './security-universe-import.service.js';
import type { MildDeteriorationHistory } from './breadth-calculation.js';

export const BREADTH_V2_ASSESSMENT_EVIDENCE_VERSION = 'BREADTH_V2_ASSESSMENT_EVIDENCE_V1';
export const BREADTH_V2_ASSESSMENT_EVIDENCE_SCHEMA_VERSION = 1;
export const BREADTH_V2_PUBLICATION_LOCK_KEY = createHash('sha256').update('ai-trader:breadth-v2-assessment-publication').digest().readBigInt64BE(0);
const identity = { dimension: 'BREADTH' as const, algorithmVersion: BREADTH_V2_TERTILE_V1.algorithmVersion };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const MAX_CATCH_UP = 20;
const state = z.enum(['POSITIVE', 'MIXED', 'NEGATIVE']);
const predecessorEvidence = z.object({
  algorithmVersion: z.literal(BREADTH_V2_TERTILE_V1.algorithmVersion),
  assessmentEvidenceVersion: z.literal(BREADTH_V2_ASSESSMENT_EVIDENCE_VERSION),
  evidenceSchemaVersion: z.literal(BREADTH_V2_ASSESSMENT_EVIDENCE_SCHEMA_VERSION),
  measurementVersion: z.literal(BREADTH_V2_MEASUREMENT_VERSION),
  transition: z.object({ effectiveState: state, recoveryConfirmationAfter: z.number().int().min(0).max(1), mildDeteriorationConfirmationAfter: z.number().int().min(0).max(1) }),
});
type Db = PrismaClient | Prisma.TransactionClient;
type ObservationSet = Prisma.MarketBreadthObservationSetGetPayload<{ include: { horizons: true } }>;
type Options = { db?: PrismaClient; now?: Date; clock?: () => Date };
type Reason = 'MISSING_MEASUREMENT' | 'INVALID_MEASUREMENT_EVIDENCE' | 'INSUFFICIENT_BOOTSTRAP_HISTORY' | 'CALENDAR_EVIDENCE_UNAVAILABLE' | 'CALCULATION_FAILED';
type Blocker = { sessionDate: string; status: 'UNAVAILABLE' | 'FAILED'; reasonCode: Reason; message: string; inputHash: string | null };

function nextSession(date: string, exceptions: readonly CalendarException[]) {
  for (let i = 1; i <= 370; i++) { const next = addDays(date, i); if (marketSession(next, exceptions)) return next; }
  throw new Error('No next reviewed market session within calendar horizon.');
}
function priorSession(date: string, exceptions: readonly CalendarException[]) {
  for (let i = 1; i <= 370; i++) { const prior = addDays(date, -i); if (marketSession(prior, exceptions)) return prior; }
  throw new Error('No prior reviewed market session within calendar horizon.');
}
function calendar(rows: { sessionDate: Date; type: 'CLOSED' | 'EARLY_CLOSE'; closeTimeMinutesEt: number | null }[]): CalendarException[] {
  return rows.map(row => ({ sessionDate: iso(row.sessionDate), type: row.type, closeTimeMinutesEt: row.closeTimeMinutesEt }));
}
function invalidMeasurement(message: string, sessionDate: string, inputHash: string | null): Blocker { return { sessionDate, status: 'FAILED', reasonCode: 'INVALID_MEASUREMENT_EVIDENCE', message, inputHash }; }

/** Validate the immutable set before classifying only its persisted horizon shares. */
export function classifyBreadthV2ObservationSet(set: ObservationSet, exceptions: readonly CalendarException[]) {
  const date = iso(set.sessionDate);
  if (set.measurementVersion !== BREADTH_V2_MEASUREMENT_VERSION || set.provider !== 'TIINGO' || set.evidenceSchemaVersion !== BREADTH_V2_EVIDENCE_SCHEMA_VERSION || set.horizons.length !== 3 || set.universeCount <= 0 || set.targetBarCount > set.universeCount) throw new Error('Invalid V2 observation-set identity or counts.');
  const provenance = set.evidenceJson as Record<string, unknown>;
  const source = provenance?.source as Record<string, unknown> | undefined;
  if (!provenance || provenance.revisionId !== set.breadthUniverseRevisionId || provenance.memberCount !== set.universeCount || typeof provenance.constituentHash !== 'string' || provenance.constituentHash.length !== 64 || source?.provider !== 'TIINGO' || source.timeframe !== 'DAY_1' || source.adjustmentMode !== 'UNADJUSTED' || provenance.gapPolicy !== 'STRICT' || provenance.splitNormalizationVersion !== BREADTH_V2_TERTILE_V1.splitNormalizationVersion || Math.abs(set.targetCoverageRatio.toNumber() - set.targetBarCount / set.universeCount) > 0.0000000001) throw new Error('Invalid V2 observation-set provenance or target coverage.');
  const expected = datesBetween(addDays(date, -75), date).filter(d => marketSession(d, exceptions)).slice(-21);
  if (expected.length !== 21 || expected.at(-1) !== date) throw new Error('Calendar evidence unavailable for exact V2 anchors.');
  const byHorizon = new Map(set.horizons.map(row => [row.horizonSessions, row]));
  if (byHorizon.size !== 3 || [1, 5, 20].some(h => !byHorizon.has(h))) throw new Error('V2 observation set must contain exactly 1/5/20 horizons.');
  const shares = {} as { DAY_1: number; DAY_5: number; DAY_20: number };
  const horizonEvidence: Record<string, unknown> = {};
  for (const horizon of [1, 5, 20] as const) {
    const row = byHorizon.get(horizon)!;
    const anchor = expected[20 - horizon]!;
    if (iso(row.anchorSessionDate) !== anchor || row.universeCount !== set.universeCount || row.anchorBarCount > set.universeCount || row.eligibleCount + row.excludedCount !== set.universeCount || row.eligibleCount !== row.directionalCount + row.unchangedCount || row.directionalCount <= 0 || row.directionalCount !== row.advancingCount + row.decliningCount) throw new Error(`Invalid DAY_${horizon} counts or exact anchor.`);
    const share = row.advanceShare.toNumber(), net = row.netBreadth.toNumber();
    if (Math.abs(share - row.advancingCount / row.directionalCount) > 0.0000000001 || Math.abs(net - (row.advancingCount - row.decliningCount) / row.directionalCount) > 0.0000000001 || Math.abs(row.coverageRatio.toNumber() - row.eligibleCount / set.universeCount) > 0.0000000001) throw new Error(`Invalid DAY_${horizon} ratios.`);
    shares[`DAY_${horizon}`] = share;
    horizonEvidence[`DAY_${horizon}`] = { horizonObservationId: row.id, anchorSessionDate: anchor, advanceShare: row.advanceShare.toString(), netBreadth: row.netBreadth.toString(), canonicalInputHash: row.canonicalInputHash };
  }
  const expectedInputHash = hash({ measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, revisionId: set.breadthUniverseRevisionId, constituentHash: provenance.constituentHash, date, horizonHashes: [1, 5, 20].map(h => byHorizon.get(h)!.canonicalInputHash) });
  if (set.canonicalInputHash !== expectedInputHash) throw new Error('V2 observation-set input hash differs from its horizon evidence.');
  const classified = classifyFrozenBreadthV2Shares(shares);
  if (!classified.rawState) throw new Error('Required V2 horizon classification is unavailable.');
  for (const horizon of ['DAY_1', 'DAY_5', 'DAY_20'] as const) (horizonEvidence[horizon] as Record<string, unknown>).state = classified.horizonStates[horizon];
  const d5 = classified.horizonStates.DAY_5, d20 = classified.horizonStates.DAY_20;
  const structuralPath = d5 === d20 ? 'STRUCTURAL_AGREEMENT' : d5 !== 'MIXED' && d20 !== 'MIXED' ? 'OPPOSITE_DIRECTIONAL' : classified.rawState === 'MIXED' ? 'ONE_STRUCTURAL_DIRECTION_UNCONFIRMED' : 'DAY_1_CONFIRMED_STRUCTURAL_DIRECTION';
  return { sessionDate: date, horizonEvidence, ...classified, structuralPath };
}

async function verifyObservationPopulation(db: Db, set: ObservationSet) {
  const revision = await db.breadthUniverseRevision.findUnique({ where: { id: set.breadthUniverseRevisionId } });
  const members = await db.breadthUniverseRevisionMember.findMany({ where: { revisionId: set.breadthUniverseRevisionId }, include: { security: { select: { symbol: true } } } });
  const expectedHash = constituentHash(members.map(row => row.security.symbol));
  if (!revision || iso(revision.effectiveFrom) > iso(set.sessionDate) || revision.memberCount !== set.universeCount || members.length !== set.universeCount || new Set(members.map(row => row.securityId)).size !== members.length || new Set(members.map(row => row.security.symbol)).size !== members.length || (set.evidenceJson as { constituentHash?: string }).constituentHash !== expectedHash) throw new Error('V2 observation-set frozen population integrity failure.');
}

function continuation(previous: MarketRegimeDimensionAssessment): MildDeteriorationHistory {
  if (previous.dimension !== identity.dimension || previous.algorithmVersion !== identity.algorithmVersion || previous.status !== 'VALID' || !previous.sessionDate || previous.evidenceSchemaVersion !== BREADTH_V2_ASSESSMENT_EVIDENCE_SCHEMA_VERSION) throw new Error('Invalid V2 predecessor identity.');
  const parsed = predecessorEvidence.parse(previous.evidenceJson);
  if (parsed.transition.effectiveState !== previous.effectiveState) throw new Error('V2 predecessor transition conflicts with its effective state.');
  return { effectiveState: parsed.transition.effectiveState, recoveryConfirmation: parsed.transition.recoveryConfirmationAfter, mildDeteriorationConfirmation: parsed.transition.mildDeteriorationConfirmationAfter };
}

async function previewNext(db: Db, now: Date) {
  const exceptions = calendar(await db.marketCalendarException.findMany({ orderBy: { sessionDate: 'asc' } }));
  const latestEligible = latestEligibleTiingoSession(now, exceptions);
  if (!latestEligible) return { readiness: 'NOT_DUE' as const, sessionDate: null };
  const previous = await db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: 'VALID' }, orderBy: { targetAt: 'desc' } });
  const pending = await db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, status: { not: 'VALID' }, ...(previous ? { targetAt: { gt: previous.targetAt } } : {}) }, orderBy: [{ targetAt: 'asc' }, { attempt: 'desc' }] });
  let date: string | null = pending?.sessionDate ? iso(pending.sessionDate) : previous?.sessionDate ? nextSession(iso(previous.sessionDate), exceptions) : null;
  if (!date) {
    const latestSet = await db.marketBreadthObservationSet.findFirst({ where: { measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, sessionDate: { lte: new Date(latestEligible) } }, orderBy: { sessionDate: 'desc' } });
    date = latestSet ? iso(latestSet.sessionDate) : null;
    if (!date) return { readiness: 'BLOCKED' as const, sessionDate: latestEligible, blocker: { sessionDate: latestEligible, status: 'UNAVAILABLE' as const, reasonCode: 'MISSING_MEASUREMENT' as const, message: 'No authoritative V2 measurement set is available for bootstrap.', inputHash: null }, canAttempt: false };
  }
  if (date > latestEligible) {
    if (!previous) return { readiness: 'NOT_DUE' as const, sessionDate: date };
    try {
      const history = continuation(previous);
      return { readiness: 'ALREADY_PUBLISHED' as const, sessionDate: iso(previous.sessionDate!), latestAssessmentId: previous.id, effectiveState: history.effectiveState, recoveryConfirmation: history.recoveryConfirmation, mildDeteriorationConfirmation: history.mildDeteriorationConfirmation };
    } catch (error) {
      return { readiness: 'BLOCKED' as const, sessionDate: iso(previous.sessionDate!), blocker: { sessionDate: iso(previous.sessionDate!), status: 'FAILED' as const, reasonCode: 'CALCULATION_FAILED' as const, message: error instanceof Error ? error.message : 'Invalid V2 predecessor.', inputHash: null }, canAttempt: false };
    }
  }
  let next: string;
  try { next = nextSession(date, exceptions); }
  catch { return { readiness: 'BLOCKED' as const, sessionDate: date, blocker: { sessionDate: date, status: 'FAILED' as const, reasonCode: 'CALENDAR_EVIDENCE_UNAVAILABLE' as const, message: 'Next expected market session unavailable.', inputHash: null }, canAttempt: true }; }
  const targetAt = tiingoDayEligibleAt(date), validUntil = tiingoDayEligibleAt(next);
  const sets = await db.marketBreadthObservationSet.findMany({ where: { measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, sessionDate: new Date(date) }, include: { horizons: true } });
  if (!sets.length) return { readiness: 'BLOCKED' as const, sessionDate: date, targetAt, validUntil, previousAssessmentId: previous?.id ?? null, blocker: { sessionDate: date, status: 'UNAVAILABLE' as const, reasonCode: 'MISSING_MEASUREMENT' as const, message: 'The next expected session has no authoritative V2 measurement set.', inputHash: null }, canAttempt: true };
  if (sets.length !== 1) return { readiness: 'BLOCKED' as const, sessionDate: date, targetAt, validUntil, previousAssessmentId: previous?.id ?? null, blocker: invalidMeasurement('Multiple V2 measurement sets resolve to the same session.', date, hash(sets.map(set => set.canonicalInputHash))), canAttempt: true };
  const set = sets[0]!;
  let classified: ReturnType<typeof classifyBreadthV2ObservationSet>;
  try { classified = classifyBreadthV2ObservationSet(set, exceptions); await verifyObservationPopulation(db, set); }
  catch (error) { return { readiness: 'BLOCKED' as const, sessionDate: date, targetAt, validUntil, previousAssessmentId: previous?.id ?? null, observationSetId: set.id, blocker: invalidMeasurement(error instanceof Error ? error.message : 'Invalid V2 measurement.', date, set.canonicalInputHash), canAttempt: true }; }
  let prior: MildDeteriorationHistory;
  let replay: Awaited<ReturnType<typeof replayBreadthV2Bootstrap>> | null = null;
  if (previous) {
    try { prior = continuation(previous); }
    catch (error) { return { readiness: 'BLOCKED' as const, sessionDate: date, targetAt, validUntil, previousAssessmentId: previous.id, observationSetId: set.id, blocker: { sessionDate: date, status: 'FAILED' as const, reasonCode: 'CALCULATION_FAILED' as const, message: error instanceof Error ? error.message : 'Invalid V2 predecessor.', inputHash: set.canonicalInputHash }, canAttempt: true }; }
  } else {
    try {
      replay = await replayBreadthV2Bootstrap(db, set, priorSession(date, exceptions));
      if (!replay.validRawSessionCount || !replay.preCurrentEffectiveState) return { readiness: 'BLOCKED' as const, sessionDate: date, targetAt, validUntil, observationSetId: set.id, bootstrap: true, historicalReplay: compactReplay(replay), blocker: { sessionDate: date, status: 'UNAVAILABLE' as const, reasonCode: 'INSUFFICIENT_BOOTSTRAP_HISTORY' as const, message: 'No valid historical raw state established V2 hysteresis.', inputHash: replay.historicalReplayHash }, canAttempt: true };
      prior = { effectiveState: replay.preCurrentEffectiveState, recoveryConfirmation: replay.preCurrentRecoveryConfirmation, mildDeteriorationConfirmation: replay.preCurrentMildDeteriorationConfirmation };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Historical V2 replay failed.';
      return { readiness: 'BLOCKED' as const, sessionDate: date, targetAt, validUntil, observationSetId: set.id, bootstrap: true, blocker: { sessionDate: date, status: 'FAILED' as const, reasonCode: message.includes('calendar') || message.includes('session') ? 'CALENDAR_EVIDENCE_UNAVAILABLE' as const : 'CALCULATION_FAILED' as const, message, inputHash: set.canonicalInputHash }, canAttempt: true };
    }
  }
  const transition = advanceFrozenBreadthV2(prior, classified.rawState);
  const historicalReplay = replay ? compactReplay(replay) : null;
  return { readiness: 'READY' as const, sessionDate: date, targetAt, validUntil, observationSetId: set.id, observationSetHash: set.canonicalInputHash, dataThroughAt: set.dataThroughAt, revisionId: set.breadthUniverseRevisionId, memberCount: set.universeCount, constituentHash: (set.evidenceJson as { constituentHash?: string }).constituentHash ?? null, horizonValues: classified.horizonEvidence, horizonStates: classified.horizonStates, rawState: classified.rawState, structuralPath: classified.structuralPath, transition, bootstrap: previous === null, historicalReplay, previousAssessmentId: previous?.id ?? null, priorAttemptId: pending?.id ?? null };
}

function compactReplay(replay: Awaited<ReturnType<typeof replayBreadthV2Bootstrap>>) {
  const { rawStates: _rawStates, ...summary } = replay;
  return summary;
}

export async function breadthV2AssessmentStatus(options: Options = {}) {
  const db = options.db ?? prisma, now = options.now ?? new Date();
  return db.$transaction(async tx => { await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY'); return previewNext(tx, now); }, { isolationLevel: 'RepeatableRead', timeout: 30 * 60_000 });
}

export async function publishBreadthV2Assessments(options: Options = {}) {
  const db = options.db ?? prisma, now = options.now ?? new Date(), clock = options.clock ?? (() => new Date());
  return db.$transaction(async tx => {
    const locks = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${BREADTH_V2_PUBLICATION_LOCK_KEY}::bigint) AS acquired`;
    if (!locks[0]?.acquired) throw new HttpError(409, 'BREADTH_V2 assessment publication is already running.');
    const result: { published: number; attempts: number; suppressed: boolean; notDue: boolean; blocked: Blocker | null; assessments: number[] } = { published: 0, attempts: 0, suppressed: false, notDue: false, blocked: null, assessments: [] };
    for (let count = 0; count < MAX_CATCH_UP; count++) {
      const preview = await previewNext(tx, now);
      if (preview.readiness === 'ALREADY_PUBLISHED' || preview.readiness === 'NOT_DUE') return { ...result, notDue: result.attempts === 0 };
      if (preview.readiness === 'BLOCKED' && (!preview.canAttempt || !('targetAt' in preview) || !preview.targetAt)) return { ...result, blocked: preview.blocker };
      const date = preview.sessionDate!;
      const targetAt = preview.targetAt!;
      const priorAttempt = await tx.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, targetAt }, orderBy: { attempt: 'desc' } });
      const blocker = preview.readiness === 'BLOCKED' ? preview.blocker : null;
      const fingerprint = hash({ algorithmVersion: identity.algorithmVersion, evidenceVersion: BREADTH_V2_ASSESSMENT_EVIDENCE_VERSION, sessionDate: date, targetAt, previousAssessmentId: 'previousAssessmentId' in preview ? preview.previousAssessmentId : null, observationSetHash: 'observationSetHash' in preview ? preview.observationSetHash : 'observationSetId' in preview ? preview.observationSetId : null, blocker: blocker ? { reasonCode: blocker.reasonCode, inputHash: blocker.inputHash, message: blocker.message } : null, historicalReplayHash: 'historicalReplay' in preview ? preview.historicalReplay?.historicalReplayHash ?? null : null });
      if (blocker && priorAttempt?.status !== 'VALID' && (priorAttempt?.evidenceJson as { attemptFingerprint?: string } | undefined)?.attemptFingerprint === fingerprint) return { ...result, suppressed: true, blocked: blocker };
      const startedAt = clock();
      const completedAt = clock();
      const evidence = preview.readiness === 'READY' ? {
        algorithmVersion: identity.algorithmVersion, assessmentEvidenceVersion: BREADTH_V2_ASSESSMENT_EVIDENCE_VERSION, evidenceSchemaVersion: BREADTH_V2_ASSESSMENT_EVIDENCE_SCHEMA_VERSION,
        definition: BREADTH_V2_TERTILE_V1, measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, observationSetId: preview.observationSetId, observationSetCanonicalInputHash: preview.observationSetHash,
        revisionId: preview.revisionId, memberCount: preview.memberCount, constituentHash: preview.constituentHash,
        horizons: preview.horizonValues, horizonStates: preview.horizonStates, rawState: preview.rawState,
        structuralAggregation: { rule: BREADTH_V2_TERTILE_V1.structuralAggregationRule, path: preview.structuralPath },
        transition: { predecessorAssessmentId: preview.previousAssessmentId, ...preview.transition },
        bootstrap: preview.bootstrap, historicalReplay: preview.historicalReplay,
        timingVersion: TIINGO_DAY_1_TIMING_VERSION, targetAt, validUntil: preview.validUntil, dataThroughAt: preview.dataThroughAt,
        attemptFingerprint: fingerprint,
      } : { algorithmVersion: identity.algorithmVersion, assessmentEvidenceVersion: BREADTH_V2_ASSESSMENT_EVIDENCE_VERSION, evidenceSchemaVersion: BREADTH_V2_ASSESSMENT_EVIDENCE_SCHEMA_VERSION,
        measurementVersion: BREADTH_V2_MEASUREMENT_VERSION, sessionDate: date, predecessorAssessmentId: 'previousAssessmentId' in preview ? preview.previousAssessmentId : null,
        observationSetId: 'observationSetId' in preview ? preview.observationSetId : null, blocker, attemptFingerprint: fingerprint, timingVersion: TIINGO_DAY_1_TIMING_VERSION };
      const assessment = await tx.marketRegimeDimensionAssessment.create({ data: {
        ...identity, evidenceSchemaVersion: BREADTH_V2_ASSESSMENT_EVIDENCE_SCHEMA_VERSION, sessionDate: new Date(date), targetAt,
        attempt: (priorAttempt?.attempt ?? 0) + 1, status: blocker?.status ?? 'VALID', reasonCode: blocker?.reasonCode ?? null,
        rawState: preview.readiness === 'READY' ? preview.rawState : null,
        effectiveState: preview.readiness === 'READY' ? preview.transition.effectiveState : null,
        dataThroughAt: preview.readiness === 'READY' ? preview.dataThroughAt : null,
        validUntil: preview.readiness === 'READY' ? preview.validUntil : null,
        previousAssessmentId: 'previousAssessmentId' in preview ? preview.previousAssessmentId : null,
        startedAt, completedAt, evidenceJson: json(evidence),
      } });
      result.attempts++; result.assessments.push(assessment.id);
      if (!blocker) result.published++;
      const event = blocker ? 'breadth_v2_assessment_blocked' : preview.readiness === 'READY' && preview.bootstrap ? 'breadth_v2_assessment_bootstrap' : priorAttempt?.status !== 'VALID' && priorAttempt ? 'breadth_v2_assessment_recovered' : preview.readiness === 'READY' && preview.transition.transitioned ? 'breadth_v2_assessment_transition' : null;
      if (event) await tx.systemEvent.create({ data: { type: event, entityType: 'market_regime_assessment', entityId: String(assessment.id), severity: blocker ? 'WARNING' : 'INFO', message: blocker ? `BREADTH_V2 stopped at ${date}: ${blocker.reasonCode}.` : `BREADTH_V2 ${date}: ${assessment.effectiveState}.`, payloadJson: { assessmentId: assessment.id, sessionDate: date, reasonCode: blocker?.reasonCode ?? null, previousAssessmentId: assessment.previousAssessmentId, recoveredFromBlocked: !blocker && !!priorAttempt && priorAttempt.status !== 'VALID' } } });
      if (blocker) return { ...result, blocked: blocker };
      if (preview.readiness === 'READY' && preview.bootstrap) return result; // First publication is one current assessment, never historical catch-up.
    }
    return result;
  }, { isolationLevel: 'RepeatableRead', timeout: 30 * 60_000 });
}

export async function latestBreadthV2Assessment(db: PrismaClient = prisma) { return db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity }, orderBy: [{ targetAt: 'desc' }, { attempt: 'desc' }] }); }
export async function listBreadthV2Assessments(limit: number, beforeId?: number, db: PrismaClient = prisma) { return db.marketRegimeDimensionAssessment.findMany({ where: { ...identity, ...(beforeId ? { id: { lt: beforeId } } : {}) }, take: limit, orderBy: { id: 'desc' } }); }
export async function getBreadthV2Assessment(id: number, db: PrismaClient = prisma) { return db.marketRegimeDimensionAssessment.findFirst({ where: { ...identity, id } }); }
