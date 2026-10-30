-- Phase 4A.2C2: controlled TradingView worker ownership without broker authority.

-- Keep the advisory-lock-first protocol while narrowing C1's broad row-lock set. Immutable
-- obligation, Signal, route and routing-run evidence is validated from the transaction snapshot;
-- mutable source-cycle/authority/catalog/exposure identities remain fenced with row locks.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('external_signal_broker_worker_claim_guard()'::regprocedure) INTO definition;
  definition := replace(
    definition,
    'FOR UPDATE OF o,i,ac,c,s,sr,rr,auth,gen,ta,tas,sub,sec,src,b,rev,ec',
    'FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec'
  );
  IF definition NOT LIKE '%FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec%' THEN
    RAISE EXCEPTION 'unable to narrow TradingView worker-claim lock protocol';
  END IF;
  EXECUTE definition;
END $$;

CREATE OR REPLACE FUNCTION external_signal_order_intent_dispatch_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paired_consumption boolean;
BEGIN
  IF TG_OP='INSERT' AND NEW."externalSignalAccountCycleId" IS NOT NULL AND NEW.status<>'received' THEN RAISE EXCEPTION 'marked external signal OrderIntent must be created in received status'; END IF;
  IF TG_OP='UPDATE' AND OLD."externalSignalAccountCycleId" IS NOT NULL THEN
    IF ROW(NEW."externalSignalAccountCycleId",NEW.source,NEW.symbol,NEW.side,NEW."orderType",NEW."timeInForce",NEW.qty,NEW.notional,NEW."limitPrice",NEW."extendedHours",NEW."clientOrderId",NEW."createdAt",NEW."subscriptionId",NEW."subscriptionKey",NEW."tradingAccountId",NEW."tradingAccountSubscriptionId",NEW."liveEntryAcceptanceRunId")
      IS DISTINCT FROM ROW(OLD."externalSignalAccountCycleId",OLD.source,OLD.symbol,OLD.side,OLD."orderType",OLD."timeInForce",OLD.qty,OLD.notional,OLD."limitPrice",OLD."extendedHours",OLD."clientOrderId",OLD."createdAt",OLD."subscriptionId",OLD."subscriptionKey",OLD."tradingAccountId",OLD."tradingAccountSubscriptionId",OLD."liveEntryAcceptanceRunId")
    THEN RAISE EXCEPTION 'marked external signal origin is insert-only and immutable, including activation evidence'; END IF;
    paired_consumption := EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=OLD.id);
    IF paired_consumption THEN
      IF NEW.status='pending' OR (NEW.status IN ('blocked','failed') AND NEW.status IS DISTINCT FROM OLD.status) THEN RAISE EXCEPTION 'consumed TradingView dispatch cannot return to a pre-dispatch or definitely-not-sent status'; END IF;
    ELSIF NEW.status='submitting' AND OLD.status='pending' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "ExternalSignalBrokerWorkerClaim" c
        JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=c."orderIntentId" AND ec.status='ENTRY_SUBMITTING' AND ec."releasedAt" IS NULL
        JOIN "EntryExposureClaimEvent" e ON e."claimId"=ec.id AND e."eventType"='WORKER_CLAIMED_FOR_SUBMISSION'
        WHERE c."orderIntentId"=OLD.id AND c."accountCycleId"=OLD."externalSignalAccountCycleId" AND c."clientOrderId"=OLD."clientOrderId"
      ) THEN RAISE EXCEPTION 'marked external signal dispatch is quarantined without its complete atomic worker claim'; END IF;
    ELSIF NEW.status IN ('blocked','failed') AND OLD.status='submitting' THEN
      IF NOT EXISTS (SELECT 1 FROM "EntryExposureClaim" ec JOIN "EntryExposureClaimEvent" e ON e."claimId"=ec.id WHERE ec."orderIntentId"=OLD.id AND e."eventType"='NOT_SENT_EVIDENCE_RECORDED') THEN RAISE EXCEPTION 'marked external signal pre-dispatch terminal transition requires durable not-sent evidence'; END IF;
    ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('received','pending','blocked','failed') THEN RAISE EXCEPTION 'marked external signal dispatch is quarantined in Phase 4A.2C2'; END IF;
    IF NEW."trackedPositionId" IS DISTINCT FROM OLD."trackedPositionId" OR NEW."lastSubmittedOrderSyncAt" IS DISTINCT FROM OLD."lastSubmittedOrderSyncAt" THEN RAISE EXCEPTION 'marked external signal broker progress is quarantined'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION external_signal_exposure_claim_c2_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean; consumed boolean;
BEGIN
  IF NEW."orderIntentId" IS NULL THEN RETURN NEW; END IF;
  SELECT (i."externalSignalAccountCycleId" IS NOT NULL), EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=i.id)
    INTO marked,consumed FROM "OrderIntent" i WHERE i.id=NEW."orderIntentId";
  IF NOT coalesce(marked,false) THEN RETURN NEW; END IF;
  IF consumed AND (NEW.status IN ('ENTRY_PENDING','ADMISSION_BLOCKED','RELEASED') OR NEW."releasedAt" IS NOT NULL) THEN RAISE EXCEPTION 'consumed TradingView dispatch exposure cannot use pre-dispatch recovery'; END IF;
  IF TG_OP='UPDATE' AND OLD.status='ENTRY_PENDING' AND NEW.status='ENTRY_SUBMITTING' AND NOT EXISTS (SELECT 1 FROM "ExternalSignalBrokerWorkerClaim" c WHERE c."orderIntentId"=NEW."orderIntentId") THEN RAISE EXCEPTION 'TradingView ENTRY_SUBMITTING transition requires its immutable worker claim'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EntryExposureClaim_external_signal_c2_guard" BEFORE UPDATE ON "EntryExposureClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_exposure_claim_c2_guard();
