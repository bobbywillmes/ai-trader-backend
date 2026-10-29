ALTER TYPE "ExternalSignalAccountCycleStatus" ADD VALUE 'ENTRY_EXECUTION_PROSPECTIVE' AFTER 'ENTRY_SHADOW_ALLOWED';
ALTER TYPE "ExternalSignalCorrelationDecisionType" ADD VALUE 'ENTRY_EXECUTION_PROSPECTIVE' AFTER 'ENTRY_SHADOW_AUTHORITY';

ALTER TABLE "ExternalSignalTradeCycleAccount" DROP CONSTRAINT "ExternalSignalTradeCycleAccount_shadow_links_check";
ALTER TABLE "ExternalSignalTradeCycleAccount" ADD CONSTRAINT "ExternalSignalTradeCycleAccount_execution_links_check" CHECK (
  "trackedPositionId" IS NULL OR status::text IN ('TERMINAL_CLOSED','EXIT_PENDING')
);

-- Historical decisions remain exactly SHADOW. Only the new prospective decision may carry
-- EXECUTE, and it must freeze an EXECUTE rollout generation.
ALTER TABLE "ExternalSignalCorrelationDecision" DROP CONSTRAINT "ExternalSignalCorrelationDecision_shadow_only_check";
ALTER TABLE "ExternalSignalCorrelationDecision" ADD CONSTRAINT "ExternalSignalCorrelationDecision_authority_check" CHECK (
  ("decisionType"::text='ENTRY_EXECUTION_PROSPECTIVE' AND "authorityMode"='EXECUTE' AND "rolloutGenerationId" IS NOT NULL)
  OR ("decisionType"::text<>'ENTRY_EXECUTION_PROSPECTIVE' AND "authorityMode"='SHADOW')
);

CREATE FUNCTION "check_external_signal_correlation_authority"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE generation_direction "ExternalSignalExecutionDirection";
DECLARE generation_authority "ExternalSignalExecutionAuthorityMode";
DECLARE account RECORD;
BEGIN
  IF NEW."rolloutGenerationId" IS NOT NULL THEN
    SELECT direction,"authorityMode" INTO generation_direction,generation_authority FROM "ExternalSignalExecutionRolloutGeneration" WHERE id=NEW."rolloutGenerationId";
  END IF;
  IF NEW."decisionType"::text='ENTRY_EXECUTION_PROSPECTIVE' THEN
    SELECT "entryRolloutGenerationId",status INTO account FROM "ExternalSignalTradeCycleAccount" WHERE id=NEW."accountCycleId";
    IF NEW."accountCycleId" IS NULL OR NEW."signalRouteId" IS NULL OR generation_direction IS DISTINCT FROM 'ENTRY'
      OR generation_authority IS DISTINCT FROM 'EXECUTE' OR account."entryRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId"
      OR account.status::text NOT IN ('ENTRY_EXECUTION_PROSPECTIVE','ENTRY_INTENT_CREATED','EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED')
    THEN RAISE EXCEPTION 'prospective execution correlation identity is invalid' USING ERRCODE='23514'; END IF;
  ELSIF NEW."rolloutGenerationId" IS NOT NULL AND (generation_direction IS DISTINCT FROM 'ENTRY' OR generation_authority IS DISTINCT FROM 'SHADOW') THEN
    RAISE EXCEPTION 'historical correlation decisions require a SHADOW generation' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ExternalSignalCorrelationDecision_authority_identity" AFTER INSERT ON "ExternalSignalCorrelationDecision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_external_signal_correlation_authority"();

