-- Phase 4A.2C1: inert TradingView PAPER broker-dispatch safety foundation.
-- This migration grants no dispatch path and deliberately keeps the marked-intent quarantine closed.
CREATE TYPE "ExternalSignalBrokerDispatchAction" AS ENUM ('ACTIVATE', 'DEACTIVATE');

CREATE TABLE "ExternalSignalBrokerDispatchState" (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  "activeRolloutGenerationId" INTEGER UNIQUE REFERENCES "ExternalSignalExecutionRolloutGeneration"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "activatedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ExternalSignalBrokerDispatchState_singleton_check" CHECK (id=1 AND version>0),
  CONSTRAINT "ExternalSignalBrokerDispatchState_active_check" CHECK (("activeRolloutGenerationId" IS NULL)=("activatedAt" IS NULL))
);
INSERT INTO "ExternalSignalBrokerDispatchState" (id,version,"updatedAt") VALUES (1,1,statement_timestamp());

CREATE TABLE "ExternalSignalBrokerDispatchActivation" (
  id SERIAL PRIMARY KEY,
  "rolloutGenerationId" INTEGER NOT NULL REFERENCES "ExternalSignalExecutionRolloutGeneration"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  action "ExternalSignalBrokerDispatchAction" NOT NULL,
  "stateVersion" INTEGER NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  "actorUserId" INTEGER NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ExternalSignalBrokerDispatchActivation_rolloutGenerationId_id_idx" ON "ExternalSignalBrokerDispatchActivation"("rolloutGenerationId",id);

CREATE FUNCTION external_signal_broker_dispatch_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g "ExternalSignalExecutionRolloutGeneration"%ROWTYPE; ds "ExternalSignalBrokerDispatchState"%ROWTYPE; es "ExternalSignalExecutionRolloutState"%ROWTYPE; owner_ok boolean;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'TradingView broker dispatch activation history is append-only'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);
  SELECT * INTO es FROM "ExternalSignalExecutionRolloutState" WHERE id=1 FOR UPDATE;
  SELECT * INTO ds FROM "ExternalSignalBrokerDispatchState" WHERE id=1 FOR UPDATE;
  SELECT enabled AND "platformRole"='SYSTEM_OWNER' INTO owner_ok FROM "User" WHERE id=NEW."actorUserId" FOR UPDATE;
  SELECT * INTO g FROM "ExternalSignalExecutionRolloutGeneration" WHERE id=NEW."rolloutGenerationId" FOR UPDATE;
  IF owner_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'SYSTEM_OWNER required'; END IF;
  IF btrim(NEW.reason)='' THEN RAISE EXCEPTION 'dispatch activation reason required'; END IF;
  IF g.id IS NULL OR g.direction<>'ENTRY' OR g."authorityMode"<>'EXECUTE' OR NOT g.enabled THEN RAISE EXCEPTION 'dispatch is restricted to enabled ENTRY EXECUTE generations'; END IF;
  NEW."createdAt":=statement_timestamp(); NEW."stateVersion":=ds.version+1;
  IF NEW.action='ACTIVATE' THEN
    IF ds."activeRolloutGenerationId" IS NOT NULL THEN RAISE EXCEPTION 'a TradingView broker dispatch generation is already active'; END IF;
    IF es."activeRolloutGenerationId" IS DISTINCT FROM g.id OR es."activatedAt" IS NULL THEN RAISE EXCEPTION 'exact execution generation must be active before dispatch activation'; END IF;
    -- The dispatch epoch starts now. Earlier signals, cycles, obligations, and intents remain ineligible.
  ELSE
    IF ds."activeRolloutGenerationId" IS DISTINCT FROM g.id THEN RAISE EXCEPTION 'only the active TradingView broker dispatch generation may deactivate'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalBrokerDispatchActivation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalBrokerDispatchActivation" FOR EACH ROW EXECUTE FUNCTION external_signal_broker_dispatch_activation_guard();

