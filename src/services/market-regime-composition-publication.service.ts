import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import {
  AUTHORITATIVE_MARKET_REGIME_SOURCES,
  MARKET_REGIME_COMPOSITION_EVIDENCE_SCHEMA_VERSION,
  MARKET_REGIME_COMPOSITION_VERSION,
} from './market-regime-composition.definition.js';
import {
  selectMarketRegimeComposition,
  type DimensionAssessmentCandidate,
} from './market-regime-composition.service.js';
import { readMarketRegimeExpectedTargets } from './market-regime-target-resolution.service.js';

type CompositionDb = Prisma.TransactionClient;
export const MARKET_REGIME_COMPOSITION_LOCK_KEY = createHash('sha256')
  .update('ai-trader:market-regime-composition-v1-publication').digest().readBigInt64BE(0);

const includeSources = { sources: { orderBy: { ordinal: 'asc' as const } } };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function selectCandidates(db: CompositionDb, observedAt: Date, targets: Awaited<ReturnType<typeof readMarketRegimeExpectedTargets>>['targets']) {
  return Promise.all(AUTHORITATIVE_MARKET_REGIME_SOURCES.map(definition => db.marketRegimeDimensionAssessment.findFirst({
    where: {
      dimension: definition.dimension,
      algorithmVersion: definition.algorithmVersion,
      targetAt: { lte: targets[definition.key] },
      completedAt: { lte: observedAt },
    },
    orderBy: [{ targetAt: 'desc' }, { attempt: 'desc' }, { completedAt: 'desc' }, { id: 'desc' }],
  }))) as Promise<Array<DimensionAssessmentCandidate | null>>;
}

export async function previewMarketRegimeCompositionInTransaction(db: CompositionDb, observedAt: Date) {
  const resolution = await readMarketRegimeExpectedTargets(db, observedAt);
  const candidates = await selectCandidates(db, observedAt, resolution.targets);
  const selection = selectMarketRegimeComposition({ observedAt, expectedTargets: resolution.targets,
    assessments: candidates.filter((row): row is DimensionAssessmentCandidate => row !== null) });
  return { ...selection, sessions: resolution.sessions };
}

export async function previewMarketRegimeComposition(observedAt = new Date(), client: PrismaClient = prisma) {
  return client.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return previewMarketRegimeCompositionInTransaction(tx, observedAt);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000, maxWait: 5_000 });
}

