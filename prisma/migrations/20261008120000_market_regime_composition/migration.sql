BEGIN;

CREATE TYPE "MarketRegimeCompositionPublicationStatus" AS ENUM ('SUCCEEDED', 'FAILED');
CREATE TYPE "MarketRegimeCompositionEvidenceHealth" AS ENUM ('COMPLETE', 'DEGRADED');
CREATE TYPE "MarketRegimeCompositionSourceHealth" AS ENUM ('AVAILABLE', 'MISSING', 'UNAVAILABLE', 'FAILED', 'STALE', 'EXPIRED', 'INVALID');

CREATE TABLE "MarketRegimeAssessment" (
  "id" SERIAL NOT NULL,
  "compositionVersion" TEXT NOT NULL,
  "evidenceSchemaVersion" INTEGER NOT NULL,
  "targetAt" TIMESTAMPTZ(3) NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "dataThroughAt" TIMESTAMPTZ(3),
  "validUntil" TIMESTAMPTZ(3),
  "publicationStatus" "MarketRegimeCompositionPublicationStatus" NOT NULL,
  "evidenceHealth" "MarketRegimeCompositionEvidenceHealth" NOT NULL,
  "publicationReasonCode" TEXT,
  "evidenceReasonCode" TEXT,
  "sourceSetFingerprint" TEXT NOT NULL,
  "previousAssessmentId" INTEGER,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evidenceJson" JSONB NOT NULL,
  CONSTRAINT "MarketRegimeAssessment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MarketRegimeAssessment_terminal_check" CHECK (
    length("compositionVersion") BETWEEN 1 AND 80 AND
    "evidenceSchemaVersion" > 0 AND
    "targetAt" <= "observedAt" AND
    "startedAt" <= "observedAt" AND "observedAt" <= "completedAt" AND
    jsonb_typeof("evidenceJson") = 'object' AND
    length("sourceSetFingerprint") = 64 AND "sourceSetFingerprint" ~ '^[a-f0-9]+$' AND
    "previousAssessmentId" IS DISTINCT FROM "id" AND
    (("publicationStatus" = 'SUCCEEDED' AND "publicationReasonCode" IS NULL) OR
     ("publicationStatus" = 'FAILED' AND length(trim("publicationReasonCode")) > 0)) AND
    (("evidenceHealth" = 'COMPLETE' AND "evidenceReasonCode" IS NULL AND
      "dataThroughAt" IS NOT NULL AND "dataThroughAt" <= "observedAt" AND
      "validUntil" IS NOT NULL AND "validUntil" > "observedAt") OR
     ("evidenceHealth" = 'DEGRADED' AND length(trim("evidenceReasonCode")) > 0 AND
      "dataThroughAt" IS NULL AND "validUntil" IS NULL))
  )
);

