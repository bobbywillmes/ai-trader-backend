BEGIN;

-- Deployment preconditions: fail visibly rather than rewriting immutable Phase 2 evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "StrategyMarketPolicyRevision"
    WHERE ("status" = 'PREPARED' AND ("activatedAt" IS NOT NULL OR "retiredAt" IS NOT NULL))
       OR ("status" = 'ACTIVE' AND ("activatedAt" IS NULL OR "retiredAt" IS NOT NULL))
       OR ("status" = 'RETIRED' AND ("activatedAt" IS NULL OR "retiredAt" IS NULL))
  ) THEN
    RAISE EXCEPTION 'Phase 2 integrity precondition failed: invalid strategy market policy revision lifecycle';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "StrategyMarketEligibilityDecision" d
    JOIN "StrategyMarketPolicyRevision" r ON r."id" = d."policyRevisionId"
    JOIN "StrategyMarketPolicy" p ON p."id" = r."policyId"
    WHERE p."strategyId" <> d."strategyId"
  ) THEN
    RAISE EXCEPTION 'Phase 2 integrity precondition failed: decision policy strategy mismatch';
  END IF;
END
$$;

ALTER TABLE "StrategyMarketPolicyRevision"
  DROP CONSTRAINT "StrategyMarketPolicyRevision_lifecycle_check",
  ADD CONSTRAINT "StrategyMarketPolicyRevision_lifecycle_check" CHECK (
    ("status" = 'PREPARED' AND "activatedAt" IS NULL AND "retiredAt" IS NULL) OR
    ("status" = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL) OR
    ("status" = 'RETIRED' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL AND "retiredAt" >= "activatedAt")
  );

CREATE FUNCTION "enforce_strategy_market_policy_revision_lifecycle"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."policyId" IS DISTINCT FROM OLD."policyId" OR
     NEW."revision" IS DISTINCT FROM OLD."revision" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Strategy market policy revision identity is immutable';
  END IF;

  IF OLD."status" = 'PREPARED' THEN
    IF NEW."status" NOT IN ('PREPARED', 'ACTIVE') THEN
      RAISE EXCEPTION 'Strategy market policy revision transition % -> % is not allowed', OLD."status", NEW."status";
    END IF;
    IF NEW."status" = 'ACTIVE' AND (NEW."activatedAt" IS NULL OR NEW."retiredAt" IS NOT NULL) THEN
      RAISE EXCEPTION 'An ACTIVE strategy market policy revision requires activation evidence';
    END IF;
  ELSIF OLD."status" = 'ACTIVE' THEN
    IF NEW."status" <> 'RETIRED' THEN
      RAISE EXCEPTION 'Strategy market policy revision transition ACTIVE -> % is not allowed', NEW."status";
    END IF;
    IF NEW."changeNote" IS DISTINCT FROM OLD."changeNote" OR
       NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" OR
       NEW."retiredAt" IS NULL THEN
      RAISE EXCEPTION 'Activated strategy market policy revision metadata is immutable';
    END IF;
  ELSE
    RAISE EXCEPTION 'RETIRED strategy market policy revisions are immutable';
  END IF;

  IF OLD."status" <> 'PREPARED' AND NEW."changeNote" IS DISTINCT FROM OLD."changeNote" THEN
    RAISE EXCEPTION 'Activated strategy market policy revision metadata is immutable';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StrategyMarketPolicyRevision_lifecycle_guard"
BEFORE UPDATE ON "StrategyMarketPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "enforce_strategy_market_policy_revision_lifecycle"();

CREATE FUNCTION "enforce_strategy_market_policy_revision_insert_delete"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PREPARED' OR NEW."activatedAt" IS NOT NULL OR NEW."retiredAt" IS NOT NULL THEN
      RAISE EXCEPTION 'New strategy market policy revisions must begin PREPARED';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'PREPARED' THEN
    RAISE EXCEPTION 'Activated strategy market policy revisions cannot be deleted';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StrategyMarketPolicyRevision_insert_guard"
BEFORE INSERT ON "StrategyMarketPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "enforce_strategy_market_policy_revision_insert_delete"();
CREATE TRIGGER "StrategyMarketPolicyRevision_delete_guard"
BEFORE DELETE ON "StrategyMarketPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "enforce_strategy_market_policy_revision_insert_delete"();

CREATE FUNCTION "enforce_strategy_market_policy_identity"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."strategyId" IS DISTINCT FROM OLD."strategyId" OR
     NEW."authority" IS DISTINCT FROM OLD."authority" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Strategy market policy identity and authority are immutable';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StrategyMarketPolicy_identity_guard"
BEFORE UPDATE ON "StrategyMarketPolicy"
FOR EACH ROW EXECUTE FUNCTION "enforce_strategy_market_policy_identity"();

