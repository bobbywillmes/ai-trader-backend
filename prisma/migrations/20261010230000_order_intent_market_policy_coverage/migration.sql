CREATE TYPE "OrderIntentMarketPolicyCoverageProvenance" AS ENUM ('ACTIVE_EXACT', 'SUPERSEDED_COMPARE_ONLY', 'UNENROLLED', 'CAPTURE_UNKNOWN');

CREATE TABLE "OrderIntentMarketPolicyCaptureRollout" (
  "id" INTEGER PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "deployedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveEpoch" TIMESTAMPTZ(3),
  "disabledAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "OrderIntentMarketPolicyCaptureRollout_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "OrderIntentMarketPolicyCaptureRollout_epoch_check" CHECK (
    (NOT "enabled" OR ("effectiveEpoch" IS NOT NULL AND "disabledAt" IS NULL))
    AND ("disabledAt" IS NULL OR ("effectiveEpoch" IS NOT NULL AND "disabledAt" >= "effectiveEpoch"))
  )
);

CREATE TABLE "OrderIntentMarketPolicyCoverageScannerState" (
  "id" INTEGER PRIMARY KEY,
  "lastOrderIntentId" INTEGER NOT NULL DEFAULT 0,
  "lastScannedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "OrderIntentMarketPolicyCoverageScannerState_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "OrderIntentMarketPolicyCoverageScannerState_cursor_check" CHECK ("lastOrderIntentId" >= 0)
);

CREATE TABLE "OrderIntentMarketPolicyCoverage" (
  "id" SERIAL PRIMARY KEY,
  "orderIntentId" INTEGER NOT NULL UNIQUE,
  "tradingAccountId" INTEGER NOT NULL,
  "accountSubscriptionId" INTEGER NOT NULL,
  "enrollmentGenerationId" INTEGER,
  "boundPolicyRevisionId" INTEGER,
  "activePolicyRevisionId" INTEGER,
  "provenance" "OrderIntentMarketPolicyCoverageProvenance" NOT NULL,
  "comparisonMode" TEXT NOT NULL DEFAULT 'COMPARE_ONLY',
  "tradingEffect" TEXT NOT NULL DEFAULT 'NONE',
  "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderIntentMarketPolicyCoverage_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyCoverage_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyCoverage_accountSubscriptionId_fkey" FOREIGN KEY ("accountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyCoverage_enrollmentGenerationId_fkey" FOREIGN KEY ("enrollmentGenerationId") REFERENCES "AssignmentMarketPolicyEnrollmentGeneration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyCoverage_boundPolicyRevisionId_fkey" FOREIGN KEY ("boundPolicyRevisionId") REFERENCES "StrategyMarketPolicyRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyCoverage_activePolicyRevisionId_fkey" FOREIGN KEY ("activePolicyRevisionId") REFERENCES "StrategyMarketPolicyRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyCoverage_compare_only_check" CHECK ("comparisonMode" = 'COMPARE_ONLY' AND "tradingEffect" = 'NONE'),
  CONSTRAINT "OrderIntentMarketPolicyCoverage_provenance_shape_check" CHECK (
    ("provenance" = 'ACTIVE_EXACT' AND "enrollmentGenerationId" IS NOT NULL AND "boundPolicyRevisionId" IS NOT NULL AND "activePolicyRevisionId" = "boundPolicyRevisionId")
    OR ("provenance" = 'SUPERSEDED_COMPARE_ONLY' AND "enrollmentGenerationId" IS NOT NULL AND "boundPolicyRevisionId" IS NOT NULL AND "activePolicyRevisionId" IS DISTINCT FROM "boundPolicyRevisionId")
    OR ("provenance" = 'UNENROLLED' AND "enrollmentGenerationId" IS NULL AND "boundPolicyRevisionId" IS NULL)
    OR ("provenance" = 'CAPTURE_UNKNOWN' AND "enrollmentGenerationId" IS NULL AND "boundPolicyRevisionId" IS NULL AND "activePolicyRevisionId" IS NULL)
  )
);

CREATE INDEX "OrderIntentMarketPolicyCoverage_assignment_captured_idx" ON "OrderIntentMarketPolicyCoverage" ("accountSubscriptionId", "capturedAt");
CREATE INDEX "OrderIntentMarketPolicyCoverage_generation_idx" ON "OrderIntentMarketPolicyCoverage" ("enrollmentGenerationId");

INSERT INTO "OrderIntentMarketPolicyCaptureRollout" ("id", "enabled", "deployedAt", "effectiveEpoch", "disabledAt", "updatedAt")
VALUES (1, false, statement_timestamp(), NULL, NULL, statement_timestamp());
INSERT INTO "OrderIntentMarketPolicyCoverageScannerState" ("id", "lastOrderIntentId", "lastScannedAt", "updatedAt")
VALUES (1, 0, NULL, statement_timestamp());

CREATE FUNCTION "guard_order_intent_market_policy_capture_rollout"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> 1 OR OLD.id <> 1 THEN
    RAISE EXCEPTION 'OrderIntent market-policy capture rollout is a singleton' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."deployedAt") IS DISTINCT FROM ROW(OLD."deployedAt") THEN
    RAISE EXCEPTION 'OrderIntent market-policy capture deployment epoch is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT OLD.enabled AND NEW.enabled THEN
    IF OLD."effectiveEpoch" IS NOT NULL THEN
      RAISE EXCEPTION 'OrderIntent market-policy capture cannot be re-enabled without a new rollout epoch design' USING ERRCODE = '23514';
    END IF;
    NEW."effectiveEpoch" := clock_timestamp();
    NEW."disabledAt" := NULL;
  ELSIF OLD.enabled AND NOT NEW.enabled THEN
    NEW."effectiveEpoch" := OLD."effectiveEpoch";
    NEW."disabledAt" := clock_timestamp();
  ELSIF ROW(NEW."effectiveEpoch", NEW."disabledAt") IS DISTINCT FROM ROW(OLD."effectiveEpoch", OLD."disabledAt") THEN
    RAISE EXCEPTION 'OrderIntent market-policy capture epochs are database-managed' USING ERRCODE = '23514';
  END IF;
  NEW."updatedAt" := statement_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER "OrderIntentMarketPolicyCaptureRollout_guard"