CREATE TABLE "MarketRegimeAssessmentSource" (
  "id" SERIAL NOT NULL,
  "marketRegimeAssessmentId" INTEGER NOT NULL,
  "dimension" "MarketRegimeDimension" NOT NULL,
  "requiredAlgorithmVersion" TEXT NOT NULL,
  "expectedTargetAt" TIMESTAMPTZ(3) NOT NULL,
  "sourceAssessmentId" INTEGER,
  "sourceEvidenceSchemaVersion" INTEGER,
  "sourceAttempt" INTEGER,
  "sourceStatus" "MarketRegimeDimensionAssessmentStatus",
  "sourceTargetAt" TIMESTAMPTZ(3),
  "sourceCompletedAt" TIMESTAMPTZ(3),
  "sourceDataThroughAt" TIMESTAMPTZ(3),
  "sourceValidUntil" TIMESTAMPTZ(3),
  "sourceRawState" TEXT,
  "sourceEffectiveState" TEXT,
  "health" "MarketRegimeCompositionSourceHealth" NOT NULL,
  "reasonCode" TEXT,
  "ordinal" INTEGER NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketRegimeAssessmentSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MarketRegimeAssessmentSource_identity_check" CHECK (
    ("ordinal" = 1 AND "dimension" = 'TREND' AND "requiredAlgorithmVersion" = 'TREND_V1') OR
    ("ordinal" = 2 AND "dimension" = 'VOLATILITY' AND "requiredAlgorithmVersion" = 'VOLATILITY_V1') OR
    ("ordinal" = 3 AND "dimension" = 'BREADTH' AND "requiredAlgorithmVersion" = 'BREADTH_V1') OR
    ("ordinal" = 4 AND "dimension" = 'PARTICIPATION' AND "requiredAlgorithmVersion" = 'PARTICIPATION_V1') OR
    ("ordinal" = 5 AND "dimension" = 'INTRADAY_STRESS' AND "requiredAlgorithmVersion" = 'INTRADAY_STRESS_V1')
  ),
  CONSTRAINT "MarketRegimeAssessmentSource_evidence_check" CHECK (
    "expectedTargetAt" IS NOT NULL AND jsonb_typeof("evidenceJson") = 'object' AND
    (("health" = 'MISSING' AND "sourceAssessmentId" IS NULL AND
      "sourceEvidenceSchemaVersion" IS NULL AND "sourceAttempt" IS NULL AND "sourceStatus" IS NULL AND
      "sourceTargetAt" IS NULL AND "sourceCompletedAt" IS NULL AND "sourceDataThroughAt" IS NULL AND
      "sourceValidUntil" IS NULL AND "sourceRawState" IS NULL AND "sourceEffectiveState" IS NULL AND
      length(trim("reasonCode")) > 0) OR
     ("health" <> 'MISSING' AND "sourceAssessmentId" IS NOT NULL AND
      "sourceEvidenceSchemaVersion" > 0 AND "sourceAttempt" > 0 AND "sourceStatus" IS NOT NULL AND
      "sourceTargetAt" IS NOT NULL AND "sourceCompletedAt" IS NOT NULL AND
      (("health" = 'AVAILABLE' AND "sourceStatus" = 'VALID' AND "sourceTargetAt" = "expectedTargetAt" AND
        "sourceRawState" IS NOT NULL AND "sourceEffectiveState" IS NOT NULL AND
        "sourceDataThroughAt" IS NOT NULL AND "sourceValidUntil" IS NOT NULL AND "reasonCode" IS NULL) OR
       ("health" = 'STALE' AND "sourceStatus" = 'VALID' AND "sourceTargetAt" < "expectedTargetAt" AND
        "sourceRawState" IS NOT NULL AND "sourceEffectiveState" IS NOT NULL AND length(trim("reasonCode")) > 0) OR
       ("health" = 'EXPIRED' AND "sourceStatus" = 'VALID' AND "sourceTargetAt" = "expectedTargetAt" AND
        "sourceValidUntil" IS NOT NULL AND "sourceRawState" IS NOT NULL AND "sourceEffectiveState" IS NOT NULL AND length(trim("reasonCode")) > 0) OR
       ("health" = 'UNAVAILABLE' AND "sourceStatus" = 'UNAVAILABLE' AND length(trim("reasonCode")) > 0) OR
       ("health" = 'FAILED' AND "sourceStatus" = 'FAILED' AND length(trim("reasonCode")) > 0) OR
       ("health" = 'INVALID' AND length(trim("reasonCode")) > 0)))
  ))
);

CREATE UNIQUE INDEX "MarketRegimeAssessment_version_source_key" ON "MarketRegimeAssessment"("compositionVersion", "sourceSetFingerprint");
CREATE UNIQUE INDEX "MarketRegimeAssessment_identity_key" ON "MarketRegimeAssessment"("id", "compositionVersion");
CREATE INDEX "MarketRegimeAssessment_version_target_idx" ON "MarketRegimeAssessment"("compositionVersion", "targetAt");
CREATE INDEX "MarketRegimeAssessment_previous_idx" ON "MarketRegimeAssessment"("previousAssessmentId", "compositionVersion");
CREATE UNIQUE INDEX "MarketRegimeAssessmentSource_dimension_key" ON "MarketRegimeAssessmentSource"("marketRegimeAssessmentId", "dimension");
CREATE UNIQUE INDEX "MarketRegimeAssessmentSource_ordinal_key" ON "MarketRegimeAssessmentSource"("marketRegimeAssessmentId", "ordinal");
CREATE INDEX "MarketRegimeAssessmentSource_source_idx" ON "MarketRegimeAssessmentSource"("sourceAssessmentId", "dimension", "requiredAlgorithmVersion");