CREATE OR REPLACE FUNCTION "check_external_signal_account_cycle_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cycle_row "ExternalSignalTradeCycle"%ROWTYPE;
DECLARE route_row RECORD;
DECLARE rollout_row "ExternalSignalExecutionRolloutGeneration"%ROWTYPE;
BEGIN
  SELECT * INTO cycle_row FROM "ExternalSignalTradeCycle" WHERE id=NEW."externalSignalTradeCycleId";
  SELECT sr.*,s."externalSignalTradeCycleId" AS signal_cycle_id,s.event,s."schemaVersion" INTO route_row
    FROM "SignalRoute" sr JOIN "SignalRoutingRun" rr ON rr.id=sr."signalRoutingRunId"
    JOIN "Signal" s ON s.id=rr."signalId" WHERE sr.id=NEW."entrySignalRouteId";
  IF cycle_row.id IS NULL OR route_row.id IS NULL OR route_row.event<>'ENTRY_LONG' OR route_row."schemaVersion"<>2
    OR route_row.signal_cycle_id<>cycle_row.id OR route_row."tradingAccountId"<>NEW."tradingAccountId"
    OR route_row."tradingAccountSubscriptionId"<>NEW."tradingAccountSubscriptionId"
    OR route_row."subscriptionId"<>NEW."subscriptionId" OR cycle_row."securityId"<>NEW."securityId"
  THEN RAISE EXCEPTION 'External signal account cycle does not match its original entry route' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS (SELECT 1 FROM "TradingAccountSubscription" tas WHERE tas.id=NEW."tradingAccountSubscriptionId" AND tas."tradingAccountId"=NEW."tradingAccountId" AND tas."subscriptionId"=NEW."subscriptionId" AND tas."routingSecurityId"=NEW."securityId")
  THEN RAISE EXCEPTION 'External signal account cycle assignment identity is invalid' USING ERRCODE='23514'; END IF;
  IF NEW."entryRolloutGenerationId" IS NOT NULL AND (TG_OP='INSERT' OR OLD."entryRolloutGenerationId" IS NULL) THEN
    SELECT * INTO rollout_row FROM "ExternalSignalExecutionRolloutGeneration" WHERE id=NEW."entryRolloutGenerationId";
    IF rollout_row.id IS NULL OR rollout_row.direction<>'ENTRY' OR NOT (
      (rollout_row."authorityMode"='EXECUTE' AND NEW.status IN ('ENTRY_EXECUTION_PROSPECTIVE','ENTRY_INTENT_CREATED','EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED'))
      OR (rollout_row."authorityMode"='SHADOW' AND NEW.status NOT IN ('ENTRY_EXECUTION_PROSPECTIVE','ENTRY_INTENT_CREATED'))
    ) THEN RAISE EXCEPTION 'External signal account cycle entry rollout identity is invalid' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION "protect_external_signal_account_cycle"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'External signal account cycles are append-preserving' USING ERRCODE='23514'; END IF;
  IF ROW(OLD."externalSignalTradeCycleId",OLD."entrySignalRouteId",OLD."tradingAccountId",OLD."tradingAccountSubscriptionId",OLD."subscriptionId",OLD."securityId",OLD."createdAt") IS DISTINCT FROM ROW(NEW."externalSignalTradeCycleId",NEW."entrySignalRouteId",NEW."tradingAccountId",NEW."tradingAccountSubscriptionId",NEW."subscriptionId",NEW."securityId",NEW."createdAt") THEN RAISE EXCEPTION 'External signal account cycle identity is immutable' USING ERRCODE='23514'; END IF;
  IF OLD."entryRolloutGenerationId" IS NOT NULL AND NEW."entryRolloutGenerationId" IS DISTINCT FROM OLD."entryRolloutGenerationId" THEN RAISE EXCEPTION 'External signal account cycle rollout link is write-once' USING ERRCODE='23514'; END IF;
  IF OLD."entryReservationKey" IS NOT NULL AND ROW(NEW."entryReservationKey",NEW."entryReservationCreatedAt") IS DISTINCT FROM ROW(OLD."entryReservationKey",OLD."entryReservationCreatedAt") THEN RAISE EXCEPTION 'External signal entry reservation is write-once' USING ERRCODE='23514'; END IF;
  IF OLD."entryOrderIntentId" IS NOT NULL AND NEW."entryOrderIntentId" IS DISTINCT FROM OLD."entryOrderIntentId" THEN RAISE EXCEPTION 'External signal entry intent link is write-once' USING ERRCODE='23514'; END IF;
  IF OLD.status IN ('TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED') THEN RAISE EXCEPTION 'External signal terminal account cycle state is immutable and absorbing' USING ERRCODE='23514'; END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='ENTRY_ROUTE_PENDING' AND NEW.status IN ('ENTRY_ADMISSION_PENDING','ENTRY_EXECUTION_PROSPECTIVE','ENTRY_SUPPRESSED_BY_EXIT','EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE')) OR
    (OLD.status='ENTRY_ADMISSION_PENDING' AND NEW.status IN ('ENTRY_SHADOW_ALLOWED','ENTRY_SUPPRESSED_BY_EXIT','EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE')) OR
    (OLD.status='ENTRY_SHADOW_ALLOWED' AND NEW.status IN ('EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE')) OR
    (OLD.status='ENTRY_EXECUTION_PROSPECTIVE' AND NEW.status IN ('ENTRY_INTENT_CREATED','ENTRY_SUPPRESSED_BY_EXIT','EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE')) OR
    (OLD.status='ENTRY_INTENT_CREATED' AND NEW.status IN ('EXIT_PENDING','BLOCKED','TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED')) OR
    (OLD.status='ENTRY_SUPPRESSED_BY_EXIT' AND NEW.status='TERMINAL_NO_EXPOSURE') OR
    (OLD.status='EXIT_PENDING' AND NEW.status IN ('ENTRY_SUPPRESSED_BY_EXIT','BLOCKED','TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED')) OR
    (OLD.status='BLOCKED' AND NEW.status IN ('EXIT_PENDING','TERMINAL_NO_EXPOSURE','TERMINAL_CLOSED'))
  ) THEN RAISE EXCEPTION 'External signal account cycle state transition is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- The application creates the marked intent, claim, market-policy obligation, TradingView
