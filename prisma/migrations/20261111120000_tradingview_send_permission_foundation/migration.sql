-- Phase 4A.2C3C.1A: broker-inert send-permission database foundation.
-- No application writer, scheduler, adapter integration, quarantine relaxation, activation, or broker authority is added.
SET LOCAL lock_timeout = '15s';

LOCK TABLE "ExternalSignalBrokerDispatchConsumption", "MarketPolicyBrokerDispatchConsumption",
  "MarketPolicyBrokerDispatchDecision", "ExternalSignalDispatchFence", "OrderIntent", "EntryExposureClaim",
  "EntryExposureClaimEvent", "ExternalSignalBrokerWorkerClaim", "ExternalSignalEntryExecutionObligation",
  "ExternalSignalEntryExecutionAuthorization", "ExternalSignalTradeCycleAccount", "BrokerOrder", "BrokerActivity"
  IN SHARE ROW EXCLUSIVE MODE;

-- The reviewed F/P/A database freshness minimums are deliberately distinct names. They are database admission
-- thresholds, not broker transport timeouts.
CREATE FUNCTION external_signal_c3c_f_minimum_remaining() RETURNS interval LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$ SELECT interval '5 seconds' $$;
CREATE FUNCTION external_signal_c3c_p_minimum_remaining() RETURNS interval LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$ SELECT interval '5 seconds' $$;
CREATE FUNCTION external_signal_c3c_a_minimum_remaining() RETURNS interval LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp AS $$ SELECT interval '5 seconds' $$;

-- Audit the immutable C3B.2 pair before changing future finalization. Invalid history is never rewritten.
CREATE VIEW "ExternalSignalBrokerDispatchPairDeadlineAudit" AS
SELECT
  tv."orderIntentId",
  tv.id AS "tradingViewConsumptionId",
  tv."marketPolicyDispatchConsumptionId",
  mi."decisionId" AS "marketPolicyDispatchDecisionId",
  tv."authorizationDeadlineAt" AS "tradingViewDeadlineAt",
  d."dispatchExpiresAt" AS "marketPolicyDeadlineAt",
  least(tv."authorizationDeadlineAt", d."dispatchExpiresAt") AS "effectiveDeadlineAt",
  array_remove(ARRAY[
    CASE WHEN mi.id IS NULL THEN 'MISSING_MI_CONSUMPTION' END,
    CASE WHEN d.id IS NULL THEN 'MISSING_MI_DECISION' END,
    CASE WHEN mi."orderIntentId" IS DISTINCT FROM tv."orderIntentId" THEN 'MI_INTENT_MISMATCH' END,
    CASE WHEN d."orderIntentId" IS DISTINCT FROM tv."orderIntentId" THEN 'DECISION_INTENT_MISMATCH' END,
    CASE WHEN d.id IS NOT NULL AND (d.outcome <> 'ALLOWED' OR d."dispatchDisposition" <> 'DISPATCH_AUTHORIZED') THEN 'DECISION_NOT_ALLOWED' END,
    CASE WHEN d."dispatchExpiresAt" IS NULL OR d."dispatchExpiresAt" <= d."evaluatedAt" THEN 'INVALID_MI_EXPIRY' END,
    CASE WHEN tv."authorizationDeadlineAt" <= tv."authorizedAt" THEN 'INVALID_TV_EXPIRY' END,
    CASE WHEN least(tv."authorizationDeadlineAt", d."dispatchExpiresAt") <= clock_timestamp() THEN 'PAIR_EXPIRED' END,
    CASE WHEN d."dispatchExpiresAt" < tv."authorizationDeadlineAt" THEN 'MI_EXPIRES_BEFORE_TV' END
  ], NULL) AS findings
FROM "ExternalSignalBrokerDispatchConsumption" tv
LEFT JOIN "MarketPolicyBrokerDispatchConsumption" mi ON mi.id = tv."marketPolicyDispatchConsumptionId"
LEFT JOIN "MarketPolicyBrokerDispatchDecision" d ON d.id = mi."decisionId";

DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "ExternalSignalBrokerDispatchPairDeadlineAudit"
  WHERE findings && ARRAY['MISSING_MI_CONSUMPTION','MISSING_MI_DECISION','MI_INTENT_MISMATCH','DECISION_INTENT_MISMATCH','DECISION_NOT_ALLOWED','INVALID_MI_EXPIRY','INVALID_TV_EXPIRY']::text[];
  IF bad <> 0 THEN
    RAISE EXCEPTION 'C3C.1A historical-pair audit found % structurally invalid pair(s); explicit remediation is required', bad;
  END IF;
END $$;