CREATE FUNCTION external_signal_broker_dispatch_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "ExternalSignalBrokerDispatchActivation"%ROWTYPE;
BEGIN
  -- Depth 2 is an explicit dispatch event; depth 3 is the same apply trigger nested beneath
  -- the ENTRY-deactivation coupling trigger. No caller-controlled direct update is accepted.
  IF TG_OP<>'UPDATE' OR pg_trigger_depth() NOT IN (2,3) THEN RAISE EXCEPTION 'TradingView broker dispatch state is database-owned'; END IF;
  SELECT * INTO e FROM "ExternalSignalBrokerDispatchActivation" ORDER BY id DESC LIMIT 1;
  IF e.id IS NULL OR NEW.version<>OLD.version+1 OR NEW.version<>e."stateVersion" OR NEW."updatedAt" IS DISTINCT FROM e."createdAt"
    OR (e.action='ACTIVATE' AND ROW(NEW."activeRolloutGenerationId",NEW."activatedAt") IS DISTINCT FROM ROW(e."rolloutGenerationId",e."createdAt"))
    OR (e.action='DEACTIVATE' AND ROW(NEW."activeRolloutGenerationId",NEW."activatedAt") IS DISTINCT FROM ROW(NULL::integer,NULL::timestamptz))
  THEN RAISE EXCEPTION 'TradingView broker dispatch state does not match its activation event'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalBrokerDispatchState_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalBrokerDispatchState" FOR EACH ROW EXECUTE FUNCTION external_signal_broker_dispatch_state_guard();

CREATE FUNCTION external_signal_broker_dispatch_activation_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ExternalSignalBrokerDispatchState" SET version=NEW."stateVersion",
    "activeRolloutGenerationId"=CASE WHEN NEW.action='ACTIVATE' THEN NEW."rolloutGenerationId" ELSE NULL END,
    "activatedAt"=CASE WHEN NEW.action='ACTIVATE' THEN NEW."createdAt" ELSE NULL END,"updatedAt"=NEW."createdAt" WHERE id=1;
  RETURN NULL;
END $$;
CREATE TRIGGER "ExternalSignalBrokerDispatchActivation_apply" AFTER INSERT ON "ExternalSignalBrokerDispatchActivation" FOR EACH ROW EXECUTE FUNCTION external_signal_broker_dispatch_activation_apply();

