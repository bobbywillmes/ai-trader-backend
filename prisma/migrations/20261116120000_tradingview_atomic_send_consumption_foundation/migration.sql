-- Phase 4A.2C3C.1B.1: atomic broker-send consumption foundation.
-- Database integrity only: no writer, adapter capability, transport, quarantine relaxation, or withdrawal path.
SET LOCAL lock_timeout = '15s';

LOCK TABLE "ExternalSignalBrokerSendResolution", "ExternalSignalBrokerSendPermission",
  "ExternalSignalBrokerDispatchConsumption", "MarketPolicyBrokerDispatchConsumption",
  "MarketPolicyBrokerDispatchDecision", "ExternalSignalDispatchFence", "OrderIntent",
  "EntryExposureClaim", "EntryExposureClaimEvent", "ExternalSignalBrokerWorkerClaim",
  "ExternalSignalEntryExecutionObligation", "ExternalSignalEntryExecutionAuthorization",
  "ExternalSignalTradeCycleAccount", "BrokerOrder", "BrokerActivity"
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "ExternalSignalBrokerSendResolution"
  ADD COLUMN "preResolutionFenceVersion" BIGINT NOT NULL;

ALTER TABLE "EntryExposureClaimEvent"
  ADD COLUMN "externalSignalBrokerProtocol" TEXT,
  ADD COLUMN "externalSignalBrokerSendResolutionId" INTEGER,
  ADD COLUMN "externalSignalBrokerSendPermissionId" INTEGER,
  ADD COLUMN "externalSignalOrderIntentId" INTEGER,
  ADD COLUMN "externalSignalTradingAccountId" INTEGER,
  ADD COLUMN "externalSignalClientOrderId" TEXT,
  ADD COLUMN "preAdapterFenceVersion" BIGINT,
  ADD CONSTRAINT "EntryExposureClaimEvent_c3c_shape_check" CHECK (
    ("externalSignalBrokerProtocol" IS NULL AND "externalSignalBrokerSendResolutionId" IS NULL
      AND "externalSignalBrokerSendPermissionId" IS NULL AND "externalSignalOrderIntentId" IS NULL
      AND "externalSignalTradingAccountId" IS NULL AND "externalSignalClientOrderId" IS NULL
      AND "preAdapterFenceVersion" IS NULL)
    OR
    ("externalSignalBrokerProtocol" = 'TRADINGVIEW_C3C_ADAPTER_INVOCATION_STARTED_V1'
      AND "eventType" = 'ADAPTER_INVOCATION_STARTED'
      AND "externalSignalBrokerSendResolutionId" IS NOT NULL
      AND "externalSignalBrokerSendPermissionId" IS NOT NULL
      AND "externalSignalOrderIntentId" IS NOT NULL
      AND "externalSignalTradingAccountId" IS NOT NULL
      AND "externalSignalClientOrderId" IS NOT NULL
      AND "preAdapterFenceVersion" IS NOT NULL)
  ),
  ADD CONSTRAINT "EntryExposureClaimEvent_c3c_resolution_key" UNIQUE ("externalSignalBrokerSendResolutionId"),
  ADD CONSTRAINT "EntryExposureClaimEvent_c3c_permission_key" UNIQUE ("externalSignalBrokerSendPermissionId"),
  ADD CONSTRAINT "EntryExposureClaimEvent_c3c_resolution_fkey" FOREIGN KEY ("externalSignalBrokerSendResolutionId")
    REFERENCES "ExternalSignalBrokerSendResolution"(id) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "EntryExposureClaimEvent_c3c_permission_fkey" FOREIGN KEY ("externalSignalBrokerSendPermissionId")
    REFERENCES "ExternalSignalBrokerSendPermission"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "EntryExposureClaimEvent_c3c_intent_fkey" FOREIGN KEY ("externalSignalOrderIntentId")
    REFERENCES "OrderIntent"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "EntryExposureClaimEvent_c3c_account_fkey" FOREIGN KEY ("externalSignalTradingAccountId")
    REFERENCES "TradingAccount"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- The shared current-authority validator is also used after marker-first insertion. Exclude only the fully
