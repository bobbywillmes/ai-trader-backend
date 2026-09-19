BEGIN;

-- INTRADAY_STRESS_V1: session-local intraday dimension. sessionDate identifies which
-- regular session a 15-minute targetAt belongs to (required for session-boundary
-- hysteresis reset and replay bootstrap), mirroring TREND/VOLATILITY/BREADTH.
ALTER TABLE "MarketRegimeDimensionAssessment"
  DROP CONSTRAINT "RegimeDimension_terminal_check",
  DROP CONSTRAINT "RegimeDimension_states_check",
  ADD CONSTRAINT "RegimeDimension_terminal_check" CHECK (
    "attempt" > 0 AND "evidenceSchemaVersion" > 0 AND length("algorithmVersion") BETWEEN 1 AND 80 AND
    "completedAt" >= "startedAt" AND jsonb_typeof("evidenceJson") = 'object' AND
    ("dimension" NOT IN ('TREND', 'VOLATILITY', 'BREADTH', 'INTRADAY_STRESS') OR "sessionDate" IS NOT NULL) AND
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
    ("dimension" = 'INTRADAY_STRESS' AND "rawState" IN ('NORMAL','ELEVATED','HIGH','SEVERE') AND "effectiveState" IN ('NORMAL','ELEVATED','HIGH','SEVERE'))
  );

COMMIT;