-- Future C3B.2 authorization is bounded by both immutable clocks and preserves five seconds for F.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('external_signal_broker_consumption_guard()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%stamp >= d."dispatchExpiresAt" - interval ''2 seconds''%'
     OR definition NOT LIKE '%least(receipt + make_interval(secs => 120), stamp + make_interval(secs => 30))%' THEN
    RAISE EXCEPTION 'unexpected C3B.2 finalization guard; refuse to apply C3C.1A tightening';
  END IF;
  definition := replace(definition,
    'stamp >= d."dispatchExpiresAt" - interval ''2 seconds''',
    'stamp >= d."dispatchExpiresAt" - external_signal_c3c_f_minimum_remaining()');
  definition := replace(definition,
    'least(receipt + make_interval(secs => 120), stamp + make_interval(secs => 30))',
    'least(receipt + make_interval(secs => 120), stamp + make_interval(secs => 30), d."dispatchExpiresAt")');
  EXECUTE definition;
END $$;

CREATE TYPE "ExternalSignalBrokerSendResolutionOutcome" AS ENUM ('CONSUMED', 'WITHDRAWN_NEVER_SENT');

CREATE TABLE "ExternalSignalBrokerSendPermission" (
  id SERIAL PRIMARY KEY,
  "orderIntentId" INTEGER NOT NULL UNIQUE,
  "tradingViewDispatchConsumptionId" INTEGER NOT NULL,
  "marketPolicyDispatchConsumptionId" INTEGER NOT NULL,
  "marketPolicyDispatchDecisionId" INTEGER NOT NULL,
  "executionObligationId" INTEGER NOT NULL,
  "workerClaimId" INTEGER NOT NULL UNIQUE,
  "entryExposureClaimId" INTEGER NOT NULL UNIQUE,
  "tradingAccountId" INTEGER NOT NULL,
  "securityId" INTEGER NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "executionAuthorizationId" INTEGER NOT NULL,
  "effectiveDeadlineAt" TIMESTAMPTZ NOT NULL,
  "prePermissionFenceVersion" BIGINT NOT NULL,
  "permittedAt" TIMESTAMPTZ NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  CONSTRAINT "ExternalSignalBrokerSendPerm_tvConsumptionId_key" UNIQUE ("tradingViewDispatchConsumptionId"),
  CONSTRAINT "ExternalSignalBrokerSendPerm_miConsumptionId_key" UNIQUE ("marketPolicyDispatchConsumptionId"),
  CONSTRAINT "ExternalSignalBrokerSendPerm_miDecisionId_key" UNIQUE ("marketPolicyDispatchDecisionId"),
  CONSTRAINT "ExternalSignalBrokerSendPerm_executionObligationId_key" UNIQUE ("executionObligationId")
);
CREATE INDEX "ExternalSignalBrokerSendPerm_account_security_idx" ON "ExternalSignalBrokerSendPermission"("tradingAccountId","securityId");
CREATE INDEX "ExternalSignalBrokerSendPermission_effectiveDeadlineAt_idx" ON "ExternalSignalBrokerSendPermission"("effectiveDeadlineAt");

CREATE TABLE "ExternalSignalBrokerSendResolution" (
  id SERIAL PRIMARY KEY,
  "orderIntentId" INTEGER NOT NULL UNIQUE,
  "permissionId" INTEGER UNIQUE,
  "tradingViewDispatchConsumptionId" INTEGER NOT NULL,
  "marketPolicyDispatchConsumptionId" INTEGER NOT NULL,
  outcome "ExternalSignalBrokerSendResolutionOutcome" NOT NULL,
  "resolvedAt" TIMESTAMPTZ NOT NULL,
  "evidenceJson" JSONB NOT NULL,
  CONSTRAINT "ExternalSignalBrokerSendResolution_permission_outcome_check" CHECK (
    (outcome = 'CONSUMED' AND "permissionId" IS NOT NULL) OR
    (outcome = 'WITHDRAWN_NEVER_SENT')
  ),
  CONSTRAINT "ExternalSignalBrokerSendRes_tvConsumptionId_key" UNIQUE ("tradingViewDispatchConsumptionId"),
  CONSTRAINT "ExternalSignalBrokerSendRes_miConsumptionId_key" UNIQUE ("marketPolicyDispatchConsumptionId")
);

ALTER TABLE "ExternalSignalBrokerSendPermission"
  ADD CONSTRAINT "ExternalSignalBrokerSendPermission_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendPerm_tvConsumptionId_fkey" FOREIGN KEY ("tradingViewDispatchConsumptionId") REFERENCES "ExternalSignalBrokerDispatchConsumption"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendPerm_miConsumptionId_fkey" FOREIGN KEY ("marketPolicyDispatchConsumptionId") REFERENCES "MarketPolicyBrokerDispatchConsumption"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendPerm_miDecisionId_fkey" FOREIGN KEY ("marketPolicyDispatchDecisionId") REFERENCES "MarketPolicyBrokerDispatchDecision"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendPerm_executionObligationId_fkey" FOREIGN KEY ("executionObligationId") REFERENCES "ExternalSignalEntryExecutionObligation"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendPermission_workerClaimId_fkey" FOREIGN KEY ("workerClaimId") REFERENCES "ExternalSignalBrokerWorkerClaim"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendPermission_entryExposureClaimId_fkey" FOREIGN KEY ("entryExposureClaimId") REFERENCES "EntryExposureClaim"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendPermission_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "TradingAccount"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendPermission_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendPerm_executionAuthorizationId_fkey" FOREIGN KEY ("executionAuthorizationId") REFERENCES "ExternalSignalEntryExecutionAuthorization"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE "ExternalSignalBrokerSendResolution"
  ADD CONSTRAINT "ExternalSignalBrokerSendResolution_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendResolution_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "ExternalSignalBrokerSendPermission"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendRes_tvConsumptionId_fkey" FOREIGN KEY ("tradingViewDispatchConsumptionId") REFERENCES "ExternalSignalBrokerDispatchConsumption"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "ExternalSignalBrokerSendRes_miConsumptionId_fkey" FOREIGN KEY ("marketPolicyDispatchConsumptionId") REFERENCES "MarketPolicyBrokerDispatchConsumption"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE FUNCTION external_signal_broker_send_evidence_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP; END $$;

CREATE TRIGGER "ExternalSignalBrokerSendPermission_immutable" BEFORE UPDATE OR DELETE ON "ExternalSignalBrokerSendPermission"
  FOR EACH ROW EXECUTE FUNCTION external_signal_broker_send_evidence_immutable();
CREATE TRIGGER "ExternalSignalBrokerSendPermission_truncate_guard" BEFORE TRUNCATE ON "ExternalSignalBrokerSendPermission"
  FOR EACH STATEMENT EXECUTE FUNCTION external_signal_broker_send_evidence_immutable();
CREATE TRIGGER "ExternalSignalBrokerSendResolution_immutable" BEFORE UPDATE OR DELETE ON "ExternalSignalBrokerSendResolution"
  FOR EACH ROW EXECUTE FUNCTION external_signal_broker_send_evidence_immutable();
CREATE TRIGGER "ExternalSignalBrokerSendResolution_truncate_guard" BEFORE TRUNCATE ON "ExternalSignalBrokerSendResolution"
  FOR EACH STATEMENT EXECUTE FUNCTION external_signal_broker_send_evidence_immutable();

-- F and P are separate commits. Both must therefore evaluate the same mutable authority after taking the
-- canonical dispatch-graph locks. This function is intentionally not granted to the runtime role and is only
-- called from trigger functions. It does not write evidence or advance the fence.
CREATE FUNCTION external_signal_validate_current_send_authority(p_intent_id integer, p_decision_id integer) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o "ExternalSignalEntryExecutionObligation"%ROWTYPE; i "OrderIntent"%ROWTYPE; sig "Signal"%ROWTYPE;
  ac "ExternalSignalTradeCycleAccount"%ROWTYPE; ta "TradingAccount"%ROWTYPE; tas "TradingAccountSubscription"%ROWTYPE;
  sub "Subscription"%ROWTYPE; auth "ExternalSignalEntryExecutionAuthorization"%ROWTYPE;
  execution_state "ExternalSignalExecutionRolloutState"%ROWTYPE; dispatch_state "ExternalSignalBrokerDispatchState"%ROWTYPE;
  wc "ExternalSignalBrokerWorkerClaim"%ROWTYPE; claim "EntryExposureClaim"%ROWTYPE;
  d "MarketPolicyBrokerDispatchDecision"%ROWTYPE; mo "OrderIntentMarketPolicyEnforcementObligation"%ROWTYPE;
  mi_rollout "MarketPolicyEnforcementRuntimeRollout"%ROWTYPE;
  mi_generation "AssignmentMarketPolicyEnrollmentGeneration"%ROWTYPE;
  mi_auth "AssignmentMarketPolicyEnforcementAuthorization"%ROWTYPE;
  flag boolean; stamp timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO o FROM "ExternalSignalEntryExecutionObligation" WHERE "orderIntentId"=p_intent_id;
  SELECT * INTO i FROM "OrderIntent" WHERE id=p_intent_id;
  IF o.id IS NULL OR i.id IS NULL THEN RAISE EXCEPTION 'TRADINGVIEW_CURRENT_AUTHORITY_GRAPH_MISSING'; END IF;
  SELECT * INTO sig FROM "Signal" WHERE id=o."entrySignalId";
  SELECT * INTO ac FROM "ExternalSignalTradeCycleAccount" WHERE id=o."accountCycleId";
  SELECT * INTO ta FROM "TradingAccount" WHERE id=i."tradingAccountId";
  SELECT * INTO tas FROM "TradingAccountSubscription" WHERE id=i."tradingAccountSubscriptionId";
  SELECT * INTO sub FROM "Subscription" WHERE id=i."subscriptionId";
  SELECT * INTO auth FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=o."authorizationId";
  SELECT * INTO execution_state FROM "ExternalSignalExecutionRolloutState" WHERE id=1;
  SELECT * INTO dispatch_state FROM "ExternalSignalBrokerDispatchState" WHERE id=1;
  SELECT * INTO wc FROM "ExternalSignalBrokerWorkerClaim" WHERE "orderIntentId"=p_intent_id;
  SELECT * INTO claim FROM "EntryExposureClaim" WHERE "orderIntentId"=p_intent_id;
  SELECT * INTO d FROM "MarketPolicyBrokerDispatchDecision" WHERE id=p_decision_id;
  SELECT * INTO mo FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=p_intent_id FOR SHARE;
  SELECT * INTO mi_rollout FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id=1 FOR SHARE;
  IF d."enrollmentGenerationId" IS NOT NULL THEN SELECT * INTO mi_generation FROM "AssignmentMarketPolicyEnrollmentGeneration" WHERE id=d."enrollmentGenerationId" FOR SHARE; END IF;
  IF d."authorizationId" IS NOT NULL THEN SELECT * INTO mi_auth FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=d."authorizationId" FOR SHARE; END IF;

  SELECT enabled INTO flag FROM "ExternalSignalSource" WHERE id=sig."signalSourceId";
  IF NOT coalesce(flag,false) THEN RAISE EXCEPTION 'TRADINGVIEW_SOURCE_DISABLED'; END IF;
  SELECT enabled INTO flag FROM "StrategySignalBinding" WHERE id=sig."strategySignalBindingId";
  IF NOT coalesce(flag,false) THEN RAISE EXCEPTION 'TRADINGVIEW_BINDING_DISABLED'; END IF;
  SELECT status='ACTIVE' AND "authorityMode"='TRADE_ELIGIBLE' INTO flag FROM "StrategySignalRevision" WHERE id=sig."strategySignalRevisionId";
  IF NOT coalesce(flag,false) THEN RAISE EXCEPTION 'TRADINGVIEW_REVISION_NOT_TRADE_ELIGIBLE'; END IF;
  SELECT enabled AND direction='ENTRY' AND "authorityMode"='EXECUTE' INTO flag FROM "ExternalSignalExecutionRolloutGeneration" WHERE id=o."rolloutGenerationId";
  IF NOT coalesce(flag,false) OR execution_state."activeRolloutGenerationId" IS DISTINCT FROM o."rolloutGenerationId" THEN RAISE EXCEPTION 'TRADINGVIEW_EXECUTION_ROLLOUT_NOT_CURRENT'; END IF;
  IF dispatch_state."activeRolloutGenerationId" IS DISTINCT FROM o."rolloutGenerationId" OR dispatch_state."activatedAt" IS NULL OR dispatch_state.version <> wc."dispatchStateVersion" THEN RAISE EXCEPTION 'TRADINGVIEW_DISPATCH_STATE_CHANGED'; END IF;

  IF ta.environment <> 'PAPER' OR ta.status <> 'ACTIVE' OR NOT ta."tradingEnabled" OR ta."killSwitchEnabled" OR coalesce(ta."tradingBlocked",false) THEN RAISE EXCEPTION 'TRADINGVIEW_ACCOUNT_NOT_ELIGIBLE'; END IF;
  IF NOT tas.enabled OR NOT tas."entriesEnabled" OR tas."tradingAccountId"<>ta.id OR tas."subscriptionId"<>sub.id THEN RAISE EXCEPTION 'TRADINGVIEW_ASSIGNMENT_NOT_ELIGIBLE'; END IF;
  IF NOT sub.enabled THEN RAISE EXCEPTION 'TRADINGVIEW_SUBSCRIPTION_DISABLED'; END IF;
  SELECT enabled INTO flag FROM "Strategy" WHERE id=sub."strategyId"; IF NOT coalesce(flag,false) THEN RAISE EXCEPTION 'TRADINGVIEW_STRATEGY_DISABLED'; END IF;
  SELECT enabled INTO flag FROM "Security" WHERE id=sub."securityId"; IF NOT coalesce(flag,false) THEN RAISE EXCEPTION 'TRADINGVIEW_SECURITY_DISABLED'; END IF;
  SELECT enabled INTO flag FROM "ExitProfile" WHERE id=sub."exitProfileId"; IF NOT coalesce(flag,false) THEN RAISE EXCEPTION 'TRADINGVIEW_EXIT_PROFILE_DISABLED'; END IF;
  IF tas."allocationId" IS NOT NULL THEN SELECT enabled AND "tradingAccountId"=ta.id INTO flag FROM "TradingAccountAllocation" WHERE id=tas."allocationId"; IF NOT coalesce(flag,false) THEN RAISE EXCEPTION 'TRADINGVIEW_ALLOCATION_NOT_ELIGIBLE'; END IF; END IF;

  IF auth.id IS NULL OR auth.status<>'AUTHORIZED' OR auth."rolloutGenerationId"<>o."rolloutGenerationId" OR auth."tradingAccountId"<>ta.id
     OR auth."tradingAccountSubscriptionId"<>tas.id OR auth."subscriptionId"<>sub.id OR auth."securityId"<>sub."securityId"
     OR auth."authorizationFingerprint" IS DISTINCT FROM o."authorizationFingerprint" THEN RAISE EXCEPTION 'TRADINGVIEW_AUTHORIZATION_NOT_EFFECTIVE'; END IF;
  IF ROW(i."externalSignalAccountCycleId",i."tradingAccountSubscriptionId",i."subscriptionId",i."tradingAccountId",i.side,i.source,i.status,i."clientOrderId") IS DISTINCT FROM
     ROW(ac.id,tas.id,sub.id,ta.id,'buy'::text,'tradingview'::text,'submitting'::text,o."clientOrderId") THEN RAISE EXCEPTION 'TRADINGVIEW_INTENT_NOT_EXECUTABLE'; END IF;
  IF wc.id IS NULL OR ROW(wc."executionObligationId",wc."accountCycleId",wc."rolloutGenerationId",wc."clientOrderId") IS DISTINCT FROM ROW(o.id,ac.id,o."rolloutGenerationId",o."clientOrderId") THEN RAISE EXCEPTION 'TRADINGVIEW_WORKER_CLAIM_INVALID'; END IF;
  IF claim.id IS NULL OR claim.status<>'ENTRY_SUBMITTING' OR claim."releasedAt" IS NOT NULL OR claim."trackedPositionId" IS NOT NULL OR claim."tradingAccountId"<>ta.id OR claim."securityId"<>sub."securityId" THEN RAISE EXCEPTION 'TRADINGVIEW_CLAIM_STATE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=claim.id AND e."eventType"='WORKER_CLAIMED_FOR_SUBMISSION' AND (e."evidenceJson"->>'workerClaimId')::integer=wc.id) THEN RAISE EXCEPTION 'TRADINGVIEW_WORKER_CLAIM_INVALID'; END IF;
  IF EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=claim.id AND e."eventType" IN ('NOT_SENT_EVIDENCE_RECORDED','ADAPTER_INVOCATION_STARTED','DISPATCH_OUTCOME_RECORDED','BROKER_DELIVERY_UNCERTAIN')) THEN RAISE EXCEPTION 'TRADINGVIEW_CONTRADICTORY_EVIDENCE'; END IF;
  IF EXISTS (SELECT 1 FROM "TrackedPosition" p WHERE p."tradingAccountId"=ta.id AND p."securityId"=sub."securityId" AND p.status='open') THEN RAISE EXCEPTION 'TRADINGVIEW_OPEN_POSITION_EXISTS'; END IF;
  IF ac."pendingExitAcceptedAt" IS NOT NULL OR ac."terminalAt" IS NOT NULL OR EXISTS (SELECT 1 FROM "Signal" x WHERE x."externalSignalTradeCycleId"=o."sourceCycleId" AND x.event='EXIT_LONG') THEN RAISE EXCEPTION 'TRADINGVIEW_EXIT_ACCEPTED'; END IF;

  IF NOT mi_rollout.enabled OR mi_rollout.environment<>'PAPER' THEN RAISE EXCEPTION 'TRADINGVIEW_MI_RUNTIME_INACTIVE'; END IF;
  IF mo.id IS NULL OR d.id IS NULL OR d."obligationId" IS DISTINCT FROM mo.id OR d."authorizationId" IS DISTINCT FROM mo."authorizationId"
     OR d."authorizationFingerprint" IS DISTINCT FROM mo."authorizationFingerprint" OR d."authorityVersion" IS DISTINCT FROM mo."authorityVersion"
     OR d."policyRevisionId" IS DISTINCT FROM mo."policyRevisionId" OR d."enrollmentGenerationId" IS DISTINCT FROM mo."enrollmentGenerationId" THEN RAISE EXCEPTION 'TRADINGVIEW_MI_OBLIGATION_MISMATCH'; END IF;
  IF mi_generation.id IS NULL OR mi_generation.status<>'ACTIVE' OR mi_generation."policyRevisionId"<>mo."policyRevisionId" OR mi_generation."accountSubscriptionId"<>tas.id THEN RAISE EXCEPTION 'TRADINGVIEW_MI_ENROLLMENT_INACTIVE'; END IF;
  IF mi_auth.id IS NULL OR mi_auth.status<>'AUTHORIZED' OR mi_auth."enrollmentGenerationId"<>mi_generation.id OR mi_auth."authorizationFingerprint" IS DISTINCT FROM mo."authorizationFingerprint"
     OR mi_auth."authorityVersion" IS DISTINCT FROM mo."authorityVersion" OR mi_auth."subscriptionId" IS DISTINCT FROM sub.id OR mi_auth."securityId" IS DISTINCT FROM sub."securityId"
     OR mi_auth.id IS DISTINCT FROM (SELECT a.id FROM "AssignmentMarketPolicyEnforcementAuthorization" a WHERE a."accountSubscriptionId"=tas.id ORDER BY a.id DESC LIMIT 1) THEN RAISE EXCEPTION 'TRADINGVIEW_MI_AUTHORIZATION_NOT_CURRENT'; END IF;
  SELECT r.status='ACTIVE' AND p."strategyId"=sub."strategyId" INTO flag FROM "StrategyMarketPolicyRevision" r JOIN "StrategyMarketPolicy" p ON p.id=r."policyId" WHERE r.id=mo."policyRevisionId" FOR SHARE;
  IF NOT coalesce(flag,false) THEN RAISE EXCEPTION 'TRADINGVIEW_MI_POLICY_REVISION_INACTIVE'; END IF;
  IF d.id IS DISTINCT FROM (SELECT x.id FROM "MarketPolicyBrokerDispatchDecision" x WHERE x."orderIntentId"=p_intent_id ORDER BY x."dispatchSequence" DESC,x.id DESC LIMIT 1)
     OR d.outcome<>'ALLOWED' OR d."dispatchDisposition"<>'DISPATCH_AUTHORIZED' OR d."dispatchExpiresAt" IS NULL OR d."validUntil" IS NULL
     OR stamp>=d."dispatchExpiresAt" OR stamp>=d."validUntil" THEN RAISE EXCEPTION 'TRADINGVIEW_DECISION_NOT_AUTHORIZED'; END IF;
