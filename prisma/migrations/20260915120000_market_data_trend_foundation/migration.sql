BEGIN;

CREATE TYPE "MarketCalendarExceptionType" AS ENUM ('CLOSED', 'EARLY_CLOSE');
CREATE TYPE "MarketBarTimeframe" AS ENUM ('DAY_1', 'MINUTE_15');
CREATE TYPE "MarketDataProvider" AS ENUM ('MASSIVE');
CREATE TYPE "MarketBarAdjustmentMode" AS ENUM ('UNADJUSTED');
CREATE TYPE "MarketRegimeDimension" AS ENUM ('TREND', 'VOLATILITY', 'BREADTH', 'INTRADAY_STRESS', 'PARTICIPATION', 'LEADERSHIP');
CREATE TYPE "MarketRegimeDimensionAssessmentStatus" AS ENUM ('VALID', 'UNAVAILABLE', 'FAILED');

CREATE TABLE "MarketCalendarException" (
  "id" SERIAL PRIMARY KEY,
  "sessionDate" DATE NOT NULL,
  "name" TEXT NOT NULL,
  "type" "MarketCalendarExceptionType" NOT NULL,
  "closeTimeMinutesEt" INTEGER,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "MarketCalendarException_close_check" CHECK (
    ("type" = 'CLOSED' AND "closeTimeMinutesEt" IS NULL) OR
    ("type" = 'EARLY_CLOSE' AND "closeTimeMinutesEt" IS NOT NULL AND "closeTimeMinutesEt" > 570 AND "closeTimeMinutesEt" < 960)
  ),
  CONSTRAINT "MarketCalendarException_name_check" CHECK (length(trim("name")) BETWEEN 1 AND 160)
);
CREATE UNIQUE INDEX "MarketCalendarException_sessionDate_key" ON "MarketCalendarException"("sessionDate");

CREATE TABLE "MarketBar" (
  "id" SERIAL PRIMARY KEY,
  "securityId" INTEGER NOT NULL,
  "timeframe" "MarketBarTimeframe" NOT NULL,
  "barStartAt" TIMESTAMPTZ(3) NOT NULL,
  "open" DECIMAL(24,10) NOT NULL,
  "high" DECIMAL(24,10) NOT NULL,
  "low" DECIMAL(24,10) NOT NULL,
  "close" DECIMAL(24,10) NOT NULL,
  "volume" DECIMAL(30,6) NOT NULL,
  "provider" "MarketDataProvider" NOT NULL,
  "adjustmentMode" "MarketBarAdjustmentMode" NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketBar_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MarketBar_ohlcv_check" CHECK (
    "open" > 0 AND "high" > 0 AND "low" > 0 AND "close" > 0 AND "volume" >= 0 AND
    "open"::text NOT IN ('NaN','Infinity','-Infinity') AND "high"::text NOT IN ('NaN','Infinity','-Infinity') AND
    "low"::text NOT IN ('NaN','Infinity','-Infinity') AND "close"::text NOT IN ('NaN','Infinity','-Infinity') AND
    "volume"::text NOT IN ('NaN','Infinity','-Infinity') AND
    "low" <= "open" AND "low" <= "close" AND "low" <= "high" AND
    "high" >= "open" AND "high" >= "close"
  )
);
CREATE UNIQUE INDEX "MarketBar_securityId_timeframe_barStartAt_key" ON "MarketBar"("securityId", "timeframe", "barStartAt");

CREATE TABLE "MarketRegimeDimensionAssessment" (
  "id" SERIAL PRIMARY KEY,
  "dimension" "MarketRegimeDimension" NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "evidenceSchemaVersion" INTEGER NOT NULL,
  "targetAt" TIMESTAMPTZ(3) NOT NULL,
  "sessionDate" DATE,
  "attempt" INTEGER NOT NULL,
  "status" "MarketRegimeDimensionAssessmentStatus" NOT NULL,
  "reasonCode" TEXT,
  "rawState" TEXT,
  "effectiveState" TEXT,
  "dataThroughAt" TIMESTAMPTZ(3),
  "validUntil" TIMESTAMPTZ(3),
  "previousAssessmentId" INTEGER,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evidenceJson" JSONB NOT NULL,
  CONSTRAINT "RegimeDimension_terminal_check" CHECK (
    "attempt" > 0 AND "evidenceSchemaVersion" > 0 AND length("algorithmVersion") BETWEEN 1 AND 80 AND
    "completedAt" >= "startedAt" AND jsonb_typeof("evidenceJson") = 'object' AND
    ("dimension" <> 'TREND' OR "sessionDate" IS NOT NULL) AND
    (("status" = 'VALID' AND "rawState" IS NOT NULL AND "effectiveState" IS NOT NULL AND
      "dataThroughAt" IS NOT NULL AND "validUntil" IS NOT NULL AND "validUntil" > "targetAt" AND "dataThroughAt" <= "targetAt") OR
     ("status" <> 'VALID' AND "rawState" IS NULL AND "effectiveState" IS NULL AND length(trim("reasonCode")) > 0 AND "reasonCode" IS NOT NULL))
  ),
  -- Extend this whitelist only when another dimension's vocabulary is designed.
  CONSTRAINT "RegimeDimension_states_check" CHECK (
    ("rawState" IS NULL AND "effectiveState" IS NULL) OR
    ("dimension" = 'TREND' AND "rawState" IN ('UP','NEUTRAL','DOWN') AND "effectiveState" IN ('UP','NEUTRAL','DOWN'))
  ),
  CONSTRAINT "RegimeDimension_not_self_check" CHECK ("previousAssessmentId" IS NULL OR "previousAssessmentId" <> "id")
);
CREATE UNIQUE INDEX "RegimeDimension_attempt_key" ON "MarketRegimeDimensionAssessment"("dimension", "algorithmVersion", "targetAt", "attempt");
CREATE UNIQUE INDEX "RegimeDimension_identity_key" ON "MarketRegimeDimensionAssessment"("id", "dimension", "algorithmVersion");
CREATE UNIQUE INDEX "RegimeDimension_valid_key" ON "MarketRegimeDimensionAssessment"("dimension", "algorithmVersion", "targetAt") WHERE "status" = 'VALID';
CREATE INDEX "RegimeDimension_previous_idx" ON "MarketRegimeDimensionAssessment"("previousAssessmentId", "dimension", "algorithmVersion");
ALTER TABLE "MarketRegimeDimensionAssessment" ADD CONSTRAINT "MarketRegimeDimensionAssessment_previousAssessmentId_dimensi_fkey"
FOREIGN KEY ("previousAssessmentId", "dimension", "algorithmVersion") REFERENCES "MarketRegimeDimensionAssessment"("id", "dimension", "algorithmVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_market_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Market data and regime assessment evidence is immutable'; END $$;
CREATE TRIGGER immutable_market_bar BEFORE UPDATE OR DELETE ON "MarketBar"
FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation();
CREATE TRIGGER immutable_regime_dimension BEFORE UPDATE OR DELETE ON "MarketRegimeDimensionAssessment"
FOR EACH ROW EXECUTE FUNCTION reject_market_evidence_mutation();
COMMIT;
