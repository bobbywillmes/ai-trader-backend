-- Phase 3C.3: authoritative broker-time market-policy enforcement for PAPER BUY entries.
--
-- This migration is additive. It creates no decisions and changes no outcome for intents without a
-- frozen Phase 3C.2 obligation unless the PAPER runtime rollout is active (legacy queued-intent
-- quarantine). A frozen obligation is consumed at broker time regardless of the rollout: the
-- rollout governs future admission, not the delivery of an earlier enforced obligation.
--
-- It also carries three targeted Phase 3C.2 corrections (Hermes L1, L2, L3).

-- ---------------------------------------------------------------------------------------------
-- 1. Phase 3C.2 follow-up corrections
-- ---------------------------------------------------------------------------------------------

-- L2: evaluatedAt is truncated to milliseconds, transaction_timestamp() is not. Compare at the same
-- precision so a very fast admission transaction is never rejected as a spurious technical failure.
-- Shared by admission attempts and broker-time decisions.
CREATE FUNCTION "market_policy_evaluated_in_current_transaction"(evaluated_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
  SELECT evaluated_at >= date_trunc('milliseconds', transaction_timestamp()) AND evaluated_at <= clock_timestamp()
$$;

CREATE OR REPLACE FUNCTION "validate_market_policy_enforcement_admission_attempt"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NOT "market_policy_evaluated_in_current_transaction"(NEW."evaluatedAt") OR oi.id IS NULL
       OR ROW(oi."tradingAccountId", oi."tradingAccountSubscriptionId", upper(btrim(oi.symbol)), lower(btrim(oi.side)), oi."clientOrderId")
       IS DISTINCT FROM ROW(NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."securitySymbol", 'buy', NEW."clientOrderId") THEN
      RAISE EXCEPTION 'An admitted attempt must be evaluated in, and match, the exact OrderIntent admission transaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- L1: an admitted ALLOWED attempt must still be unexpired when its transaction commits, not only when
-- the attempt row was inserted. ALLOWED-but-not-admitted evidence (orderIntentCreated = false) is
-- recorded after the fact and is never executable, so it is not held to commit-time freshness.
CREATE OR REPLACE FUNCTION "verify_market_policy_enforcement_admission_attempt"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF attempt."orderIntentCreated" AND attempt."validUntil" <= clock_timestamp() THEN
      RAISE EXCEPTION 'ALLOWED admission evidence expired before its OrderIntent committed' USING ERRCODE = '23514';
    END IF;
    IF attempt."orderIntentCreated" AND NOT EXISTS (
      SELECT 1 FROM "OrderIntentMarketPolicyEnforcementObligation" o WHERE o."admissionAttemptId" = attempt.id AND o."orderIntentId" = attempt."orderIntentId"
    ) THEN
      RAISE EXCEPTION 'An admitted attempt must freeze its OrderIntent obligation in the same transaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- L3: the deferred backstop classified every BUY as an entry, so a protective BUY closing a short
-- tracked position would have been rejected under active enforcement. A protective exit BUY is bound
-- to a tracked position and is not declared an entry; every other BUY remains an entry and keeps the
-- full obligation requirement.
CREATE FUNCTION "order_intent_is_entry_buy"(side TEXT, tracked_position_id INTEGER, raw_request JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(side)) = 'buy'
    AND (tracked_position_id IS NULL OR COALESCE(raw_request->>'signalType', 'exit') = 'entry')
$$;

CREATE OR REPLACE FUNCTION "require_order_intent_market_policy_enforcement_obligation"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rollout_enabled BOOLEAN; account_environment "TradingAccountEnvironment"; latest "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
BEGIN
  IF NEW."tradingAccountSubscriptionId" IS NULL OR NOT "order_intent_is_entry_buy"(NEW.side, NEW."trackedPositionId", NEW."rawRequestJson"::jsonb) THEN RETURN NULL; END IF;
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

-- ---------------------------------------------------------------------------------------------
-- 2. Immutable authoritative broker-time decisions and gates
-- ---------------------------------------------------------------------------------------------

CREATE TYPE "MarketPolicyBrokerDispatchOutcome" AS ENUM (
  'ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE', 'AUTHORIZATION_REVOKED', 'AUTHORIZATION_INVALIDATED',
  'AUTHORIZATION_SUPERSEDED', 'AUTHORIZATION_INEFFECTIVE', 'POLICY_REVISION_SUPERSEDED', 'ENROLLMENT_GENERATION_INACTIVE',
  'ENTRY_IDENTITY_MISMATCH', 'LEGACY_UNOBLIGATED_QUARANTINED', 'TECHNICAL_FAILURE'
);
CREATE TYPE "MarketPolicyBrokerDispatchDisposition" AS ENUM ('DISPATCH_AUTHORIZED', 'DEFINITELY_NOT_SENT', 'NOT_SENT_TECHNICAL_FAILURE');

CREATE TABLE "MarketPolicyBrokerDispatchDecision" (
  "id" SERIAL PRIMARY KEY,
  "decisionKey" TEXT NOT NULL,
  "decisionVersion" TEXT NOT NULL,
  "authority" TEXT NOT NULL DEFAULT 'AUTHORITATIVE',
  "orderIntentId" INTEGER NOT NULL,
  "obligationId" INTEGER,
  "dispatchSequence" INTEGER NOT NULL,
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
  "authorizationStatus" TEXT,
  "rolloutEnabled" BOOLEAN NOT NULL,
  "rolloutVersion" INTEGER NOT NULL,
  "evaluatorVersion" TEXT,
  "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
  "validUntil" TIMESTAMPTZ(3),
  "dispatchExpiresAt" TIMESTAMPTZ(3),
  "marketRegimeAssessmentId" INTEGER,
  "compositionVersion" TEXT,
  "compositionSourceSetFingerprint" TEXT,
  "compositionEvidenceHealth" "MarketRegimeCompositionEvidenceHealth",
  "outcome" "MarketPolicyBrokerDispatchOutcome" NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "dispatchDisposition" "MarketPolicyBrokerDispatchDisposition" NOT NULL,
  "technicalDiagnostic" TEXT,
  "evidenceJson" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrokerDispatchDecision_orderIntent_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchDecision_obligation_fkey" FOREIGN KEY ("obligationId") REFERENCES "OrderIntentMarketPolicyEnforcementObligation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchDecision_account_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchDecision_assignment_fkey" FOREIGN KEY ("accountSubscriptionId") REFERENCES "TradingAccountSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchDecision_security_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchDecision_revision_fkey" FOREIGN KEY ("policyRevisionId") REFERENCES "StrategyMarketPolicyRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchDecision_generation_fkey" FOREIGN KEY ("enrollmentGenerationId") REFERENCES "AssignmentMarketPolicyEnrollmentGeneration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchDecision_authorization_fkey" FOREIGN KEY ("authorizationId") REFERENCES "AssignmentMarketPolicyEnforcementAuthorization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchDecision_composition_fkey" FOREIGN KEY ("marketRegimeAssessmentId") REFERENCES "MarketRegimeAssessment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchDecision_version_check" CHECK (
    "decisionVersion" = 'MARKET_POLICY_BROKER_TIME_ENFORCEMENT_V1' AND "authority" = 'AUTHORITATIVE' AND "environment" = 'PAPER'
    AND "dispatchSequence" > 0 AND "rolloutVersion" >= 0
  ),
  -- An ALLOWED decision is the only dispatch authorization; every other outcome is a definite non-send.
  CONSTRAINT "BrokerDispatchDecision_disposition_check" CHECK (
    ("outcome" = 'ALLOWED') = ("dispatchDisposition" = 'DISPATCH_AUTHORIZED')
    AND ("outcome" = 'TECHNICAL_FAILURE') = ("dispatchDisposition" = 'NOT_SENT_TECHNICAL_FAILURE')
    AND ("outcome" = 'TECHNICAL_FAILURE') = ("technicalDiagnostic" IS NOT NULL)
    AND ("technicalDiagnostic" IS NULL OR char_length("technicalDiagnostic") BETWEEN 1 AND 500)
  ),
  CONSTRAINT "BrokerDispatchDecision_obligation_check" CHECK (
    ("outcome" IN ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE', 'AUTHORIZATION_REVOKED', 'AUTHORIZATION_INVALIDATED', 'AUTHORIZATION_SUPERSEDED',
                   'AUTHORIZATION_INEFFECTIVE', 'POLICY_REVISION_SUPERSEDED', 'ENROLLMENT_GENERATION_INACTIVE', 'ENTRY_IDENTITY_MISMATCH')
      AND "obligationId" IS NOT NULL AND "subscriptionId" IS NOT NULL AND "securityId" IS NOT NULL AND "securitySymbol" IS NOT NULL
      AND "strategyId" IS NOT NULL AND "policyRevisionId" IS NOT NULL AND "enrollmentGenerationId" IS NOT NULL
      AND "authorizationId" IS NOT NULL AND "authorizationFingerprint" IS NOT NULL AND "authorityVersion" = 'PAPER_MARKET_POLICY_ENFORCEMENT_V2')
    OR ("outcome" = 'LEGACY_UNOBLIGATED_QUARANTINED' AND "obligationId" IS NULL AND "authorizationId" IS NOT NULL AND "rolloutEnabled")
    OR "outcome" = 'TECHNICAL_FAILURE'
  ),
  CONSTRAINT "BrokerDispatchDecision_evaluation_check" CHECK (
    ("outcome" IN ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE')) = ("evaluatorVersion" IS NOT NULL)
    AND ("evaluatorVersion" IS NULL OR "evaluatorVersion" = 'STRATEGY_MARKET_ELIGIBILITY_V1')
    AND ("outcome" <> 'ALLOWED' OR ("marketRegimeAssessmentId" IS NOT NULL AND "validUntil" IS NOT NULL AND "validUntil" > "evaluatedAt"
      AND "dispatchExpiresAt" IS NOT NULL AND "dispatchExpiresAt" > "evaluatedAt" AND "dispatchExpiresAt" <= "validUntil"))
    AND ("outcome" = 'ALLOWED' OR ("validUntil" IS NULL AND "dispatchExpiresAt" IS NULL))
  ),
  CONSTRAINT "BrokerDispatchDecision_composition_check" CHECK (
    ("marketRegimeAssessmentId" IS NULL AND "compositionSourceSetFingerprint" IS NULL AND "compositionVersion" IS NULL AND "compositionEvidenceHealth" IS NULL)
    OR ("marketRegimeAssessmentId" IS NOT NULL AND "compositionSourceSetFingerprint" IS NOT NULL
      AND "compositionVersion" = 'MARKET_REGIME_COMPOSITION_V1' AND "compositionEvidenceHealth" IS NOT NULL
      AND "outcome" IN ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE'))
  )
);
CREATE UNIQUE INDEX "BrokerDispatchDecision_decisionKey_key" ON "MarketPolicyBrokerDispatchDecision" ("decisionKey");
CREATE UNIQUE INDEX "BrokerDispatchDecision_intent_sequence_key" ON "MarketPolicyBrokerDispatchDecision" ("orderIntentId", "dispatchSequence");
CREATE INDEX "BrokerDispatchDecision_assignment_idx" ON "MarketPolicyBrokerDispatchDecision" ("accountSubscriptionId", "id");
CREATE INDEX "BrokerDispatchDecision_account_idx" ON "MarketPolicyBrokerDispatchDecision" ("tradingAccountId", "createdAt");
CREATE INDEX "BrokerDispatchDecision_authorization_idx" ON "MarketPolicyBrokerDispatchDecision" ("authorizationId");
CREATE INDEX "BrokerDispatchDecision_obligation_idx" ON "MarketPolicyBrokerDispatchDecision" ("obligationId");

CREATE TABLE "MarketPolicyBrokerDispatchGate" (
  "id" SERIAL PRIMARY KEY,
  "decisionId" INTEGER NOT NULL,
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
  CONSTRAINT "BrokerDispatchGate_decision_fkey" FOREIGN KEY ("decisionId") REFERENCES "MarketPolicyBrokerDispatchDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchGate_source_identity_fk" FOREIGN KEY ("sourceAssessmentId", "dimension", "algorithmVersion") REFERENCES "MarketRegimeDimensionAssessment"("id", "dimension", "algorithmVersion") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchGate_ordinal_check" CHECK ("ordinal" BETWEEN 1 AND 5),
  CONSTRAINT "BrokerDispatchGate_requirement_check" CHECK (("requirement" = 'IGNORED') = ("outcome" = 'IGNORED'))
);
CREATE UNIQUE INDEX "BrokerDispatchGate_decision_dimension_key" ON "MarketPolicyBrokerDispatchGate" ("decisionId", "dimension");
CREATE UNIQUE INDEX "BrokerDispatchGate_decision_ordinal_key" ON "MarketPolicyBrokerDispatchGate" ("decisionId", "ordinal");
CREATE INDEX "BrokerDispatchGate_source_idx" ON "MarketPolicyBrokerDispatchGate" ("sourceAssessmentId", "dimension", "algorithmVersion");

-- Decisions are authoritative only when PostgreSQL independently confirms what they claim. Every
-- outcome bound to an obligation must mirror the frozen obligation exactly, so a newer policy
-- revision or authorization can never be substituted. ALLOWED additionally requires the exact bound
-- authorization to still be AUTHORIZED and latest, its generation and revision ACTIVE, the assignment
-- binding unchanged, committed composition evidence, an executable claim, and no earlier dispatch.
CREATE FUNCTION "validate_market_policy_broker_dispatch_decision"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rollout "MarketPolicyEnforcementRuntimeRollout"%ROWTYPE;
  o "OrderIntentMarketPolicyEnforcementObligation"%ROWTYPE;
  a "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
  latest "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
  tas "TradingAccountSubscription"%ROWTYPE;
  oi "OrderIntent"%ROWTYPE;
  c "EntryExposureClaim"%ROWTYPE;
  m "MarketRegimeAssessment"%ROWTYPE;
  account_environment "TradingAccountEnvironment";
  generation_status "AssignmentMarketPolicyEnrollmentStatus";
  revision_status "StrategyMarketPolicyRevisionStatus";
  next_sequence INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Broker-time market-policy decisions are immutable' USING ERRCODE = '23514'; END IF;
  SELECT environment INTO account_environment FROM "TradingAccount" WHERE id = NEW."tradingAccountId";
  IF account_environment IS DISTINCT FROM 'PAPER' THEN RAISE EXCEPTION 'Broker-time market-policy enforcement is PAPER-only' USING ERRCODE = '23514'; END IF;
  SELECT * INTO oi FROM "OrderIntent" WHERE id = NEW."orderIntentId";
  IF oi.id IS NULL OR ROW(oi."tradingAccountId", oi."tradingAccountSubscriptionId", oi."clientOrderId")
     IS DISTINCT FROM ROW(NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."clientOrderId")
     OR NOT "order_intent_is_entry_buy"(oi.side, oi."trackedPositionId", oi."rawRequestJson"::jsonb) THEN
    RAISE EXCEPTION 'A broker-time decision must mirror its exact entry BUY OrderIntent and stable client order ID' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(max("dispatchSequence"), 0) + 1 INTO next_sequence FROM "MarketPolicyBrokerDispatchDecision" WHERE "orderIntentId" = NEW."orderIntentId";
  IF NEW."dispatchSequence" <> next_sequence THEN RAISE EXCEPTION 'Broker-time decision sequence must be contiguous per OrderIntent' USING ERRCODE = '23514'; END IF;

  IF NEW.outcome = 'TECHNICAL_FAILURE' THEN
    -- Recorded after the failed preparation rolled back; PostgreSQL stamps it. It authorizes nothing.
    NEW."evaluatedAt" := statement_timestamp();
    NEW."createdAt" := NEW."evaluatedAt";
    RETURN NEW;
  END IF;

  SELECT * INTO rollout FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id = 1 FOR SHARE;
  IF rollout.id IS NULL OR rollout.enabled IS DISTINCT FROM NEW."rolloutEnabled" OR rollout.version IS DISTINCT FROM NEW."rolloutVersion" THEN
    RAISE EXCEPTION 'A broker-time decision must record the exact runtime rollout state it observed' USING ERRCODE = '23514';
  END IF;
  IF NOT "market_policy_evaluated_in_current_transaction"(NEW."evaluatedAt") THEN
    RAISE EXCEPTION 'A broker-time decision must be evaluated at current PostgreSQL time in its own transaction' USING ERRCODE = '23514';
  END IF;

  IF NEW.outcome = 'LEGACY_UNOBLIGATED_QUARANTINED' THEN
    IF NOT rollout.enabled OR EXISTS (SELECT 1 FROM "OrderIntentMarketPolicyEnforcementObligation" x WHERE x."orderIntentId" = NEW."orderIntentId") THEN
      RAISE EXCEPTION 'Only an un-obligated entry under the active rollout can be quarantined' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO latest FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId" = NEW."accountSubscriptionId" ORDER BY id DESC LIMIT 1;
    IF latest.id IS DISTINCT FROM NEW."authorizationId" OR NOT (latest.status = 'AUTHORIZED' OR (latest.status = 'INVALIDATED'
       AND NOT EXISTS (SELECT 1 FROM "AssignmentMarketPolicyEnforcementLapseResolution" r WHERE r."authorizationId" = latest.id))) THEN
      RAISE EXCEPTION 'Quarantine requires the assignment''s latest authorization to require enforcement' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO o FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE id = NEW."obligationId";
  IF o.id IS NULL OR ROW(o."orderIntentId", o."tradingAccountId", o."accountSubscriptionId", o."subscriptionId", o."securityId", o."securitySymbol",
                         o."strategyId", o."policyRevisionId", o."enrollmentGenerationId", o."authorizationId", o."authorizationFingerprint", o."authorityVersion")
     IS DISTINCT FROM ROW(NEW."orderIntentId", NEW."tradingAccountId", NEW."accountSubscriptionId", NEW."subscriptionId", NEW."securityId", NEW."securitySymbol",
                         NEW."strategyId", NEW."policyRevisionId", NEW."enrollmentGenerationId", NEW."authorizationId", NEW."authorizationFingerprint", NEW."authorityVersion") THEN
    RAISE EXCEPTION 'A broker-time decision must mirror the exact frozen obligation of its OrderIntent' USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome <> 'ALLOWED' THEN RETURN NEW; END IF;

  -- ALLOWED: lock the exact bound authorization (revocation and every invalidation wait for this commit).
  SELECT * INTO a FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id = o."authorizationId" FOR SHARE;
  IF a.status IS DISTINCT FROM 'AUTHORIZED' OR a."authorizationFingerprint" IS DISTINCT FROM o."authorizationFingerprint"
     OR NEW."authorizationStatus" IS DISTINCT FROM 'AUTHORIZED'
     OR EXISTS (SELECT 1 FROM "AssignmentMarketPolicyEnforcementAuthorization" later WHERE later."accountSubscriptionId" = a."accountSubscriptionId" AND later.id > a.id) THEN
    RAISE EXCEPTION 'ALLOWED broker dispatch requires the exact frozen authorization to remain AUTHORIZED and latest' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO tas FROM "TradingAccountSubscription" WHERE id = o."accountSubscriptionId";
  SELECT status INTO generation_status FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id = o."enrollmentGenerationId";
  SELECT status INTO revision_status FROM "StrategyMarketPolicyRevision" WHERE id = o."policyRevisionId";
  IF generation_status IS DISTINCT FROM 'ACTIVE' OR revision_status IS DISTINCT FROM 'ACTIVE'
     OR ROW(tas."tradingAccountId", tas."subscriptionId", tas."routingSecurityId", tas."routingStrategyId")
     IS DISTINCT FROM ROW(a."tradingAccountId", a."subscriptionId", a."securityId", a."strategyId")
     OR upper(btrim(oi.symbol)) IS DISTINCT FROM o."securitySymbol" THEN
    RAISE EXCEPTION 'ALLOWED broker dispatch requires the frozen generation and revision ACTIVE and the binding unchanged' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO m FROM "MarketRegimeAssessment" WHERE id = NEW."marketRegimeAssessmentId";
  IF m.id IS NULL OR m."compositionVersion" <> NEW."compositionVersion" OR m."sourceSetFingerprint" <> NEW."compositionSourceSetFingerprint"
     OR m."evidenceHealth" <> NEW."compositionEvidenceHealth" OR m."publicationStatus" <> 'SUCCEEDED' OR m."observedAt" > NEW."evaluatedAt" THEN
    RAISE EXCEPTION 'Broker-time composition evidence must mirror a committed composition observed before evaluation' USING ERRCODE = '23514';
  END IF;
  IF NEW."validUntil" <= clock_timestamp() OR NEW."dispatchExpiresAt" IS DISTINCT FROM LEAST(NEW."validUntil", NEW."evaluatedAt" + interval '30 seconds') THEN
    RAISE EXCEPTION 'ALLOWED broker dispatch must be unexpired and bounded by the dispatch window' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO c FROM "EntryExposureClaim" WHERE "orderIntentId" = NEW."orderIntentId";
  IF oi.status IS DISTINCT FROM 'submitting' OR c.id IS NULL OR c."releasedAt" IS NOT NULL OR c.status IS DISTINCT FROM 'ENTRY_SUBMITTING'
     OR c."tradingAccountId" IS DISTINCT FROM o."tradingAccountId" OR c."securityId" IS DISTINCT FROM o."securityId" THEN
    RAISE EXCEPTION 'ALLOWED broker dispatch requires the exact executable EntryExposureClaim' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchConsumption" x WHERE x."orderIntentId" = NEW."orderIntentId") THEN
    RAISE EXCEPTION 'An OrderIntent whose dispatch already started can never be authorized for another POST' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BrokerDispatchDecision_validate" BEFORE INSERT OR UPDATE OR DELETE ON "MarketPolicyBrokerDispatchDecision" FOR EACH ROW EXECUTE FUNCTION "validate_market_policy_broker_dispatch_decision"();

CREATE FUNCTION "validate_market_policy_broker_dispatch_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d "MarketPolicyBrokerDispatchDecision"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Broker-time market-policy gates are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO d FROM "MarketPolicyBrokerDispatchDecision" WHERE id = NEW."decisionId";
  IF d.id IS NULL OR d.outcome NOT IN ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE') OR d."marketRegimeAssessmentId" IS NULL THEN
    RAISE EXCEPTION 'Broker-time gates belong only to an evaluated decision with composition evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BrokerDispatchGate_validate" BEFORE INSERT OR UPDATE OR DELETE ON "MarketPolicyBrokerDispatchGate" FOR EACH ROW EXECUTE FUNCTION "validate_market_policy_broker_dispatch_gate"();

-- Commit-time check of the five-dimension REQUIRED/IGNORED contract of the exact frozen revision, and
-- of the dispatch window: an ALLOWED decision whose window closed before commit authorizes nothing.
CREATE FUNCTION "verify_market_policy_broker_dispatch_decision"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d "MarketPolicyBrokerDispatchDecision"%ROWTYPE; gate_count INTEGER; required_until TIMESTAMPTZ;
BEGIN
  SELECT * INTO d FROM "MarketPolicyBrokerDispatchDecision" WHERE id = NEW.id;
  SELECT count(*) INTO gate_count FROM "MarketPolicyBrokerDispatchGate" WHERE "decisionId" = d.id;
  IF d.outcome IN ('ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE') AND d."marketRegimeAssessmentId" IS NOT NULL AND gate_count <> 5 THEN
    RAISE EXCEPTION 'An evaluated broker-time decision requires exactly five dimension gates' USING ERRCODE = '23514';
  END IF;
  IF d.outcome = 'ALLOWED' THEN
    IF NOT EXISTS (SELECT 1 FROM "StrategyMarketPolicyDimensionRule" r WHERE r."revisionId" = d."policyRevisionId" AND r.requirement = 'REQUIRED') THEN
      RAISE EXCEPTION 'ALLOWED broker dispatch requires at least one REQUIRED dimension' USING ERRCODE = '23514';
    END IF;
    IF (SELECT count(*) FROM "StrategyMarketPolicyDimensionRule" r WHERE r."revisionId" = d."policyRevisionId") <> 5 OR EXISTS (
      SELECT 1 FROM "StrategyMarketPolicyDimensionRule" r
      LEFT JOIN "MarketPolicyBrokerDispatchGate" g ON g."decisionId" = d.id AND g.dimension = r.dimension
      LEFT JOIN "MarketRegimeAssessmentSource" s ON s."marketRegimeAssessmentId" = d."marketRegimeAssessmentId" AND s.dimension = r.dimension
      WHERE r."revisionId" = d."policyRevisionId" AND (
        g.id IS NULL OR g.requirement <> r.requirement OR g."algorithmVersion" <> r."algorithmVersion"
        OR (r.requirement = 'REQUIRED' AND (
          g.outcome <> 'PASS' OR s.id IS NULL OR s.health <> 'AVAILABLE' OR s."sourceStatus" IS DISTINCT FROM 'VALID'
          OR s."requiredAlgorithmVersion" <> r."algorithmVersion"
          OR s."sourceAssessmentId" IS NULL OR s."sourceAssessmentId" IS DISTINCT FROM g."sourceAssessmentId"
          OR s."sourceEffectiveState" IS NULL OR s."sourceEffectiveState" IS DISTINCT FROM g."observedState"
          OR s."sourceValidUntil" IS NULL OR s."sourceValidUntil" <= d."evaluatedAt"
          OR NOT EXISTS (SELECT 1 FROM "StrategyMarketPolicyAllowedState" st WHERE st."ruleId" = r.id AND st.state = g."observedState")))
      )
    ) THEN
      RAISE EXCEPTION 'ALLOWED broker dispatch violates the frozen five-dimension REQUIRED/IGNORED contract' USING ERRCODE = '23514';
    END IF;
    SELECT min(s."sourceValidUntil") INTO required_until FROM "StrategyMarketPolicyDimensionRule" r
      JOIN "MarketRegimeAssessmentSource" s ON s."marketRegimeAssessmentId" = d."marketRegimeAssessmentId" AND s.dimension = r.dimension
      WHERE r."revisionId" = d."policyRevisionId" AND r.requirement = 'REQUIRED';
    IF d."validUntil" IS DISTINCT FROM required_until THEN
      RAISE EXCEPTION 'ALLOWED broker dispatch validity must equal the earliest required source expiration' USING ERRCODE = '23514';
    END IF;
    IF d."dispatchExpiresAt" <= clock_timestamp() THEN
      RAISE EXCEPTION 'ALLOWED broker dispatch window closed before the decision committed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "BrokerDispatchDecision_verify" AFTER INSERT ON "MarketPolicyBrokerDispatchDecision"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "verify_market_policy_broker_dispatch_decision"();

-- ---------------------------------------------------------------------------------------------
-- 3. Single-use dispatch consumption: the authorization-to-dispatch linearization point
-- ---------------------------------------------------------------------------------------------

CREATE TABLE "MarketPolicyBrokerDispatchConsumption" (
  "id" SERIAL PRIMARY KEY,
  "decisionId" INTEGER NOT NULL,
  "orderIntentId" INTEGER NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "brokerPostOpportunityId" INTEGER,
  "consumedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evidenceJson" JSONB NOT NULL,
  CONSTRAINT "BrokerDispatchConsumption_decision_fkey" FOREIGN KEY ("decisionId") REFERENCES "MarketPolicyBrokerDispatchDecision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchConsumption_orderIntent_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BrokerDispatchConsumption_opportunity_fkey" FOREIGN KEY ("brokerPostOpportunityId") REFERENCES "OrderIntentBrokerPostOpportunity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "BrokerDispatchConsumption_decision_key" ON "MarketPolicyBrokerDispatchConsumption" ("decisionId");
-- At most one dispatch per enforced OrderIntent, ever: a started dispatch is recovered, never repeated.
CREATE UNIQUE INDEX "BrokerDispatchConsumption_orderIntent_key" ON "MarketPolicyBrokerDispatchConsumption" ("orderIntentId");

-- Consumption commits immediately before the adapter is invoked. A revocation, invalidation,
-- supersession or newer grant that committed first, an expired dispatch window, a superseded
-- decision, or a non-executable intent or claim refuses it, and no POST occurs. A revocation that
-- commits after consumption cannot recall an in-flight external request.
CREATE FUNCTION "validate_market_policy_broker_dispatch_consumption"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d "MarketPolicyBrokerDispatchDecision"%ROWTYPE;
  a "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
  tas "TradingAccountSubscription"%ROWTYPE;
  oi "OrderIntent"%ROWTYPE;
  c "EntryExposureClaim"%ROWTYPE;
  generation_status "AssignmentMarketPolicyEnrollmentStatus";
  revision_status "StrategyMarketPolicyRevisionStatus";
  opportunity_intent INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Broker dispatch consumptions are immutable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO d FROM "MarketPolicyBrokerDispatchDecision" WHERE id = NEW."decisionId";
  IF d.id IS NULL OR d.outcome <> 'ALLOWED' OR d."dispatchDisposition" <> 'DISPATCH_AUTHORIZED'
     OR d."orderIntentId" <> NEW."orderIntentId" OR d."clientOrderId" <> NEW."clientOrderId" THEN
    RAISE EXCEPTION 'BROKER_DISPATCH_NOT_AUTHORIZED: only an ALLOWED decision for this exact intent can be consumed' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchDecision" later WHERE later."orderIntentId" = d."orderIntentId" AND later."dispatchSequence" > d."dispatchSequence") THEN
    RAISE EXCEPTION 'BROKER_DISPATCH_DECISION_SUPERSEDED: a later broker-time decision exists for this intent' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO a FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id = d."authorizationId" FOR SHARE;
  IF a.status IS DISTINCT FROM 'AUTHORIZED' OR a."authorizationFingerprint" IS DISTINCT FROM d."authorizationFingerprint"
     OR EXISTS (SELECT 1 FROM "AssignmentMarketPolicyEnforcementAuthorization" later WHERE later."accountSubscriptionId" = a."accountSubscriptionId" AND later.id > a.id) THEN
    RAISE EXCEPTION 'BROKER_DISPATCH_AUTHORIZATION_CHANGED: the frozen authorization is no longer effective' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO tas FROM "TradingAccountSubscription" WHERE id = d."accountSubscriptionId";
  SELECT status INTO generation_status FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id = d."enrollmentGenerationId";
  SELECT status INTO revision_status FROM "StrategyMarketPolicyRevision" WHERE id = d."policyRevisionId";
  IF generation_status IS DISTINCT FROM 'ACTIVE' OR revision_status IS DISTINCT FROM 'ACTIVE'
     OR ROW(tas."tradingAccountId", tas."subscriptionId", tas."routingSecurityId", tas."routingStrategyId")
     IS DISTINCT FROM ROW(a."tradingAccountId", a."subscriptionId", a."securityId", a."strategyId") THEN
    RAISE EXCEPTION 'BROKER_DISPATCH_AUTHORIZATION_CHANGED: the frozen generation, revision or binding changed' USING ERRCODE = '23514';
  END IF;
  IF clock_timestamp() >= d."dispatchExpiresAt" THEN
    RAISE EXCEPTION 'BROKER_DISPATCH_WINDOW_EXPIRED: the broker-time decision expired before dispatch' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO oi FROM "OrderIntent" WHERE id = NEW."orderIntentId";
  SELECT * INTO c FROM "EntryExposureClaim" WHERE "orderIntentId" = NEW."orderIntentId";
  IF oi.status IS DISTINCT FROM 'submitting' OR c.id IS NULL OR c."releasedAt" IS NOT NULL OR c.status IS DISTINCT FROM 'ENTRY_SUBMITTING' THEN
    RAISE EXCEPTION 'BROKER_DISPATCH_INTENT_NOT_EXECUTABLE: the intent or its claim is no longer executable' USING ERRCODE = '23514';
  END IF;
  IF NEW."brokerPostOpportunityId" IS NOT NULL THEN
    SELECT "orderIntentId" INTO opportunity_intent FROM "OrderIntentBrokerPostOpportunity" WHERE id = NEW."brokerPostOpportunityId";
    IF opportunity_intent IS DISTINCT FROM NEW."orderIntentId" THEN
      RAISE EXCEPTION 'A dispatch consumption may cite only its own intent''s broker opportunity' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."consumedAt" := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER "BrokerDispatchConsumption_validate" BEFORE INSERT OR UPDATE OR DELETE ON "MarketPolicyBrokerDispatchConsumption" FOR EACH ROW EXECUTE FUNCTION "validate_market_policy_broker_dispatch_consumption"();
