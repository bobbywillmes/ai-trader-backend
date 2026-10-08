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
