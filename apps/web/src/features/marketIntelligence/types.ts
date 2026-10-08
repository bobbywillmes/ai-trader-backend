export type AssessmentStatus = "VALID" | "UNAVAILABLE" | "FAILED";
export type Assessment = {
  id: number; dimension: string; algorithmVersion: string; evidenceSchemaVersion: number;
  targetAt: string; sessionDate: string | null; attempt: number; status: AssessmentStatus;
  reasonCode: string | null; rawState: string | null; effectiveState: string | null;
  dataThroughAt: string | null; validUntil: string | null; previousAssessmentId: number | null;
  startedAt: string; completedAt: string; createdAt: string; evidenceJson: unknown;
};
export type DimensionKey = "trend" | "volatility" | "breadth" | "participation" | "intradayStress";
export type DimensionSummary = { dimension: string; algorithmVersion: string; latestAttempt: Assessment | null; latestValid: Assessment | null };
export type HorizonObservation = { id: number; horizonSessions: number; anchorSessionDate: string; coverageRatio: string; advanceShare: string; netBreadth: string; advancingCount: number; decliningCount: number; unchangedCount: number; evidenceJson: unknown };
export type BreadthObservation = { id: number; sessionDate: string; measurementVersion: string; universeCount: number; targetBarCount: number; targetCoverageRatio: string; dataThroughAt: string; evidenceJson: unknown; horizons: HorizonObservation[] };
export type IntelligenceSummary = {
  evaluatedAt: string; semantics: string; dimensions: Record<DimensionKey, DimensionSummary>;
  breadthV2: { latestAttempt: Assessment | null; latestValid: Assessment | null; latestObservation: BreadthObservation | null; assessmentReadiness: Record<string, unknown>; observationReadiness: Record<string, unknown>; worker: Record<string, unknown> };
};
export type Freshness = "AVAILABLE" | "EXPIRED" | "UNAVAILABLE" | "FAILED" | "NOT_PUBLISHED";
export type CompositionSource = {
  id: number; ordinal: number; dimension: string; requiredAlgorithmVersion: string;
  expectedTargetAt: string; sourceAssessmentId: number | null; sourceEvidenceSchemaVersion: number | null;
  sourceAttempt: number | null; sourceStatus: AssessmentStatus | null; sourceTargetAt: string | null;
  sourceCompletedAt: string | null; sourceDataThroughAt: string | null; sourceValidUntil: string | null;
  sourceRawState: string | null; sourceEffectiveState: string | null; health: string; reasonCode: string | null;
  currentHealth?: string; currentReasonCode?: string | null; evidenceJson: unknown;
};
export type MarketRegimeComposition = {
  id: number; compositionVersion: string; evidenceSchemaVersion: number; targetAt: string; observedAt: string;
  dataThroughAt: string | null; validUntil: string | null; publicationStatus: "SUCCEEDED" | "FAILED";
  evidenceHealth: "COMPLETE" | "DEGRADED"; publicationReasonCode: string | null; evidenceReasonCode: string | null;
  sourceSetFingerprint: string; previousAssessmentId: number | null; startedAt: string; completedAt: string;
  createdAt: string; evidenceJson: unknown; sources: CompositionSource[];
};
export type CurrentMarketRegimeComposition = {
  evaluatedAt: string; freshness: "FRESH" | "EXPIRED" | "PUBLICATION_FAILED" | "NOT_PUBLISHED";
  wholeVectorUsable: boolean; assessment: MarketRegimeComposition | null;
};