CREATE TABLE "ExternalSignalBrokerWorkerClaim" (
  id SERIAL PRIMARY KEY,
  "orderIntentId" INTEGER NOT NULL UNIQUE REFERENCES "OrderIntent"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "executionObligationId" INTEGER NOT NULL UNIQUE REFERENCES "ExternalSignalEntryExecutionObligation"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "accountCycleId" INTEGER NOT NULL UNIQUE REFERENCES "ExternalSignalTradeCycleAccount"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "rolloutGenerationId" INTEGER NOT NULL REFERENCES "ExternalSignalExecutionRolloutGeneration"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "dispatchStateVersion" INTEGER NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "claimFingerprint" TEXT NOT NULL UNIQUE,
  "claimedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalSignalBrokerWorkerClaim_fingerprint_check" CHECK ("claimFingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "ExternalSignalBrokerDispatchConsumption" (
  id SERIAL PRIMARY KEY,
  "orderIntentId" INTEGER NOT NULL UNIQUE REFERENCES "OrderIntent"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "executionObligationId" INTEGER NOT NULL UNIQUE REFERENCES "ExternalSignalEntryExecutionObligation"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "workerClaimId" INTEGER NOT NULL UNIQUE REFERENCES "ExternalSignalBrokerWorkerClaim"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "marketPolicyDispatchConsumptionId" INTEGER NOT NULL UNIQUE REFERENCES "MarketPolicyBrokerDispatchConsumption"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "rolloutGenerationId" INTEGER NOT NULL REFERENCES "ExternalSignalExecutionRolloutGeneration"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "executionAuthorizationId" INTEGER NOT NULL REFERENCES "ExternalSignalEntryExecutionAuthorization"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "dispatchStateVersion" INTEGER NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "brokerPostOpportunityId" INTEGER REFERENCES "OrderIntentBrokerPostOpportunity"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "consumedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evidenceJson" JSONB NOT NULL
);

CREATE FUNCTION external_signal_signal_v2_immutability_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."schemaVersion"=2 THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'accepted v2 Signal evidence cannot be deleted'; END IF;
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'accepted v2 Signal identity and timestamps are immutable'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER "Signal_v2_immutability_guard" BEFORE UPDATE OR DELETE ON "Signal" FOR EACH ROW EXECUTE FUNCTION external_signal_signal_v2_immutability_guard();

CREATE FUNCTION external_signal_broker_worker_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x RECORD; ds "ExternalSignalBrokerDispatchState"%ROWTYPE; es "ExternalSignalExecutionRolloutState"%ROWTYPE; expected text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'TradingView broker worker claims are immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);
  SELECT * INTO es FROM "ExternalSignalExecutionRolloutState" WHERE id=1 FOR UPDATE;
  SELECT * INTO ds FROM "ExternalSignalBrokerDispatchState" WHERE id=1 FOR UPDATE;
  SELECT o.*,i."externalSignalAccountCycleId",i."clientOrderId" AS intent_client_order_id,i.status AS intent_status,
    i.source AS intent_source,i.side AS intent_side,i.symbol AS intent_symbol,i."tradingAccountId" AS intent_account,
    i."tradingAccountSubscriptionId" AS intent_assignment,i."subscriptionId" AS intent_subscription,
    i."trackedPositionId" AS intent_position,i."lastSubmittedOrderSyncAt",i."createdAt" AS intent_created_at,
    ac.status AS account_cycle_status,ac."externalSignalTradeCycleId" AS ac_source_cycle,
    ac."entrySignalRouteId" AS ac_route,ac."tradingAccountId" AS ac_account,
    ac."tradingAccountSubscriptionId" AS ac_assignment,ac."subscriptionId" AS ac_subscription,
    ac."securityId" AS ac_security,ac."entryRolloutGenerationId",ac."entryOrderIntentId",
    ac."trackedPositionId" AS ac_position,ac."pendingExitAcceptedAt",ac."terminalAt" AS ac_terminal_at,ac."noExposureProof",
    c.status AS source_cycle_status,c."strategySignalBindingId" AS cycle_binding,
    c."strategySignalRevisionId" AS cycle_revision_id,c."strategyRevision" AS cycle_revision,c."securityId" AS cycle_security,
    c."terminalAt" AS cycle_terminal_at,s.event AS signal_event,s."createdAt" AS signal_created_at,
    s."externalSignalTradeCycleId" AS signal_cycle,s."signalSourceId" AS signal_source,
    s."strategySignalBindingId" AS signal_binding,s."strategySignalRevisionId" AS signal_revision_id,
    s."strategyRevision" AS signal_revision,s."securityId" AS signal_security,s.symbol AS signal_symbol,
    sr."signalRoutingRunId",sr."tradingAccountId" AS route_account,sr."tradingAccountSubscriptionId" AS route_assignment,
    sr."subscriptionId" AS route_subscription,rr."signalId" AS route_signal,
    auth.status AS auth_status,auth."rolloutGenerationId" AS auth_rollout,auth."tradingAccountId" AS auth_account,
    auth."tradingAccountSubscriptionId" AS auth_assignment,auth."subscriptionId" AS auth_subscription,
    auth."securityId" AS auth_security,auth."signalSourceId" AS auth_source,
    auth."strategySignalBindingId" AS auth_binding,auth."strategySignalRevisionId" AS auth_revision_id,
    auth."strategyRevision" AS auth_revision,auth."authorizationFingerprint" AS auth_fingerprint,
    gen.direction AS rollout_direction,gen."authorityMode" AS rollout_authority,gen.enabled AS rollout_enabled,
    ta.environment,ta.status AS account_status,ta."tradingEnabled",ta."killSwitchEnabled",ta."tradingBlocked",
    tas.enabled AS assignment_enabled,tas."entriesEnabled",tas."tradingAccountId" AS assignment_account,
    tas."subscriptionId" AS assignment_subscription,tas."routingStrategyId",tas."routingSecurityId",
    sub.enabled AS subscription_enabled,sub."strategyId" AS subscription_strategy,sub."securityId" AS subscription_security,
    sec.enabled AS security_enabled,sec.symbol AS security_symbol,src.provider,src.enabled AS source_enabled,
    b."signalSourceId" AS binding_source,b."strategyId" AS binding_strategy,b.enabled AS binding_enabled,
    rev.status AS revision_status,rev."authorityMode" AS revision_authority,
    ec.id AS claim_id,ec.status AS exposure_status,ec."releasedAt" AS exposure_released_at,
    ec."trackedPositionId" AS exposure_position,ec."tradingAccountId" AS exposure_account,ec."securityId" AS exposure_security
  INTO x FROM "ExternalSignalEntryExecutionObligation" o
    JOIN "OrderIntent" i ON i.id=o."orderIntentId"
    JOIN "ExternalSignalTradeCycleAccount" ac ON ac.id=o."accountCycleId"
    JOIN "ExternalSignalTradeCycle" c ON c.id=o."sourceCycleId"
    JOIN "Signal" s ON s.id=o."entrySignalId"
    JOIN "SignalRoute" sr ON sr.id=o."entrySignalRouteId"
    JOIN "SignalRoutingRun" rr ON rr.id=sr."signalRoutingRunId"
    JOIN "ExternalSignalEntryExecutionAuthorization" auth ON auth.id=o."authorizationId"
    JOIN "ExternalSignalExecutionRolloutGeneration" gen ON gen.id=o."rolloutGenerationId"
    JOIN "TradingAccount" ta ON ta.id=ac."tradingAccountId"
    JOIN "TradingAccountSubscription" tas ON tas.id=ac."tradingAccountSubscriptionId"
    JOIN "Subscription" sub ON sub.id=ac."subscriptionId"
    JOIN "Security" sec ON sec.id=ac."securityId"
    JOIN "ExternalSignalSource" src ON src.id=auth."signalSourceId"
    JOIN "StrategySignalBinding" b ON b.id=auth."strategySignalBindingId"
    JOIN "StrategySignalRevision" rev ON rev.id=auth."strategySignalRevisionId"
    JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=i.id
  WHERE o.id=NEW."executionObligationId"
  FOR UPDATE OF o,i,ac,c,s,sr,rr,auth,gen,ta,tas,sub,sec,src,b,rev,ec;
  IF x.id IS NULL OR es."activeRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId" OR es."activatedAt" IS NULL
    OR ds."activeRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId" OR ds."activatedAt" IS NULL OR ds.version IS DISTINCT FROM NEW."dispatchStateVersion"
    OR x."executionEpochAt" IS DISTINCT FROM es."activatedAt" OR x.auth_status IS DISTINCT FROM 'AUTHORIZED'
    OR x.auth_rollout IS DISTINCT FROM NEW."rolloutGenerationId" OR x.auth_fingerprint IS DISTINCT FROM x."authorizationFingerprint"
    OR x.rollout_direction IS DISTINCT FROM 'ENTRY' OR x.rollout_authority IS DISTINCT FROM 'EXECUTE' OR x.rollout_enabled IS DISTINCT FROM true
    OR ROW(NEW."orderIntentId",NEW."accountCycleId",NEW."rolloutGenerationId",NEW."clientOrderId") IS DISTINCT FROM ROW(x."orderIntentId",x."accountCycleId",x."rolloutGenerationId",x."clientOrderId")
    OR ROW(x."externalSignalAccountCycleId",x.intent_client_order_id,x.intent_account,x.intent_assignment,x.intent_subscription) IS DISTINCT FROM ROW(x."accountCycleId",x."clientOrderId",x.ac_account,x.ac_assignment,x.ac_subscription)
    OR x.intent_source IS DISTINCT FROM 'tradingview' OR lower(x.intent_side) IS DISTINCT FROM 'buy' OR x.intent_status IS DISTINCT FROM 'pending'
    OR x.intent_position IS NOT NULL OR x."lastSubmittedOrderSyncAt" IS NOT NULL
    OR x.account_cycle_status IS DISTINCT FROM 'ENTRY_INTENT_CREATED' OR x."entryOrderIntentId" IS DISTINCT FROM x."orderIntentId"
    OR x."entryRolloutGenerationId" IS DISTINCT FROM x."rolloutGenerationId" OR x.ac_position IS NOT NULL
    OR x."pendingExitAcceptedAt" IS NOT NULL OR x.ac_terminal_at IS NOT NULL OR x."noExposureProof" IS NOT NULL
    OR x.source_cycle_status NOT IN ('ENTRY_RECEIVED','ROUTED') OR x.cycle_terminal_at IS NOT NULL
    OR x.signal_event IS DISTINCT FROM 'ENTRY_LONG' OR x.signal_cycle IS DISTINCT FROM x."sourceCycleId" OR x.route_signal IS DISTINCT FROM x."entrySignalId"
    OR ROW(x.ac_source_cycle,x.ac_route,x.ac_account,x.ac_assignment,x.ac_subscription,x.ac_security) IS DISTINCT FROM ROW(x."sourceCycleId",x."entrySignalRouteId",x.auth_account,x.auth_assignment,x.auth_subscription,x.auth_security)
    OR ROW(x.route_account,x.route_assignment,x.route_subscription) IS DISTINCT FROM ROW(x.ac_account,x.ac_assignment,x.ac_subscription)
    OR ROW(x.signal_source,x.signal_binding,x.signal_revision_id,x.signal_revision,x.signal_security) IS DISTINCT FROM ROW(x.auth_source,x.auth_binding,x.auth_revision_id,x.auth_revision,x.auth_security)
    OR ROW(x.cycle_binding,x.cycle_revision_id,x.cycle_revision,x.cycle_security) IS DISTINCT FROM ROW(x.auth_binding,x.auth_revision_id,x.auth_revision,x.auth_security)
    OR x.environment IS DISTINCT FROM 'PAPER' OR x.account_status IS DISTINCT FROM 'ACTIVE' OR x."tradingEnabled" IS DISTINCT FROM true
    OR x."killSwitchEnabled" IS DISTINCT FROM false OR x."tradingBlocked" IS TRUE
    OR ROW(x.assignment_account,x.assignment_subscription,x."routingStrategyId",x."routingSecurityId") IS DISTINCT FROM ROW(x.ac_account,x.ac_subscription,x.subscription_strategy,x.ac_security)
    OR x.assignment_enabled IS DISTINCT FROM true OR x."entriesEnabled" IS DISTINCT FROM true OR x.subscription_enabled IS DISTINCT FROM true OR x.security_enabled IS DISTINCT FROM true
    OR x.provider IS DISTINCT FROM 'TRADINGVIEW' OR x.source_enabled IS DISTINCT FROM true OR x.binding_source IS DISTINCT FROM x.auth_source
    OR x.binding_strategy IS DISTINCT FROM x.subscription_strategy OR x.binding_enabled IS DISTINCT FROM true
    OR x.revision_status IS DISTINCT FROM 'ACTIVE' OR x.revision_authority IS DISTINCT FROM 'TRADE_ELIGIBLE'
    OR x.claim_id IS NULL OR x.exposure_status IS DISTINCT FROM 'ENTRY_PENDING' OR x.exposure_released_at IS NOT NULL OR x.exposure_position IS NOT NULL
    OR ROW(x.exposure_account,x.exposure_security) IS DISTINCT FROM ROW(x.ac_account,x.ac_security)
    OR x.signal_created_at AT TIME ZONE 'UTC' < ds."activatedAt" OR x.intent_created_at AT TIME ZONE 'UTC' < ds."activatedAt"
    OR x."createdAt" < ds."activatedAt" OR x."accountCycleId" IS NULL
    OR EXISTS (SELECT 1 FROM "Signal" exit_signal WHERE exit_signal."externalSignalTradeCycleId"=x."sourceCycleId" AND exit_signal.event='EXIT_LONG')
    OR EXISTS (SELECT 1 FROM "ExternalSignalBrokerWorkerClaim" wc WHERE wc."orderIntentId"=x."orderIntentId")
    OR EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" dc WHERE dc."orderIntentId"=x."orderIntentId")
    OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchConsumption" mc WHERE mc."orderIntentId"=x."orderIntentId")
    OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerUnenforcedDispatch" ud WHERE ud."orderIntentId"=x."orderIntentId")
    OR EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=x."orderIntentId")
    OR EXISTS (SELECT 1 FROM "BrokerActivity" ba WHERE ba."orderIntentId"=x."orderIntentId")
    OR EXISTS (SELECT 1 FROM "OrderIntentBrokerOpportunityEvent" oe WHERE oe."orderIntentId"=x."orderIntentId" AND oe."eventType" NOT IN ('OPPORTUNITY_CAPTURED','DEFERRED','MISSING_OBSERVATION'))
    OR EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" ce WHERE ce."claimId"=x.claim_id AND ce."eventType" IN ('ADAPTER_INVOCATION_STARTED','DISPATCH_OUTCOME_RECORDED','NOT_SENT_EVIDENCE_RECORDED'))
    OR EXISTS (SELECT 1 FROM "TrackedPosition" tp WHERE tp."tradingAccountId"=x.ac_account AND tp."securityId"=x.ac_security AND tp.status='open')
  THEN RAISE EXCEPTION 'TradingView worker claim lacks current post-activation authority'; END IF;
  NEW."claimedAt":=statement_timestamp();
  expected:=encode(digest(convert_to((jsonb_build_object('accountCycleId',NEW."accountCycleId",'claimedAtEpochMicros',floor(extract(epoch FROM NEW."claimedAt")*1000000)::numeric,'clientOrderId',NEW."clientOrderId",'dispatchStateVersion',NEW."dispatchStateVersion",'executionObligationId',NEW."executionObligationId",'orderIntentId',NEW."orderIntentId",'rolloutGenerationId',NEW."rolloutGenerationId"))::text,'UTF8'),'sha256'),'hex');
  NEW."claimFingerprint":=expected;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalBrokerWorkerClaim_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalBrokerWorkerClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_broker_worker_claim_guard();

