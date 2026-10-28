CREATE OR REPLACE FUNCTION "check_external_signal_correlation_decision_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE signal_cycle INTEGER; DECLARE account_cycle INTEGER; DECLARE account_rollout INTEGER; DECLARE account_route INTEGER; DECLARE route_signal INTEGER; DECLARE rollout_direction "ExternalSignalExecutionDirection"; DECLARE rollout_enabled BOOLEAN;
BEGIN
  SELECT "externalSignalTradeCycleId" INTO signal_cycle FROM "Signal" WHERE id=NEW."signalId";
  IF signal_cycle IS DISTINCT FROM NEW."externalSignalTradeCycleId" THEN RAISE EXCEPTION 'Correlation decision Signal/source-cycle mismatch' USING ERRCODE='23514'; END IF;
  IF NEW."accountCycleId" IS NOT NULL THEN
    SELECT "externalSignalTradeCycleId","entryRolloutGenerationId","entrySignalRouteId" INTO account_cycle,account_rollout,account_route FROM "ExternalSignalTradeCycleAccount" WHERE id=NEW."accountCycleId";
    IF account_cycle IS DISTINCT FROM NEW."externalSignalTradeCycleId" THEN RAISE EXCEPTION 'Correlation decision account/source-cycle mismatch' USING ERRCODE='23514'; END IF;
    IF NEW."signalRouteId" IS NOT NULL AND account_route IS DISTINCT FROM NEW."signalRouteId" THEN RAISE EXCEPTION 'Correlation decision account/route mismatch' USING ERRCODE='23514'; END IF;
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
  IF NEW."decisionType" IN ('ENTRY_RESERVATION','ENTRY_SHADOW_AUTHORITY','ENTRY_SUPPRESSED','ROUTE_EVALUATION_BLOCKED') AND NEW."accountCycleId" IS NULL THEN RAISE EXCEPTION 'Account decision requires an account cycle' USING ERRCODE='23514'; END IF;
  IF NEW."decisionType"='LIVE_ROUTE_BLOCKED' AND (NEW."signalRouteId" IS NULL OR NEW."accountCycleId" IS NOT NULL OR NEW."reservationKey" IS NOT NULL) THEN RAISE EXCEPTION 'LIVE blocked decision requires only an original route' USING ERRCODE='23514'; END IF;
  IF NEW."decisionType"='ENTRY_SHADOW_AUTHORITY' AND NEW."rolloutGenerationId" IS NULL THEN RAISE EXCEPTION 'Shadow authority decision requires a rollout generation' USING ERRCODE='23514'; END IF;
  IF NEW."decisionType"='ENTRY_SHADOW_AUTHORITY' AND rollout_enabled IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Shadow authority requires an enabled rollout' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