BEFORE UPDATE ON "OrderIntentMarketPolicyCaptureRollout"
FOR EACH ROW EXECUTE FUNCTION "guard_order_intent_market_policy_capture_rollout"();

CREATE FUNCTION "validate_order_intent_market_policy_coverage"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent_account INTEGER; intent_assignment INTEGER; generation_account INTEGER; generation_assignment INTEGER; generation_bound INTEGER;
BEGIN
  SELECT "tradingAccountId", "tradingAccountSubscriptionId" INTO intent_account, intent_assignment FROM "OrderIntent" WHERE id = NEW."orderIntentId";
  IF intent_account IS NULL OR intent_assignment IS NULL OR NEW."tradingAccountId" <> intent_account OR NEW."accountSubscriptionId" <> intent_assignment THEN
    RAISE EXCEPTION 'OrderIntent market-policy coverage intent identity mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW."enrollmentGenerationId" IS NOT NULL THEN
    SELECT "tradingAccountId", "accountSubscriptionId", "policyRevisionId" INTO generation_account, generation_assignment, generation_bound
      FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id = NEW."enrollmentGenerationId";
    IF generation_account IS NULL OR ROW(NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."boundPolicyRevisionId")
      IS DISTINCT FROM ROW(generation_account, generation_assignment, generation_bound) THEN
      RAISE EXCEPTION 'OrderIntent market-policy coverage enrollment identity mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "OrderIntentMarketPolicyCoverage_validate"
BEFORE INSERT ON "OrderIntentMarketPolicyCoverage"
FOR EACH ROW EXECUTE FUNCTION "validate_order_intent_market_policy_coverage"();

CREATE FUNCTION "prevent_order_intent_market_policy_coverage_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OrderIntent market-policy coverage is immutable' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER "OrderIntentMarketPolicyCoverage_immutable"
BEFORE UPDATE OR DELETE ON "OrderIntentMarketPolicyCoverage"
FOR EACH ROW EXECUTE FUNCTION "prevent_order_intent_market_policy_coverage_mutation"();

CREATE FUNCTION "capture_order_intent_market_policy_coverage"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rollout_enabled BOOLEAN; rollout_epoch TIMESTAMPTZ; generation_id INTEGER; bound_revision_id INTEGER; active_revision_id INTEGER;
BEGIN
  BEGIN
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

    INSERT INTO "OrderIntentMarketPolicyCoverage" (
      "orderIntentId", "tradingAccountId", "accountSubscriptionId", "enrollmentGenerationId",
      "boundPolicyRevisionId", "activePolicyRevisionId", "provenance", "comparisonMode", "tradingEffect", "capturedAt"
    ) VALUES (
      NEW.id, NEW."tradingAccountId", NEW."tradingAccountSubscriptionId", generation_id,
      bound_revision_id, active_revision_id,
      CASE WHEN generation_id IS NULL THEN 'UNENROLLED'::"OrderIntentMarketPolicyCoverageProvenance"
           WHEN bound_revision_id = active_revision_id THEN 'ACTIVE_EXACT'::"OrderIntentMarketPolicyCoverageProvenance"
           ELSE 'SUPERSEDED_COMPARE_ONLY'::"OrderIntentMarketPolicyCoverageProvenance" END,
      'COMPARE_ONLY', 'NONE', statement_timestamp()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER "OrderIntent_capture_market_policy_coverage"
AFTER INSERT ON "OrderIntent"
FOR EACH ROW
WHEN (lower(NEW.side) = 'buy' AND NEW."tradingAccountId" IS NOT NULL AND NEW."tradingAccountSubscriptionId" IS NOT NULL)
EXECUTE FUNCTION "capture_order_intent_market_policy_coverage"();
