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
  definition := replace(
    definition,
    'OR x.signal_created_at AT TIME ZONE ''UTC'' < ds."activatedAt" OR x.intent_created_at AT TIME ZONE ''UTC'' < ds."activatedAt"',
    'OR x.signal_created_at AT TIME ZONE ''UTC'' < ds."activatedAt" OR clock_timestamp() - (x.signal_created_at AT TIME ZONE ''UTC'') > interval ''120 seconds'' OR x.intent_created_at AT TIME ZONE ''UTC'' < ds."activatedAt"'
  );
  IF definition NOT LIKE '%FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec%' THEN
    RAISE EXCEPTION 'unable to narrow TradingView worker-claim lock protocol';
  END IF;
  EXECUTE definition;
END $$;

CREATE OR REPLACE FUNCTION external_signal_order_intent_dispatch_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paired_consumption boolean; worker_claimed boolean; not_sent boolean; broker_evidence boolean;
BEGIN
  IF TG_OP='INSERT' AND NEW."externalSignalAccountCycleId" IS NOT NULL AND NEW.status<>'received' THEN RAISE EXCEPTION 'marked external signal OrderIntent must be created in received status'; END IF;
  IF TG_OP='UPDATE' AND OLD."externalSignalAccountCycleId" IS NOT NULL THEN
    IF ROW(NEW."externalSignalAccountCycleId",NEW.source,NEW.symbol,NEW.side,NEW."orderType",NEW."timeInForce",NEW.qty,NEW.notional,NEW."limitPrice",NEW."extendedHours",NEW."clientOrderId",NEW."createdAt",NEW."subscriptionId",NEW."subscriptionKey",NEW."tradingAccountId",NEW."tradingAccountSubscriptionId",NEW."liveEntryAcceptanceRunId",NEW."rawRequestJson" - 'riskEvaluation')
      IS DISTINCT FROM ROW(OLD."externalSignalAccountCycleId",OLD.source,OLD.symbol,OLD.side,OLD."orderType",OLD."timeInForce",OLD.qty,OLD.notional,OLD."limitPrice",OLD."extendedHours",OLD."clientOrderId",OLD."createdAt",OLD."subscriptionId",OLD."subscriptionKey",OLD."tradingAccountId",OLD."tradingAccountSubscriptionId",OLD."liveEntryAcceptanceRunId",OLD."rawRequestJson" - 'riskEvaluation')
    THEN RAISE EXCEPTION 'marked external signal origin is insert-only and immutable, including activation evidence'; END IF;
    paired_consumption := EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=OLD.id);
    worker_claimed := EXISTS (SELECT 1 FROM "ExternalSignalBrokerWorkerClaim" c WHERE c."orderIntentId"=OLD.id);
    not_sent := EXISTS (SELECT 1 FROM "EntryExposureClaim" ec JOIN "EntryExposureClaimEvent" e ON e."claimId"=ec.id WHERE ec."orderIntentId"=OLD.id AND e."eventType"='NOT_SENT_EVIDENCE_RECORDED');
    broker_evidence := EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=OLD.id)
      OR EXISTS (SELECT 1 FROM "BrokerActivity" ba WHERE ba."orderIntentId"=OLD.id)
      OR EXISTS (SELECT 1 FROM "OrderIntentBrokerOpportunityEvent" oe WHERE oe."orderIntentId"=OLD.id AND oe."eventType" NOT IN ('OPPORTUNITY_CAPTURED','DEFERRED','MISSING_OBSERVATION'));
    IF OLD.status IN ('blocked','failed') AND (NEW."blockReason" IS DISTINCT FROM OLD."blockReason" OR NEW."rawRequestJson" IS DISTINCT FROM OLD."rawRequestJson") THEN
      RAISE EXCEPTION 'terminal TradingView refusal and its evidence are immutable';
    END IF;
    IF paired_consumption THEN
      IF NEW.status IS DISTINCT FROM OLD.status OR NEW."blockReason" IS DISTINCT FROM OLD."blockReason" THEN RAISE EXCEPTION 'consumed TradingView dispatch lifecycle is quarantined pending C3 validated broker evidence'; END IF;
    ELSIF worker_claimed AND OLD.status IN ('blocked','failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'completed TradingView worker claim cannot become reclaimable';
    ELSIF NEW.status='submitting' AND OLD.status='pending' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "ExternalSignalBrokerWorkerClaim" c
        JOIN "EntryExposureClaim" ec ON ec."orderIntentId"=c."orderIntentId" AND ec.status='ENTRY_SUBMITTING' AND ec."releasedAt" IS NULL
        JOIN "EntryExposureClaimEvent" e ON e."claimId"=ec.id AND e."eventType"='WORKER_CLAIMED_FOR_SUBMISSION'
        WHERE c."orderIntentId"=OLD.id AND c."accountCycleId"=OLD."externalSignalAccountCycleId" AND c."clientOrderId"=OLD."clientOrderId"
      ) THEN RAISE EXCEPTION 'marked external signal dispatch is quarantined without its complete atomic worker claim'; END IF;
    ELSIF NEW.status IN ('blocked','failed') AND OLD.status='submitting' THEN
      IF NOT not_sent OR broker_evidence THEN RAISE EXCEPTION 'marked external signal pre-dispatch terminal transition requires uncontradicted durable not-sent evidence'; END IF;
    ELSIF worker_claimed AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'claimed TradingView intent dispatch is quarantined in Phase 4A.2C2';
    ELSIF not_sent AND OLD.status IN ('blocked','failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'refused TradingView intent cannot become reclaimable';
    ELSIF NEW.status IS DISTINCT FROM OLD.status AND NOT (NOT worker_claimed AND NEW.status IN ('received','pending','blocked','failed')) THEN
      RAISE EXCEPTION 'marked external signal dispatch is quarantined in Phase 4A.2C2'; END IF;
    IF NEW."trackedPositionId" IS DISTINCT FROM OLD."trackedPositionId" OR NEW."lastSubmittedOrderSyncAt" IS DISTINCT FROM OLD."lastSubmittedOrderSyncAt" THEN RAISE EXCEPTION 'marked external signal broker progress is quarantined'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- A JSON label is not ownership. For a claimed lifecycle the immutable worker-claim row and its
-- database-owned claim event must precede the not-sent event, and the producer must be one of the
-- C2 code paths that owns that exact claim. Unclaimed refusal evidence is accepted only after the
-- pending intent has been atomically closed and while no worker claim exists.
CREATE FUNCTION external_signal_c2_not_sent_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent_id integer; intent_status text; marked boolean; worker_id integer; claim_event_id integer; producer text; evidence_worker_id integer;
BEGIN
  IF NEW."eventType"<>'NOT_SENT_EVIDENCE_RECORDED' THEN RETURN NEW; END IF;
  SELECT ec."orderIntentId",i.status,(i."externalSignalAccountCycleId" IS NOT NULL)
    INTO intent_id,intent_status,marked FROM "EntryExposureClaim" ec JOIN "OrderIntent" i ON i.id=ec."orderIntentId" WHERE ec.id=NEW."claimId";
  IF NOT coalesce(marked,false) THEN RETURN NEW; END IF;
  SELECT id INTO worker_id FROM "ExternalSignalBrokerWorkerClaim" WHERE "orderIntentId"=intent_id;
  producer := NEW."evidenceJson"->>'producer';
  IF worker_id IS NULL THEN
    IF intent_status NOT IN ('blocked','failed') OR producer<>'TRADINGVIEW_C2_PRECLAIM_REFUSAL' THEN
      RAISE EXCEPTION 'unclaimed TradingView not-sent evidence requires its closed pre-claim refusal';
    END IF;
  ELSE
    BEGIN evidence_worker_id := (NEW."evidenceJson"->>'workerClaimId')::integer; EXCEPTION WHEN others THEN evidence_worker_id := NULL; END;
    SELECT e.id INTO claim_event_id FROM "EntryExposureClaimEvent" e
      WHERE e."claimId"=NEW."claimId" AND e."eventType"='WORKER_CLAIMED_FOR_SUBMISSION'
        AND (e."evidenceJson"->>'workerClaimId')::integer=worker_id ORDER BY e.id DESC LIMIT 1;
    IF evidence_worker_id IS DISTINCT FROM worker_id OR claim_event_id IS NULL OR claim_event_id>=NEW.id
      OR producer NOT IN ('TRADINGVIEW_C2_RISK_REFUSAL','TRADINGVIEW_C2_DISPATCH_UNAVAILABLE','TRADINGVIEW_C2_PRE_DISPATCH_RECOVERY','WORKER_PRE_BOUNDARY_FAILURE') THEN
      RAISE EXCEPTION 'claimed TradingView not-sent evidence lacks current worker-claim provenance';
    END IF;
    IF EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW."claimId" AND e."eventType"='NOT_SENT_EVIDENCE_RECORDED' AND e.id>claim_event_id) THEN
      RAISE EXCEPTION 'claimed TradingView lifecycle already has not-sent evidence';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EntryExposureClaimEvent_external_signal_c2_not_sent_guard" BEFORE INSERT ON "EntryExposureClaimEvent" FOR EACH ROW EXECUTE FUNCTION external_signal_c2_not_sent_evidence_guard();