END $$;

-- Keep F and P on the same mutable-state validator. The replacement is pinned to the reviewed F body.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('external_signal_broker_consumption_guard()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%stamp := clock_timestamp();%' THEN RAISE EXCEPTION 'unexpected C3B.2 finalization guard clock'; END IF;
  definition := replace(definition, 'stamp := clock_timestamp();', 'stamp := clock_timestamp(); PERFORM external_signal_validate_current_send_authority(NEW."orderIntentId", mi."decisionId");');
  EXECUTE definition;
END $$;

-- Transaction P database guard. Every identity and state check follows the accepted canonical lock prelude. The caller supplies
-- only immutable identity, the expected pre-permission fence version, and evidence; database time/deadline are never caller clocks.
CREATE FUNCTION external_signal_broker_send_permission_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  tv "ExternalSignalBrokerDispatchConsumption"%ROWTYPE;
  mi "MarketPolicyBrokerDispatchConsumption"%ROWTYPE;
  d "MarketPolicyBrokerDispatchDecision"%ROWTYPE;
  o "ExternalSignalEntryExecutionObligation"%ROWTYPE;
  wc "ExternalSignalBrokerWorkerClaim"%ROWTYPE;
  c "EntryExposureClaim"%ROWTYPE;
  i "OrderIntent"%ROWTYPE;
  ac "ExternalSignalTradeCycleAccount"%ROWTYPE;
  auth "ExternalSignalEntryExecutionAuthorization"%ROWTYPE;
  ds "ExternalSignalBrokerDispatchState"%ROWTYPE;
  fence_v bigint;
  stamp timestamptz;
  effective_deadline timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'TradingView broker send permission is immutable'; END IF;
  IF NEW."permittedAt" IS NOT NULL OR NEW."effectiveDeadlineAt" IS NOT NULL THEN
    RAISE EXCEPTION 'permittedAt and effectiveDeadlineAt are database-stamped and cannot be supplied';
  END IF;
  SELECT * INTO tv FROM "ExternalSignalBrokerDispatchConsumption" WHERE id=NEW."tradingViewDispatchConsumptionId";
  SELECT * INTO mi FROM "MarketPolicyBrokerDispatchConsumption" WHERE id=NEW."marketPolicyDispatchConsumptionId";
  IF tv.id IS NULL OR mi.id IS NULL THEN RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_PAIR_MISSING'; END IF;
  PERFORM external_signal_lock_dispatch_graph(NEW."orderIntentId", mi."decisionId");
  SELECT version INTO fence_v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=NEW."orderIntentId" FOR UPDATE;
  SELECT * INTO o FROM "ExternalSignalEntryExecutionObligation" WHERE id=NEW."executionObligationId" FOR SHARE;
  SELECT * INTO wc FROM "ExternalSignalBrokerWorkerClaim" WHERE id=NEW."workerClaimId" FOR SHARE;
  SELECT * INTO d FROM "MarketPolicyBrokerDispatchDecision" WHERE id=NEW."marketPolicyDispatchDecisionId" FOR SHARE;
  SELECT * INTO i FROM "OrderIntent" WHERE id=NEW."orderIntentId";
  SELECT * INTO c FROM "EntryExposureClaim" WHERE id=NEW."entryExposureClaimId";
  SELECT * INTO ac FROM "ExternalSignalTradeCycleAccount" WHERE id=o."accountCycleId";
  SELECT * INTO auth FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=NEW."executionAuthorizationId";
  SELECT * INTO ds FROM "ExternalSignalBrokerDispatchState" WHERE id=1;
  stamp := clock_timestamp();

  PERFORM external_signal_validate_current_send_authority(NEW."orderIntentId", d.id);

  IF NEW."prePermissionFenceVersion" IS NULL OR fence_v IS DISTINCT FROM NEW."prePermissionFenceVersion" THEN
    RAISE EXCEPTION 'TradingView permission dispatch fence version is stale or missing (supplied %, current %)', NEW."prePermissionFenceVersion", fence_v;
  END IF;
  IF tv."orderIntentId" <> NEW."orderIntentId" OR tv."marketPolicyDispatchConsumptionId" <> mi.id
     OR mi."orderIntentId" <> NEW."orderIntentId" OR mi."decisionId" <> d.id THEN
    RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_PAIR_INCONSISTENT';
  END IF;
  IF d.outcome <> 'ALLOWED' OR d."dispatchDisposition" <> 'DISPATCH_AUTHORIZED' OR d."dispatchExpiresAt" IS NULL
     OR d."clientOrderId" <> NEW."clientOrderId" THEN RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_DECISION_INVALID'; END IF;
  IF o.id IS NULL OR wc.id IS NULL OR c.id IS NULL OR i.id IS NULL OR ac.id IS NULL OR auth.id IS NULL THEN
    RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_IDENTITY_MISSING';
  END IF;
  IF ROW(tv."executionObligationId",tv."workerClaimId",tv."executionAuthorizationId",tv."clientOrderId") IS DISTINCT FROM
     ROW(o.id,wc.id,auth.id,NEW."clientOrderId")
     OR ROW(o."orderIntentId",o."authorizationId",o."clientOrderId") IS DISTINCT FROM ROW(i.id,auth.id,NEW."clientOrderId")
     OR ROW(wc."orderIntentId",wc."executionObligationId",wc."accountCycleId",wc."clientOrderId") IS DISTINCT FROM ROW(i.id,o.id,o."accountCycleId",NEW."clientOrderId") THEN
    RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_FROZEN_IDENTITY_MISMATCH';
  END IF;
  IF ROW(NEW."tradingAccountId",NEW."securityId") IS DISTINCT FROM ROW(i."tradingAccountId",ac."securityId")
     OR i."clientOrderId" IS DISTINCT FROM NEW."clientOrderId" OR i.side <> 'buy' OR i.source <> 'tradingview'
     OR i.status <> 'submitting' OR i."externalSignalAccountCycleId" IS DISTINCT FROM ac.id THEN
    RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_INTENT_INVALID';
  END IF;
  IF c."orderIntentId" IS DISTINCT FROM i.id OR c."tradingAccountId" <> NEW."tradingAccountId" OR c."securityId" <> NEW."securityId"
     OR c.status <> 'ENTRY_SUBMITTING' OR c."releasedAt" IS NOT NULL OR c."trackedPositionId" IS NOT NULL THEN
    RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_CLAIM_INVALID';
  END IF;
  IF auth.status <> 'AUTHORIZED' OR auth.id <> o."authorizationId" OR auth."authorizationFingerprint" IS DISTINCT FROM o."authorizationFingerprint"
     OR ds."activeRolloutGenerationId" IS DISTINCT FROM o."rolloutGenerationId" OR ds.version <> tv."dispatchStateVersion" THEN
    RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_AUTHORIZATION_NOT_CURRENT';
  END IF;
  IF ac."pendingExitAcceptedAt" IS NOT NULL OR ac."terminalAt" IS NOT NULL
     OR EXISTS (SELECT 1 FROM "Signal" s WHERE s."externalSignalTradeCycleId"=o."sourceCycleId" AND s.event='EXIT_LONG') THEN
    RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_EXIT_OR_TERMINAL';
  END IF;
  IF EXISTS (SELECT 1 FROM "ExternalSignalBrokerSendResolution" r WHERE r."orderIntentId"=i.id)
     OR EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=c.id AND e."eventType" IN ('ADAPTER_INVOCATION_STARTED','NOT_SENT_EVIDENCE_RECORDED','DISPATCH_OUTCOME_RECORDED','BROKER_DELIVERY_UNCERTAIN'))
     OR EXISTS (SELECT 1 FROM external_signal_marked_intent_broker_evidence(i.id)) THEN
    RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_PRIOR_RESOLUTION_OR_BROKER_EVIDENCE';
  END IF;
  effective_deadline := least(tv."authorizationDeadlineAt", d."dispatchExpiresAt");
  IF effective_deadline IS NULL OR effective_deadline - stamp < external_signal_c3c_p_minimum_remaining() THEN
    RAISE EXCEPTION 'TRADINGVIEW_PERMISSION_DEADLINE_INSUFFICIENT';
  END IF;
  NEW."permittedAt" := stamp;
  NEW."effectiveDeadlineAt" := effective_deadline;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalBrokerSendPermission_a_guard" BEFORE INSERT ON "ExternalSignalBrokerSendPermission"
  FOR EACH ROW EXECUTE FUNCTION external_signal_broker_send_permission_guard();