CREATE FUNCTION external_signal_broker_consumption_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o "ExternalSignalEntryExecutionObligation"%ROWTYPE; c "ExternalSignalBrokerWorkerClaim"%ROWTYPE; mi "MarketPolicyBrokerDispatchConsumption"%ROWTYPE; auth "ExternalSignalEntryExecutionAuthorization"%ROWTYPE;
DECLARE ds "ExternalSignalBrokerDispatchState"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'TradingView broker dispatch consumption is immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);
  SELECT * INTO ds FROM "ExternalSignalBrokerDispatchState" WHERE id=1 FOR UPDATE;
  SELECT * INTO o FROM "ExternalSignalEntryExecutionObligation" WHERE id=NEW."executionObligationId";
  SELECT * INTO c FROM "ExternalSignalBrokerWorkerClaim" WHERE id=NEW."workerClaimId";
  SELECT * INTO mi FROM "MarketPolicyBrokerDispatchConsumption" WHERE id=NEW."marketPolicyDispatchConsumptionId";
  -- The row lock is both the revoke/invalidate serialization point and the stale-snapshot
  -- fence: SERIALIZABLE transactions abort after a concurrent authorization update, while
  -- READ COMMITTED transactions re-read and fail closed on the terminal status.
  SELECT * INTO auth FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=NEW."executionAuthorizationId" FOR UPDATE;
  IF o.id IS NULL OR c.id IS NULL OR mi.id IS NULL OR auth.id IS NULL OR auth.status<>'AUTHORIZED'
    OR ds."activeRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId" OR ds.version<>NEW."dispatchStateVersion"
    OR ROW(NEW."orderIntentId",NEW."rolloutGenerationId",NEW."executionAuthorizationId",NEW."clientOrderId") IS DISTINCT FROM ROW(o."orderIntentId",o."rolloutGenerationId",o."authorizationId",o."clientOrderId")
    OR ROW(c."orderIntentId",c."executionObligationId",c."accountCycleId",c."rolloutGenerationId",c."dispatchStateVersion",c."clientOrderId") IS DISTINCT FROM ROW(o."orderIntentId",o.id,o."accountCycleId",o."rolloutGenerationId",NEW."dispatchStateVersion",o."clientOrderId")
    OR mi."orderIntentId"<>NEW."orderIntentId" OR mi."clientOrderId"<>NEW."clientOrderId"
    OR mi."brokerPostOpportunityId" IS DISTINCT FROM NEW."brokerPostOpportunityId"
    OR auth."rolloutGenerationId"<>NEW."rolloutGenerationId" OR auth.id<>o."authorizationId"
  THEN RAISE EXCEPTION 'TradingView final dispatch evidence graph is inconsistent'; END IF;
  NEW."consumedAt":=statement_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalBrokerDispatchConsumption_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalBrokerDispatchConsumption" FOR EACH ROW EXECUTE FUNCTION external_signal_broker_consumption_guard();

