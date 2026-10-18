-- Phase 3C.2: authoritative, fail-closed pre-intent market-policy enforcement for explicitly
-- authorized PAPER assignments, behind a default-disabled runtime rollout.
--
-- This migration is additive. It creates the runtime rollout disabled, creates no new grants,
-- and changes no trading outcome until a SYSTEM_OWNER explicitly activates the rollout.
-- Existing PAPER_MARKET_POLICY_ENFORCEMENT_V1 grants never bound the exact tradable Security,
-- so effective V1 grants are INVALIDATED here (AUTHORITY_BINDING_REAPPROVAL_REQUIRED) rather
-- than reinterpreted as Security-bound authority. Owners must reauthorize or explicitly opt out.

-- ---------------------------------------------------------------------------------------------
-- 1. Security-bound authorization identity (Hermes M1)
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "AssignmentMarketPolicyEnforcementAuthorization"
  ADD COLUMN "subscriptionId" INTEGER,
  ADD COLUMN "securityId" INTEGER,
  ADD COLUMN "securitySymbol" TEXT,
  ADD COLUMN "invalidationSource" TEXT,
  ADD COLUMN "invalidationEvidenceJson" JSONB,
  ADD CONSTRAINT "AssignmentEnforcementAuthorization_subscription_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AssignmentEnforcementAuthorization_security_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AssignmentMarketPolicyEnforcementAuthorization"
  DROP CONSTRAINT "AssignmentEnforcementAuthorization_version_check",
  ADD CONSTRAINT "AssignmentEnforcementAuthorization_version_check" CHECK (
    ("authorityVersion" = 'PAPER_MARKET_POLICY_ENFORCEMENT_V1'
      AND "subscriptionId" IS NULL AND "securityId" IS NULL AND "securitySymbol" IS NULL)
    OR ("authorityVersion" = 'PAPER_MARKET_POLICY_ENFORCEMENT_V2'
      AND "subscriptionId" IS NOT NULL AND "securityId" IS NOT NULL
      AND "securitySymbol" IS NOT NULL AND char_length("securitySymbol") BETWEEN 1 AND 32)
  ),
  DROP CONSTRAINT "AssignmentEnforcementAuthorization_lifecycle_check",
  ADD CONSTRAINT "AssignmentEnforcementAuthorization_lifecycle_check" CHECK (
    ("status" = 'AUTHORIZED'
      AND "revokedByUserId" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL
      AND "invalidatedByUserId" IS NULL AND "invalidatedAt" IS NULL AND "invalidationReasonCode" IS NULL
      AND "invalidationSource" IS NULL AND "invalidationEvidenceJson" IS NULL)
    OR ("status" = 'REVOKED'
      AND "revokedByUserId" IS NOT NULL AND "revokedAt" IS NOT NULL AND "revokedAt" >= "authorizedAt"
      AND "revocationReason" IS NOT NULL AND char_length(btrim("revocationReason")) BETWEEN 1 AND 500
      AND "invalidatedByUserId" IS NULL AND "invalidatedAt" IS NULL AND "invalidationReasonCode" IS NULL
      AND "invalidationSource" IS NULL AND "invalidationEvidenceJson" IS NULL)
    OR ("status" = 'INVALIDATED'
      AND "invalidatedAt" IS NOT NULL AND "invalidatedAt" >= "authorizedAt"
      AND "invalidationReasonCode" IN (
        'ENROLLMENT_DISABLED', 'POLICY_REVISION_SUPERSEDED', 'ACCOUNT_HOLDER_CHANGED', 'ASSIGNMENT_IDENTITY_CHANGED',
        'ASSIGNMENT_SUBSCRIPTION_CHANGED', 'SUBSCRIPTION_IDENTITY_CHANGED', 'SECURITY_IDENTITY_CHANGED',
        'AUTHORITY_BINDING_REAPPROVAL_REQUIRED')
      AND "revokedByUserId" IS NULL AND "revokedAt" IS NULL AND "revocationReason" IS NULL)
  ),
  ADD CONSTRAINT "AssignmentEnforcementAuthorization_invalidation_source_check" CHECK (
    "invalidationSource" IS NULL OR "invalidationSource" IN (
      'ENROLLMENT_GENERATION_TRIGGER', 'POLICY_REVISION_TRIGGER', 'ACCOUNT_HOLDER_TRIGGER',
      'ASSIGNMENT_TRIGGER', 'SUBSCRIPTION_TRIGGER', 'SECURITY_TRIGGER', 'MIGRATION')
  );

CREATE INDEX "AssignmentEnforcementAuthorization_subscription_idx" ON "AssignmentMarketPolicyEnforcementAuthorization" ("subscriptionId");
CREATE INDEX "AssignmentEnforcementAuthorization_security_idx" ON "AssignmentMarketPolicyEnforcementAuthorization" ("securityId");

ALTER TABLE "AssignmentMarketPolicyEnforcementAuthorizationEvent"
  ADD COLUMN "subscriptionId" INTEGER,
  ADD COLUMN "securityId" INTEGER,
  ADD COLUMN "securitySymbol" TEXT,
  ADD COLUMN "provenanceJson" JSONB;