ALTER TABLE "MarketRegimeAssessment" ADD CONSTRAINT "MarketRegimeAssessment_previous_version_fk"
  FOREIGN KEY ("previousAssessmentId", "compositionVersion") REFERENCES "MarketRegimeAssessment"("id", "compositionVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MarketRegimeAssessmentSource" ADD CONSTRAINT "MarketRegimeAssessmentSource_marketRegimeAssessmentId_fkey"
  FOREIGN KEY ("marketRegimeAssessmentId") REFERENCES "MarketRegimeAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MarketRegimeAssessmentSource" ADD CONSTRAINT "MarketRegimeAssessmentSource_source_identity_fk"
  FOREIGN KEY ("sourceAssessmentId", "dimension", "requiredAlgorithmVersion") REFERENCES "MarketRegimeDimensionAssessment"("id", "dimension", "algorithmVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "enforce_market_regime_composition_five_sources"() RETURNS trigger AS $$
DECLARE composition_id INTEGER;
DECLARE parent_health "MarketRegimeCompositionEvidenceHealth";
DECLARE available_count INTEGER;
BEGIN
  composition_id := NEW."id";
  IF (SELECT count(*) FROM "MarketRegimeAssessmentSource" WHERE "marketRegimeAssessmentId" = composition_id) <> 5 THEN
    RAISE EXCEPTION 'MarketRegimeAssessment % must contain exactly five authoritative V1 sources', composition_id;
  END IF;
  SELECT "evidenceHealth" INTO parent_health FROM "MarketRegimeAssessment" WHERE "id" = composition_id;
  SELECT count(*) INTO available_count FROM "MarketRegimeAssessmentSource"
    WHERE "marketRegimeAssessmentId" = composition_id AND "health" = 'AVAILABLE';
  IF (parent_health = 'COMPLETE' AND available_count <> 5) OR
     (parent_health = 'DEGRADED' AND available_count = 5) THEN
    RAISE EXCEPTION 'MarketRegimeAssessment % evidence health conflicts with its source vector', composition_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "MarketRegimeAssessment_five_sources_check"
  AFTER INSERT ON "MarketRegimeAssessment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_market_regime_composition_five_sources"();

CREATE FUNCTION "enforce_market_regime_composition_source_snapshot"() RETURNS trigger AS $$
DECLARE source_row "MarketRegimeDimensionAssessment"%ROWTYPE;
BEGIN
  IF NEW."sourceAssessmentId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO source_row FROM "MarketRegimeDimensionAssessment" WHERE "id" = NEW."sourceAssessmentId";
  IF NOT FOUND OR
     NEW."sourceEvidenceSchemaVersion" IS DISTINCT FROM source_row."evidenceSchemaVersion" OR
     NEW."sourceAttempt" IS DISTINCT FROM source_row."attempt" OR
     NEW."sourceStatus" IS DISTINCT FROM source_row."status" OR
     NEW."sourceTargetAt" IS DISTINCT FROM source_row."targetAt" OR
     NEW."sourceCompletedAt" IS DISTINCT FROM source_row."completedAt" OR
     NEW."sourceDataThroughAt" IS DISTINCT FROM source_row."dataThroughAt" OR
     NEW."sourceValidUntil" IS DISTINCT FROM source_row."validUntil" OR
     NEW."sourceRawState" IS DISTINCT FROM source_row."rawState" OR
     NEW."sourceEffectiveState" IS DISTINCT FROM source_row."effectiveState" THEN
    RAISE EXCEPTION 'MarketRegimeAssessmentSource snapshot conflicts with source assessment %', NEW."sourceAssessmentId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "MarketRegimeAssessmentSource_snapshot_check"
  AFTER INSERT ON "MarketRegimeAssessmentSource" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_market_regime_composition_source_snapshot"();

CREATE FUNCTION "prevent_market_regime_composition_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MarketRegimeAssessment_immutable"
  BEFORE UPDATE OR DELETE ON "MarketRegimeAssessment"
  FOR EACH ROW EXECUTE FUNCTION "prevent_market_regime_composition_mutation"();
CREATE TRIGGER "MarketRegimeAssessmentSource_immutable"
  BEFORE UPDATE OR DELETE ON "MarketRegimeAssessmentSource"
  FOR EACH ROW EXECUTE FUNCTION "prevent_market_regime_composition_mutation"();

COMMIT;
