-- Phase 3C.1: explicit, PAPER-only market-policy enforcement authorization.
--
-- Authorization is a separate append-preserving record. The Phase 3A generation fields
-- "enforcementAuthorityVersion" / "enforcementAuthorizedAt" and their null-only constraint
-- are intentionally retained: a single mutable pair on the generation cannot represent
-- revocation, invalidation, or reauthorization without rewriting history.
--
-- This migration creates no authorization rows. Existing ACTIVE generations remain
-- NOT_AUTHORIZED. No trading-path table, trigger, or evidence authority is altered.

CREATE TYPE "AssignmentMarketPolicyEnforcementAuthorizationStatus" AS ENUM ('AUTHORIZED', 'REVOKED', 'INVALIDATED');
CREATE TYPE "AssignmentMarketPolicyEnforcementAuthorizationAction" AS ENUM ('GRANT', 'REVOKE', 'INVALIDATE');

CREATE TABLE "AssignmentMarketPolicyEnforcementAuthorization" (
  "id" SERIAL PRIMARY KEY,
  "enrollmentId" INTEGER NOT NULL,
  "enrollmentGenerationId" INTEGER NOT NULL,
  "authorizationSequence" INTEGER NOT NULL,
  "authorityVersion" TEXT NOT NULL,
  "status" "AssignmentMarketPolicyEnforcementAuthorizationStatus" NOT NULL DEFAULT 'AUTHORIZED',
  "environment" "TradingAccountEnvironment" NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "accountSubscriptionId" INTEGER NOT NULL,
  "strategyId" INTEGER NOT NULL,
  "policyRevisionId" INTEGER NOT NULL,
  "accountHolderUserId" INTEGER NOT NULL,
  "configurationFingerprint" TEXT NOT NULL,
  "authorizationFingerprint" TEXT NOT NULL,
  "authorizedByUserId" INTEGER NOT NULL,
  "authorizedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "grantReason" TEXT NOT NULL,
  "revokedByUserId" INTEGER,
  "revokedAt" TIMESTAMPTZ(3),
  "revocationReason" TEXT,
  "invalidatedByUserId" INTEGER,
  "invalidatedAt" TIMESTAMPTZ(3),
  "invalidationReasonCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssignmentEnforcementAuthorization_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "AssignmentMarketPolicyEnrollment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_generation_fkey" FOREIGN KEY ("enrollmentGenerationId") REFERENCES "AssignmentMarketPolicyEnrollmentGeneration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_account_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_assignment_fkey" FOREIGN KEY ("accountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_revision_fkey" FOREIGN KEY ("policyRevisionId") REFERENCES "StrategyMarketPolicyRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_holder_fkey" FOREIGN KEY ("accountHolderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_authorizer_fkey" FOREIGN KEY ("authorizedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_revoker_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_invalidator_fkey" FOREIGN KEY ("invalidatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorization_sequence_key" UNIQUE ("enrollmentGenerationId", "authorizationSequence"),
  CONSTRAINT "AssignmentEnforcementAuthorization_fingerprint_key" UNIQUE ("authorizationFingerprint"),
  CONSTRAINT "AssignmentEnforcementAuthorization_sequence_check" CHECK ("authorizationSequence" > 0),
  CONSTRAINT "AssignmentEnforcementAuthorization_paper_only_check" CHECK ("environment" = 'PAPER'),
  CONSTRAINT "AssignmentEnforcementAuthorization_version_check" CHECK ("authorityVersion" = 'PAPER_MARKET_POLICY_ENFORCEMENT_V1'),
  CONSTRAINT "AssignmentEnforcementAuthorization_fingerprints_check" CHECK ("configurationFingerprint" ~ '^[a-f0-9]{64}$' AND "authorizationFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AssignmentEnforcementAuthorization_grant_reason_check" CHECK (char_length(btrim("grantReason")) BETWEEN 1 AND 500),
  CONSTRAINT "AssignmentEnforcementAuthorization_lifecycle_check" CHECK (
    ("status" = 'AUTHORIZED'
      AND "revokedByUserId" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL
      AND "invalidatedByUserId" IS NULL AND "invalidatedAt" IS NULL AND "invalidationReasonCode" IS NULL)
    OR ("status" = 'REVOKED'
      AND "revokedByUserId" IS NOT NULL AND "revokedAt" IS NOT NULL AND "revokedAt" >= "authorizedAt"
      AND "revocationReason" IS NOT NULL AND char_length(btrim("revocationReason")) BETWEEN 1 AND 500
      AND "invalidatedByUserId" IS NULL AND "invalidatedAt" IS NULL AND "invalidationReasonCode" IS NULL)
    OR ("status" = 'INVALIDATED'
      AND "invalidatedAt" IS NOT NULL AND "invalidatedAt" >= "authorizedAt"
      AND "invalidationReasonCode" IN ('ENROLLMENT_DISABLED', 'POLICY_REVISION_SUPERSEDED', 'ACCOUNT_HOLDER_CHANGED', 'ASSIGNMENT_IDENTITY_CHANGED')
      AND "revokedByUserId" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL)
  )
);

-- At most one effective grant per exact generation and per assignment.
CREATE UNIQUE INDEX "AssignmentEnforcementAuthorization_one_authorized_generation" ON "AssignmentMarketPolicyEnforcementAuthorization" ("enrollmentGenerationId") WHERE "status" = 'AUTHORIZED';
CREATE UNIQUE INDEX "AssignmentEnforcementAuthorization_one_authorized_assignment" ON "AssignmentMarketPolicyEnforcementAuthorization" ("accountSubscriptionId") WHERE "status" = 'AUTHORIZED';
CREATE INDEX "AssignmentEnforcementAuthorization_assignment_idx" ON "AssignmentMarketPolicyEnforcementAuthorization" ("accountSubscriptionId", "id");
CREATE INDEX "AssignmentEnforcementAuthorization_account_idx" ON "AssignmentMarketPolicyEnforcementAuthorization" ("tradingAccountId");
CREATE INDEX "AssignmentEnforcementAuthorization_revision_idx" ON "AssignmentMarketPolicyEnforcementAuthorization" ("policyRevisionId");

CREATE TABLE "AssignmentMarketPolicyEnforcementAuthorizationEvent" (
  "id" SERIAL PRIMARY KEY,
  "authorizationId" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "action" "AssignmentMarketPolicyEnforcementAuthorizationAction" NOT NULL,
  "fromStatus" "AssignmentMarketPolicyEnforcementAuthorizationStatus",
  "toStatus" "AssignmentMarketPolicyEnforcementAuthorizationStatus" NOT NULL,
  "actorUserId" INTEGER,
  "reason" TEXT NOT NULL,
  "authorityVersion" TEXT NOT NULL,
  "enrollmentGenerationId" INTEGER NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "accountSubscriptionId" INTEGER NOT NULL,
  "strategyId" INTEGER NOT NULL,
  "policyRevisionId" INTEGER NOT NULL,
  "accountHolderUserId" INTEGER NOT NULL,
  "configurationFingerprint" TEXT NOT NULL,
  "authorizationFingerprint" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssignmentEnforcementAuthorizationEvent_authorization_fkey" FOREIGN KEY ("authorizationId") REFERENCES "AssignmentMarketPolicyEnforcementAuthorization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorizationEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AssignmentEnforcementAuthorizationEvent_sequence_key" UNIQUE ("authorizationId", "sequence"),
  CONSTRAINT "AssignmentEnforcementAuthorizationEvent_legal_shape_check" CHECK (
    ("action" = 'GRANT' AND "sequence" = 1 AND "fromStatus" IS NULL AND "toStatus" = 'AUTHORIZED' AND "actorUserId" IS NOT NULL)
    OR ("action" = 'REVOKE' AND "sequence" = 2 AND "fromStatus" = 'AUTHORIZED' AND "toStatus" = 'REVOKED' AND "actorUserId" IS NOT NULL)
    OR ("action" = 'INVALIDATE' AND "sequence" = 2 AND "fromStatus" = 'AUTHORIZED' AND "toStatus" = 'INVALIDATED')
  )
);
CREATE INDEX "AssignmentEnforcementAuthorizationEvent_assignment_idx" ON "AssignmentMarketPolicyEnforcementAuthorizationEvent" ("accountSubscriptionId", "occurredAt");

CREATE FUNCTION "validate_assignment_market_policy_enforcement_authorization"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g "AssignmentMarketPolicyEnrollmentGeneration"%ROWTYPE;
  account_environment "TradingAccountEnvironment"; holder_id INTEGER;
  assignment_account INTEGER; assignment_strategy INTEGER;
  revision_status "StrategyMarketPolicyRevisionStatus"; revision_strategy INTEGER;
  actor_role "PlatformRole"; actor_enabled BOOLEAN; next_sequence INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Enforcement authorizations are append-preserving' USING ERRCODE = '23514'; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'AUTHORIZED' THEN RAISE EXCEPTION 'Enforcement authorization must be inserted as AUTHORIZED' USING ERRCODE = '23514'; END IF;
    -- Share locks serialize the grant against concurrent disable, retirement, ownership and environment changes.
    SELECT * INTO g FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id = NEW."enrollmentGenerationId" FOR SHARE;
    IF g.id IS NULL OR g.status <> 'ACTIVE' THEN RAISE EXCEPTION 'Enforcement authorization requires an ACTIVE enrollment generation' USING ERRCODE = '23514'; END IF;
    IF ROW(NEW."enrollmentId", NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."strategyId", NEW."policyRevisionId", NEW."accountHolderUserId", NEW."configurationFingerprint")
       IS DISTINCT FROM ROW(g."enrollmentId", g."tradingAccountId", g."accountSubscriptionId", g."strategyId", g."policyRevisionId", g."accountHolderUserId", g."configurationFingerprint") THEN
      RAISE EXCEPTION 'Enforcement authorization identity must match the exact enrollment generation' USING ERRCODE = '23514';
    END IF;
    SELECT environment, "accountHolderUserId" INTO account_environment, holder_id FROM "TradingAccount" WHERE id = NEW."tradingAccountId" FOR SHARE;
    IF account_environment IS DISTINCT FROM 'PAPER' OR NEW.environment <> 'PAPER' THEN RAISE EXCEPTION 'Enforcement authorization is PAPER-only' USING ERRCODE = '23514'; END IF;
    IF holder_id IS DISTINCT FROM NEW."accountHolderUserId" THEN RAISE EXCEPTION 'Enforcement authorization requires the unchanged account holder' USING ERRCODE = '23514'; END IF;
    SELECT "tradingAccountId", "routingStrategyId" INTO assignment_account, assignment_strategy FROM "TradingAccountSubscription" WHERE id = NEW."accountSubscriptionId" FOR SHARE;
    IF assignment_account IS DISTINCT FROM NEW."tradingAccountId" OR assignment_strategy IS DISTINCT FROM NEW."strategyId" THEN RAISE EXCEPTION 'Enforcement authorization assignment identity mismatch' USING ERRCODE = '23514'; END IF;
    SELECT r.status, p."strategyId" INTO revision_status, revision_strategy FROM "StrategyMarketPolicyRevision" r JOIN "StrategyMarketPolicy" p ON p.id = r."policyId" WHERE r.id = NEW."policyRevisionId" FOR SHARE OF r;
    IF revision_status IS DISTINCT FROM 'ACTIVE' OR revision_strategy IS DISTINCT FROM NEW."strategyId" THEN RAISE EXCEPTION 'Enforcement authorization requires the Strategy''s ACTIVE policy revision' USING ERRCODE = '23514'; END IF;
    SELECT "platformRole", enabled INTO actor_role, actor_enabled FROM "User" WHERE id = NEW."authorizedByUserId";
    IF actor_role IS DISTINCT FROM 'SYSTEM_OWNER' OR actor_enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'Enforcement authorization requires an enabled SYSTEM_OWNER' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(max("authorizationSequence"), 0) + 1 INTO next_sequence FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "enrollmentGenerationId" = NEW."enrollmentGenerationId";
    IF NEW."authorizationSequence" <> next_sequence THEN RAISE EXCEPTION 'Enforcement authorization sequence must be contiguous' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'AUTHORIZED' THEN RAISE EXCEPTION 'Terminal enforcement authorizations are immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.status NOT IN ('REVOKED', 'INVALIDATED') THEN RAISE EXCEPTION 'Illegal enforcement authorization transition' USING ERRCODE = '23514'; END IF;
  IF ROW(OLD."enrollmentId", OLD."enrollmentGenerationId", OLD."authorizationSequence", OLD."authorityVersion", OLD.environment, OLD."tradingAccountId", OLD."accountSubscriptionId", OLD."strategyId", OLD."policyRevisionId", OLD."accountHolderUserId", OLD."configurationFingerprint", OLD."authorizationFingerprint", OLD."authorizedByUserId", OLD."authorizedAt", OLD."grantReason", OLD."createdAt")
     IS DISTINCT FROM ROW(NEW."enrollmentId", NEW."enrollmentGenerationId", NEW."authorizationSequence", NEW."authorityVersion", NEW.environment, NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."strategyId", NEW."policyRevisionId", NEW."accountHolderUserId", NEW."configurationFingerprint", NEW."authorizationFingerprint", NEW."authorizedByUserId", NEW."authorizedAt", NEW."grantReason", NEW."createdAt") THEN
    RAISE EXCEPTION 'Enforcement authorization grant evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'REVOKED' THEN
    SELECT "platformRole", enabled INTO actor_role, actor_enabled FROM "User" WHERE id = NEW."revokedByUserId";
    IF actor_role IS DISTINCT FROM 'SYSTEM_OWNER' OR actor_enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'Enforcement revocation requires an enabled SYSTEM_OWNER' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AssignmentEnforcementAuthorization_validate" BEFORE INSERT OR UPDATE OR DELETE ON "AssignmentMarketPolicyEnforcementAuthorization" FOR EACH ROW EXECUTE FUNCTION "validate_assignment_market_policy_enforcement_authorization"();

-- Every grant and terminal transition writes exactly one immutable audit event, including direct SQL and cascaded invalidation.
CREATE FUNCTION "record_assignment_market_policy_enforcement_authorization_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "AssignmentMarketPolicyEnforcementAuthorizationEvent" (
    "authorizationId", "sequence", "action", "fromStatus", "toStatus", "actorUserId", "reason", "authorityVersion",
    "enrollmentGenerationId", "tradingAccountId", "accountSubscriptionId", "strategyId", "policyRevisionId", "accountHolderUserId",
    "configurationFingerprint", "authorizationFingerprint", "occurredAt"
  ) VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 2 END,
    CASE WHEN TG_OP = 'INSERT' THEN 'GRANT' WHEN NEW.status = 'REVOKED' THEN 'REVOKE' ELSE 'INVALIDATE' END::"AssignmentMarketPolicyEnforcementAuthorizationAction",
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,
    CASE WHEN TG_OP = 'INSERT' THEN NEW."authorizedByUserId" WHEN NEW.status = 'REVOKED' THEN NEW."revokedByUserId" ELSE NEW."invalidatedByUserId" END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW."grantReason" WHEN NEW.status = 'REVOKED' THEN NEW."revocationReason" ELSE NEW."invalidationReasonCode" END,
    NEW."authorityVersion", NEW."enrollmentGenerationId", NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."strategyId", NEW."policyRevisionId", NEW."accountHolderUserId",
    NEW."configurationFingerprint", NEW."authorizationFingerprint",
    CASE WHEN TG_OP = 'INSERT' THEN NEW."authorizedAt" WHEN NEW.status = 'REVOKED' THEN NEW."revokedAt" ELSE NEW."invalidatedAt" END
  );
  RETURN NULL;