-- Canonical V2 authorization fingerprint. It must stay byte-identical to the application's
-- JSON.stringify serialization in enforcementAuthorizationFingerprint(); PostgreSQL recomputes it
-- for every grant so an arbitrary application-supplied fingerprint is never accepted as evidence.
CREATE FUNCTION "enforcement_authorization_fingerprint_v2"(a "AssignmentMarketPolicyEnforcementAuthorization", generation_number INTEGER)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    '{"authorityVersion":' || to_json(a."authorityVersion")::text
    || ',"environment":"PAPER"'
    || ',"accountId":' || a."tradingAccountId"
    || ',"assignmentId":' || a."accountSubscriptionId"
    || ',"subscriptionId":' || a."subscriptionId"
    || ',"securityId":' || a."securityId"
    || ',"securitySymbol":' || to_json(a."securitySymbol")::text
    || ',"strategyId":' || a."strategyId"
    || ',"policyRevisionId":' || a."policyRevisionId"
    || ',"enrollmentId":' || a."enrollmentId"
    || ',"enrollmentGenerationId":' || a."enrollmentGenerationId"
    || ',"generation":' || generation_number
    || ',"configurationFingerprint":' || to_json(a."configurationFingerprint")::text
    || ',"accountHolderUserId":' || a."accountHolderUserId"
    || ',"authorizationSequence":' || a."authorizationSequence"
    || '}', 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION "validate_assignment_market_policy_enforcement_authorization"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g "AssignmentMarketPolicyEnrollmentGeneration"%ROWTYPE;
  account_environment "TradingAccountEnvironment"; holder_id INTEGER;
  assignment_account INTEGER; assignment_strategy INTEGER; assignment_subscription INTEGER; assignment_security INTEGER;
  subscription_strategy INTEGER; subscription_security INTEGER; subscription_symbol TEXT; security_symbol TEXT;
  revision_status "StrategyMarketPolicyRevisionStatus"; revision_strategy INTEGER;
  actor_role "PlatformRole"; actor_enabled BOOLEAN; next_sequence INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Enforcement authorizations are append-preserving' USING ERRCODE = '23514'; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'AUTHORIZED' THEN RAISE EXCEPTION 'Enforcement authorization must be inserted as AUTHORIZED' USING ERRCODE = '23514'; END IF;
    IF NEW."authorityVersion" IS DISTINCT FROM 'PAPER_MARKET_POLICY_ENFORCEMENT_V2' THEN
      RAISE EXCEPTION 'Enforcement authorization must bind the exact Security (PAPER_MARKET_POLICY_ENFORCEMENT_V2)' USING ERRCODE = '23514';
    END IF;
    -- Lock order: assignment, generation, account, subscription, security, revision, actor.
    -- FOR UPDATE on the assignment serializes direct-SQL grants against in-flight entry admission.
    SELECT "tradingAccountId", "routingStrategyId", "subscriptionId", "routingSecurityId"
      INTO assignment_account, assignment_strategy, assignment_subscription, assignment_security
      FROM "TradingAccountSubscription" WHERE id = NEW."accountSubscriptionId" FOR UPDATE;
    SELECT * INTO g FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id = NEW."enrollmentGenerationId" FOR SHARE;
    IF g.id IS NULL OR g.status <> 'ACTIVE' THEN RAISE EXCEPTION 'Enforcement authorization requires an ACTIVE enrollment generation' USING ERRCODE = '23514'; END IF;
    IF ROW(NEW."enrollmentId", NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."strategyId", NEW."policyRevisionId", NEW."accountHolderUserId", NEW."configurationFingerprint")
       IS DISTINCT FROM ROW(g."enrollmentId", g."tradingAccountId", g."accountSubscriptionId", g."strategyId", g."policyRevisionId", g."accountHolderUserId", g."configurationFingerprint") THEN
      RAISE EXCEPTION 'Enforcement authorization identity must match the exact enrollment generation' USING ERRCODE = '23514';
    END IF;
    SELECT environment, "accountHolderUserId" INTO account_environment, holder_id FROM "TradingAccount" WHERE id = NEW."tradingAccountId" FOR SHARE;
    IF account_environment IS DISTINCT FROM 'PAPER' OR NEW.environment <> 'PAPER' THEN RAISE EXCEPTION 'Enforcement authorization is PAPER-only' USING ERRCODE = '23514'; END IF;
    IF holder_id IS DISTINCT FROM NEW."accountHolderUserId" THEN RAISE EXCEPTION 'Enforcement authorization requires the unchanged account holder' USING ERRCODE = '23514'; END IF;
    IF assignment_account IS DISTINCT FROM NEW."tradingAccountId" OR assignment_strategy IS DISTINCT FROM NEW."strategyId" THEN RAISE EXCEPTION 'Enforcement authorization assignment identity mismatch' USING ERRCODE = '23514'; END IF;
    SELECT "strategyId", "securityId", symbol INTO subscription_strategy, subscription_security, subscription_symbol
      FROM "Subscription" WHERE id = assignment_subscription FOR SHARE;
    SELECT symbol INTO security_symbol FROM "Security" WHERE id = assignment_security FOR SHARE;
    IF NEW."subscriptionId" IS DISTINCT FROM assignment_subscription OR NEW."securityId" IS DISTINCT FROM assignment_security
       OR subscription_strategy IS DISTINCT FROM assignment_strategy OR subscription_security IS DISTINCT FROM assignment_security
       OR NEW."securitySymbol" IS DISTINCT FROM security_symbol OR upper(btrim(subscription_symbol)) IS DISTINCT FROM security_symbol THEN
      RAISE EXCEPTION 'Enforcement authorization must bind the assignment''s exact Subscription and canonical Security' USING ERRCODE = '23514';
    END IF;
    SELECT r.status, p."strategyId" INTO revision_status, revision_strategy FROM "StrategyMarketPolicyRevision" r JOIN "StrategyMarketPolicy" p ON p.id = r."policyId" WHERE r.id = NEW."policyRevisionId" FOR SHARE OF r;
    IF revision_status IS DISTINCT FROM 'ACTIVE' OR revision_strategy IS DISTINCT FROM NEW."strategyId" THEN RAISE EXCEPTION 'Enforcement authorization requires the Strategy''s ACTIVE policy revision' USING ERRCODE = '23514'; END IF;
    -- FOR SHARE serializes the grant against a concurrent disable or demotion of the granting owner.
    SELECT "platformRole", enabled INTO actor_role, actor_enabled FROM "User" WHERE id = NEW."authorizedByUserId" FOR SHARE;
    IF actor_role IS DISTINCT FROM 'SYSTEM_OWNER' OR actor_enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'Enforcement authorization requires an enabled SYSTEM_OWNER' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(max("authorizationSequence"), 0) + 1 INTO next_sequence FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "enrollmentGenerationId" = NEW."enrollmentGenerationId";
    IF NEW."authorizationSequence" <> next_sequence THEN RAISE EXCEPTION 'Enforcement authorization sequence must be contiguous' USING ERRCODE = '23514'; END IF;
    IF NEW."authorizationFingerprint" IS DISTINCT FROM "enforcement_authorization_fingerprint_v2"(NEW, g.generation) THEN
      RAISE EXCEPTION 'Enforcement authorization fingerprint must equal the canonical PostgreSQL-computed identity' USING ERRCODE = '23514';
    END IF;
    -- PostgreSQL owns authoritative timestamps; application-supplied values are never evidence.
    NEW."authorizedAt" := statement_timestamp();
    NEW."createdAt" := NEW."authorizedAt";
    RETURN NEW;
  END IF;

  IF OLD.status <> 'AUTHORIZED' THEN RAISE EXCEPTION 'Terminal enforcement authorizations are immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.status NOT IN ('REVOKED', 'INVALIDATED') THEN RAISE EXCEPTION 'Illegal enforcement authorization transition' USING ERRCODE = '23514'; END IF;
  IF ROW(OLD."enrollmentId", OLD."enrollmentGenerationId", OLD."authorizationSequence", OLD."authorityVersion", OLD.environment, OLD."tradingAccountId", OLD."accountSubscriptionId", OLD."strategyId", OLD."policyRevisionId", OLD."accountHolderUserId", OLD."configurationFingerprint", OLD."authorizationFingerprint", OLD."authorizedByUserId", OLD."authorizedAt", OLD."grantReason", OLD."createdAt", OLD."subscriptionId", OLD."securityId", OLD."securitySymbol")
     IS DISTINCT FROM ROW(NEW."enrollmentId", NEW."enrollmentGenerationId", NEW."authorizationSequence", NEW."authorityVersion", NEW.environment, NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."strategyId", NEW."policyRevisionId", NEW."accountHolderUserId", NEW."configurationFingerprint", NEW."authorizationFingerprint", NEW."authorizedByUserId", NEW."authorizedAt", NEW."grantReason", NEW."createdAt", NEW."subscriptionId", NEW."securityId", NEW."securitySymbol") THEN
    RAISE EXCEPTION 'Enforcement authorization grant evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'REVOKED' THEN
    SELECT "platformRole", enabled INTO actor_role, actor_enabled FROM "User" WHERE id = NEW."revokedByUserId" FOR SHARE;
    IF actor_role IS DISTINCT FROM 'SYSTEM_OWNER' OR actor_enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'Enforcement revocation requires an enabled SYSTEM_OWNER' USING ERRCODE = '23514'; END IF;
    NEW."revokedAt" := GREATEST(statement_timestamp(), OLD."authorizedAt");
  ELSE
    IF NEW."invalidationSource" IS NULL THEN RAISE EXCEPTION 'Enforcement invalidation requires an authoritative invalidation source' USING ERRCODE = '23514'; END IF;
    NEW."invalidatedAt" := GREATEST(statement_timestamp(), OLD."authorizedAt");
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "record_assignment_market_policy_enforcement_authorization_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "AssignmentMarketPolicyEnforcementAuthorizationEvent" (
    "authorizationId", "sequence", "action", "fromStatus", "toStatus", "actorUserId", "reason", "authorityVersion",
    "enrollmentGenerationId", "tradingAccountId", "accountSubscriptionId", "strategyId", "policyRevisionId", "accountHolderUserId",
    "configurationFingerprint", "authorizationFingerprint", "subscriptionId", "securityId", "securitySymbol", "provenanceJson", "occurredAt"
  ) VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 2 END,
    CASE WHEN TG_OP = 'INSERT' THEN 'GRANT' WHEN NEW.status = 'REVOKED' THEN 'REVOKE' ELSE 'INVALIDATE' END::"AssignmentMarketPolicyEnforcementAuthorizationAction",
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,
    CASE WHEN TG_OP = 'INSERT' THEN NEW."authorizedByUserId" WHEN NEW.status = 'REVOKED' THEN NEW."revokedByUserId" ELSE NEW."invalidatedByUserId" END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW."grantReason" WHEN NEW.status = 'REVOKED' THEN NEW."revocationReason" ELSE NEW."invalidationReasonCode" END,
    NEW."authorityVersion", NEW."enrollmentGenerationId", NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."strategyId", NEW."policyRevisionId", NEW."accountHolderUserId",
    NEW."configurationFingerprint", NEW."authorizationFingerprint", NEW."subscriptionId", NEW."securityId", NEW."securitySymbol",
    CASE WHEN TG_OP = 'UPDATE' AND NEW.status = 'INVALIDATED'
      THEN jsonb_build_object('source', NEW."invalidationSource", 'evidence', NEW."invalidationEvidenceJson")
      WHEN TG_OP = 'UPDATE' AND NEW.status = 'REVOKED'
      THEN jsonb_build_object('source', 'SYSTEM_OWNER_REVOCATION', 'consequence', 'EXPLICIT_RETURN_TO_NON_ENFORCED_BEHAVIOR')
      ELSE NULL END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW."authorizedAt" WHEN NEW.status = 'REVOKED' THEN NEW."revokedAt" ELSE NEW."invalidatedAt" END
  );
  -- Unexpected invalidation is operator-visible. A SystemEvent delivery failure is swallowed in its own
  -- subtransaction: the immutable authorization event above remains the authoritative audit record, and
  -- the trading gate never depends on SystemEvent delivery.
  IF TG_OP = 'UPDATE' AND NEW.status = 'INVALIDATED' THEN
    BEGIN
      INSERT INTO "SystemEvent" (type, "entityType", "entityId", message, "payloadJson", severity, "tradingAccountId", "actorUserId")
      VALUES (
        'MARKET_POLICY_ENFORCEMENT_AUTHORIZATION_INVALIDATED', 'AssignmentMarketPolicyEnforcementAuthorization', NEW.id::text,
        'PAPER market-policy enforcement authorization was automatically INVALIDATED; new entries for this assignment fail closed while runtime enforcement is active until reauthorization or an explicit SYSTEM_OWNER opt-out.',
        jsonb_build_object('authorizationId', NEW.id, 'accountSubscriptionId', NEW."accountSubscriptionId", 'enrollmentGenerationId', NEW."enrollmentGenerationId",
          'policyRevisionId', NEW."policyRevisionId", 'authorityVersion', NEW."authorityVersion", 'invalidationReasonCode', NEW."invalidationReasonCode",
          'invalidationSource', NEW."invalidationSource", 'invalidationEvidence', NEW."invalidationEvidenceJson", 'lapseSemantics', 'FAIL_CLOSED_UNTIL_REAUTHORIZED_OR_OWNER_OPT_OUT'),
        'WARNING', NEW."tradingAccountId", NEW."invalidatedByUserId");
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION "validate_assignment_enforcement_authorization_event"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Enforcement authorization events are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO a FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id = NEW."authorizationId";
  IF a.id IS NULL OR a.status <> NEW."toStatus" OR ROW(NEW."authorityVersion", NEW."enrollmentGenerationId", NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."strategyId", NEW."policyRevisionId", NEW."accountHolderUserId", NEW."configurationFingerprint", NEW."authorizationFingerprint", NEW."subscriptionId", NEW."securityId", NEW."securitySymbol")
     IS DISTINCT FROM ROW(a."authorityVersion", a."enrollmentGenerationId", a."tradingAccountId", a."accountSubscriptionId", a."strategyId", a."policyRevisionId", a."accountHolderUserId", a."configurationFingerprint", a."authorizationFingerprint", a."subscriptionId", a."securityId", a."securitySymbol") THEN
    RAISE EXCEPTION 'Enforcement authorization event must mirror the exact authorization state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION "invalidate_enforcement_authorization_on_enrollment_disable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = statement_timestamp(), "invalidatedByUserId" = NEW."disabledByUserId", "invalidationReasonCode" = 'ENROLLMENT_DISABLED',
         "invalidationSource" = 'ENROLLMENT_GENERATION_TRIGGER',
         "invalidationEvidenceJson" = jsonb_build_object('enrollmentGenerationId', NEW.id, 'disabledByUserId', NEW."disabledByUserId", 'disableReason', NEW."disableReason")
   WHERE "enrollmentGenerationId" = NEW.id AND status = 'AUTHORIZED';
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION "invalidate_enforcement_authorization_on_revision_retire"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = statement_timestamp(), "invalidationReasonCode" = 'POLICY_REVISION_SUPERSEDED',
         "invalidationSource" = 'POLICY_REVISION_TRIGGER',
         "invalidationEvidenceJson" = jsonb_build_object('policyRevisionId', NEW.id, 'fromStatus', OLD.status, 'toStatus', NEW.status)
   WHERE "policyRevisionId" = NEW.id AND status = 'AUTHORIZED';
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION "invalidate_enforcement_authorization_on_account_holder_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = statement_timestamp(), "invalidationReasonCode" = 'ACCOUNT_HOLDER_CHANGED',
         "invalidationSource" = 'ACCOUNT_HOLDER_TRIGGER',
         "invalidationEvidenceJson" = jsonb_build_object('tradingAccountId', NEW.id, 'fromAccountHolderUserId', OLD."accountHolderUserId", 'toAccountHolderUserId', NEW."accountHolderUserId")
   WHERE "tradingAccountId" = NEW.id AND status = 'AUTHORIZED' AND "accountHolderUserId" <> NEW."accountHolderUserId";
  RETURN NULL;