-- relational C3C marker from its generic "prior adapter marker" refusal; P's own guard continues to reject every
-- prior marker, while A's dedicated guards and deferred checks validate this exact marker.
DO $$
DECLARE definition text; old_clause text; new_clause text;
BEGIN
  SELECT pg_get_functiondef('external_signal_validate_current_send_authority(integer,integer)'::regprocedure) INTO definition;
  old_clause := 'e."eventType" IN (''NOT_SENT_EVIDENCE_RECORDED'',''ADAPTER_INVOCATION_STARTED'',''DISPATCH_OUTCOME_RECORDED'',''BROKER_DELIVERY_UNCERTAIN''))';
  new_clause := 'e."eventType" IN (''NOT_SENT_EVIDENCE_RECORDED'',''ADAPTER_INVOCATION_STARTED'',''DISPATCH_OUTCOME_RECORDED'',''BROKER_DELIVERY_UNCERTAIN'') AND e."externalSignalBrokerProtocol" IS DISTINCT FROM ''TRADINGVIEW_C3C_ADAPTER_INVOCATION_STARTED_V1'')';
  IF position(old_clause IN definition)=0 THEN RAISE EXCEPTION 'unexpected current-send-authority evidence predicate'; END IF;
  definition := replace(definition, old_clause, new_clause);
  EXECUTE definition;
END $$;

-- A C3C marker is relational evidence. The JSON protocol label is duplicated only for diagnostics and cannot
-- create a marker by itself. Preserve every ordinary adapter marker exactly as before.
CREATE FUNCTION external_signal_c3c_adapter_marker_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p "ExternalSignalBrokerSendPermission"%ROWTYPE;
  r "ExternalSignalBrokerSendResolution"%ROWTYPE;
  c "EntryExposureClaim"%ROWTYPE;
  fence_v bigint;