END $$;
CREATE TRIGGER "AssignmentEnforcementAuthorization_record_event" AFTER INSERT OR UPDATE ON "AssignmentMarketPolicyEnforcementAuthorization" FOR EACH ROW EXECUTE FUNCTION "record_assignment_market_policy_enforcement_authorization_event"();

CREATE FUNCTION "validate_assignment_enforcement_authorization_event"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Enforcement authorization events are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO a FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id = NEW."authorizationId";
  IF a.id IS NULL OR a.status <> NEW."toStatus" OR ROW(NEW."authorityVersion", NEW."enrollmentGenerationId", NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."strategyId", NEW."policyRevisionId", NEW."accountHolderUserId", NEW."configurationFingerprint", NEW."authorizationFingerprint")
     IS DISTINCT FROM ROW(a."authorityVersion", a."enrollmentGenerationId", a."tradingAccountId", a."accountSubscriptionId", a."strategyId", a."policyRevisionId", a."accountHolderUserId", a."configurationFingerprint", a."authorizationFingerprint") THEN
    RAISE EXCEPTION 'Enforcement authorization event must mirror the exact authorization state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AssignmentEnforcementAuthorizationEvent_validate" BEFORE INSERT OR UPDATE OR DELETE ON "AssignmentMarketPolicyEnforcementAuthorizationEvent" FOR EACH ROW EXECUTE FUNCTION "validate_assignment_enforcement_authorization_event"();

