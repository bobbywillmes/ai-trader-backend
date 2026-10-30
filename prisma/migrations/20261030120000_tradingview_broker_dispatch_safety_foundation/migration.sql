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
  IF TG_OP<>'UPDATE' OR pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'TradingView broker dispatch state is database-owned'; END IF;
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
DECLARE o "ExternalSignalEntryExecutionObligation"%ROWTYPE; i "OrderIntent"%ROWTYPE; a "ExternalSignalTradeCycleAccount"%ROWTYPE; ds "ExternalSignalBrokerDispatchState"%ROWTYPE; auth "ExternalSignalEntryExecutionAuthorization"%ROWTYPE; expected text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'TradingView broker worker claims are immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);
  SELECT * INTO ds FROM "ExternalSignalBrokerDispatchState" WHERE id=1 FOR UPDATE;
  SELECT * INTO o FROM "ExternalSignalEntryExecutionObligation" WHERE id=NEW."executionObligationId" FOR UPDATE;
  SELECT * INTO i FROM "OrderIntent" WHERE id=NEW."orderIntentId" FOR UPDATE;
  SELECT * INTO a FROM "ExternalSignalTradeCycleAccount" WHERE id=NEW."accountCycleId" FOR UPDATE;
  SELECT * INTO auth FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=o."authorizationId" FOR UPDATE;
  IF ds."activeRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId" OR ds."activatedAt" IS NULL OR ds.version<>NEW."dispatchStateVersion"
    OR o.id IS NULL OR i.id IS NULL OR a.id IS NULL OR auth.id IS NULL OR auth.status<>'AUTHORIZED'
    OR ROW(NEW."orderIntentId",NEW."accountCycleId",NEW."rolloutGenerationId",NEW."clientOrderId") IS DISTINCT FROM ROW(o."orderIntentId",o."accountCycleId",o."rolloutGenerationId",o."clientOrderId")
    OR i."externalSignalAccountCycleId"<>a.id OR i."clientOrderId"<>o."clientOrderId" OR i.status<>'pending'
    OR a."entryOrderIntentId"<>i.id OR a."entryRolloutGenerationId"<>o."rolloutGenerationId"
    OR auth.id<>o."authorizationId" OR auth."rolloutGenerationId"<>o."rolloutGenerationId"
    OR o."executionEpochAt"<ds."activatedAt" OR o."createdAt"<ds."activatedAt" OR i."createdAt"<ds."activatedAt"
    OR EXISTS (SELECT 1 FROM "Signal" s WHERE s.id=o."entrySignalId" AND s."createdAt"<ds."activatedAt")
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
  SELECT * INTO auth FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=NEW."executionAuthorizationId";
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
    IF NEW."externalSignalAccountCycleId" IS DISTINCT FROM OLD."externalSignalAccountCycleId" THEN RAISE EXCEPTION 'marked external signal origin is immutable'; END IF;
    IF NEW.status NOT IN ('received','pending','blocked','failed') THEN RAISE EXCEPTION 'marked external signal OrderIntent dispatch is quarantined by the complete broker lifecycle contract'; END IF;
    IF NEW."trackedPositionId" IS DISTINCT FROM OLD."trackedPositionId" OR NEW."lastSubmittedOrderSyncAt" IS DISTINCT FROM OLD."lastSubmittedOrderSyncAt" THEN RAISE EXCEPTION 'marked external signal broker progress is quarantined'; END IF;
    -- Existing non-dispatch recovery may move among the four allowlisted states. C2 must add
    -- a narrowly scoped claim-backed pending-to-submitting exception; C1 adds no such exception.
  END IF;
  RETURN NEW;
END $$;

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
