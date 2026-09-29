BEGIN;

CREATE TABLE "MarketBreadthObservationSet" (
  "id" SERIAL PRIMARY KEY,
  "breadthUniverseRevisionId" INTEGER NOT NULL REFERENCES "BreadthUniverseRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "sessionDate" DATE NOT NULL,
  "provider" "MarketDataProvider" NOT NULL,
  "measurementVersion" TEXT NOT NULL,
  "evidenceSchemaVersion" INTEGER NOT NULL,
  "universeCount" INTEGER NOT NULL,
  "targetBarCount" INTEGER NOT NULL,
  "targetCoverageRatio" DECIMAL(12,10) NOT NULL,
  "dataThroughAt" TIMESTAMPTZ(3) NOT NULL,
  "canonicalInputHash" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketBreadthObservationSet_integrity_check" CHECK (
    "provider" = 'TIINGO' AND "universeCount" > 0 AND "targetBarCount" BETWEEN 0 AND "universeCount" AND
    "targetCoverageRatio" BETWEEN 0 AND 1 AND "evidenceSchemaVersion" > 0 AND
    length("measurementVersion") BETWEEN 1 AND 80 AND length("canonicalInputHash") = 64 AND
    "completedAt" >= "startedAt" AND jsonb_typeof("evidenceJson") = 'object'
  )
);
CREATE UNIQUE INDEX "MarketBreadthObservationSet_identity_key" ON "MarketBreadthObservationSet"("measurementVersion", "breadthUniverseRevisionId", "sessionDate");
CREATE INDEX "MarketBreadthObservationSet_sessionDate_idx" ON "MarketBreadthObservationSet"("sessionDate");

CREATE TABLE "MarketBreadthHorizonObservation" (
  "id" SERIAL PRIMARY KEY,
  "observationSetId" INTEGER NOT NULL REFERENCES "MarketBreadthObservationSet"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "horizonSessions" INTEGER NOT NULL,
  "anchorSessionDate" DATE NOT NULL,
  "universeCount" INTEGER NOT NULL,
  "anchorBarCount" INTEGER NOT NULL,
  "eligibleCount" INTEGER NOT NULL,
  "excludedCount" INTEGER NOT NULL,
  "advancingCount" INTEGER NOT NULL,
  "decliningCount" INTEGER NOT NULL,
  "unchangedCount" INTEGER NOT NULL,
  "directionalCount" INTEGER NOT NULL,
  "coverageRatio" DECIMAL(12,10) NOT NULL,
  "advanceShare" DECIMAL(12,10) NOT NULL,
  "netBreadth" DECIMAL(12,10) NOT NULL,
  "canonicalInputHash" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  CONSTRAINT "MarketBreadthHorizonObservation_integrity_check" CHECK (
    "horizonSessions" IN (1,5,20) AND "universeCount" > 0 AND "anchorBarCount" BETWEEN 0 AND "universeCount" AND
    "eligibleCount" >= 0 AND "excludedCount" >= 0 AND
    "eligibleCount" + "excludedCount" = "universeCount" AND
    "advancingCount" >= 0 AND "decliningCount" >= 0 AND "unchangedCount" >= 0 AND
    "directionalCount" > 0 AND "directionalCount" = "advancingCount" + "decliningCount" AND
    "eligibleCount" = "directionalCount" + "unchangedCount" AND
    "coverageRatio" BETWEEN 0 AND 1 AND "advanceShare" BETWEEN 0 AND 1 AND
    "netBreadth" BETWEEN -1 AND 1 AND length("canonicalInputHash") = 64 AND
    jsonb_typeof("evidenceJson") = 'object'
  )
);
CREATE UNIQUE INDEX "MarketBreadthHorizonObservation_identity_key" ON "MarketBreadthHorizonObservation"("observationSetId", "horizonSessions");

CREATE TRIGGER immutable_breadth_v2_observation_set BEFORE UPDATE OR DELETE ON "MarketBreadthObservationSet"
FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation();
CREATE TRIGGER immutable_breadth_v2_horizon_observation BEFORE UPDATE OR DELETE ON "MarketBreadthHorizonObservation"
FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation();

COMMIT;
