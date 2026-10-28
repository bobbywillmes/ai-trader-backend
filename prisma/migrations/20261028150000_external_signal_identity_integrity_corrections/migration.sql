-- Account-cycle writers serialize on the source-cycle parent. The application lock
-- order remains source cycle first, then account cycle; this trigger is the database
-- backstop for direct SQL and future writers that fail to take the parent lock first.
CREATE FUNCTION "lock_external_signal_account_cycle_parent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "ExternalSignalTradeCycle"
    WHERE id = NEW."externalSignalTradeCycleId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'External signal account cycle parent does not exist' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "ExternalSignalTradeCycleAccount_parent_lock"
  BEFORE INSERT OR UPDATE ON "ExternalSignalTradeCycleAccount"
  FOR EACH ROW EXECUTE FUNCTION "lock_external_signal_account_cycle_parent"();

-- Mutable assignment catalog fields establish identity only at account-cycle
-- creation. The frozen route/account/assignment/subscription/security columns are
-- protected separately and remain the authority for every later lifecycle update.
CREATE OR REPLACE FUNCTION "check_external_signal_account_cycle_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cycle_row "ExternalSignalTradeCycle"%ROWTYPE;
DECLARE route_row RECORD;
DECLARE rollout_row "ExternalSignalExecutionRolloutGeneration"%ROWTYPE;
BEGIN
  SELECT * INTO cycle_row FROM "ExternalSignalTradeCycle" WHERE id = NEW."externalSignalTradeCycleId";
  SELECT sr.*, s."externalSignalTradeCycleId" AS signal_cycle_id, s.event, s."schemaVersion"
    INTO route_row
    FROM "SignalRoute" sr
    JOIN "SignalRoutingRun" rr ON rr.id = sr."signalRoutingRunId"
    JOIN "Signal" s ON s.id = rr."signalId"
    WHERE sr.id = NEW."entrySignalRouteId";
  IF cycle_row.id IS NULL OR route_row.id IS NULL
    OR route_row.event <> 'ENTRY_LONG' OR route_row."schemaVersion" <> 2
    OR route_row.signal_cycle_id <> cycle_row.id
    OR route_row."tradingAccountId" <> NEW."tradingAccountId"
    OR route_row."tradingAccountSubscriptionId" <> NEW."tradingAccountSubscriptionId"
    OR route_row."subscriptionId" <> NEW."subscriptionId"
    OR cycle_row."securityId" <> NEW."securityId" THEN
    RAISE EXCEPTION 'External signal account cycle does not match its original entry route' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM "TradingAccountSubscription" tas
    WHERE tas.id = NEW."tradingAccountSubscriptionId"
      AND tas."tradingAccountId" = NEW."tradingAccountId"
      AND tas."subscriptionId" = NEW."subscriptionId"
      AND tas."routingSecurityId" = NEW."securityId"
  ) THEN
    RAISE EXCEPTION 'External signal account cycle assignment identity is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW."entryRolloutGenerationId" IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD."entryRolloutGenerationId" IS NULL) THEN
    SELECT * INTO rollout_row FROM "ExternalSignalExecutionRolloutGeneration" WHERE id = NEW."entryRolloutGenerationId";
    IF rollout_row.id IS NULL OR rollout_row.direction <> 'ENTRY' OR rollout_row."authorityMode" <> 'SHADOW' THEN
      RAISE EXCEPTION 'External signal account cycle entry rollout identity is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- The parent row lock above is held through commit. Therefore source terminalization
-- and every account INSERT/UPDATE have a single serialization point. Deferred checks
-- still evaluate final transaction state, but can no longer observe write-skewed
-- account membership or status.
CREATE OR REPLACE FUNCTION "check_external_signal_account_terminal_parent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status "ExternalSignalTradeCycleStatus";
BEGIN
  SELECT status INTO parent_status FROM "ExternalSignalTradeCycle"
    WHERE id = NEW."externalSignalTradeCycleId" FOR UPDATE;
  IF parent_status = 'TERMINAL_NO_EXPOSURE' AND NEW.status <> 'TERMINAL_NO_EXPOSURE' THEN
    RAISE EXCEPTION 'Terminal no-exposure source cycle requires compatible account cycles' USING ERRCODE = '23514';
  END IF;
  IF parent_status = 'TERMINAL_CLOSED' AND NEW.status NOT IN ('TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED') THEN
    RAISE EXCEPTION 'Terminal closed source cycle requires terminal account cycles' USING ERRCODE = '23514';
  END IF;
  IF parent_status = 'CONFLICT' THEN
    RAISE EXCEPTION 'Terminal conflict source cycle cannot accept or mutate account cycles' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
