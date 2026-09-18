BEGIN;

CREATE TABLE "MarketBreadthObservation" (
  "id" SERIAL PRIMARY KEY,
  "sessionDate" DATE NOT NULL,
  "previousSessionDate" DATE NOT NULL,
  "provider" "MarketDataProvider" NOT NULL,
  "universeDefinitionVersion" TEXT NOT NULL,
  "evidenceSchemaVersion" INTEGER NOT NULL,
  "universeCount" INTEGER NOT NULL,
  "currentBarCount" INTEGER NOT NULL,
  "priorBarCount" INTEGER NOT NULL,
  "advancingCount" INTEGER NOT NULL,
  "decliningCount" INTEGER NOT NULL,
  "unchangedCount" INTEGER NOT NULL,
  "directionalCount" INTEGER NOT NULL,
  "excludedCount" INTEGER NOT NULL,
  "advanceShare" DECIMAL(7,6) NOT NULL,
  "netBreadth" DECIMAL(7,6) NOT NULL,
  "dataThroughAt" TIMESTAMPTZ(3) NOT NULL,
  "canonicalInputHash" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketBreadthObservation_counts_check" CHECK (
    "universeCount" >= 0 AND "currentBarCount" >= 0 AND "priorBarCount" >= 0 AND
    "advancingCount" >= 0 AND "decliningCount" >= 0 AND "unchangedCount" >= 0 AND
    "directionalCount" >= 0 AND "excludedCount" >= 0 AND
    "directionalCount" = "advancingCount" + "decliningCount" AND
    "directionalCount" > 0 AND
    "advanceShare" >= 0 AND "advanceShare" <= 1 AND
    "netBreadth" >= -1 AND "netBreadth" <= 1 AND
    "previousSessionDate" < "sessionDate" AND
    "completedAt" >= "startedAt" AND "evidenceSchemaVersion" > 0 AND
    length("universeDefinitionVersion") BETWEEN 1 AND 80 AND
    length("canonicalInputHash") = 64 AND
    jsonb_typeof("evidenceJson") = 'object'
  )
);
CREATE UNIQUE INDEX "MarketBreadthObservation_identity_key" ON "MarketBreadthObservation"("provider", "universeDefinitionVersion", "sessionDate");
CREATE INDEX "MarketBreadthObservation_sessionDate_idx" ON "MarketBreadthObservation"("sessionDate");

-- Reuses the shared immutability trigger function already defined for MarketBar /
-- MarketRegimeDimensionAssessment in 20260915120000_market_data_trend_foundation.
CREATE TRIGGER immutable_breadth_observation BEFORE UPDATE OR DELETE ON "MarketBreadthObservation"
FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation();

ALTER TABLE "MarketRegimeDimensionAssessment"
  DROP CONSTRAINT "RegimeDimension_terminal_check",
  DROP CONSTRAINT "RegimeDimension_states_check",
  ADD CONSTRAINT "RegimeDimension_terminal_check" CHECK (
    "attempt" > 0 AND "evidenceSchemaVersion" > 0 AND length("algorithmVersion") BETWEEN 1 AND 80 AND
    "completedAt" >= "startedAt" AND jsonb_typeof("evidenceJson") = 'object' AND
    ("dimension" NOT IN ('TREND', 'VOLATILITY', 'BREADTH') OR "sessionDate" IS NOT NULL) AND
    (("status" = 'VALID' AND "rawState" IS NOT NULL AND "effectiveState" IS NOT NULL AND
      "dataThroughAt" IS NOT NULL AND "validUntil" IS NOT NULL AND "validUntil" > "targetAt" AND "dataThroughAt" <= "targetAt") OR
     ("status" <> 'VALID' AND "rawState" IS NULL AND "effectiveState" IS NULL AND length(trim("reasonCode")) > 0 AND "reasonCode" IS NOT NULL))
  ),
  -- Extend this whitelist only when another dimension's vocabulary is designed.
  ADD CONSTRAINT "RegimeDimension_states_check" CHECK (
    ("rawState" IS NULL AND "effectiveState" IS NULL) OR
    ("dimension" = 'TREND' AND "rawState" IN ('UP','NEUTRAL','DOWN') AND "effectiveState" IN ('UP','NEUTRAL','DOWN')) OR
    ("dimension" = 'VOLATILITY' AND "rawState" IN ('LOW','NORMAL','HIGH','EXTREME') AND "effectiveState" IN ('LOW','NORMAL','HIGH','EXTREME')) OR
    ("dimension" = 'BREADTH' AND "rawState" IN ('POSITIVE','MIXED','NEGATIVE') AND "effectiveState" IN ('POSITIVE','MIXED','NEGATIVE'))
  );

COMMIT;