CREATE TRIGGER "ExternalSignalBrokerSendPermission_zz_a_fence_bump" AFTER INSERT ON "ExternalSignalBrokerSendPermission"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_order_ref();
CREATE FUNCTION external_signal_broker_send_permission_fence_verify() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v bigint;
BEGIN
  SELECT version INTO v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=NEW."orderIntentId";
  IF v IS DISTINCT FROM NEW."prePermissionFenceVersion" + 1 THEN
    RAISE EXCEPTION 'TradingView permission fence did not advance exactly once (stored %, current %)', NEW."prePermissionFenceVersion", v;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "ExternalSignalBrokerSendPermission_zz_b_fence_verify" AFTER INSERT ON "ExternalSignalBrokerSendPermission"
  FOR EACH ROW EXECUTE FUNCTION external_signal_broker_send_permission_fence_verify();

-- C3C.1A has no complete Transaction A / withdrawal protocol. Keep the schema and immutable protections,
-- but fail closed on every insert. C3C.1B will replace this blanket denial after independent review.
CREATE FUNCTION external_signal_broker_send_resolution_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'TRADINGVIEW_RESOLUTION_DISABLED_C3C1A';
END $$;
CREATE TRIGGER "ExternalSignalBrokerSendResolution_a_guard" BEFORE INSERT ON "ExternalSignalBrokerSendResolution"
  FOR EACH ROW EXECUTE FUNCTION external_signal_broker_send_resolution_guard();

