ALTER TYPE "ExternalSignalCorrelationDecisionType" ADD VALUE 'LIVE_ROUTE_BLOCKED';
ALTER TYPE "ExternalSignalCorrelationDecisionType" ADD VALUE 'ROUTE_EVALUATION_BLOCKED';

ALTER TABLE "ExternalSignalCorrelationDecision" ADD COLUMN "signalRouteId" INTEGER;
ALTER TABLE "ExternalSignalCorrelationDecision" ADD CONSTRAINT "ExternalSignalCorrelationDecision_route_fkey"
  FOREIGN KEY ("signalRouteId") REFERENCES "SignalRoute"(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ExternalSignalCorrelationDecision" DROP CONSTRAINT "ExternalSignalCorrelationDecision_signal_account_type_key";
ALTER TABLE "ExternalSignalCorrelationDecision" ADD CONSTRAINT "ExternalSignalCorrelationDecision_signal_target_type_key"
  UNIQUE NULLS NOT DISTINCT ("signalId", "accountCycleId", "signalRouteId", "decisionType");

CREATE FUNCTION "check_external_signal_account_cycle_paper"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "TradingAccount" a WHERE a.id=NEW."tradingAccountId" AND a.environment='PAPER') THEN
    RAISE EXCEPTION 'External signal account cycles are PAPER-only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalTradeCycleAccount_paper_only"
  BEFORE INSERT OR UPDATE ON "ExternalSignalTradeCycleAccount"
  FOR EACH ROW EXECUTE FUNCTION "check_external_signal_account_cycle_paper"();

CREATE FUNCTION "check_external_signal_correlation_decision_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE signal_cycle INTEGER; DECLARE account_cycle INTEGER; DECLARE account_rollout INTEGER; DECLARE route_signal INTEGER; DECLARE rollout_direction "ExternalSignalExecutionDirection"; DECLARE rollout_enabled BOOLEAN;
BEGIN
  SELECT "externalSignalTradeCycleId" INTO signal_cycle FROM "Signal" WHERE id=NEW."signalId";
  IF signal_cycle IS DISTINCT FROM NEW."externalSignalTradeCycleId" THEN
    RAISE EXCEPTION 'Correlation decision Signal/source-cycle mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW."accountCycleId" IS NOT NULL THEN
    SELECT "externalSignalTradeCycleId","entryRolloutGenerationId" INTO account_cycle,account_rollout FROM "ExternalSignalTradeCycleAccount" WHERE id=NEW."accountCycleId";
    IF account_cycle IS DISTINCT FROM NEW."externalSignalTradeCycleId" THEN
      RAISE EXCEPTION 'Correlation decision account/source-cycle mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW."signalRouteId" IS NOT NULL THEN
    SELECT rr."signalId" INTO route_signal FROM "SignalRoute" sr JOIN "SignalRoutingRun" rr ON rr.id=sr."signalRoutingRunId" WHERE sr.id=NEW."signalRouteId";
    IF route_signal IS DISTINCT FROM NEW."signalId" THEN RAISE EXCEPTION 'Correlation decision route/Signal mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW."rolloutGenerationId" IS NOT NULL THEN
    SELECT direction,enabled INTO rollout_direction,rollout_enabled FROM "ExternalSignalExecutionRolloutGeneration" WHERE id=NEW."rolloutGenerationId";
    IF rollout_direction IS DISTINCT FROM 'ENTRY' THEN RAISE EXCEPTION 'Correlation decision rollout direction mismatch' USING ERRCODE='23514'; END IF;
    IF NEW."accountCycleId" IS NOT NULL AND account_rollout IS DISTINCT FROM NEW."rolloutGenerationId" THEN RAISE EXCEPTION 'Correlation decision/account rollout mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW."decisionType" IN ('ENTRY_RESERVATION','ENTRY_SHADOW_AUTHORITY','ENTRY_SUPPRESSED','ROUTE_EVALUATION_BLOCKED') AND NEW."accountCycleId" IS NULL THEN
    RAISE EXCEPTION 'Account decision requires an account cycle' USING ERRCODE='23514';
  END IF;
  IF NEW."decisionType"='LIVE_ROUTE_BLOCKED' AND (NEW."signalRouteId" IS NULL OR NEW."accountCycleId" IS NOT NULL OR NEW."reservationKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'LIVE blocked decision requires only an original route' USING ERRCODE='23514';
  END IF;
  IF NEW."decisionType"='ENTRY_SHADOW_AUTHORITY' AND NEW."rolloutGenerationId" IS NULL THEN
    RAISE EXCEPTION 'Shadow authority decision requires a rollout generation' USING ERRCODE='23514';
  END IF;
  IF NEW."decisionType"='ENTRY_SHADOW_AUTHORITY' AND rollout_enabled IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Shadow authority requires an enabled rollout' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ExternalSignalCorrelationDecision_identity_check"
  AFTER INSERT ON "ExternalSignalCorrelationDecision" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_external_signal_correlation_decision_identity"();