ALTER TABLE "StrategyMarketEligibilityDecisionGate"
  ADD CONSTRAINT "StrategyMarketEligibilityDecisionGate_identity_check" CHECK (
    jsonb_typeof("allowedStatesJson") = 'array' AND jsonb_typeof("evidenceJson") = 'object' AND
    (("ordinal" = 1 AND "dimension" = 'TREND' AND "algorithmVersion" = 'TREND_V1') OR
     ("ordinal" = 2 AND "dimension" = 'VOLATILITY' AND "algorithmVersion" = 'VOLATILITY_V1') OR
     ("ordinal" = 3 AND "dimension" = 'BREADTH' AND "algorithmVersion" = 'BREADTH_V1') OR
     ("ordinal" = 4 AND "dimension" = 'PARTICIPATION' AND "algorithmVersion" = 'PARTICIPATION_V1') OR
     ("ordinal" = 5 AND "dimension" = 'INTRADAY_STRESS' AND "algorithmVersion" = 'INTRADAY_STRESS_V1'))
  );

CREATE FUNCTION "validate_strategy_market_eligibility_decision"(decision_id INTEGER) RETURNS void AS $$
DECLARE decision_row "StrategyMarketEligibilityDecision"%ROWTYPE;
DECLARE gate_count INTEGER;
DECLARE derived_outcome "StrategyMarketEligibilityOutcome";
BEGIN
  SELECT * INTO decision_row FROM "StrategyMarketEligibilityDecision" WHERE "id" = decision_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT count(*) INTO gate_count FROM "StrategyMarketEligibilityDecisionGate" WHERE "decisionId" = decision_id;

  IF decision_row."reasonCode" = 'NO_ACTIVE_POLICY' THEN
    IF decision_row."policyRevisionId" IS NOT NULL OR gate_count <> 0 OR decision_row."outcome" <> 'INSUFFICIENT_EVIDENCE' THEN
      RAISE EXCEPTION 'NO_ACTIVE_POLICY decision % must have no policy, no gates and insufficient evidence', decision_id;
    END IF;
    RETURN;
  ELSIF decision_row."reasonCode" = 'NO_COMPOSITION' THEN
    IF decision_row."policyRevisionId" IS NULL OR decision_row."marketRegimeAssessmentId" IS NOT NULL OR gate_count <> 0 OR decision_row."outcome" <> 'INSUFFICIENT_EVIDENCE' THEN
      RAISE EXCEPTION 'NO_COMPOSITION decision % must have a policy, no composition, no gates and insufficient evidence', decision_id;
    END IF;
    RETURN;
  END IF;

  IF decision_row."policyRevisionId" IS NULL OR decision_row."marketRegimeAssessmentId" IS NULL OR gate_count <> 5 THEN
    RAISE EXCEPTION 'Strategy market eligibility decision % must contain exactly five authoritative gates', decision_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "StrategyMarketPolicyRevision" r
    JOIN "StrategyMarketPolicy" p ON p."id" = r."policyId"
    WHERE r."id" = decision_row."policyRevisionId" AND p."strategyId" <> decision_row."strategyId"
  ) THEN
    RAISE EXCEPTION 'Strategy market eligibility decision % references another strategy policy', decision_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "StrategyMarketEligibilityDecisionGate" g
    LEFT JOIN "StrategyMarketPolicyDimensionRule" rule
      ON rule."revisionId" = decision_row."policyRevisionId"
     AND rule."dimension" = g."dimension"
     AND rule."algorithmVersion" = g."algorithmVersion"
    LEFT JOIN "MarketRegimeAssessmentSource" source
      ON source."marketRegimeAssessmentId" = decision_row."marketRegimeAssessmentId"
     AND source."dimension" = g."dimension"
     AND source."requiredAlgorithmVersion" = g."algorithmVersion"
    WHERE g."decisionId" = decision_id
      AND (rule."id" IS NULL OR source."id" IS NULL OR
           g."requirement" IS DISTINCT FROM rule."requirement" OR
           g."allowedStatesJson" IS DISTINCT FROM COALESCE(
             (SELECT jsonb_agg(a."state" ORDER BY a."state") FROM "StrategyMarketPolicyAllowedState" a WHERE a."ruleId" = rule."id"),
             '[]'::jsonb) OR
           g."sourceAssessmentId" IS DISTINCT FROM source."sourceAssessmentId" OR
           (g."sourceHealth" IS DISTINCT FROM source."health" AND NOT (
             source."health" = 'AVAILABLE' AND g."sourceHealth" = 'EXPIRED' AND
             source."sourceValidUntil" IS NOT NULL AND source."sourceValidUntil" <= decision_row."evaluatedAt")) OR
           g."observedState" IS DISTINCT FROM source."sourceEffectiveState")
  ) THEN
    RAISE EXCEPTION 'Strategy market eligibility decision % gate evidence conflicts with policy or composition', decision_id;
  END IF;

  SELECT CASE
    WHEN bool_or("outcome" = 'INSUFFICIENT_EVIDENCE') FILTER (WHERE "requirement" = 'REQUIRED') THEN 'INSUFFICIENT_EVIDENCE'::"StrategyMarketEligibilityOutcome"
    WHEN bool_or("outcome" = 'BLOCKED') FILTER (WHERE "requirement" = 'REQUIRED') THEN 'BLOCKED'::"StrategyMarketEligibilityOutcome"
    ELSE 'ALLOWED'::"StrategyMarketEligibilityOutcome"
  END INTO derived_outcome
  FROM "StrategyMarketEligibilityDecisionGate" WHERE "decisionId" = decision_id;

  IF derived_outcome IS DISTINCT FROM decision_row."outcome" THEN
    RAISE EXCEPTION 'Strategy market eligibility decision % outcome conflicts with its gates', decision_id;
  END IF;