-- Disabling the exact generation invalidates its effective grant without deleting it.
CREATE FUNCTION "invalidate_enforcement_authorization_on_enrollment_disable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = GREATEST(NEW."disabledAt", "authorizedAt"), "invalidatedByUserId" = NEW."disabledByUserId", "invalidationReasonCode" = 'ENROLLMENT_DISABLED'
   WHERE "enrollmentGenerationId" = NEW.id AND status = 'AUTHORIZED';
  RETURN NULL;
END $$;
CREATE TRIGGER "AssignmentEnrollmentGeneration_invalidate_authorization" AFTER UPDATE OF status ON "AssignmentMarketPolicyEnrollmentGeneration" FOR EACH ROW WHEN (NEW.status = 'DISABLED' AND OLD.status <> 'DISABLED') EXECUTE FUNCTION "invalidate_enforcement_authorization_on_enrollment_disable"();

-- A superseded or retired policy revision never carries authority forward.
CREATE FUNCTION "invalidate_enforcement_authorization_on_revision_retire"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = GREATEST(CURRENT_TIMESTAMP, "authorizedAt"), "invalidationReasonCode" = 'POLICY_REVISION_SUPERSEDED'
   WHERE "policyRevisionId" = NEW.id AND status = 'AUTHORIZED';
  RETURN NULL;