CREATE FUNCTION external_signal_dispatch_pair_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent_id integer;
BEGIN
  intent_id:=CASE WHEN TG_TABLE_NAME='ExternalSignalBrokerDispatchConsumption' THEN NEW."orderIntentId" ELSE NEW."orderIntentId" END;
  IF EXISTS (SELECT 1 FROM "OrderIntent" WHERE id=intent_id AND "externalSignalAccountCycleId" IS NOT NULL) AND NOT (
    EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchConsumption" m WHERE m."orderIntentId"=intent_id)
    AND EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" t JOIN "MarketPolicyBrokerDispatchConsumption" m ON m.id=t."marketPolicyDispatchConsumptionId" WHERE t."orderIntentId"=intent_id AND m."orderIntentId"=intent_id)
  ) THEN RAISE EXCEPTION 'marked TradingView intent requires paired final-dispatch consumptions'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ExternalSignalBrokerDispatchConsumption_pair_check" AFTER INSERT OR UPDATE ON "ExternalSignalBrokerDispatchConsumption" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_pair_check();
CREATE CONSTRAINT TRIGGER "MarketPolicyBrokerDispatchConsumption_external_pair_check" AFTER INSERT OR UPDATE ON "MarketPolicyBrokerDispatchConsumption" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_pair_check();

