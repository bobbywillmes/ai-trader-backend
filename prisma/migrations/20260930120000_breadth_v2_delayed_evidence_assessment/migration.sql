BEGIN;

-- V2 targetAt is the logical Tiingo 20:15 ET session boundary. Its immutable
-- measurement can arrive after that boundary; retain the actual receipt time.
-- Existing dimension/version evidence timing remains unchanged.
ALTER TABLE "MarketRegimeDimensionAssessment"
  DROP CONSTRAINT "RegimeDimension_terminal_check",
  ADD CONSTRAINT "RegimeDimension_terminal_check" CHECK (
    "attempt" > 0 AND "evidenceSchemaVersion" > 0 AND length("algorithmVersion") BETWEEN 1 AND 80 AND
    "completedAt" >= "startedAt" AND jsonb_typeof("evidenceJson") = 'object' AND
    ("dimension" NOT IN ('TREND', 'VOLATILITY', 'BREADTH', 'INTRADAY_STRESS', 'PARTICIPATION') OR "sessionDate" IS NOT NULL) AND
    (("status" = 'VALID' AND "rawState" IS NOT NULL AND "effectiveState" IS NOT NULL AND
      "dataThroughAt" IS NOT NULL AND "validUntil" IS NOT NULL AND "validUntil" > "targetAt" AND
      ("dataThroughAt" <= "targetAt" OR
       ("dimension" = 'BREADTH' AND "algorithmVersion" = 'BREADTH_V2_TERTILE_V1' AND "dataThroughAt" <= "completedAt"))) OR
     ("status" <> 'VALID' AND "rawState" IS NULL AND "effectiveState" IS NULL AND length(trim("reasonCode")) > 0 AND "reasonCode" IS NOT NULL))
  );

COMMIT;