END $$;
CREATE TRIGGER "StrategyMarketPolicyRevision_invalidate_authorization" AFTER UPDATE OF status ON "StrategyMarketPolicyRevision" FOR EACH ROW WHEN (OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE') EXECUTE FUNCTION "invalidate_enforcement_authorization_on_revision_retire"();

-- Ownership changes invalidate; environment changes away from PAPER are rejected while a grant is effective.
CREATE FUNCTION "invalidate_enforcement_authorization_on_account_holder_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = GREATEST(CURRENT_TIMESTAMP, "authorizedAt"), "invalidationReasonCode" = 'ACCOUNT_HOLDER_CHANGED'
   WHERE "tradingAccountId" = NEW.id AND status = 'AUTHORIZED' AND "accountHolderUserId" <> NEW."accountHolderUserId";
  RETURN NULL;
END $$;
CREATE TRIGGER "TradingAccount_invalidate_enforcement_authorization_holder" AFTER UPDATE OF "accountHolderUserId" ON "TradingAccount" FOR EACH ROW WHEN (OLD."accountHolderUserId" IS DISTINCT FROM NEW."accountHolderUserId") EXECUTE FUNCTION "invalidate_enforcement_authorization_on_account_holder_change"();

CREATE FUNCTION "prevent_non_paper_account_with_enforcement_authorization"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.environment <> 'PAPER' AND EXISTS (
    SELECT 1 FROM "AssignmentMarketPolicyEnforcementAuthorization" a WHERE a."tradingAccountId" = NEW.id AND a.status = 'AUTHORIZED'
  ) THEN RAISE EXCEPTION 'Revoke market-policy enforcement authorization before leaving PAPER' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "TradingAccount_prevent_non_paper_with_enforcement_authorization" BEFORE UPDATE OF environment ON "TradingAccount" FOR EACH ROW WHEN (OLD.environment IS DISTINCT FROM NEW.environment) EXECUTE FUNCTION "prevent_non_paper_account_with_enforcement_authorization"();

CREATE FUNCTION "invalidate_enforcement_authorization_on_assignment_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = GREATEST(CURRENT_TIMESTAMP, "authorizedAt"), "invalidationReasonCode" = 'ASSIGNMENT_IDENTITY_CHANGED'
   WHERE "accountSubscriptionId" = NEW.id AND status = 'AUTHORIZED' AND ("tradingAccountId" <> NEW."tradingAccountId" OR "strategyId" <> NEW."routingStrategyId");
  RETURN NULL;
END $$;
CREATE TRIGGER "TradingAccountSubscription_invalidate_enforcement_authorization" AFTER UPDATE OF "tradingAccountId", "routingStrategyId" ON "TradingAccountSubscription" FOR EACH ROW WHEN (OLD."tradingAccountId" IS DISTINCT FROM NEW."tradingAccountId" OR OLD."routingStrategyId" IS DISTINCT FROM NEW."routingStrategyId") EXECUTE FUNCTION "invalidate_enforcement_authorization_on_assignment_change"();
