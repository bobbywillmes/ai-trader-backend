CREATE TYPE "OrderIntentMarketPolicyCompositionCapture" AS ENUM ('EXACT', 'NONE_VISIBLE', 'LEGACY_UNKNOWN');

ALTER TABLE "OrderIntentMarketPolicyCoverage"
  ADD COLUMN "marketRegimeAssessmentId" INTEGER,
  ADD COLUMN "compositionCapture" "OrderIntentMarketPolicyCompositionCapture" NOT NULL DEFAULT 'LEGACY_UNKNOWN',
  ADD COLUMN "captureSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "OrderIntentMarketPolicyCoverage_marketRegimeAssessmentId_fkey"
    FOREIGN KEY ("marketRegimeAssessmentId") REFERENCES "MarketRegimeAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "OrderIntentMarketPolicyCoverage_composition_capture_check" CHECK (
    ("captureSchemaVersion" = 1 AND "compositionCapture" = 'LEGACY_UNKNOWN' AND "marketRegimeAssessmentId" IS NULL)
    OR ("captureSchemaVersion" = 2 AND "compositionCapture" = 'EXACT' AND "marketRegimeAssessmentId" IS NOT NULL)
    OR ("captureSchemaVersion" = 2 AND "compositionCapture" = 'NONE_VISIBLE' AND "marketRegimeAssessmentId" IS NULL)
  );

CREATE INDEX "OrderIntentMarketPolicyCoverage_composition_idx"
  ON "OrderIntentMarketPolicyCoverage" ("marketRegimeAssessmentId");

CREATE OR REPLACE FUNCTION "capture_order_intent_market_policy_coverage"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rollout_enabled BOOLEAN;
  rollout_epoch TIMESTAMPTZ;
  generation_id INTEGER;
  bound_revision_id INTEGER;
  active_revision_id INTEGER;
  composition_id INTEGER;
  capture_instant TIMESTAMPTZ;
BEGIN
  BEGIN
    capture_instant := statement_timestamp();
    SELECT enabled, "effectiveEpoch" INTO rollout_enabled, rollout_epoch
      FROM "OrderIntentMarketPolicyCaptureRollout" WHERE id = 1;
    IF NOT COALESCE(rollout_enabled, false) OR rollout_epoch IS NULL OR NEW."createdAt" < rollout_epoch THEN
      RETURN NEW;
    END IF;

    SELECT g.id, g."policyRevisionId"
      INTO generation_id, bound_revision_id
      FROM "AssignmentMarketPolicyEnrollmentGeneration" g
      WHERE g."accountSubscriptionId" = NEW."tradingAccountSubscriptionId" AND g.status = 'ACTIVE'
      ORDER BY g.generation DESC LIMIT 1;

    SELECT r.id INTO active_revision_id
      FROM "TradingAccountSubscription" tas
      JOIN "StrategyMarketPolicy" p ON p."strategyId" = tas."routingStrategyId"
      JOIN "StrategyMarketPolicyRevision" r ON r."policyId" = p.id AND r.status = 'ACTIVE'
      WHERE tas.id = NEW."tradingAccountSubscriptionId"
      LIMIT 1;

    SELECT m.id INTO composition_id
      FROM "MarketRegimeAssessment" m
      WHERE m."compositionVersion" = 'MARKET_REGIME_COMPOSITION_V1'
        AND m."publicationStatus" = 'SUCCEEDED'
        AND m."observedAt" <= capture_instant
      ORDER BY m."targetAt" DESC, m."observedAt" DESC, m.id DESC
      LIMIT 1;

    INSERT INTO "OrderIntentMarketPolicyCoverage" (
      "orderIntentId", "tradingAccountId", "accountSubscriptionId", "enrollmentGenerationId",
      "boundPolicyRevisionId", "activePolicyRevisionId", "marketRegimeAssessmentId", provenance,
      "compositionCapture", "captureSchemaVersion", "comparisonMode", "tradingEffect", "capturedAt"
    ) VALUES (
      NEW.id, NEW."tradingAccountId", NEW."tradingAccountSubscriptionId", generation_id,
      bound_revision_id, active_revision_id, composition_id,
      CASE WHEN generation_id IS NULL THEN 'UNENROLLED'::"OrderIntentMarketPolicyCoverageProvenance"
           WHEN bound_revision_id = active_revision_id THEN 'ACTIVE_EXACT'::"OrderIntentMarketPolicyCoverageProvenance"
           ELSE 'SUPERSEDED_COMPARE_ONLY'::"OrderIntentMarketPolicyCoverageProvenance" END,
      CASE WHEN composition_id IS NULL THEN 'NONE_VISIBLE'::"OrderIntentMarketPolicyCompositionCapture"
           ELSE 'EXACT'::"OrderIntentMarketPolicyCompositionCapture" END,
      2, 'COMPARE_ONLY', 'NONE', capture_instant
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $$;
