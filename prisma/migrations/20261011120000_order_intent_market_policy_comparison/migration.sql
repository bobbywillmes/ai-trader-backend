CREATE TYPE "OrderIntentMarketPolicyComparisonOutcome" AS ENUM ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE', 'TECHNICAL_FAILURE');
CREATE TYPE "OrderIntentMarketPolicyComparisonDeliveryStatus" AS ENUM ('PENDING', 'CLAIMED', 'RETRY_WAIT', 'COMPLETED', 'TERMINAL_FAILURE');

CREATE TABLE "OrderIntentMarketPolicyComparisonRollout" (
  id INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  "enabledAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "OrderIntentMarketPolicyComparisonRollout_singleton_check" CHECK (id = 1),
  CONSTRAINT "OrderIntentMarketPolicyComparisonRollout_enabled_check" CHECK ((enabled AND "enabledAt" IS NOT NULL) OR (NOT enabled))
);

CREATE TABLE "OrderIntentMarketPolicyComparisonDelivery" (
  id SERIAL PRIMARY KEY,
  "coverageId" INTEGER NOT NULL UNIQUE,
  status "OrderIntentMarketPolicyComparisonDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "lastErrorCode" TEXT,
  "completedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "OrderIntentMarketPolicyComparisonDelivery_coverageId_fkey" FOREIGN KEY ("coverageId") REFERENCES "OrderIntentMarketPolicyCoverage"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyComparisonDelivery_attempt_check" CHECK ("attemptCount" >= 0 AND "attemptCount" <= 3),
  CONSTRAINT "OrderIntentMarketPolicyComparisonDelivery_state_check" CHECK (
    (status = 'CLAIMED' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "completedAt" IS NULL)
    OR (status IN ('PENDING','RETRY_WAIT') AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "completedAt" IS NULL)
    OR (status IN ('COMPLETED','TERMINAL_FAILURE') AND "leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL AND "completedAt" IS NOT NULL)
  )
);
CREATE INDEX "OrderIntentMarketPolicyComparisonDelivery_due_idx" ON "OrderIntentMarketPolicyComparisonDelivery"(status,"nextAttemptAt");
CREATE INDEX "OrderIntentMarketPolicyComparisonDelivery_lease_idx" ON "OrderIntentMarketPolicyComparisonDelivery"("leaseExpiresAt");

CREATE TABLE "OrderIntentMarketPolicyComparisonAttempt" (
  id SERIAL PRIMARY KEY,
  "coverageId" INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  "strategyId" INTEGER NOT NULL,
  "enrollmentGenerationId" INTEGER NOT NULL,
  "policyRevisionId" INTEGER NOT NULL,
  "marketRegimeAssessmentId" INTEGER NOT NULL,
  "evidenceAsOf" TIMESTAMPTZ(3) NOT NULL,
  "evaluationVersion" TEXT NOT NULL,
  "enrollmentDisposition" TEXT NOT NULL,
  outcome "OrderIntentMarketPolicyComparisonOutcome" NOT NULL,
  "reasonCode" TEXT NOT NULL,
  authority TEXT NOT NULL DEFAULT 'COMPARE_ONLY',
  "tradingEffect" TEXT NOT NULL DEFAULT 'NONE',
  "evidenceJson" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderIntentMarketPolicyComparisonAttempt_coverageId_fkey" FOREIGN KEY ("coverageId") REFERENCES "OrderIntentMarketPolicyCoverage"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyComparisonAttempt_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyComparisonAttempt_enrollmentGenerat_fkey" FOREIGN KEY ("enrollmentGenerationId") REFERENCES "AssignmentMarketPolicyEnrollmentGeneration"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyComparisonAttempt_policyRevisionId_fkey" FOREIGN KEY ("policyRevisionId") REFERENCES "StrategyMarketPolicyRevision"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyComparisonAttempt_marketRegimeAsses_fkey" FOREIGN KEY ("marketRegimeAssessmentId") REFERENCES "MarketRegimeAssessment"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyComparisonAttempt_authority_check" CHECK (authority = 'COMPARE_ONLY' AND "tradingEffect" = 'NONE'),
  CONSTRAINT "OrderIntentMarketPolicyComparisonAttempt_attempt_check" CHECK (attempt BETWEEN 1 AND 3),
  CONSTRAINT "OrderIntentMarketPolicyComparisonAttempt_disposition_check" CHECK ("enrollmentDisposition" IN ('ACTIVE','SUPERSEDED_DIAGNOSTIC')),
  CONSTRAINT "OrderIntentMarketPolicyComparisonAttempt_coverage_attempt_key" UNIQUE ("coverageId", attempt)
);
CREATE UNIQUE INDEX "OrderIntentMarketPolicyComparisonAttempt_completed_key" ON "OrderIntentMarketPolicyComparisonAttempt"("coverageId") WHERE outcome <> 'TECHNICAL_FAILURE';
CREATE INDEX "OrderIntentMarketPolicyComparisonAttempt_policy_idx" ON "OrderIntentMarketPolicyComparisonAttempt"("policyRevisionId");
CREATE INDEX "OrderIntentMarketPolicyComparisonAttempt_composition_idx" ON "OrderIntentMarketPolicyComparisonAttempt"("marketRegimeAssessmentId");

CREATE TABLE "OrderIntentMarketPolicyComparisonGate" (
  id SERIAL PRIMARY KEY,
  "comparisonAttemptId" INTEGER NOT NULL,
  dimension "MarketRegimeDimension" NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  requirement "StrategyMarketPolicyDimensionRequirement" NOT NULL,
  outcome "StrategyMarketEligibilityGateOutcome" NOT NULL,
  "observedState" TEXT,
  "sourceHealth" "MarketRegimeCompositionSourceHealth",
  "sourceAssessmentId" INTEGER,
  "allowedStatesJson" JSONB NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  ordinal INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderIntentMarketPolicyComparisonGate_comparisonAttemptId_fkey" FOREIGN KEY ("comparisonAttemptId") REFERENCES "OrderIntentMarketPolicyComparisonAttempt"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyComparisonGate_source_identity_fk" FOREIGN KEY ("sourceAssessmentId",dimension,"algorithmVersion") REFERENCES "MarketRegimeDimensionAssessment"(id,dimension,"algorithmVersion") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderIntentMarketPolicyComparisonGate_ordinal_check" CHECK (ordinal BETWEEN 1 AND 5),
  CONSTRAINT "OrderIntentMarketPolicyComparisonGate_attempt_dimension_key" UNIQUE ("comparisonAttemptId",dimension),
  CONSTRAINT "OrderIntentMarketPolicyComparisonGate_attempt_ordinal_key" UNIQUE ("comparisonAttemptId",ordinal)
);

CREATE FUNCTION "guard_order_intent_market_policy_comparison_rollout"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> 1 OR OLD.id <> 1 THEN RAISE EXCEPTION 'OrderIntent comparison rollout is a singleton' USING ERRCODE='23514'; END IF;
  IF NOT OLD.enabled AND NEW.enabled THEN NEW."enabledAt" := clock_timestamp();
  ELSIF OLD.enabled AND NOT NEW.enabled THEN NEW."enabledAt" := OLD."enabledAt";
  ELSIF NEW."enabledAt" IS DISTINCT FROM OLD."enabledAt" THEN RAISE EXCEPTION 'OrderIntent comparison rollout timestamps are database-managed' USING ERRCODE='23514'; END IF;
  NEW."updatedAt" := statement_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER "OrderIntentMarketPolicyComparisonRollout_guard" BEFORE UPDATE ON "OrderIntentMarketPolicyComparisonRollout" FOR EACH ROW EXECUTE FUNCTION "guard_order_intent_market_policy_comparison_rollout"();

CREATE FUNCTION "validate_order_intent_market_policy_comparison_attempt"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c "OrderIntentMarketPolicyCoverage"%ROWTYPE; g "AssignmentMarketPolicyEnrollmentGeneration"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "OrderIntentMarketPolicyCoverage" WHERE id=NEW."coverageId";
  SELECT * INTO g FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id=NEW."enrollmentGenerationId";
  IF c."captureSchemaVersion" <> 2 OR c."compositionCapture" <> 'EXACT' OR c.provenance NOT IN ('ACTIVE_EXACT','SUPERSEDED_COMPARE_ONLY')
    OR ROW(NEW."enrollmentGenerationId",NEW."policyRevisionId",NEW."marketRegimeAssessmentId",NEW."evidenceAsOf")
       IS DISTINCT FROM ROW(c."enrollmentGenerationId",c."boundPolicyRevisionId",c."marketRegimeAssessmentId",c."capturedAt")
    OR NEW."strategyId" IS DISTINCT FROM g."strategyId"
    OR NEW."enrollmentDisposition" IS DISTINCT FROM (CASE WHEN c.provenance='ACTIVE_EXACT' THEN 'ACTIVE' ELSE 'SUPERSEDED_DIAGNOSTIC' END) THEN
    RAISE EXCEPTION 'OrderIntent comparison identity does not match exact coverage' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "OrderIntentMarketPolicyComparisonAttempt_validate" BEFORE INSERT ON "OrderIntentMarketPolicyComparisonAttempt" FOR EACH ROW EXECUTE FUNCTION "validate_order_intent_market_policy_comparison_attempt"();

CREATE FUNCTION "enforce_order_intent_market_policy_comparison_gates"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate_count INTEGER;
BEGIN
  SELECT count(*) INTO gate_count FROM "OrderIntentMarketPolicyComparisonGate" WHERE "comparisonAttemptId"=NEW.id;
  IF (NEW.outcome='TECHNICAL_FAILURE' AND gate_count<>0) OR (NEW.outcome<>'TECHNICAL_FAILURE' AND gate_count<>5) THEN
    RAISE EXCEPTION 'OrderIntent comparison attempt % has invalid gate completeness', NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER "OrderIntentMarketPolicyComparisonAttempt_gate_check" AFTER INSERT ON "OrderIntentMarketPolicyComparisonAttempt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_order_intent_market_policy_comparison_gates"();

CREATE FUNCTION "prevent_order_intent_market_policy_comparison_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% rows are immutable',TG_TABLE_NAME USING ERRCODE='23514'; END $$;
CREATE TRIGGER "OrderIntentMarketPolicyComparisonAttempt_immutable" BEFORE UPDATE OR DELETE ON "OrderIntentMarketPolicyComparisonAttempt" FOR EACH ROW EXECUTE FUNCTION "prevent_order_intent_market_policy_comparison_mutation"();
CREATE TRIGGER "OrderIntentMarketPolicyComparisonGate_immutable" BEFORE UPDATE OR DELETE ON "OrderIntentMarketPolicyComparisonGate" FOR EACH ROW EXECUTE FUNCTION "prevent_order_intent_market_policy_comparison_mutation"();

INSERT INTO "OrderIntentMarketPolicyComparisonRollout" (id,enabled,"enabledAt","updatedAt") VALUES (1,false,NULL,statement_timestamp());