END
$$ LANGUAGE plpgsql;

CREATE FUNCTION "enforce_strategy_market_eligibility_decision"() RETURNS trigger AS $$
BEGIN
  PERFORM "validate_strategy_market_eligibility_decision"(NEW."id");
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "StrategyMarketEligibilityDecision_complete_check"
AFTER INSERT ON "StrategyMarketEligibilityDecision" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_strategy_market_eligibility_decision"();

CREATE FUNCTION "enforce_strategy_market_eligibility_gate"() RETURNS trigger AS $$
BEGIN
  PERFORM "validate_strategy_market_eligibility_decision"(NEW."decisionId");
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "StrategyMarketEligibilityDecisionGate_complete_check"
AFTER INSERT ON "StrategyMarketEligibilityDecisionGate" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_strategy_market_eligibility_gate"();

CREATE FUNCTION "validate_signal_route_market_eligibility_attempt"(attempt_id INTEGER) RETURNS void AS $$
DECLARE attempt_row "SignalRouteMarketEligibilityAttempt"%ROWTYPE;
DECLARE signal_strategy_id INTEGER;
DECLARE decision_row "StrategyMarketEligibilityDecision"%ROWTYPE;
BEGIN
  SELECT * INTO attempt_row FROM "SignalRouteMarketEligibilityAttempt" WHERE "id" = attempt_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT s."strategyId" INTO signal_strategy_id
  FROM "SignalRoute" route
  JOIN "SignalRoutingRun" run ON run."id" = route."signalRoutingRunId"
  JOIN "Signal" s ON s."id" = run."signalId"
  WHERE route."id" = attempt_row."signalRouteId";

  IF signal_strategy_id IS DISTINCT FROM attempt_row."strategyId" THEN
    RAISE EXCEPTION 'Signal route market eligibility attempt % strategy conflicts with its route', attempt_id;
  END IF;

  IF attempt_row."eligibilityDecisionId" IS NOT NULL THEN
    SELECT * INTO decision_row FROM "StrategyMarketEligibilityDecision" WHERE "id" = attempt_row."eligibilityDecisionId";
    IF decision_row."strategyId" IS DISTINCT FROM attempt_row."strategyId" OR
       decision_row."contextType" IS DISTINCT FROM 'SIGNAL_ROUTE' OR
       decision_row."contextIdentity" IS DISTINCT FROM ('SIGNAL_ROUTE:' || attempt_row."signalRouteId"::text) THEN
      RAISE EXCEPTION 'Signal route market eligibility attempt % decision identity conflicts with its route', attempt_id;
    END IF;
  END IF;
END
$$ LANGUAGE plpgsql;

CREATE FUNCTION "enforce_signal_route_market_eligibility_attempt_identity"() RETURNS trigger AS $$
BEGIN
  PERFORM "validate_signal_route_market_eligibility_attempt"(NEW."id");
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "SignalRouteMarketEligibilityAttempt_identity_check"
AFTER INSERT ON "SignalRouteMarketEligibilityAttempt" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_signal_route_market_eligibility_attempt_identity"();

-- Validate every persisted row before the migration can commit. These calls are read-only.
DO $$
DECLARE row_id INTEGER;
BEGIN
  FOR row_id IN SELECT "id" FROM "StrategyMarketEligibilityDecision" LOOP
    PERFORM "validate_strategy_market_eligibility_decision"(row_id);
  END LOOP;
  FOR row_id IN SELECT "id" FROM "SignalRouteMarketEligibilityAttempt" LOOP
    PERFORM "validate_signal_route_market_eligibility_attempt"(row_id);
  END LOOP;
END
$$;

COMMIT;
