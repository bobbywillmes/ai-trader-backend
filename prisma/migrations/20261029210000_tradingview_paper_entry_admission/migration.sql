ALTER TYPE "ExternalSignalAccountCycleStatus" ADD VALUE 'ENTRY_EXECUTION_PROSPECTIVE' AFTER 'ENTRY_SHADOW_ALLOWED';
ALTER TYPE "ExternalSignalCorrelationDecisionType" ADD VALUE 'ENTRY_EXECUTION_PROSPECTIVE' AFTER 'ENTRY_SHADOW_AUTHORITY';

ALTER TABLE "ExternalSignalTradeCycleAccount" DROP CONSTRAINT "ExternalSignalTradeCycleAccount_shadow_links_check";
ALTER TABLE "ExternalSignalTradeCycleAccount" ADD CONSTRAINT "ExternalSignalTradeCycleAccount_execution_links_check" CHECK (
  (status='ENTRY_INTENT_CREATED' AND "trackedPositionId" IS NULL)
  OR (status<>'ENTRY_INTENT_CREATED' AND "entryOrderIntentId" IS NULL AND "trackedPositionId" IS NULL)
);

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