BEGIN
  IF NEW."eventType" <> 'ADAPTER_INVOCATION_STARTED' THEN
    IF NEW."externalSignalBrokerProtocol" IS NOT NULL THEN RAISE EXCEPTION 'TRADINGVIEW_C3C_MARKER_EVENT_TYPE_INVALID'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."evidenceJson"->>'protocol' = 'TRADINGVIEW_C3C_ADAPTER_INVOCATION_STARTED_V1'
     AND NEW."externalSignalBrokerProtocol" IS DISTINCT FROM 'TRADINGVIEW_C3C_ADAPTER_INVOCATION_STARTED_V1' THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_FORGED_JSON_PROTOCOL';
  END IF;
  IF NEW."externalSignalBrokerProtocol" IS NULL THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'TRADINGVIEW_CONSUMPTION_REQUIRES_READ_COMMITTED';
  END IF;
  SELECT * INTO p FROM "ExternalSignalBrokerSendPermission" WHERE id=NEW."externalSignalBrokerSendPermissionId";
  IF p.id IS NULL THEN RAISE EXCEPTION 'TRADINGVIEW_C3C_PERMISSION_MISSING'; END IF;
  PERFORM external_signal_lock_dispatch_graph(p."orderIntentId", p."marketPolicyDispatchDecisionId");
  SELECT version INTO fence_v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=p."orderIntentId" FOR UPDATE;
  SELECT * INTO p FROM "ExternalSignalBrokerSendPermission" WHERE id=p.id FOR SHARE;
  SELECT * INTO c FROM "EntryExposureClaim" WHERE id=NEW."claimId";
  SELECT * INTO r FROM "ExternalSignalBrokerSendResolution" WHERE id=NEW."externalSignalBrokerSendResolutionId";
  PERFORM external_signal_validate_current_send_authority(p."orderIntentId", p."marketPolicyDispatchDecisionId");
  IF ROW(NEW."claimId",NEW."externalSignalBrokerSendPermissionId",NEW."externalSignalOrderIntentId",
         NEW."externalSignalTradingAccountId",NEW."externalSignalClientOrderId") IS DISTINCT FROM
     ROW(p."entryExposureClaimId",p.id,p."orderIntentId",p."tradingAccountId",p."clientOrderId")
     OR c."orderIntentId" IS DISTINCT FROM p."orderIntentId" THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_MARKER_IDENTITY_MISMATCH';
  END IF;
  IF r.id IS NOT NULL AND (r.outcome <> 'CONSUMED' OR r."permissionId" IS DISTINCT FROM p.id
     OR r."orderIntentId" IS DISTINCT FROM p."orderIntentId") THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_MARKER_RESOLUTION_MISMATCH';
  END IF;
  -- The existing C2 delivery fence is deliberately the first BEFORE INSERT trigger. It has already performed
  -- the claim no-op update and the first of A's two fence increments when this guard runs.
  IF r.id IS NOT NULL AND fence_v IS DISTINCT FROM r."preResolutionFenceVersion" + 1 THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_STARTING_FENCE_MISMATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=c.id
      AND e."eventType" IN ('ADAPTER_INVOCATION_STARTED','NOT_SENT_EVIDENCE_RECORDED','DISPATCH_OUTCOME_RECORDED','BROKER_DELIVERY_UNCERTAIN'))
     OR EXISTS (SELECT 1 FROM external_signal_marked_intent_broker_evidence(p."orderIntentId")) THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_CONFLICTING_DELIVERY_EVIDENCE';
  END IF;
  IF p."effectiveDeadlineAt" - clock_timestamp() < external_signal_c3c_a_minimum_remaining() THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_DEADLINE_INSUFFICIENT';
  END IF;
  NEW."preAdapterFenceVersion" := coalesce(r."preResolutionFenceVersion", fence_v - 1);
  RETURN NEW;
END $$;

CREATE TRIGGER "EntryExposureClaimEvent_external_signal_c3c_adapter_guard"
  BEFORE INSERT ON "EntryExposureClaimEvent" FOR EACH ROW
  EXECUTE FUNCTION external_signal_c3c_adapter_marker_guard();

-- Permit the complete CONSUMED protocol only. WITHDRAWN_NEVER_SENT remains unavailable until C3C.1B.2.
CREATE OR REPLACE FUNCTION external_signal_broker_send_resolution_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p "ExternalSignalBrokerSendPermission"%ROWTYPE;
  tv "ExternalSignalBrokerDispatchConsumption"%ROWTYPE;
  mi "MarketPolicyBrokerDispatchConsumption"%ROWTYPE;
  d "MarketPolicyBrokerDispatchDecision"%ROWTYPE;
  i "OrderIntent"%ROWTYPE;
  c "EntryExposureClaim"%ROWTYPE;
  marker "EntryExposureClaimEvent"%ROWTYPE;
  fence_v bigint;
