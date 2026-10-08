import { createHash } from 'node:crypto';
import type { MarketRegimeDimension, MarketRegimeDimensionAssessmentStatus } from '@prisma/client';
import {
  AUTHORITATIVE_MARKET_REGIME_SOURCES,
  MARKET_REGIME_COMPOSITION_EVIDENCE_SCHEMA_VERSION,
  MARKET_REGIME_COMPOSITION_VERSION,
  type AuthoritativeMarketRegimeSourceKey,
} from './market-regime-composition.definition.js';

export type DimensionAssessmentCandidate = {
  id: number;
  dimension: MarketRegimeDimension;
  algorithmVersion: string;
  evidenceSchemaVersion: number;
  targetAt: Date;
  attempt: number;
  status: MarketRegimeDimensionAssessmentStatus;
  reasonCode: string | null;
  rawState: string | null;
  effectiveState: string | null;
  dataThroughAt: Date | null;
  validUntil: Date | null;
  completedAt: Date;
};

export type ExpectedMarketRegimeTargets = Record<AuthoritativeMarketRegimeSourceKey, Date>;

export type ComposedMarketRegimeSource = {
  ordinal: number;
  key: AuthoritativeMarketRegimeSourceKey;
  dimension: MarketRegimeDimension;
  requiredAlgorithmVersion: string;
  expectedTargetAt: Date;
  source: DimensionAssessmentCandidate | null;
  health: 'AVAILABLE' | 'MISSING' | 'UNAVAILABLE' | 'FAILED' | 'STALE' | 'EXPIRED' | 'INVALID';
  reasonCode: string | null;
};

export type MarketRegimeCompositionSelection = {
  compositionVersion: typeof MARKET_REGIME_COMPOSITION_VERSION;
  evidenceSchemaVersion: typeof MARKET_REGIME_COMPOSITION_EVIDENCE_SCHEMA_VERSION;
  publicationStatus: 'SUCCEEDED';
  observedAt: Date;
  targetAt: Date;
  dataThroughAt: Date | null;
  validUntil: Date | null;
  evidenceHealth: 'COMPLETE' | 'DEGRADED';
  publicationReasonCode: string | null;
  evidenceReasonCode: string | null;
  sourceSetFingerprint: string;
  sources: ComposedMarketRegimeSource[];
};

function compareCandidates(a: DimensionAssessmentCandidate, b: DimensionAssessmentCandidate) {
  return b.targetAt.getTime() - a.targetAt.getTime()
    || b.attempt - a.attempt
    || b.completedAt.getTime() - a.completedAt.getTime()
    || b.id - a.id;
}

function classifySource(
  source: DimensionAssessmentCandidate | null,
  expectedTargetAt: Date,
  observedAt: Date,
): Pick<ComposedMarketRegimeSource, 'health' | 'reasonCode'> {
  if (!source) return { health: 'MISSING', reasonCode: 'SOURCE_MISSING' };
  if (source.status === 'FAILED') return { health: 'FAILED', reasonCode: source.reasonCode ?? 'SOURCE_FAILED' };
  if (source.status === 'UNAVAILABLE') return { health: 'UNAVAILABLE', reasonCode: source.reasonCode ?? 'SOURCE_UNAVAILABLE' };
  if (!source.rawState || !source.effectiveState || !source.dataThroughAt || !source.validUntil
    || source.evidenceSchemaVersion < 1 || source.attempt < 1
    || source.validUntil.getTime() <= source.targetAt.getTime()
    || source.dataThroughAt.getTime() > source.completedAt.getTime()) {
    return { health: 'INVALID', reasonCode: 'SOURCE_EVIDENCE_INVALID' };
  }
  if (source.targetAt.getTime() !== expectedTargetAt.getTime()) {
    return { health: 'STALE', reasonCode: 'EXPECTED_TARGET_NOT_PUBLISHED' };
  }
  if (observedAt.getTime() >= source.validUntil.getTime()) {
    return { health: 'EXPIRED', reasonCode: 'SOURCE_EXPIRED' };
  }
  return { health: 'AVAILABLE', reasonCode: null };
}