CREATE FUNCTION external_signal_unenforced_dispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "OrderIntent" WHERE id=NEW."orderIntentId" AND "externalSignalAccountCycleId" IS NOT NULL) THEN RAISE EXCEPTION 'marked TradingView intent cannot use unenforced dispatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "MarketPolicyBrokerUnenforcedDispatch_external_guard" BEFORE INSERT OR UPDATE ON "MarketPolicyBrokerUnenforcedDispatch" FOR EACH ROW EXECUTE FUNCTION external_signal_unenforced_dispatch_guard();

-- Replace the partial deny list with a complete C1 lifecycle allowlist. No worker-claim exception exists.
CREATE OR REPLACE FUNCTION external_signal_order_intent_dispatch_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW."externalSignalAccountCycleId" IS NOT NULL AND NEW.status<>'received' THEN RAISE EXCEPTION 'marked external signal OrderIntent must be created in received status'; END IF;
  IF TG_OP='UPDATE' AND OLD."externalSignalAccountCycleId" IS NOT NULL THEN
    IF ROW(NEW."externalSignalAccountCycleId",NEW.source,NEW.symbol,NEW.side,NEW."orderType",NEW."timeInForce",NEW.qty,NEW.notional,NEW."limitPrice",NEW."extendedHours",NEW."clientOrderId",NEW."createdAt",NEW."subscriptionId",NEW."subscriptionKey",NEW."tradingAccountId",NEW."tradingAccountSubscriptionId",NEW."liveEntryAcceptanceRunId")
      IS DISTINCT FROM ROW(OLD."externalSignalAccountCycleId",OLD.source,OLD.symbol,OLD.side,OLD."orderType",OLD."timeInForce",OLD.qty,OLD.notional,OLD."limitPrice",OLD."extendedHours",OLD."clientOrderId",OLD."createdAt",OLD."subscriptionId",OLD."subscriptionKey",OLD."tradingAccountId",OLD."tradingAccountSubscriptionId",OLD."liveEntryAcceptanceRunId")
    THEN RAISE EXCEPTION 'marked external signal origin is insert-only and immutable, including activation evidence'; END IF;
    IF NEW.status NOT IN ('received','pending','blocked','failed') THEN RAISE EXCEPTION 'marked external signal OrderIntent dispatch is quarantined by the complete broker lifecycle contract'; END IF;
    IF NEW."trackedPositionId" IS DISTINCT FROM OLD."trackedPositionId" OR NEW."lastSubmittedOrderSyncAt" IS DISTINCT FROM OLD."lastSubmittedOrderSyncAt" THEN RAISE EXCEPTION 'marked external signal broker progress is quarantined'; END IF;
    -- Existing non-dispatch recovery may move among the four allowlisted states. C2 must add
    -- a narrowly scoped claim-backed pending-to-submitting exception; C1 adds no such exception.
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER "OrderIntent_external_signal_dispatch_quarantine" ON "OrderIntent";
CREATE TRIGGER "OrderIntent_external_signal_dispatch_quarantine" BEFORE INSERT OR UPDATE ON "OrderIntent" FOR EACH ROW EXECUTE FUNCTION external_signal_order_intent_dispatch_quarantine();