END $$;

-- The original assignment trigger was column-scoped ("UPDATE OF tradingAccountId, routingStrategyId"), so it
-- never fired when routing identity was re-derived by the BEFORE trigger or changed by an FK cascade.
-- Row-level AFTER triggers evaluate the final row image, covering direct UPDATE, BEFORE-trigger
-- derivation, and cascaded updates alike.
DROP TRIGGER "TradingAccountSubscription_invalidate_enforcement_authorization" ON "TradingAccountSubscription";

CREATE OR REPLACE FUNCTION "invalidate_enforcement_authorization_on_assignment_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = statement_timestamp(),
         "invalidationReasonCode" = CASE WHEN "tradingAccountId" <> NEW."tradingAccountId" OR "strategyId" <> NEW."routingStrategyId"
                                         THEN 'ASSIGNMENT_IDENTITY_CHANGED' ELSE 'ASSIGNMENT_SUBSCRIPTION_CHANGED' END,
         "invalidationSource" = 'ASSIGNMENT_TRIGGER',
         "invalidationEvidenceJson" = jsonb_build_object(
           'from', jsonb_build_object('tradingAccountId', OLD."tradingAccountId", 'routingStrategyId', OLD."routingStrategyId", 'subscriptionId', OLD."subscriptionId", 'routingSecurityId', OLD."routingSecurityId"),
           'to', jsonb_build_object('tradingAccountId', NEW."tradingAccountId", 'routingStrategyId', NEW."routingStrategyId", 'subscriptionId', NEW."subscriptionId", 'routingSecurityId', NEW."routingSecurityId"),
           'triggerDepth', pg_trigger_depth())
   WHERE "accountSubscriptionId" = NEW.id AND status = 'AUTHORIZED'
     AND ("tradingAccountId" <> NEW."tradingAccountId" OR "strategyId" <> NEW."routingStrategyId"
          OR "subscriptionId" IS DISTINCT FROM NEW."subscriptionId" OR "securityId" IS DISTINCT FROM NEW."routingSecurityId");
  RETURN NULL;
END $$;
CREATE TRIGGER "TradingAccountSubscription_invalidate_enforcement_authorization" AFTER UPDATE ON "TradingAccountSubscription" FOR EACH ROW
  WHEN (OLD."tradingAccountId" IS DISTINCT FROM NEW."tradingAccountId" OR OLD."routingStrategyId" IS DISTINCT FROM NEW."routingStrategyId"
        OR OLD."subscriptionId" IS DISTINCT FROM NEW."subscriptionId" OR OLD."routingSecurityId" IS DISTINCT FROM NEW."routingSecurityId")
  EXECUTE FUNCTION "invalidate_enforcement_authorization_on_assignment_change"();