-- obligation, and account-cycle link in one transaction. Deferred validation permits that order
-- while rejecting every invalid committed graph, including hostile direct SQL.
CREATE FUNCTION "check_external_signal_entry_intent_graph"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ac "ExternalSignalTradeCycleAccount"%ROWTYPE;
DECLARE oi "OrderIntent"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='ExternalSignalTradeCycleAccount' THEN ac:=NEW;
  ELSE SELECT * INTO ac FROM "ExternalSignalTradeCycleAccount" WHERE id=NEW."externalSignalAccountCycleId"; END IF;
  IF ac.status='ENTRY_INTENT_CREATED' AND ac."entryOrderIntentId" IS NULL THEN
    RAISE EXCEPTION 'ENTRY_INTENT_CREATED requires an exact OrderIntent graph' USING ERRCODE='23514';
  END IF;
  IF ac."entryOrderIntentId" IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO oi FROM "OrderIntent" WHERE id=ac."entryOrderIntentId";
  IF oi.id IS NULL OR oi."externalSignalAccountCycleId" IS DISTINCT FROM ac.id
    OR oi."tradingAccountId" IS DISTINCT FROM ac."tradingAccountId"
    OR oi."tradingAccountSubscriptionId" IS DISTINCT FROM ac."tradingAccountSubscriptionId"
    OR oi."subscriptionId" IS DISTINCT FROM ac."subscriptionId" OR oi.source<>'tradingview' OR lower(oi.side)<>'buy'
    OR NOT EXISTS (SELECT 1 FROM "ExternalSignalEntryExecutionObligation" o WHERE o."orderIntentId"=oi.id AND o."accountCycleId"=ac.id AND o."sourceCycleId"=ac."externalSignalTradeCycleId" AND o."entrySignalRouteId"=ac."entrySignalRouteId")
    OR NOT EXISTS (SELECT 1 FROM "EntryExposureClaim" ec WHERE ec."orderIntentId"=oi.id AND ec."tradingAccountId"=ac."tradingAccountId" AND ec."securityId"=ac."securityId")
  THEN RAISE EXCEPTION 'External signal entry intent graph is incomplete or inconsistent' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ExternalSignalTradeCycleAccount_entry_graph_check" AFTER INSERT OR UPDATE ON "ExternalSignalTradeCycleAccount" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_external_signal_entry_intent_graph"();
CREATE CONSTRAINT TRIGGER "OrderIntent_external_signal_entry_graph_check" AFTER INSERT OR UPDATE ON "OrderIntent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."externalSignalAccountCycleId" IS NOT NULL) EXECUTE FUNCTION "check_external_signal_entry_intent_graph"();

CREATE OR REPLACE FUNCTION external_signal_order_intent_dispatch_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW."externalSignalAccountCycleId" IS NOT NULL AND NEW.status IS DISTINCT FROM 'received' THEN RAISE EXCEPTION 'marked external signal OrderIntent must be created in received status'; END IF;
  IF TG_OP='UPDATE' AND OLD."externalSignalAccountCycleId" IS NOT NULL
    AND NEW.status IN ('submitting','submitted','partially_filled','filled') AND NEW.status IS DISTINCT FROM OLD.status
  THEN RAISE EXCEPTION 'marked external signal OrderIntent dispatch is quarantined'; END IF;
  RETURN NEW;
END $$;
