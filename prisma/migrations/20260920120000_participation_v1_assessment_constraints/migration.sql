BEGIN;

-- Fail closed on incompatible existing evidence; no data repair.
ALTER TABLE "MarketRegimeDimensionAssessment"
  DROP CONSTRAINT "RegimeDimension_terminal_check",
  DROP CONSTRAINT "RegimeDimension_states_check",
  ADD CONSTRAINT "RegimeDimension_terminal_check" CHECK (
    "attempt" > 0 AND "evidenceSchemaVersion" > 0 AND length("algorithmVersion") BETWEEN 1 AND 80 AND
    "completedAt" >= "startedAt" AND jsonb_typeof("evidenceJson") = 'object' AND
    ("dimension" NOT IN ('TREND', 'VOLATILITY', 'BREADTH', 'PARTICIPATION') OR "sessionDate" IS NOT NULL) AND
    (("status" = 'VALID' AND "rawState" IS NOT NULL AND "effectiveState" IS NOT NULL AND
      "dataThroughAt" IS NOT NULL AND "validUntil" IS NOT NULL AND "validUntil" > "targetAt" AND "dataThroughAt" <= "targetAt") OR
     ("status" <> 'VALID' AND "rawState" IS NULL AND "effectiveState" IS NULL AND length(trim("reasonCode")) > 0 AND "reasonCode" IS NOT NULL))
  ),
  -- Extend this whitelist only when another dimension's vocabulary is designed.
  ADD CONSTRAINT "RegimeDimension_states_check" CHECK (
    ("rawState" IS NULL AND "effectiveState" IS NULL) OR
    ("dimension" = 'TREND' AND "rawState" IN ('UP','NEUTRAL','DOWN') AND "effectiveState" IN ('UP','NEUTRAL','DOWN')) OR
    ("dimension" = 'VOLATILITY' AND "rawState" IN ('LOW','NORMAL','HIGH','EXTREME') AND "effectiveState" IN ('LOW','NORMAL','HIGH','EXTREME')) OR
    ("dimension" = 'BREADTH' AND "rawState" IN ('POSITIVE','MIXED','NEGATIVE') AND "effectiveState" IN ('POSITIVE','MIXED','NEGATIVE')) OR
    ("dimension" = 'PARTICIPATION' AND "algorithmVersion" = 'PARTICIPATION_V1' AND
      "rawState" IN ('QUIET','NORMAL','ACTIVE','INTENSE') AND
      "effectiveState" IN ('QUIET','NORMAL','ACTIVE','INTENSE') AND "rawState" = "effectiveState")
  );

COMMIT;