CREATE FUNCTION "invalidate_enforcement_authorization_on_subscription_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = statement_timestamp(), "invalidationReasonCode" = 'SUBSCRIPTION_IDENTITY_CHANGED',
         "invalidationSource" = 'SUBSCRIPTION_TRIGGER',
         "invalidationEvidenceJson" = jsonb_build_object(
           'from', jsonb_build_object('subscriptionId', OLD.id, 'strategyId', OLD."strategyId", 'securityId', OLD."securityId", 'symbol', OLD.symbol),
           'to', jsonb_build_object('subscriptionId', NEW.id, 'strategyId', NEW."strategyId", 'securityId', NEW."securityId", 'symbol', NEW.symbol))
   WHERE "subscriptionId" = OLD.id AND status = 'AUTHORIZED';
  RETURN NULL;
END $$;
CREATE TRIGGER "Subscription_invalidate_enforcement_authorization" AFTER UPDATE ON "Subscription" FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD."strategyId" IS DISTINCT FROM NEW."strategyId"
        OR OLD."securityId" IS DISTINCT FROM NEW."securityId" OR OLD.symbol IS DISTINCT FROM NEW.symbol)
  EXECUTE FUNCTION "invalidate_enforcement_authorization_on_subscription_change"();

CREATE FUNCTION "invalidate_enforcement_authorization_on_security_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
     SET status = 'INVALIDATED', "invalidatedAt" = statement_timestamp(), "invalidationReasonCode" = 'SECURITY_IDENTITY_CHANGED',
         "invalidationSource" = 'SECURITY_TRIGGER',
         "invalidationEvidenceJson" = jsonb_build_object('from', jsonb_build_object('securityId', OLD.id, 'symbol', OLD.symbol), 'to', jsonb_build_object('securityId', NEW.id, 'symbol', NEW.symbol))
   WHERE "securityId" = OLD.id AND status = 'AUTHORIZED';
  RETURN NULL;
END $$;
CREATE TRIGGER "Security_invalidate_enforcement_authorization" AFTER UPDATE ON "Security" FOR EACH ROW
  WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.symbol IS DISTINCT FROM NEW.symbol)
  EXECUTE FUNCTION "invalidate_enforcement_authorization_on_security_change"();

-- V1 grants carry no Security binding. They never gain inferred Security-bound authority: an effective V1
-- grant is invalidated (with its immutable INVALIDATE event) and requires explicit reapproval or opt-out.
UPDATE "AssignmentMarketPolicyEnforcementAuthorization"
   SET status = 'INVALIDATED', "invalidatedAt" = statement_timestamp(), "invalidationReasonCode" = 'AUTHORITY_BINDING_REAPPROVAL_REQUIRED',
       "invalidationSource" = 'MIGRATION',
       "invalidationEvidenceJson" = jsonb_build_object('migration', '20261018150000_market_policy_pre_intent_enforcement', 'priorAuthorityVersion', "authorityVersion",
         'reason', 'The grant did not bind the exact tradable Subscription and canonical Security.')
 WHERE status = 'AUTHORIZED' AND "authorityVersion" = 'PAPER_MARKET_POLICY_ENFORCEMENT_V1';

-- ---------------------------------------------------------------------------------------------
-- 2. Explicit SYSTEM_OWNER resolution of an automatic invalidation (Hermes M3)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "AssignmentMarketPolicyEnforcementLapseResolution" (
  "id" SERIAL PRIMARY KEY,
  "authorizationId" INTEGER NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "accountSubscriptionId" INTEGER NOT NULL,
  "authorizationFingerprint" TEXT NOT NULL,
  "invalidationReasonCode" TEXT NOT NULL,
  "resolution" TEXT NOT NULL,
  "resolvedByUserId" INTEGER NOT NULL,
  "resolvedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL,
  CONSTRAINT "EnforcementLapseResolution_authorization_fkey" FOREIGN KEY ("authorizationId") REFERENCES "AssignmentMarketPolicyEnforcementAuthorization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementLapseResolution_resolver_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementLapseResolution_resolution_check" CHECK ("resolution" = 'RESTORE_NON_ENFORCED'),
  CONSTRAINT "EnforcementLapseResolution_reason_check" CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "EnforcementLapseResolution_authorization_key" ON "AssignmentMarketPolicyEnforcementLapseResolution" ("authorizationId");
CREATE INDEX "EnforcementLapseResolution_assignment_idx" ON "AssignmentMarketPolicyEnforcementLapseResolution" ("accountSubscriptionId");

CREATE FUNCTION "validate_enforcement_lapse_resolution"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE; actor_role "PlatformRole"; actor_enabled BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Enforcement lapse resolutions are immutable' USING ERRCODE = '23514'; END IF;
  -- FOR UPDATE conflicts with the FOR SHARE held by entry admission, so a resolution never commits mid-admission.
  SELECT * INTO a FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id = NEW."authorizationId" FOR UPDATE;
  IF a.id IS NULL OR a.status <> 'INVALIDATED' THEN RAISE EXCEPTION 'Only an automatically INVALIDATED enforcement authorization can be resolved' USING ERRCODE = '23514'; END IF;
  IF ROW(NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."authorizationFingerprint", NEW."invalidationReasonCode")
     IS DISTINCT FROM ROW(a."tradingAccountId", a."accountSubscriptionId", a."authorizationFingerprint", a."invalidationReasonCode") THEN
    RAISE EXCEPTION 'Enforcement lapse resolution must mirror the exact invalidated authorization' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "AssignmentMarketPolicyEnforcementAuthorization" later WHERE later."accountSubscriptionId" = a."accountSubscriptionId" AND later.id > a.id) THEN
    RAISE EXCEPTION 'Only the latest enforcement authorization of an assignment can be resolved' USING ERRCODE = '23514';
  END IF;
  SELECT "platformRole", enabled INTO actor_role, actor_enabled FROM "User" WHERE id = NEW."resolvedByUserId" FOR SHARE;
  IF actor_role IS DISTINCT FROM 'SYSTEM_OWNER' OR actor_enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'Enforcement lapse resolution requires an enabled SYSTEM_OWNER' USING ERRCODE = '23514'; END IF;
  NEW."resolvedAt" := statement_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER "EnforcementLapseResolution_validate" BEFORE INSERT OR UPDATE OR DELETE ON "AssignmentMarketPolicyEnforcementLapseResolution" FOR EACH ROW EXECUTE FUNCTION "validate_enforcement_lapse_resolution"();

-- ---------------------------------------------------------------------------------------------
-- 3. Default-disabled, PAPER-only runtime rollout
-- ---------------------------------------------------------------------------------------------

CREATE TYPE "MarketPolicyEnforcementRolloutAction" AS ENUM ('ACTIVATE', 'DEACTIVATE');

CREATE TABLE "MarketPolicyEnforcementRuntimeRollout" (
  "id" INTEGER PRIMARY KEY,
  "environment" "TradingAccountEnvironment" NOT NULL DEFAULT 'PAPER',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 0,
  "changedByUserId" INTEGER,
  "changedAt" TIMESTAMPTZ(3),
  "changeReason" TEXT,
  "deployedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketPolicyEnforcementRuntimeRollout_changedBy_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MarketPolicyEnforcementRuntimeRollout_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "MarketPolicyEnforcementRuntimeRollout_paper_only_check" CHECK ("environment" = 'PAPER'),
  CONSTRAINT "MarketPolicyEnforcementRuntimeRollout_lifecycle_check" CHECK (
    ("version" = 0 AND "enabled" = false AND "changedByUserId" IS NULL AND "changedAt" IS NULL AND "changeReason" IS NULL)
    OR ("version" > 0 AND "changedByUserId" IS NOT NULL AND "changedAt" IS NOT NULL
      AND "changeReason" IS NOT NULL AND char_length(btrim("changeReason")) BETWEEN 1 AND 500)
  )
);