CREATE FUNCTION external_signal_broker_evidence_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent_id integer;
BEGIN
  intent_id:=CASE WHEN TG_TABLE_NAME='BrokerOrder' THEN NEW."orderIntentId" ELSE NEW."orderIntentId" END;
  IF intent_id IS NOT NULL AND EXISTS (SELECT 1 FROM "OrderIntent" WHERE id=intent_id AND "externalSignalAccountCycleId" IS NOT NULL) THEN RAISE EXCEPTION 'marked external signal broker evidence is quarantined in Phase 4A.2C1'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BrokerOrder_external_signal_quarantine" BEFORE INSERT OR UPDATE ON "BrokerOrder" FOR EACH ROW EXECUTE FUNCTION external_signal_broker_evidence_quarantine();
CREATE TRIGGER "BrokerActivity_external_signal_quarantine" BEFORE INSERT OR UPDATE ON "BrokerActivity" FOR EACH ROW EXECUTE FUNCTION external_signal_broker_evidence_quarantine();

-- Strengthen frozen-generation consistency without changing historical SHADOW rows.
CREATE FUNCTION external_signal_frozen_generation_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ExternalSignalEntryExecutionObligation" o
    JOIN "OrderIntent" i ON i.id=o."orderIntentId"
    JOIN "ExternalSignalTradeCycleAccount" ac ON ac.id=o."accountCycleId"
    JOIN "ExternalSignalEntryExecutionAuthorization" a ON a.id=o."authorizationId"
    WHERE o.id=NEW.id AND i."externalSignalAccountCycleId"=ac.id AND ac."entryRolloutGenerationId"=o."rolloutGenerationId" AND a."rolloutGenerationId"=o."rolloutGenerationId"
  ) THEN RAISE EXCEPTION 'TradingView execution graph has an invalid or missing frozen generation'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ExternalSignalEntryExecutionObligation_generation_check" AFTER INSERT OR UPDATE ON "ExternalSignalEntryExecutionObligation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION external_signal_frozen_generation_check();

-- ENTRY execution owns the outer authority boundary. Its deactivation atomically closes any
-- matching dispatch epoch and appends the ordinary dispatch history event. A later ENTRY
-- reactivation never reopens dispatch: a new explicit dispatch activation is still required.
CREATE OR REPLACE FUNCTION external_signal_execution_activation_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action='DEACTIVATE' THEN
    IF EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchState" WHERE id=1 AND "activeRolloutGenerationId"=NEW."rolloutGenerationId") THEN
      INSERT INTO "ExternalSignalBrokerDispatchActivation" ("rolloutGenerationId",action,"stateVersion",reason,"actorUserId")
      VALUES (NEW."rolloutGenerationId",'DEACTIVATE',0,'Automatically closed because ENTRY execution was deactivated',NEW."actorUserId");
    END IF;
    UPDATE "ExternalSignalEntryExecutionAuthorization" SET status='INVALIDATED',"invalidationReasonCode"='ROLLOUT_DEACTIVATED'
      WHERE status='AUTHORIZED' AND "rolloutGenerationId"=NEW."rolloutGenerationId";
  END IF;
  RETURN NEW;
END $$;
