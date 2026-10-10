CREATE TYPE "AssignmentMarketPolicyEnrollmentStatus" AS ENUM ('PREPARED', 'ACTIVE', 'DISABLED');
CREATE TYPE "AssignmentMarketPolicyEnrollmentTransitionAction" AS ENUM ('PREPARE', 'ACTIVATE', 'DISABLE');

CREATE TABLE "AssignmentMarketPolicyEnrollment" (
  "id" SERIAL PRIMARY KEY,
  "accountSubscriptionId" INTEGER NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "AssignmentMarketPolicyEnrollment_accountSubscriptionId_fkey" FOREIGN KEY ("accountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "AssignmentMarketPolicyEnrollmentGeneration" (
  "id" SERIAL PRIMARY KEY,
  "enrollmentId" INTEGER NOT NULL,
  "generation" INTEGER NOT NULL,
  "status" "AssignmentMarketPolicyEnrollmentStatus" NOT NULL DEFAULT 'PREPARED',
  "tradingAccountId" INTEGER NOT NULL,
  "accountSubscriptionId" INTEGER NOT NULL,
  "strategyId" INTEGER NOT NULL,
  "policyRevisionId" INTEGER NOT NULL,
  "accountHolderUserId" INTEGER NOT NULL,
  "configurationFingerprint" TEXT NOT NULL,
  "preparedByUserId" INTEGER NOT NULL,
  "preparedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedByUserId" INTEGER,
  "activatedAt" TIMESTAMPTZ(3),
  "disabledByUserId" INTEGER,
  "disabledAt" TIMESTAMPTZ(3),
  "disableReason" TEXT,
  "enforcementAuthorityVersion" TEXT,
  "enforcementAuthorizedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "AssignmentMarketPolicyEnrollment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_accountSubscrip_fkey" FOREIGN KEY ("accountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_tradingAccountI_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_policyRevisionI_fkey" FOREIGN KEY ("policyRevisionId") REFERENCES "StrategyMarketPolicyRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_accountHolderUs_fkey" FOREIGN KEY ("accountHolderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_preparedByUserI_fkey" FOREIGN KEY ("preparedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_activatedByUser_fkey" FOREIGN KEY ("activatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_disabledByUserI_fkey" FOREIGN KEY ("disabledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnrollmentGeneration_number_key" UNIQUE ("enrollmentId", "generation"),
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_positive_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_phase3a_no_enforcement_check" CHECK ("enforcementAuthorityVersion" IS NULL AND "enforcementAuthorizedAt" IS NULL),
  CONSTRAINT "AssignmentMarketPolicyEnrollmentGeneration_lifecycle_fields_check" CHECK (
    ("status" = 'PREPARED' AND "activatedByUserId" IS NULL AND "activatedAt" IS NULL AND "disabledByUserId" IS NULL AND "disabledAt" IS NULL)
    OR ("status" = 'ACTIVE' AND "activatedByUserId" IS NOT NULL AND "activatedAt" IS NOT NULL AND "disabledByUserId" IS NULL AND "disabledAt" IS NULL)
    OR ("status" = 'DISABLED' AND "disabledByUserId" IS NOT NULL AND "disabledAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "AssignmentMarketPolicyEnrollmentGeneration_one_prepared" ON "AssignmentMarketPolicyEnrollmentGeneration" ("enrollmentId") WHERE "status" = 'PREPARED';
CREATE UNIQUE INDEX "AssignmentMarketPolicyEnrollmentGeneration_one_active" ON "AssignmentMarketPolicyEnrollmentGeneration" ("enrollmentId") WHERE "status" = 'ACTIVE';
CREATE INDEX "AssignmentMarketPolicyEnrollmentGeneration_assignment_idx" ON "AssignmentMarketPolicyEnrollmentGeneration" ("accountSubscriptionId");
CREATE INDEX "AssignmentMarketPolicyEnrollmentGeneration_policy_revision_idx" ON "AssignmentMarketPolicyEnrollmentGeneration" ("policyRevisionId");

CREATE TABLE "AssignmentMarketPolicyEnrollmentTransition" (
  "id" SERIAL PRIMARY KEY,
  "generationId" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "action" "AssignmentMarketPolicyEnrollmentTransitionAction" NOT NULL,
  "fromStatus" "AssignmentMarketPolicyEnrollmentStatus",
  "toStatus" "AssignmentMarketPolicyEnrollmentStatus" NOT NULL,
  "actorUserId" INTEGER NOT NULL,
  "accountHolderUserId" INTEGER NOT NULL,
  "configurationFingerprint" TEXT NOT NULL,
  "reason" TEXT,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentTransition_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "AssignmentMarketPolicyEnrollmentGeneration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentTransition_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentMarketPolicyEnrollmentTransition_accountHolderUs_fkey" FOREIGN KEY ("accountHolderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnrollmentTransition_sequence_key" UNIQUE ("generationId", "sequence"),
  CONSTRAINT "AssignmentMarketPolicyEnrollmentTransition_legal_shape_check" CHECK (
    ("action" = 'PREPARE' AND "sequence" = 1 AND "fromStatus" IS NULL AND "toStatus" = 'PREPARED')
    OR ("action" = 'ACTIVATE' AND "sequence" = 2 AND "fromStatus" = 'PREPARED' AND "toStatus" = 'ACTIVE')
    OR ("action" = 'DISABLE' AND "fromStatus" IN ('PREPARED', 'ACTIVE') AND "toStatus" = 'DISABLED')
  )
);
CREATE INDEX "AssignmentMarketPolicyEnrollmentTransition_occurred_idx" ON "AssignmentMarketPolicyEnrollmentTransition" ("occurredAt");

CREATE FUNCTION "validate_assignment_market_policy_enrollment_generation"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assignment_account INTEGER; assignment_strategy INTEGER; account_environment "TradingAccountEnvironment"; holder_id INTEGER; revision_strategy INTEGER; revision_status "StrategyMarketPolicyRevisionStatus";
BEGIN
  SELECT tas."tradingAccountId", tas."routingStrategyId", ta."environment", ta."accountHolderUserId"
    INTO assignment_account, assignment_strategy, account_environment, holder_id
    FROM "TradingAccountSubscription" tas JOIN "TradingAccount" ta ON ta.id = tas."tradingAccountId" WHERE tas.id = NEW."accountSubscriptionId";
  SELECT p."strategyId", r.status INTO revision_strategy, revision_status FROM "StrategyMarketPolicyRevision" r JOIN "StrategyMarketPolicy" p ON p.id = r."policyId" WHERE r.id = NEW."policyRevisionId";
  IF assignment_account IS NULL OR NEW."tradingAccountId" <> assignment_account OR NEW."strategyId" <> assignment_strategy THEN RAISE EXCEPTION 'Enrollment assignment identity mismatch' USING ERRCODE = '23514'; END IF;
  IF revision_strategy IS NULL OR NEW."strategyId" <> revision_strategy THEN RAISE EXCEPTION 'Enrollment policy identity mismatch' USING ERRCODE = '23514'; END IF;
  IF NEW.status IN ('PREPARED','ACTIVE') AND account_environment <> 'PAPER' THEN RAISE EXCEPTION 'Prepared and active enrollment is PAPER-only' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' AND (NEW.status <> 'PREPARED' OR revision_status <> 'ACTIVE' OR NEW."accountHolderUserId" <> holder_id) THEN RAISE EXCEPTION 'Enrollment must prepare against the active policy and current owner' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'DISABLED' OR NOT ((OLD.status = 'PREPARED' AND NEW.status IN ('ACTIVE','DISABLED')) OR (OLD.status = 'ACTIVE' AND NEW.status = 'DISABLED')) THEN RAISE EXCEPTION 'Illegal enrollment lifecycle transition' USING ERRCODE = '23514'; END IF;
    IF ROW(OLD."enrollmentId",OLD."generation",OLD."tradingAccountId",OLD."accountSubscriptionId",OLD."strategyId",OLD."policyRevisionId",OLD."accountHolderUserId",OLD."configurationFingerprint",OLD."preparedByUserId",OLD."preparedAt",OLD."createdAt") IS DISTINCT FROM ROW(NEW."enrollmentId",NEW."generation",NEW."tradingAccountId",NEW."accountSubscriptionId",NEW."strategyId",NEW."policyRevisionId",NEW."accountHolderUserId",NEW."configurationFingerprint",NEW."preparedByUserId",NEW."preparedAt",NEW."createdAt") THEN RAISE EXCEPTION 'Enrollment generation identity is immutable' USING ERRCODE = '23514'; END IF;
    IF NEW.status = 'ACTIVE' AND (revision_status <> 'ACTIVE' OR NEW."accountHolderUserId" <> holder_id) THEN RAISE EXCEPTION 'Enrollment activation requires the exact active policy revision and current owner' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AssignmentMarketPolicyEnrollmentGeneration_validate" BEFORE INSERT OR UPDATE ON "AssignmentMarketPolicyEnrollmentGeneration" FOR EACH ROW EXECUTE FUNCTION "validate_assignment_market_policy_enrollment_generation"();

CREATE FUNCTION "prevent_assignment_enrollment_transition_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Enrollment transitions are immutable' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER "AssignmentMarketPolicyEnrollmentTransition_immutable" BEFORE UPDATE OR DELETE ON "AssignmentMarketPolicyEnrollmentTransition" FOR EACH ROW EXECUTE FUNCTION "prevent_assignment_enrollment_transition_mutation"();

CREATE FUNCTION "prevent_live_account_with_market_policy_enrollment"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.environment = 'LIVE' AND OLD.environment <> 'LIVE' AND EXISTS (
    SELECT 1 FROM "AssignmentMarketPolicyEnrollmentGeneration" g WHERE g."tradingAccountId" = NEW.id AND g.status IN ('PREPARED','ACTIVE')
  ) THEN RAISE EXCEPTION 'PAPER-to-LIVE transition requires disabling market-policy enrollments' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TradingAccount_prevent_live_with_market_policy_enrollment" BEFORE UPDATE OF environment ON "TradingAccount" FOR EACH ROW EXECUTE FUNCTION "prevent_live_account_with_market_policy_enrollment"();