CREATE TABLE "MarketPolicyEnforcementRuntimeRolloutEvent" (
  "id" SERIAL PRIMARY KEY,
  "rolloutId" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "action" "MarketPolicyEnforcementRolloutAction" NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "environment" "TradingAccountEnvironment" NOT NULL,
  "actorUserId" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketPolicyEnforcementRolloutEvent_rollout_fkey" FOREIGN KEY ("rolloutId") REFERENCES "MarketPolicyEnforcementRuntimeRollout"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MarketPolicyEnforcementRolloutEvent_actor_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MarketPolicyEnforcementRolloutEvent_shape_check" CHECK (
    "version" > 0 AND "environment" = 'PAPER'
    AND (("action" = 'ACTIVATE' AND "enabled") OR ("action" = 'DEACTIVATE' AND NOT "enabled"))
  )
);
CREATE UNIQUE INDEX "MarketPolicyEnforcementRolloutEvent_version_key" ON "MarketPolicyEnforcementRuntimeRolloutEvent" ("version");

CREATE FUNCTION "validate_market_policy_enforcement_rollout"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_role "PlatformRole"; actor_enabled BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'The market-policy enforcement rollout cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.enabled OR NEW.version <> 0 THEN RAISE EXCEPTION 'The market-policy enforcement rollout is created disabled' USING ERRCODE = '23514'; END IF;
    NEW."deployedAt" := statement_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.environment <> OLD.environment OR NEW."deployedAt" <> OLD."deployedAt" THEN
    RAISE EXCEPTION 'Market-policy enforcement rollout identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.enabled = OLD.enabled THEN
    RAISE EXCEPTION 'Market-policy enforcement rollout changes must toggle state and advance the version by one' USING ERRCODE = '23514';
  END IF;
  SELECT "platformRole", enabled INTO actor_role, actor_enabled FROM "User" WHERE id = NEW."changedByUserId" FOR SHARE;
  IF actor_role IS DISTINCT FROM 'SYSTEM_OWNER' OR actor_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Market-policy enforcement rollout changes require an enabled SYSTEM_OWNER' USING ERRCODE = '23514';
  END IF;
  NEW."changedAt" := statement_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER "MarketPolicyEnforcementRuntimeRollout_validate" BEFORE INSERT OR UPDATE OR DELETE ON "MarketPolicyEnforcementRuntimeRollout" FOR EACH ROW EXECUTE FUNCTION "validate_market_policy_enforcement_rollout"();

CREATE FUNCTION "record_market_policy_enforcement_rollout_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "MarketPolicyEnforcementRuntimeRolloutEvent" ("rolloutId", "version", "action", "enabled", "environment", "actorUserId", "reason", "occurredAt")
  VALUES (NEW.id, NEW.version, CASE WHEN NEW.enabled THEN 'ACTIVATE' ELSE 'DEACTIVATE' END::"MarketPolicyEnforcementRolloutAction",
          NEW.enabled, NEW.environment, NEW."changedByUserId", NEW."changeReason", NEW."changedAt");
  RETURN NULL;
END $$;
CREATE TRIGGER "MarketPolicyEnforcementRuntimeRollout_record_event" AFTER UPDATE ON "MarketPolicyEnforcementRuntimeRollout" FOR EACH ROW EXECUTE FUNCTION "record_market_policy_enforcement_rollout_event"();

CREATE FUNCTION "validate_market_policy_enforcement_rollout_event"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "MarketPolicyEnforcementRuntimeRollout"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Market-policy enforcement rollout events are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO r FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id = NEW."rolloutId";
  IF r.id IS NULL OR ROW(r.version, r.enabled, r.environment, r."changedByUserId", r."changeReason", r."changedAt")
     IS DISTINCT FROM ROW(NEW.version, NEW.enabled, NEW.environment, NEW."actorUserId", NEW.reason, NEW."occurredAt") THEN
    RAISE EXCEPTION 'Market-policy enforcement rollout event must mirror the exact rollout change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "MarketPolicyEnforcementRolloutEvent_validate" BEFORE INSERT OR UPDATE OR DELETE ON "MarketPolicyEnforcementRuntimeRolloutEvent" FOR EACH ROW EXECUTE FUNCTION "validate_market_policy_enforcement_rollout_event"();

INSERT INTO "MarketPolicyEnforcementRuntimeRollout" ("id") VALUES (1);

-- ---------------------------------------------------------------------------------------------
-- 4. Immutable authoritative pre-intent admission attempts and gates
-- ---------------------------------------------------------------------------------------------

CREATE TYPE "MarketPolicyEnforcementAdmissionOutcome" AS ENUM (
  'ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE', 'AUTHORIZATION_LAPSED', 'AUTHORIZATION_INEFFECTIVE', 'TECHNICAL_FAILURE'
);