CREATE FUNCTION external_signal_exposure_claim_c2_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean; consumed boolean; worker_claimed boolean; owned_not_sent boolean; dispatch_outcome boolean; contradictory boolean; intent_status text; worker_id integer; claim_event_id integer;
BEGIN
  IF NEW."orderIntentId" IS NULL THEN RETURN NEW; END IF;
  SELECT (i."externalSignalAccountCycleId" IS NOT NULL), EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=i.id)
    INTO marked,consumed FROM "OrderIntent" i WHERE i.id=NEW."orderIntentId";
  IF NOT coalesce(marked,false) THEN RETURN NEW; END IF;
  SELECT i.status,c.id INTO intent_status,worker_id FROM "OrderIntent" i LEFT JOIN "ExternalSignalBrokerWorkerClaim" c ON c."orderIntentId"=i.id WHERE i.id=NEW."orderIntentId";
  worker_claimed := worker_id IS NOT NULL;
  SELECT e.id INTO claim_event_id FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW.id AND e."eventType"='WORKER_CLAIMED_FOR_SUBMISSION'
    AND (e."evidenceJson"->>'workerClaimId')::integer=worker_id ORDER BY e.id DESC LIMIT 1;
  owned_not_sent := EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW.id AND e."eventType"='NOT_SENT_EVIDENCE_RECORDED'
    AND (NOT worker_claimed OR ((e."evidenceJson"->>'workerClaimId')::integer=worker_id AND e.id>claim_event_id)));
  dispatch_outcome := EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW.id AND e."eventType"='DISPATCH_OUTCOME_RECORDED');
  contradictory := dispatch_outcome OR NEW."trackedPositionId" IS NOT NULL
    OR EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchConsumption" c WHERE c."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerUnenforcedDispatch" c WHERE c."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "BrokerActivity" ba WHERE ba."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "OrderIntentBrokerOpportunityEvent" oe WHERE oe."orderIntentId"=NEW."orderIntentId" AND oe."eventType" NOT IN ('OPPORTUNITY_CAPTURED','DEFERRED','MISSING_OBSERVATION'))
    OR EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW.id AND e."eventType"='ADAPTER_INVOCATION_STARTED');
  IF consumed AND (NEW.status IS DISTINCT FROM OLD.status OR NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" OR NEW."trackedPositionId" IS DISTINCT FROM OLD."trackedPositionId") THEN RAISE EXCEPTION 'consumed TradingView exposure cannot use pre-dispatch recovery; lifecycle is quarantined pending C3 validated broker evidence'; END IF;
  IF OLD.status='ENTRY_PENDING' AND NEW.status='ENTRY_SUBMITTING' AND NOT worker_claimed THEN RAISE EXCEPTION 'TradingView ENTRY_SUBMITTING transition requires its immutable worker claim'; END IF;
  IF worker_claimed AND OLD.status='ENTRY_PENDING' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'ENTRY_SUBMITTING' THEN RAISE EXCEPTION 'claimed TradingView exposure must enter ENTRY_SUBMITTING atomically'; END IF;
  IF worker_claimed AND OLD.status='ENTRY_SUBMITTING' AND NEW.status IN ('ENTRY_PENDING','ADMISSION_BLOCKED') THEN RAISE EXCEPTION 'claimed TradingView exposure cannot return to a pre-claim state'; END IF;
  IF worker_claimed AND OLD.status='ENTRY_SUBMITTING' AND NEW.status='RELEASED' AND (intent_status NOT IN ('blocked','failed') OR claim_event_id IS NULL OR NOT owned_not_sent OR contradictory) THEN RAISE EXCEPTION 'TradingView claim release requires terminal intent and current uncontradicted worker-owned not-sent evidence'; END IF;
  IF worker_claimed AND OLD.status='ENTRY_SUBMITTING' AND NEW.status='UNRESOLVED' AND NOT dispatch_outcome THEN RAISE EXCEPTION 'TradingView unresolved exposure requires durable dispatch-outcome evidence'; END IF;
  IF worker_claimed AND NEW.status='BROKER_ORDER_ACTIVE' AND OLD.status IS DISTINCT FROM 'BROKER_ORDER_ACTIVE' AND NOT EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=NEW."orderIntentId") THEN RAISE EXCEPTION 'TradingView broker-active exposure requires broker order evidence'; END IF;
  IF worker_claimed AND NEW.status='POSITION_OPEN' AND OLD.status IS DISTINCT FROM 'POSITION_OPEN' AND NEW."trackedPositionId" IS NULL THEN RAISE EXCEPTION 'TradingView open exposure requires an attached position'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EntryExposureClaim_external_signal_c2_guard" BEFORE UPDATE ON "EntryExposureClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_exposure_claim_c2_guard();