BEGIN
  IF NEW.outcome <> 'CONSUMED' THEN RAISE EXCEPTION 'TRADINGVIEW_WITHDRAWAL_DISABLED_C3C1B1'; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'TRADINGVIEW_CONSUMPTION_REQUIRES_READ_COMMITTED'; END IF;
  IF NEW."resolvedAt" IS NOT NULL OR NEW."preResolutionFenceVersion" IS NOT NULL THEN
    RAISE EXCEPTION 'resolvedAt and preResolutionFenceVersion are database-stamped and cannot be supplied';
  END IF;
  SELECT * INTO p FROM "ExternalSignalBrokerSendPermission" WHERE id=NEW."permissionId";
  IF p.id IS NULL THEN RAISE EXCEPTION 'TRADINGVIEW_C3C_PERMISSION_MISSING'; END IF;
  PERFORM external_signal_lock_dispatch_graph(p."orderIntentId", p."marketPolicyDispatchDecisionId");
  SELECT version INTO fence_v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=p."orderIntentId" FOR UPDATE;
  SELECT * INTO p FROM "ExternalSignalBrokerSendPermission" WHERE id=p.id FOR SHARE;
  SELECT * INTO tv FROM "ExternalSignalBrokerDispatchConsumption" WHERE id=p."tradingViewDispatchConsumptionId";
  SELECT * INTO mi FROM "MarketPolicyBrokerDispatchConsumption" WHERE id=p."marketPolicyDispatchConsumptionId";
  SELECT * INTO d FROM "MarketPolicyBrokerDispatchDecision" WHERE id=p."marketPolicyDispatchDecisionId";
  SELECT * INTO i FROM "OrderIntent" WHERE id=p."orderIntentId";
  SELECT * INTO c FROM "EntryExposureClaim" WHERE id=p."entryExposureClaimId";
  SELECT * INTO marker FROM "EntryExposureClaimEvent" WHERE "externalSignalBrokerSendResolutionId"=NEW.id;
  PERFORM external_signal_validate_current_send_authority(p."orderIntentId", p."marketPolicyDispatchDecisionId");
  IF ROW(NEW."orderIntentId",NEW."permissionId",NEW."tradingViewDispatchConsumptionId",NEW."marketPolicyDispatchConsumptionId") IS DISTINCT FROM
     ROW(p."orderIntentId",p.id,p."tradingViewDispatchConsumptionId",p."marketPolicyDispatchConsumptionId")
     OR ROW(tv."orderIntentId",tv."marketPolicyDispatchConsumptionId",mi."orderIntentId",mi."decisionId") IS DISTINCT FROM
        ROW(p."orderIntentId",mi.id,p."orderIntentId",d.id)
     OR ROW(p."executionObligationId",p."workerClaimId",p."entryExposureClaimId",p."tradingAccountId",p."securityId",p."clientOrderId") IS DISTINCT FROM
        ROW(tv."executionObligationId",tv."workerClaimId",c.id,i."tradingAccountId",c."securityId",i."clientOrderId") THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_RESOLUTION_IDENTITY_MISMATCH';
  END IF;
  IF marker.id IS NOT NULL AND marker."preAdapterFenceVersion" IS DISTINCT FROM fence_v - 2 THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_STARTING_FENCE_MISMATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=c.id
      AND e."eventType" IN ('NOT_SENT_EVIDENCE_RECORDED','DISPATCH_OUTCOME_RECORDED','BROKER_DELIVERY_UNCERTAIN'))
     OR EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=c.id AND e."eventType"='ADAPTER_INVOCATION_STARTED'
       AND e."externalSignalBrokerProtocol" IS DISTINCT FROM 'TRADINGVIEW_C3C_ADAPTER_INVOCATION_STARTED_V1')
     OR EXISTS (SELECT 1 FROM external_signal_marked_intent_broker_evidence(p."orderIntentId")) THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_CONFLICTING_DELIVERY_EVIDENCE';
  END IF;
  IF p."effectiveDeadlineAt" - clock_timestamp() < external_signal_c3c_a_minimum_remaining() THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_DEADLINE_INSUFFICIENT';
  END IF;
  NEW."preResolutionFenceVersion" := coalesce(marker."preAdapterFenceVersion", fence_v);
  NEW."resolvedAt" := clock_timestamp();
  RETURN NEW;
END $$;

-- The commit check is relational and bidirectional. It also owns the exact +2 postcondition. Attaching the
-- same check to fence updates prevents SET CONSTRAINTS ... IMMEDIATE followed by an extra fenced mutation.
CREATE FUNCTION external_signal_c3c_consumed_graph_check() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE intent_id integer; r "ExternalSignalBrokerSendResolution"%ROWTYPE;
  p "ExternalSignalBrokerSendPermission"%ROWTYPE; e "EntryExposureClaimEvent"%ROWTYPE; fence_v bigint;