-- Broker evidence is claim-free. Resolve with the existing account-scoped attribution key, lock every affected OrderIntent
-- FOR KEY SHARE in ascending ID order, and only then call the unchanged fence increment helper. Production transactions
-- that touch both objects must acquire OrderIntent before mutating EntryExposureClaim / its fence. Claim-first followed by
-- OrderIntent FOR UPDATE is an unsupported direct-SQL order and can deadlock with broker evidence; the scoped helper cannot
-- reverse its own order without deadlocking the supported intent -> claim -> fence production sequence.
CREATE FUNCTION external_signal_broker_evidence_fence_advance(p_intent_ids integer[]) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ids integer[];
BEGIN
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::integer[]) INTO ids
  FROM (SELECT DISTINCT u.x FROM unnest(p_intent_ids) u(x) WHERE u.x IS NOT NULL) q;
  PERFORM 1 FROM "OrderIntent" i WHERE i.id=ANY(ids) ORDER BY i.id FOR KEY SHARE;
  PERFORM external_signal_dispatch_fence_advance(ids);
END $$;
CREATE OR REPLACE FUNCTION external_signal_dispatch_fence_bump_broker_order() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ids integer[] := ARRAY[]::integer[];
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') THEN ids := ids || ARRAY(SELECT m FROM external_signal_broker_evidence_marked_intents(NEW."orderIntentId",NEW."clientOrderId",NEW."brokerOrderId",NEW."tradingAccountId") m); END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND ROW(NEW."orderIntentId",NEW."clientOrderId",NEW."brokerOrderId",NEW."tradingAccountId") IS DISTINCT FROM ROW(OLD."orderIntentId",OLD."clientOrderId",OLD."brokerOrderId",OLD."tradingAccountId")) THEN
    ids := ids || ARRAY(SELECT m FROM external_signal_broker_evidence_marked_intents(OLD."orderIntentId",OLD."clientOrderId",OLD."brokerOrderId",OLD."tradingAccountId") m);
  END IF;
  PERFORM external_signal_broker_evidence_fence_advance(ids); RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION external_signal_dispatch_fence_bump_broker_activity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ids integer[] := ARRAY[]::integer[];
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') THEN ids := ids || ARRAY(SELECT m FROM external_signal_broker_evidence_marked_intents(NEW."orderIntentId",NULL,NEW."orderId",NEW."tradingAccountId",NEW."brokerOrderRecordId") m); END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND ROW(NEW."orderIntentId",NEW."orderId",NEW."tradingAccountId",NEW."brokerOrderRecordId") IS DISTINCT FROM ROW(OLD."orderIntentId",OLD."orderId",OLD."tradingAccountId",OLD."brokerOrderRecordId")) THEN
    ids := ids || ARRAY(SELECT m FROM external_signal_broker_evidence_marked_intents(OLD."orderIntentId",NULL,OLD."orderId",OLD."tradingAccountId",OLD."brokerOrderRecordId") m);
  END IF;
  PERFORM external_signal_broker_evidence_fence_advance(ids); RETURN NULL;