export async function publishMarketRegimeComposition(options: { observedAt?: Date; clock?: () => Date; db?: PrismaClient } = {}) {
  const db = options.db ?? prisma;
  const observedAt = options.observedAt ?? new Date();
  const clock = options.clock ?? (() => new Date());
  let fingerprint: string | null = null;
  try {
    return await db.$transaction(async tx => {
      const locks = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${MARKET_REGIME_COMPOSITION_LOCK_KEY}::bigint) AS acquired`;
      if (!locks[0]?.acquired) throw new HttpError(409, 'Market Regime composition publication is already running.');
      const preview = await previewMarketRegimeCompositionInTransaction(tx, observedAt);
      fingerprint = preview.sourceSetFingerprint;
      const existing = await tx.marketRegimeAssessment.findUnique({
        where: { compositionVersion_sourceSetFingerprint: { compositionVersion: MARKET_REGIME_COMPOSITION_VERSION, sourceSetFingerprint: fingerprint } },
        include: includeSources,
      });
      if (existing) return { published: false, reused: true, assessment: existing, preview };
      const previous = await tx.marketRegimeAssessment.findFirst({
        where: { compositionVersion: MARKET_REGIME_COMPOSITION_VERSION }, orderBy: { id: 'desc' },
      });
      const completedAt = clock();
      if (completedAt < observedAt) throw new Error('Composition completion cannot precede observation time.');
      const evidence = {
        compositionVersion: MARKET_REGIME_COMPOSITION_VERSION,
        evidenceSchemaVersion: MARKET_REGIME_COMPOSITION_EVIDENCE_SCHEMA_VERSION,
        observedAt: observedAt.toISOString(), targetAt: preview.targetAt.toISOString(),
        sourceSetFingerprint: preview.sourceSetFingerprint, evidenceHealth: preview.evidenceHealth,
        publicationReasonCode: null, evidenceReasonCode: preview.evidenceReasonCode,
        sources: preview.sources.map(source => ({ ordinal: source.ordinal, key: source.key, dimension: source.dimension,
          requiredAlgorithmVersion: source.requiredAlgorithmVersion, expectedTargetAt: source.expectedTargetAt.toISOString(),
          sourceAssessmentId: source.source?.id ?? null, health: source.health, reasonCode: source.reasonCode })),
        sessions: preview.sessions,
        semantics: 'Immutable as-of source vector only; no directional interpretation, strategy policy, or trading authority.',
      };
      const assessment = await tx.marketRegimeAssessment.create({
        data: {
          compositionVersion: MARKET_REGIME_COMPOSITION_VERSION,
          evidenceSchemaVersion: MARKET_REGIME_COMPOSITION_EVIDENCE_SCHEMA_VERSION,
          targetAt: preview.targetAt, observedAt, dataThroughAt: preview.dataThroughAt,
          validUntil: preview.validUntil, publicationStatus: 'SUCCEEDED', evidenceHealth: preview.evidenceHealth,
          publicationReasonCode: null, evidenceReasonCode: preview.evidenceReasonCode,
          sourceSetFingerprint: preview.sourceSetFingerprint, previousAssessmentId: previous?.id ?? null,
          startedAt: observedAt, completedAt, evidenceJson: json(evidence),
          sources: { create: preview.sources.map(source => ({
            dimension: source.dimension, requiredAlgorithmVersion: source.requiredAlgorithmVersion,
            expectedTargetAt: source.expectedTargetAt, sourceAssessmentId: source.source?.id ?? null,
            sourceEvidenceSchemaVersion: source.source?.evidenceSchemaVersion ?? null,
            sourceAttempt: source.source?.attempt ?? null, sourceStatus: source.source?.status ?? null,
            sourceTargetAt: source.source?.targetAt ?? null, sourceCompletedAt: source.source?.completedAt ?? null,
            sourceDataThroughAt: source.source?.dataThroughAt ?? null, sourceValidUntil: source.source?.validUntil ?? null,
            sourceRawState: source.source?.rawState ?? null, sourceEffectiveState: source.source?.effectiveState ?? null,
            health: source.health, reasonCode: source.reasonCode, ordinal: source.ordinal,
            evidenceJson: json({ key: source.key, expectedSessionDate: preview.sessions[source.key], health: source.health, reasonCode: source.reasonCode }),
          })) },
        }, include: includeSources,
      });
      const recovered = previous?.evidenceHealth === 'DEGRADED' && assessment.evidenceHealth === 'COMPLETE';
      await tx.systemEvent.create({ data: {
        type: recovered ? 'market_regime_composition_recovered' : assessment.evidenceHealth === 'DEGRADED'
          ? 'market_regime_composition_degraded' : 'market_regime_composition_published',
        entityType: 'market_regime_composition', entityId: String(assessment.id),
        severity: assessment.evidenceHealth === 'DEGRADED' ? 'WARNING' : 'INFO',
        message: `Market Regime composition ${assessment.id} published with ${assessment.evidenceHealth} evidence.`,
        payloadJson: { assessmentId: assessment.id, compositionVersion: assessment.compositionVersion,
          evidenceHealth: assessment.evidenceHealth, sourceSetFingerprint: assessment.sourceSetFingerprint,
          previousAssessmentId: assessment.previousAssessmentId },
      } });
      return { published: true, reused: false, assessment, preview };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000, maxWait: 5_000 });
  } catch (error) {
    if (fingerprint && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.marketRegimeAssessment.findUnique({
        where: { compositionVersion_sourceSetFingerprint: { compositionVersion: MARKET_REGIME_COMPOSITION_VERSION, sourceSetFingerprint: fingerprint } },
        include: includeSources,
      });
      if (winner) return { published: false, reused: true, assessment: winner, preview: null };
    }
    throw error;
  }
}

export function evaluateMarketRegimeCompositionFreshness(row: {
  publicationStatus: 'SUCCEEDED' | 'FAILED'; evidenceHealth: 'COMPLETE' | 'DEGRADED';
  sources: Array<{ health: string; reasonCode: string | null; sourceValidUntil: Date | null }>;
}, at = new Date()) {
  const sources = row.sources.map(source => source.health === 'AVAILABLE' &&
    (source.sourceValidUntil === null || at.getTime() >= source.sourceValidUntil.getTime())
    ? { ...source, currentHealth: 'EXPIRED' as const, currentReasonCode: 'SOURCE_EXPIRED_AT_READ' as const }
    : { ...source, currentHealth: source.health, currentReasonCode: source.reasonCode });
  const freshness = row.publicationStatus === 'FAILED' ? 'PUBLICATION_FAILED' as const
    : sources.some(source => source.currentHealth === 'EXPIRED') ? 'EXPIRED' as const : 'FRESH' as const;
  return { freshness, sources, wholeVectorUsable: row.publicationStatus === 'SUCCEEDED'
    && row.evidenceHealth === 'COMPLETE' && sources.every(source => source.currentHealth === 'AVAILABLE') };
}

export async function currentMarketRegimeComposition(at = new Date(), client: PrismaClient = prisma) {
  const assessment = await client.marketRegimeAssessment.findFirst({
    where: { compositionVersion: MARKET_REGIME_COMPOSITION_VERSION }, orderBy: { id: 'desc' }, include: includeSources,
  });
  if (!assessment) return { evaluatedAt: at, freshness: 'NOT_PUBLISHED' as const, wholeVectorUsable: false, assessment: null };
  const evaluated = evaluateMarketRegimeCompositionFreshness(assessment, at);
  return { evaluatedAt: at, freshness: evaluated.freshness, wholeVectorUsable: evaluated.wholeVectorUsable,
    assessment: { ...assessment, sources: evaluated.sources } };
}

export function listMarketRegimeCompositions(limit: number, beforeId?: number, client: PrismaClient = prisma) {
  return client.marketRegimeAssessment.findMany({ where: { compositionVersion: MARKET_REGIME_COMPOSITION_VERSION,
    ...(beforeId ? { id: { lt: beforeId } } : {}) }, orderBy: { id: 'desc' }, take: limit, include: includeSources });
}

export async function getMarketRegimeComposition(id: number, client: PrismaClient = prisma) {
  const row = await client.marketRegimeAssessment.findFirst({
    where: { id, compositionVersion: MARKET_REGIME_COMPOSITION_VERSION }, include: includeSources,
  });
  if (!row) throw new HttpError(404, 'Market Regime composition not found.');
  return row;
}

export async function marketRegimeCompositionStatus(at = new Date(), client: PrismaClient = prisma) {
  const [current, preview] = await Promise.all([currentMarketRegimeComposition(at, client), previewMarketRegimeComposition(at, client)]);
  return { ...current, readiness: current.assessment?.sourceSetFingerprint === preview.sourceSetFingerprint ? 'ALREADY_CURRENT' : 'READY', preview };
}