BEGIN
  IF TG_TABLE_NAME = 'ExternalSignalBrokerSendResolution' THEN intent_id := (to_jsonb(NEW)->>'orderIntentId')::integer;
  ELSIF TG_TABLE_NAME = 'EntryExposureClaimEvent' THEN intent_id := (to_jsonb(NEW)->>'externalSignalOrderIntentId')::integer;
  ELSE intent_id := (to_jsonb(NEW)->>'orderIntentId')::integer; END IF;
  IF intent_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO r FROM "ExternalSignalBrokerSendResolution" WHERE "orderIntentId"=intent_id AND outcome='CONSUMED';
  IF r.id IS NULL THEN
    IF TG_TABLE_NAME = 'EntryExposureClaimEvent' AND to_jsonb(NEW)->>'externalSignalBrokerProtocol'='TRADINGVIEW_C3C_ADAPTER_INVOCATION_STARTED_V1' THEN
      RAISE EXCEPTION 'TRADINGVIEW_C3C_MARKER_REQUIRES_CONSUMED_RESOLUTION';
    END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO p FROM "ExternalSignalBrokerSendPermission" WHERE id=r."permissionId";
  SELECT * INTO e FROM "EntryExposureClaimEvent" WHERE "externalSignalBrokerSendResolutionId"=r.id;
  SELECT version INTO fence_v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=intent_id;
  IF p.id IS NULL OR e.id IS NULL THEN RAISE EXCEPTION 'TRADINGVIEW_C3C_INCOMPLETE_CONSUMED_GRAPH'; END IF;
  IF ROW(r."orderIntentId",r."permissionId",r."tradingViewDispatchConsumptionId",r."marketPolicyDispatchConsumptionId",r."preResolutionFenceVersion") IS DISTINCT FROM
     ROW(p."orderIntentId",p.id,p."tradingViewDispatchConsumptionId",p."marketPolicyDispatchConsumptionId",e."preAdapterFenceVersion")
     OR ROW(e."claimId",e."eventType",e."externalSignalBrokerProtocol",e."externalSignalBrokerSendPermissionId",
            e."externalSignalOrderIntentId",e."externalSignalTradingAccountId",e."externalSignalClientOrderId") IS DISTINCT FROM
        ROW(p."entryExposureClaimId",'ADAPTER_INVOCATION_STARTED'::text,'TRADINGVIEW_C3C_ADAPTER_INVOCATION_STARTED_V1'::text,
            p.id,p."orderIntentId",p."tradingAccountId",p."clientOrderId") THEN
    RAISE EXCEPTION 'TRADINGVIEW_C3C_CONSUMED_GRAPH_MISMATCH';
  END IF;
  IF fence_v IS DISTINCT FROM r."preResolutionFenceVersion" + 2 THEN
    RAISE EXCEPTION 'TradingView consumed marker fence did not advance exactly twice (stored %, current %)',r."preResolutionFenceVersion",fence_v;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "ExternalSignalBrokerSendResolution_c3c_complete"
  AFTER INSERT ON "ExternalSignalBrokerSendResolution" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION external_signal_c3c_consumed_graph_check();
CREATE CONSTRAINT TRIGGER "EntryExposureClaimEvent_c3c_complete"
  AFTER INSERT ON "EntryExposureClaimEvent" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."externalSignalBrokerProtocol" = 'TRADINGVIEW_C3C_ADAPTER_INVOCATION_STARTED_V1')
  EXECUTE FUNCTION external_signal_c3c_consumed_graph_check();
CREATE CONSTRAINT TRIGGER "ExternalSignalDispatchFence_c3c_exact_delta"
  AFTER UPDATE ON "ExternalSignalDispatchFence" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION external_signal_c3c_consumed_graph_check();

-- Restate trusted search paths after adding application functions.
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