END $$;

-- Restate the trusted search-path audit for every application function.
DO $$
DECLARE item record; trusted text := format('search_path=pg_catalog, %I, pg_temp', current_schema()); unpinned integer;
BEGIN
  FOR item IN SELECT p.oid::regprocedure signature,p.prokind,(SELECT c FROM unnest(coalesce(p.proconfig,ARRAY[]::text[])) c WHERE c LIKE 'search_path=%') existing_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=current_schema() AND p.prokind IN ('f','p') AND l.lanname NOT IN ('c','internal')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') ORDER BY p.oid
  LOOP
    IF item.existing_path IS NOT NULL AND item.existing_path IS DISTINCT FROM trusted THEN RAISE EXCEPTION 'function % pins unexpected %',item.signature,item.existing_path; END IF;
    EXECUTE format('ALTER %s %s SET search_path = pg_catalog, %I, pg_temp',CASE item.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,item.signature,current_schema());
  END LOOP;
  SELECT count(*) INTO unpinned FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=current_schema() AND p.prokind IN ('f','p') AND l.lanname NOT IN ('c','internal')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      AND NOT (trusted=ANY(coalesce(p.proconfig,ARRAY[]::text[])));
  IF unpinned<>0 THEN RAISE EXCEPTION '% application functions still lack the trusted search_path',unpinned; END IF;
END $$;