CREATE TABLE "MarketPolicyEnforcementAdmissionAttempt" (
  "id" SERIAL PRIMARY KEY,
  "attemptKey" TEXT NOT NULL,
  "admissionVersion" TEXT NOT NULL,
  "authority" TEXT NOT NULL DEFAULT 'AUTHORITATIVE',
  "requestSource" TEXT NOT NULL,
  "ownerKey" TEXT NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "environment" "TradingAccountEnvironment" NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "accountSubscriptionId" INTEGER NOT NULL,
  "subscriptionId" INTEGER,
  "securityId" INTEGER,
  "securitySymbol" TEXT,
  "strategyId" INTEGER,
  "policyRevisionId" INTEGER,
  "enrollmentGenerationId" INTEGER,
  "authorizationId" INTEGER,
  "authorizationFingerprint" TEXT,
  "authorityVersion" TEXT,
  "enforcementDisposition" TEXT NOT NULL,
  "marketRegimeAssessmentId" INTEGER,
  "compositionVersion" TEXT,
  "compositionSourceSetFingerprint" TEXT,
  "compositionEvidenceHealth" "MarketRegimeCompositionEvidenceHealth",
  "evaluatorVersion" TEXT,
  "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
  "validUntil" TIMESTAMPTZ(3),
  "outcome" "MarketPolicyEnforcementAdmissionOutcome" NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "rolloutVersion" INTEGER NOT NULL,
  "orderIntentId" INTEGER,
  "orderIntentCreated" BOOLEAN NOT NULL,
  "admissionResultCode" TEXT NOT NULL,
  "technicalDiagnostic" TEXT,
  "evidenceJson" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnforcementAdmissionAttempt_account_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionAttempt_assignment_fkey" FOREIGN KEY ("accountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionAttempt_security_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionAttempt_revision_fkey" FOREIGN KEY ("policyRevisionId") REFERENCES "StrategyMarketPolicyRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionAttempt_generation_fkey" FOREIGN KEY ("enrollmentGenerationId") REFERENCES "AssignmentMarketPolicyEnrollmentGeneration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionAttempt_authorization_fkey" FOREIGN KEY ("authorizationId") REFERENCES "AssignmentMarketPolicyEnforcementAuthorization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionAttempt_composition_fkey" FOREIGN KEY ("marketRegimeAssessmentId") REFERENCES "MarketRegimeAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionAttempt_orderIntent_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionAttempt_rollout_fkey" FOREIGN KEY ("rolloutVersion") REFERENCES "MarketPolicyEnforcementRuntimeRolloutEvent"("version") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionAttempt_version_check" CHECK ("admissionVersion" = 'MARKET_POLICY_PRE_INTENT_ENFORCEMENT_V1' AND "authority" = 'AUTHORITATIVE'),
  CONSTRAINT "EnforcementAdmissionAttempt_paper_only_check" CHECK ("environment" = 'PAPER'),
  CONSTRAINT "EnforcementAdmissionAttempt_source_check" CHECK ("requestSource" IN ('api', 'live_entry_acceptance')),
  CONSTRAINT "EnforcementAdmissionAttempt_disposition_check" CHECK ("enforcementDisposition" IN ('ENFORCED', 'LAPSED', 'AUTHORIZATION_INEFFECTIVE', 'UNKNOWN')),
  CONSTRAINT "EnforcementAdmissionAttempt_intent_check" CHECK (
    "orderIntentCreated" = ("orderIntentId" IS NOT NULL)
    AND (NOT "orderIntentCreated" OR ("outcome" = 'ALLOWED' AND "admissionResultCode" = 'ORDER_INTENT_CREATED'))
    AND ("orderIntentCreated" OR "admissionResultCode" <> 'ORDER_INTENT_CREATED')
  ),
  CONSTRAINT "EnforcementAdmissionAttempt_outcome_check" CHECK (
    ("outcome" IN ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE')
      AND "enforcementDisposition" = 'ENFORCED' AND "technicalDiagnostic" IS NULL
      AND "subscriptionId" IS NOT NULL AND "securityId" IS NOT NULL AND "securitySymbol" IS NOT NULL
      AND "strategyId" IS NOT NULL AND "policyRevisionId" IS NOT NULL AND "enrollmentGenerationId" IS NOT NULL
      AND "authorizationId" IS NOT NULL AND "authorizationFingerprint" IS NOT NULL
      AND "authorityVersion" = 'PAPER_MARKET_POLICY_ENFORCEMENT_V2' AND "evaluatorVersion" = 'STRATEGY_MARKET_ELIGIBILITY_V1'
      AND ("outcome" <> 'ALLOWED' OR ("marketRegimeAssessmentId" IS NOT NULL AND "compositionSourceSetFingerprint" IS NOT NULL
        AND "validUntil" IS NOT NULL AND "validUntil" > "evaluatedAt")))
    OR ("outcome" = 'AUTHORIZATION_LAPSED' AND "enforcementDisposition" = 'LAPSED' AND "authorizationId" IS NOT NULL
      AND "technicalDiagnostic" IS NULL AND "marketRegimeAssessmentId" IS NULL)
    OR ("outcome" = 'AUTHORIZATION_INEFFECTIVE' AND "enforcementDisposition" = 'AUTHORIZATION_INEFFECTIVE' AND "authorizationId" IS NOT NULL
      AND "technicalDiagnostic" IS NULL AND "marketRegimeAssessmentId" IS NULL)
    OR ("outcome" = 'TECHNICAL_FAILURE' AND "technicalDiagnostic" IS NOT NULL AND char_length("technicalDiagnostic") BETWEEN 1 AND 500)
  ),
  CONSTRAINT "EnforcementAdmissionAttempt_composition_check" CHECK (
    ("marketRegimeAssessmentId" IS NULL AND "compositionSourceSetFingerprint" IS NULL AND "compositionVersion" IS NULL AND "compositionEvidenceHealth" IS NULL)
    OR ("marketRegimeAssessmentId" IS NOT NULL AND "compositionSourceSetFingerprint" IS NOT NULL
      AND "compositionVersion" = 'MARKET_REGIME_COMPOSITION_V1' AND "compositionEvidenceHealth" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "EnforcementAdmissionAttempt_attemptKey_key" ON "MarketPolicyEnforcementAdmissionAttempt" ("attemptKey");
CREATE UNIQUE INDEX "EnforcementAdmissionAttempt_orderIntentId_key" ON "MarketPolicyEnforcementAdmissionAttempt" ("orderIntentId");
CREATE INDEX "EnforcementAdmissionAttempt_assignment_idx" ON "MarketPolicyEnforcementAdmissionAttempt" ("accountSubscriptionId", "id");
CREATE INDEX "EnforcementAdmissionAttempt_account_idx" ON "MarketPolicyEnforcementAdmissionAttempt" ("tradingAccountId", "createdAt");
CREATE INDEX "EnforcementAdmissionAttempt_authorization_idx" ON "MarketPolicyEnforcementAdmissionAttempt" ("authorizationId");
CREATE INDEX "EnforcementAdmissionAttempt_owner_idx" ON "MarketPolicyEnforcementAdmissionAttempt" ("ownerKey");

CREATE TABLE "MarketPolicyEnforcementAdmissionGate" (
  "id" SERIAL PRIMARY KEY,
  "attemptId" INTEGER NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "dimension" "MarketRegimeDimension" NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "requirement" "StrategyMarketPolicyDimensionRequirement" NOT NULL,
  "outcome" "StrategyMarketEligibilityGateOutcome" NOT NULL,
  "observedState" TEXT,
  "sourceHealth" "MarketRegimeCompositionSourceHealth",
  "sourceAssessmentId" INTEGER,
  "sourceValidUntil" TIMESTAMPTZ(3),
  "allowedStatesJson" JSONB NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnforcementAdmissionGate_attempt_fkey" FOREIGN KEY ("attemptId") REFERENCES "MarketPolicyEnforcementAdmissionAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionGate_source_identity_fk" FOREIGN KEY ("sourceAssessmentId", "dimension", "algorithmVersion") REFERENCES "MarketRegimeDimensionAssessment"("id", "dimension", "algorithmVersion") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementAdmissionGate_ordinal_check" CHECK ("ordinal" BETWEEN 1 AND 5),
  CONSTRAINT "EnforcementAdmissionGate_requirement_check" CHECK (("requirement" = 'IGNORED') = ("outcome" = 'IGNORED'))
);
CREATE UNIQUE INDEX "EnforcementAdmissionGate_attempt_dimension_key" ON "MarketPolicyEnforcementAdmissionGate" ("attemptId", "dimension");
CREATE UNIQUE INDEX "EnforcementAdmissionGate_attempt_ordinal_key" ON "MarketPolicyEnforcementAdmissionGate" ("attemptId", "ordinal");
CREATE INDEX "EnforcementAdmissionGate_source_idx" ON "MarketPolicyEnforcementAdmissionGate" ("sourceAssessmentId", "dimension", "algorithmVersion");

CREATE FUNCTION "validate_market_policy_enforcement_admission_attempt"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rollout "MarketPolicyEnforcementRuntimeRollout"%ROWTYPE;
  a "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
  tas "TradingAccountSubscription"%ROWTYPE;
  m "MarketRegimeAssessment"%ROWTYPE;
  oi "OrderIntent"%ROWTYPE;
  account_environment "TradingAccountEnvironment";
  generation_status "AssignmentMarketPolicyEnrollmentStatus";
  revision_status "StrategyMarketPolicyRevisionStatus";
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Market-policy enforcement admission attempts are immutable' USING ERRCODE = '23514'; END IF;
  SELECT environment INTO account_environment FROM "TradingAccount" WHERE id = NEW."tradingAccountId";
  IF account_environment IS DISTINCT FROM 'PAPER' THEN RAISE EXCEPTION 'Market-policy enforcement admission is PAPER-only' USING ERRCODE = '23514'; END IF;
  IF NEW.outcome = 'TECHNICAL_FAILURE' THEN
    -- A technical failure is recorded after its admission transaction rolled back; PostgreSQL stamps it.
    NEW."evaluatedAt" := statement_timestamp();
    NEW."createdAt" := NEW."evaluatedAt";
    RETURN NEW;
  END IF;
  SELECT * INTO rollout FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id = 1 FOR SHARE;
  IF rollout.id IS NULL OR NOT rollout.enabled OR rollout.version <> NEW."rolloutVersion" THEN
    RAISE EXCEPTION 'Authoritative market-policy admission requires the exact active runtime rollout version' USING ERRCODE = '23514';
  END IF;
  IF NEW."evaluatedAt" > clock_timestamp() OR NEW."evaluatedAt" < clock_timestamp() - interval '60 seconds' THEN
    RAISE EXCEPTION 'Admission evaluation time must be current PostgreSQL time' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO a FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id = NEW."authorizationId" FOR SHARE;
  IF a.id IS NULL OR ROW(a."tradingAccountId", a."accountSubscriptionId", a."authorizationFingerprint", a."authorityVersion")
     IS DISTINCT FROM ROW(NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."authorizationFingerprint", NEW."authorityVersion") THEN
    RAISE EXCEPTION 'Admission attempt must mirror its exact enforcement authorization' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "AssignmentMarketPolicyEnforcementAuthorization" later WHERE later."accountSubscriptionId" = a."accountSubscriptionId" AND later.id > a.id) THEN
    RAISE EXCEPTION 'Admission attempt must reference the latest enforcement authorization of its assignment' USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome = 'AUTHORIZATION_LAPSED' THEN
    IF a.status <> 'INVALIDATED' OR EXISTS (SELECT 1 FROM "AssignmentMarketPolicyEnforcementLapseResolution" r WHERE r."authorizationId" = a.id) THEN
      RAISE EXCEPTION 'A lapsed admission requires an unresolved INVALIDATED authorization' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF a.status <> 'AUTHORIZED' THEN RAISE EXCEPTION 'Enforced admission requires an AUTHORIZED enforcement authorization' USING ERRCODE = '23514'; END IF;
  IF NEW.outcome = 'AUTHORIZATION_INEFFECTIVE' THEN RETURN NEW; END IF;

  -- ENFORCED outcomes: PostgreSQL independently rechecks the exact bound identity at decision time.
  SELECT * INTO tas FROM "TradingAccountSubscription" WHERE id = NEW."accountSubscriptionId";
  SELECT status INTO generation_status FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id = a."enrollmentGenerationId";
  SELECT status INTO revision_status FROM "StrategyMarketPolicyRevision" WHERE id = a."policyRevisionId";
  IF ROW(NEW."subscriptionId", NEW."securityId", NEW."securitySymbol", NEW."strategyId", NEW."policyRevisionId", NEW."enrollmentGenerationId")
     IS DISTINCT FROM ROW(a."subscriptionId", a."securityId", a."securitySymbol", a."strategyId", a."policyRevisionId", a."enrollmentGenerationId")
     OR ROW(tas."tradingAccountId", tas."subscriptionId", tas."routingSecurityId", tas."routingStrategyId")
     IS DISTINCT FROM ROW(a."tradingAccountId", a."subscriptionId", a."securityId", a."strategyId")
     OR generation_status IS DISTINCT FROM 'ACTIVE' OR revision_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'Enforced admission identity must equal the exact current authorization binding' USING ERRCODE = '23514';
  END IF;
  IF NEW."marketRegimeAssessmentId" IS NOT NULL THEN
    SELECT * INTO m FROM "MarketRegimeAssessment" WHERE id = NEW."marketRegimeAssessmentId";
    IF m."compositionVersion" <> NEW."compositionVersion" OR m."sourceSetFingerprint" <> NEW."compositionSourceSetFingerprint"
       OR m."evidenceHealth" <> NEW."compositionEvidenceHealth" OR m."publicationStatus" <> 'SUCCEEDED' OR m."observedAt" > NEW."evaluatedAt" THEN
      RAISE EXCEPTION 'Admission composition evidence must mirror a committed composition observed before evaluation' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.outcome = 'ALLOWED' AND NEW."validUntil" <= clock_timestamp() THEN
    RAISE EXCEPTION 'ALLOWED admission evidence expired before it was frozen' USING ERRCODE = '23514';
  END IF;
  IF NEW."orderIntentId" IS NOT NULL THEN
    SELECT * INTO oi FROM "OrderIntent" WHERE id = NEW."orderIntentId";
    IF NEW."evaluatedAt" < transaction_timestamp() OR oi.id IS NULL
       OR ROW(oi."tradingAccountId", oi."tradingAccountSubscriptionId", upper(btrim(oi.symbol)), lower(btrim(oi.side)), oi."clientOrderId")
       IS DISTINCT FROM ROW(NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."securitySymbol", 'buy', NEW."clientOrderId") THEN
      RAISE EXCEPTION 'An admitted attempt must be evaluated in, and match, the exact OrderIntent admission transaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EnforcementAdmissionAttempt_validate" BEFORE INSERT OR UPDATE OR DELETE ON "MarketPolicyEnforcementAdmissionAttempt" FOR EACH ROW EXECUTE FUNCTION "validate_market_policy_enforcement_admission_attempt"();

CREATE FUNCTION "validate_market_policy_enforcement_admission_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt "MarketPolicyEnforcementAdmissionAttempt"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Market-policy enforcement admission gates are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO attempt FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE id = NEW."attemptId";
  IF attempt.id IS NULL OR attempt.outcome NOT IN ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE') OR attempt."marketRegimeAssessmentId" IS NULL THEN
    RAISE EXCEPTION 'Admission gates belong only to an evaluated enforced attempt with composition evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EnforcementAdmissionGate_validate" BEFORE INSERT OR UPDATE OR DELETE ON "MarketPolicyEnforcementAdmissionGate" FOR EACH ROW EXECUTE FUNCTION "validate_market_policy_enforcement_admission_gate"();

-- Commit-time check of the five-dimension REQUIRED/IGNORED contract. An ALLOWED attempt is accepted only if
-- every REQUIRED dimension of the exact bound revision passed on AVAILABLE, VALID, unexpired composition
-- evidence with an allowed effective state, and its validity boundary is the earliest required expiration.
CREATE FUNCTION "verify_market_policy_enforcement_admission_attempt"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt "MarketPolicyEnforcementAdmissionAttempt"%ROWTYPE; gate_count INTEGER; required_until TIMESTAMPTZ;
BEGIN
  SELECT * INTO attempt FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE id = NEW.id;
  SELECT count(*) INTO gate_count FROM "MarketPolicyEnforcementAdmissionGate" WHERE "attemptId" = attempt.id;
  IF attempt.outcome IN ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE') AND attempt."marketRegimeAssessmentId" IS NOT NULL AND gate_count <> 5 THEN
    RAISE EXCEPTION 'An evaluated enforced admission attempt requires exactly five dimension gates' USING ERRCODE = '23514';
  END IF;
  IF attempt.outcome = 'ALLOWED' THEN
    IF NOT EXISTS (SELECT 1 FROM "StrategyMarketPolicyDimensionRule" r WHERE r."revisionId" = attempt."policyRevisionId" AND r.requirement = 'REQUIRED') THEN
      RAISE EXCEPTION 'ALLOWED admission requires at least one REQUIRED dimension' USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM "StrategyMarketPolicyDimensionRule" r WHERE r."revisionId" = attempt."policyRevisionId") <> 5 OR EXISTS (
      SELECT 1 FROM "StrategyMarketPolicyDimensionRule" r
      LEFT JOIN "MarketPolicyEnforcementAdmissionGate" g ON g."attemptId" = attempt.id AND g.dimension = r.dimension
      LEFT JOIN "MarketRegimeAssessmentSource" s ON s."marketRegimeAssessmentId" = attempt."marketRegimeAssessmentId" AND s.dimension = r.dimension
      WHERE r."revisionId" = attempt."policyRevisionId" AND (
        g.id IS NULL OR g.requirement <> r.requirement OR g."algorithmVersion" <> r."algorithmVersion"
        OR (r.requirement = 'REQUIRED' AND (
          g.outcome <> 'PASS' OR s.id IS NULL OR s.health <> 'AVAILABLE' OR s."sourceStatus" IS DISTINCT FROM 'VALID'
          OR s."requiredAlgorithmVersion" <> r."algorithmVersion"
          OR s."sourceAssessmentId" IS NULL OR s."sourceAssessmentId" IS DISTINCT FROM g."sourceAssessmentId"
          OR s."sourceEffectiveState" IS NULL OR s."sourceEffectiveState" IS DISTINCT FROM g."observedState"
          OR s."sourceValidUntil" IS NULL OR s."sourceValidUntil" <= attempt."evaluatedAt"
          OR NOT EXISTS (SELECT 1 FROM "StrategyMarketPolicyAllowedState" st WHERE st."ruleId" = r.id AND st.state = g."observedState")))
      )
    ) THEN
      RAISE EXCEPTION 'ALLOWED admission violates the bound five-dimension REQUIRED/IGNORED contract' USING ERRCODE = '23514';
    END IF;
    SELECT min(s."sourceValidUntil") INTO required_until FROM "StrategyMarketPolicyDimensionRule" r
      JOIN "MarketRegimeAssessmentSource" s ON s."marketRegimeAssessmentId" = attempt."marketRegimeAssessmentId" AND s.dimension = r.dimension
      WHERE r."revisionId" = attempt."policyRevisionId" AND r.requirement = 'REQUIRED';
    IF attempt."validUntil" IS DISTINCT FROM required_until THEN
      RAISE EXCEPTION 'ALLOWED admission validity must equal the earliest required source expiration' USING ERRCODE = '23514';
    END IF;
    IF attempt."orderIntentCreated" AND NOT EXISTS (
      SELECT 1 FROM "OrderIntentMarketPolicyEnforcementObligation" o WHERE o."admissionAttemptId" = attempt.id AND o."orderIntentId" = attempt."orderIntentId"
    ) THEN
      RAISE EXCEPTION 'An admitted attempt must freeze its OrderIntent obligation in the same transaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "EnforcementAdmissionAttempt_verify" AFTER INSERT ON "MarketPolicyEnforcementAdmissionAttempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_market_policy_enforcement_admission_attempt"();

-- ---------------------------------------------------------------------------------------------
-- 5. Frozen per-intent enforcement obligation (consumed by Phase 3C.3 broker-time enforcement)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "OrderIntentMarketPolicyEnforcementObligation" (
  "id" SERIAL PRIMARY KEY,
  "orderIntentId" INTEGER NOT NULL,
  "admissionAttemptId" INTEGER NOT NULL,
  "obligationVersion" TEXT NOT NULL,
  "environment" "TradingAccountEnvironment" NOT NULL,
  "tradingAccountId" INTEGER NOT NULL,
  "accountSubscriptionId" INTEGER NOT NULL,
  "subscriptionId" INTEGER NOT NULL,
  "securityId" INTEGER NOT NULL,
  "securitySymbol" TEXT NOT NULL,
  "strategyId" INTEGER NOT NULL,
  "policyRevisionId" INTEGER NOT NULL,
  "enrollmentGenerationId" INTEGER NOT NULL,
  "authorizationId" INTEGER NOT NULL,
  "authorizationFingerprint" TEXT NOT NULL,
  "authorityVersion" TEXT NOT NULL,
  "admissionVersion" TEXT NOT NULL,
  "evaluatorVersion" TEXT NOT NULL,
  "marketRegimeAssessmentId" INTEGER NOT NULL,
  "compositionSourceSetFingerprint" TEXT NOT NULL,
  "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
  "validUntil" TIMESTAMPTZ(3) NOT NULL,
  "rolloutVersion" INTEGER NOT NULL,
  "frozenContextJson" JSONB NOT NULL,
  "frozenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnforcementObligation_orderIntent_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementObligation_attempt_fkey" FOREIGN KEY ("admissionAttemptId") REFERENCES "MarketPolicyEnforcementAdmissionAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementObligation_authorization_fkey" FOREIGN KEY ("authorizationId") REFERENCES "AssignmentMarketPolicyEnforcementAuthorization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EnforcementObligation_version_check" CHECK ("obligationVersion" = 'MARKET_POLICY_ENTRY_OBLIGATION_V1' AND "environment" = 'PAPER')
);
CREATE UNIQUE INDEX "EnforcementObligation_orderIntentId_key" ON "OrderIntentMarketPolicyEnforcementObligation" ("orderIntentId");
CREATE UNIQUE INDEX "EnforcementObligation_admissionAttemptId_key" ON "OrderIntentMarketPolicyEnforcementObligation" ("admissionAttemptId");
CREATE INDEX "EnforcementObligation_authorization_idx" ON "OrderIntentMarketPolicyEnforcementObligation" ("authorizationId");

CREATE FUNCTION "validate_order_intent_market_policy_enforcement_obligation"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt "MarketPolicyEnforcementAdmissionAttempt"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Frozen market-policy enforcement obligations are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO attempt FROM "MarketPolicyEnforcementAdmissionAttempt" WHERE id = NEW."admissionAttemptId";
  IF attempt.id IS NULL OR attempt.outcome <> 'ALLOWED' OR NOT attempt."orderIntentCreated"
     OR ROW(NEW."orderIntentId", NEW.environment, NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."subscriptionId", NEW."securityId", NEW."securitySymbol",
            NEW."strategyId", NEW."policyRevisionId", NEW."enrollmentGenerationId", NEW."authorizationId", NEW."authorizationFingerprint", NEW."authorityVersion",
            NEW."admissionVersion", NEW."evaluatorVersion", NEW."marketRegimeAssessmentId", NEW."compositionSourceSetFingerprint", NEW."evaluatedAt", NEW."validUntil", NEW."rolloutVersion")
     IS DISTINCT FROM ROW(attempt."orderIntentId", attempt.environment, attempt."tradingAccountId", attempt."accountSubscriptionId", attempt."subscriptionId", attempt."securityId", attempt."securitySymbol",
            attempt."strategyId", attempt."policyRevisionId", attempt."enrollmentGenerationId", attempt."authorizationId", attempt."authorizationFingerprint", attempt."authorityVersion",
            attempt."admissionVersion", attempt."evaluatorVersion", attempt."marketRegimeAssessmentId", attempt."compositionSourceSetFingerprint", attempt."evaluatedAt", attempt."validUntil", attempt."rolloutVersion") THEN
    RAISE EXCEPTION 'A frozen obligation must mirror its exact ALLOWED admission attempt' USING ERRCODE = '23514';
  END IF;
  NEW."frozenAt" := statement_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER "EnforcementObligation_validate" BEFORE INSERT OR UPDATE OR DELETE ON "OrderIntentMarketPolicyEnforcementObligation" FOR EACH ROW EXECUTE FUNCTION "validate_order_intent_market_policy_enforcement_obligation"();

CREATE FUNCTION "verify_order_intent_market_policy_enforcement_obligation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "EntryExposureClaim" c WHERE c."orderIntentId" = NEW."orderIntentId") THEN
    RAISE EXCEPTION 'A frozen obligation must be created atomically with its EntryExposureClaim' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "EnforcementObligation_verify" AFTER INSERT ON "OrderIntentMarketPolicyEnforcementObligation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_order_intent_market_policy_enforcement_obligation"();

-- Database backstop: while the PAPER rollout is active, no BUY OrderIntent for an enforced assignment can
-- commit without an ALLOWED frozen obligation bound to the assignment's current authorization, and no BUY
-- OrderIntent for a lapsed (unresolved INVALIDATED) assignment can commit at all. Never-authorized,
-- REVOKED, owner-resolved, LIVE, and rollout-inactive intents are unaffected.
CREATE FUNCTION "require_order_intent_market_policy_enforcement_obligation"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rollout_enabled BOOLEAN; account_environment "TradingAccountEnvironment"; latest "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
BEGIN
  IF NEW."tradingAccountSubscriptionId" IS NULL OR lower(btrim(NEW.side)) <> 'buy' THEN RETURN NULL; END IF;
  SELECT enabled INTO rollout_enabled FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id = 1;
  IF NOT COALESCE(rollout_enabled, false) THEN RETURN NULL; END IF;
  SELECT environment INTO account_environment FROM "TradingAccount" WHERE id = NEW."tradingAccountId";
  IF account_environment IS DISTINCT FROM 'PAPER' THEN RETURN NULL; END IF;
  SELECT * INTO latest FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId" = NEW."tradingAccountSubscriptionId" ORDER BY id DESC LIMIT 1;
  IF latest.id IS NULL OR latest.status = 'REVOKED' THEN RETURN NULL; END IF;
  IF latest.status = 'INVALIDATED' AND EXISTS (SELECT 1 FROM "AssignmentMarketPolicyEnforcementLapseResolution" r WHERE r."authorizationId" = latest.id) THEN RETURN NULL; END IF;
  IF latest.status = 'INVALIDATED' OR NOT EXISTS (
    SELECT 1 FROM "OrderIntentMarketPolicyEnforcementObligation" o WHERE o."orderIntentId" = NEW.id AND o."authorizationId" = latest.id
  ) THEN
    RAISE EXCEPTION 'Market-policy enforced BUY OrderIntent % requires an ALLOWED frozen enforcement obligation', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "OrderIntent_require_market_policy_enforcement_obligation" AFTER INSERT ON "OrderIntent"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "require_order_intent_market_policy_enforcement_obligation"();