function fingerprint(sources: ComposedMarketRegimeSource[]) {
  const identity = {
    compositionVersion: MARKET_REGIME_COMPOSITION_VERSION,
    evidenceSchemaVersion: MARKET_REGIME_COMPOSITION_EVIDENCE_SCHEMA_VERSION,
    sources: sources.map(item => ({
      ordinal: item.ordinal,
      dimension: item.dimension,
      requiredAlgorithmVersion: item.requiredAlgorithmVersion,
      expectedTargetAt: item.expectedTargetAt.toISOString(),
      sourceAssessmentId: item.source?.id ?? null,
      sourceTargetAt: item.source?.targetAt.toISOString() ?? null,
      sourceAttempt: item.source?.attempt ?? null,
      sourceCompletedAt: item.source?.completedAt.toISOString() ?? null,
      health: item.health,
      reasonCode: item.reasonCode,
    })),
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/**
 * Selects an immutable as-of source vector without database access or writes.
 *
 * Applicability is target-first: only rows completed by observedAt and whose target is
 * not after the caller-supplied expected target participate. The newest target wins,
 * then the highest attempt, completion time, and ID. This prevents a late historical
 * backfill from displacing the current target while allowing a late retry of that exact
 * target to replace its earlier attempt. The latest failed/unavailable attempt is retained;
 * there is no latest-valid fallback.
 */
export function selectMarketRegimeComposition(args: {
  observedAt: Date;
  expectedTargets: ExpectedMarketRegimeTargets;
  assessments: readonly DimensionAssessmentCandidate[];
}): MarketRegimeCompositionSelection {
  const observedAt = new Date(args.observedAt);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('observedAt must be a valid timestamp.');

  const sources = AUTHORITATIVE_MARKET_REGIME_SOURCES.map(definition => {
    const expectedTargetAt = new Date(args.expectedTargets[definition.key]);
    if (!Number.isFinite(expectedTargetAt.getTime())) throw new Error(`Missing valid expected target for ${definition.key}.`);
    if (expectedTargetAt.getTime() > observedAt.getTime()) throw new Error(`Expected target for ${definition.key} is after observedAt.`);
    const source = args.assessments
      .filter(row => row.dimension === definition.dimension
        && row.algorithmVersion === definition.algorithmVersion
        && row.targetAt.getTime() <= expectedTargetAt.getTime()
        && row.completedAt.getTime() <= observedAt.getTime())
      .sort(compareCandidates)[0] ?? null;
    return {
      ordinal: definition.ordinal,
      key: definition.key,
      dimension: definition.dimension as MarketRegimeDimension,
      requiredAlgorithmVersion: definition.algorithmVersion,
      expectedTargetAt,
      source,
      ...classifySource(source, expectedTargetAt, observedAt),
    } satisfies ComposedMarketRegimeSource;
  });
  const complete = sources.every(source => source.health === 'AVAILABLE');
  const available = sources.flatMap(source => source.health === 'AVAILABLE' && source.source ? [source.source] : []);
  const targetAt = new Date(Math.max(...sources.map(source => source.expectedTargetAt.getTime())));
  const dataThroughAt = complete ? new Date(Math.min(...available.map(source => source.dataThroughAt!.getTime()))) : null;
  const validUntil = complete ? new Date(Math.min(...available.map(source => source.validUntil!.getTime()))) : null;
  return {
    compositionVersion: MARKET_REGIME_COMPOSITION_VERSION,
    evidenceSchemaVersion: MARKET_REGIME_COMPOSITION_EVIDENCE_SCHEMA_VERSION,
    publicationStatus: 'SUCCEEDED',
    observedAt,
    targetAt,
    dataThroughAt,
    validUntil,
    evidenceHealth: complete ? 'COMPLETE' : 'DEGRADED',
    publicationReasonCode: null,
    evidenceReasonCode: complete ? null : 'SOURCE_VECTOR_DEGRADED',
    sourceSetFingerprint: fingerprint(sources),
    sources,
  };
}

export function isMarketRegimeCompositionUsable(
  composition: Pick<MarketRegimeCompositionSelection, 'publicationStatus' | 'evidenceHealth' | 'validUntil'>,
  at: Date,
) {
  return composition.publicationStatus === 'SUCCEEDED'
    && composition.evidenceHealth === 'COMPLETE'
    && composition.validUntil !== null
    && at.getTime() < composition.validUntil.getTime();
}
