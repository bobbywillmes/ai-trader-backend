import { z } from 'zod';

export const MARKET_REGIME_COMPOSITION_VERSION = 'MARKET_REGIME_COMPOSITION_V1';
export const MARKET_REGIME_COMPOSITION_EVIDENCE_SCHEMA_VERSION = 1;

export const AUTHORITATIVE_MARKET_REGIME_SOURCES = Object.freeze([
  { ordinal: 1, key: 'trend', dimension: 'TREND', algorithmVersion: 'TREND_V1' },
  { ordinal: 2, key: 'volatility', dimension: 'VOLATILITY', algorithmVersion: 'VOLATILITY_V1' },
  { ordinal: 3, key: 'breadth', dimension: 'BREADTH', algorithmVersion: 'BREADTH_V1' },
  { ordinal: 4, key: 'participation', dimension: 'PARTICIPATION', algorithmVersion: 'PARTICIPATION_V1' },
  { ordinal: 5, key: 'intradayStress', dimension: 'INTRADAY_STRESS', algorithmVersion: 'INTRADAY_STRESS_V1' },
] as const);

export type AuthoritativeMarketRegimeSource = typeof AUTHORITATIVE_MARKET_REGIME_SOURCES[number];
export type AuthoritativeMarketRegimeSourceKey = AuthoritativeMarketRegimeSource['key'];

export const marketRegimeCompositionSourceHealthSchema = z.enum([
  'AVAILABLE', 'MISSING', 'UNAVAILABLE', 'FAILED', 'STALE', 'EXPIRED', 'INVALID',
]);

export const marketRegimeCompositionEvidenceSchema = z.strictObject({
  compositionVersion: z.literal(MARKET_REGIME_COMPOSITION_VERSION),
  evidenceSchemaVersion: z.literal(MARKET_REGIME_COMPOSITION_EVIDENCE_SCHEMA_VERSION),
  observedAt: z.iso.datetime(),
  targetAt: z.iso.datetime(),
  sourceSetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceHealth: z.enum(['COMPLETE', 'DEGRADED']),
  publicationReasonCode: z.string().nullable(),
  evidenceReasonCode: z.string().nullable(),
  sources: z.array(z.strictObject({
    ordinal: z.number().int().min(1).max(5),
    key: z.enum(['trend', 'volatility', 'breadth', 'participation', 'intradayStress']),
    dimension: z.enum(['TREND', 'VOLATILITY', 'BREADTH', 'PARTICIPATION', 'INTRADAY_STRESS']),
    requiredAlgorithmVersion: z.string().min(1),
    expectedTargetAt: z.iso.datetime(),
    sourceAssessmentId: z.number().int().positive().nullable(),
    health: marketRegimeCompositionSourceHealthSchema,
    reasonCode: z.string().nullable(),
  })).length(5),
});
