-- Phase 4A.2C3A: inert dispatch-safety hardening. Forward-only; replaces trigger functions and adds no
-- table, column or broker capability. See docs/architecture/tradingview-paper-execution-authority.md.

-- The single stale-admission age rule. Prisma stores timestamp(3) values as UTC, so the conversion is
-- explicit and the result cannot depend on the session time zone or on DST in that zone.
CREATE FUNCTION external_signal_stale_admission_elapsed(observed_utc timestamp, at_instant timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (observed_utc AT TIME ZONE 'UTC') <= at_instant - interval '15 minutes'
$$;

-- A marked claim's acquisition time is database-owned, so it cannot be backdated at insert. The C2
-- guard below makes it immutable afterwards. Together they make it the database's age authority.
CREATE FUNCTION external_signal_exposure_claim_acquired_at_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."orderIntentId" IS NOT NULL AND EXISTS (SELECT 1 FROM "OrderIntent" i WHERE i.id=NEW."orderIntentId" AND i."externalSignalAccountCycleId" IS NOT NULL) THEN
    NEW."acquiredAt" := clock_timestamp() AT TIME ZONE 'UTC';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EntryExposureClaim_external_signal_acquired_at_stamp" BEFORE INSERT ON "EntryExposureClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_exposure_claim_acquired_at_stamp();

-- Evidence and release linearize on the claim's row version, for every isolation-level pair.
--
-- A row lock alone leaves the tuple unchanged, so a REPEATABLE READ or SERIALIZABLE release whose
-- snapshot predates the evidence could still commit. This UPDATE writes a new tuple version, so that
-- release fails with 40001, while a READ COMMITTED release re-reads and its guard sees the evidence.
-- In the other direction the UPDATE waits for a release, then re-reads the row and refuses (READ
-- COMMITTED) or fails with 40001 (snapshot isolation). It changes no value: lifecycle state,
-- timestamps and diagnostics are untouched, and no claim event is appended.
--
-- The origin is decided before any lock, so unmarked claims keep their pre-C2 FOR KEY SHARE behavior
-- from the foreign-key check. Decision without a lock has no time-of-check gap: the OrderIntent marker
-- is insert-only and the C2 guard below forbids moving a claim onto or off a marked intent.
CREATE OR REPLACE FUNCTION external_signal_c2_delivery_event_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean; released_at timestamp;
BEGIN
  IF NEW."eventType" NOT IN ('WORKER_CLAIMED_FOR_SUBMISSION','NOT_SENT_EVIDENCE_RECORDED','ADAPTER_INVOCATION_STARTED','DISPATCH_OUTCOME_RECORDED','BROKER_DELIVERY_UNCERTAIN') THEN RETURN NEW; END IF;
  SELECT i."externalSignalAccountCycleId" IS NOT NULL INTO marked
    FROM "EntryExposureClaim" ec JOIN "OrderIntent" i ON i.id=ec."orderIntentId" WHERE ec.id=NEW."claimId";
  IF NOT coalesce(marked,false) THEN RETURN NEW; END IF;
  UPDATE "EntryExposureClaim" SET "lastDiagnosedAt"="lastDiagnosedAt" WHERE id=NEW."claimId" RETURNING "releasedAt" INTO released_at;
  IF released_at IS NOT NULL THEN
    RAISE EXCEPTION 'TradingView delivery evidence cannot be appended after exposure release';
  END IF;
  RETURN NEW;
END $$;

-- This guard's narrower time guarantee: it proves that a stale-admission claim has been held for the
-- full threshold by the PostgreSQL clock. It cannot prove intent inactivity, because terminalization
-- has already rewritten OrderIntent.updatedAt in this transaction. The serialized recovery transaction
-- (recoverStaleAdmissionClaimsForAccount) makes that decision before terminalizing. JSON labels only
-- select a rule here; none of them is authority for non-send.
CREATE OR REPLACE FUNCTION external_signal_c2_not_sent_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent_id integer; intent_status text; marked boolean; worker_id integer; claim_event_id integer; producer text; evidence_worker_id integer; contradictory boolean; claim_status text; claim_acquired_at timestamp;
BEGIN
  IF NEW."eventType"<>'NOT_SENT_EVIDENCE_RECORDED' THEN RETURN NEW; END IF;
  SELECT ec."orderIntentId",i.status,(i."externalSignalAccountCycleId" IS NOT NULL),ec.status,ec."acquiredAt"
    INTO intent_id,intent_status,marked,claim_status,claim_acquired_at FROM "EntryExposureClaim" ec JOIN "OrderIntent" i ON i.id=ec."orderIntentId" WHERE ec.id=NEW."claimId";
  IF NOT coalesce(marked,false) THEN RETURN NEW; END IF;
  SELECT id INTO worker_id FROM "ExternalSignalBrokerWorkerClaim" WHERE "orderIntentId"=intent_id;
  producer := NEW."evidenceJson"->>'producer';
  contradictory := EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW."claimId" AND e."eventType" IN ('ADAPTER_INVOCATION_STARTED','DISPATCH_OUTCOME_RECORDED','BROKER_DELIVERY_UNCERTAIN'))
    OR EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=intent_id)
    OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchConsumption" c WHERE c."orderIntentId"=intent_id)
    OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerUnenforcedDispatch" c WHERE c."orderIntentId"=intent_id)
    OR EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=intent_id)
    OR EXISTS (SELECT 1 FROM "BrokerActivity" ba WHERE ba."orderIntentId"=intent_id)
    OR EXISTS (SELECT 1 FROM "OrderIntentBrokerOpportunityEvent" oe WHERE oe."orderIntentId"=intent_id AND oe."eventType" NOT IN ('OPPORTUNITY_CAPTURED','DEFERRED','MISSING_OBSERVATION'));
  IF contradictory THEN RAISE EXCEPTION 'TradingView not-sent evidence contradicts persisted dispatch or broker evidence'; END IF;
  IF worker_id IS NULL THEN
    IF intent_status NOT IN ('blocked','failed') OR claim_status<>'ENTRY_PENDING' OR NOT (
      producer='TRADINGVIEW_C2_PRECLAIM_REFUSAL'
      OR (producer='STALE_ADMISSION_NEVER_EXECUTABLE' AND NEW."evidenceJson"->>'source'='STALE_ADMISSION_RECOVERY'
        AND NEW."evidenceJson"#>>'{proof,basis}'='CLAIM_NEVER_LEFT_ENTRY_PENDING'
        AND external_signal_stale_admission_elapsed(claim_acquired_at, clock_timestamp()))
    ) THEN
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

-- Adds to C2: a claim cannot move onto or off a marked intent, a marked claim's identity and
-- acquisition time are immutable, and possible-delivery evidence blocks every release of a marked
-- claim, with or without a worker claim. C3C owns any authoritative broker-evidence release path.
CREATE OR REPLACE FUNCTION external_signal_exposure_claim_c2_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marked boolean; consumed boolean; worker_claimed boolean; owned_not_sent boolean; dispatch_outcome boolean; contradictory boolean; possible_delivery boolean; intent_status text; worker_id integer; claim_event_id integer;
BEGIN
  SELECT coalesce(bool_or(i."externalSignalAccountCycleId" IS NOT NULL),false) INTO marked FROM "OrderIntent" i WHERE i.id IN (OLD."orderIntentId",NEW."orderIntentId");
  IF NOT marked THEN RETURN NEW; END IF;
  IF ROW(NEW."orderIntentId",NEW."tradingAccountId",NEW."securityId",NEW."ownerKey",NEW."acquiredAt",NEW."createdAt") IS DISTINCT FROM ROW(OLD."orderIntentId",OLD."tradingAccountId",OLD."securityId",OLD."ownerKey",OLD."acquiredAt",OLD."createdAt") THEN
    RAISE EXCEPTION 'TradingView exposure claim identity and acquisition time are immutable';
  END IF;
  SELECT EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=NEW."orderIntentId") INTO consumed;
  SELECT i.status,c.id INTO intent_status,worker_id FROM "OrderIntent" i LEFT JOIN "ExternalSignalBrokerWorkerClaim" c ON c."orderIntentId"=i.id WHERE i.id=NEW."orderIntentId";
  worker_claimed := worker_id IS NOT NULL;
  SELECT e.id INTO claim_event_id FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW.id AND e."eventType"='WORKER_CLAIMED_FOR_SUBMISSION'
    AND (e."evidenceJson"->>'workerClaimId')::integer=worker_id ORDER BY e.id DESC LIMIT 1;
  owned_not_sent := EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW.id AND e."eventType"='NOT_SENT_EVIDENCE_RECORDED'
    AND (NOT worker_claimed OR ((e."evidenceJson"->>'workerClaimId')::integer=worker_id AND e.id>claim_event_id)));
  dispatch_outcome := EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW.id AND e."eventType" IN ('DISPATCH_OUTCOME_RECORDED','BROKER_DELIVERY_UNCERTAIN'));
  possible_delivery := dispatch_outcome OR EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId"=NEW.id AND e."eventType"='ADAPTER_INVOCATION_STARTED');
  contradictory := possible_delivery OR NEW."trackedPositionId" IS NOT NULL
    OR EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchConsumption" c WHERE c."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerUnenforcedDispatch" c WHERE c."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "BrokerActivity" ba WHERE ba."orderIntentId"=NEW."orderIntentId")
    OR EXISTS (SELECT 1 FROM "OrderIntentBrokerOpportunityEvent" oe WHERE oe."orderIntentId"=NEW."orderIntentId" AND oe."eventType" NOT IN ('OPPORTUNITY_CAPTURED','DEFERRED','MISSING_OBSERVATION'));
  IF consumed AND (NEW.status IS DISTINCT FROM OLD.status OR NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" OR NEW."trackedPositionId" IS DISTINCT FROM OLD."trackedPositionId") THEN RAISE EXCEPTION 'consumed TradingView exposure cannot use pre-dispatch recovery; lifecycle is quarantined pending C3 validated broker evidence'; END IF;
  IF NEW.status='RELEASED' AND OLD.status IS DISTINCT FROM 'RELEASED' AND intent_status IN ('received','pending') THEN RAISE EXCEPTION 'TradingView exposure cannot be released while its intent remains executable'; END IF;
  IF OLD.status='ENTRY_PENDING' AND NEW.status='ENTRY_SUBMITTING' AND NOT worker_claimed THEN RAISE EXCEPTION 'TradingView ENTRY_SUBMITTING transition requires its immutable worker claim'; END IF;
  IF worker_claimed AND OLD.status='ENTRY_PENDING' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'ENTRY_SUBMITTING' THEN RAISE EXCEPTION 'claimed TradingView exposure must enter ENTRY_SUBMITTING atomically'; END IF;
  IF worker_claimed AND OLD.status='ENTRY_SUBMITTING' AND NEW.status IN ('ENTRY_PENDING','ADMISSION_BLOCKED') THEN RAISE EXCEPTION 'claimed TradingView exposure cannot return to a pre-claim state'; END IF;
  IF worker_claimed AND OLD.status='ENTRY_SUBMITTING' AND NEW.status='RELEASED' AND (intent_status NOT IN ('blocked','failed') OR claim_event_id IS NULL OR NOT owned_not_sent OR contradictory) THEN RAISE EXCEPTION 'TradingView claim release requires terminal intent and current uncontradicted worker-owned not-sent evidence'; END IF;
  IF possible_delivery AND OLD."releasedAt" IS NULL AND NEW."releasedAt" IS NOT NULL THEN RAISE EXCEPTION 'TradingView exposure with possible-delivery evidence cannot be released before authoritative broker reconciliation'; END IF;
  IF worker_claimed AND OLD.status='ENTRY_SUBMITTING' AND NEW.status='UNRESOLVED' AND NOT dispatch_outcome THEN RAISE EXCEPTION 'TradingView unresolved exposure requires durable dispatch-outcome evidence'; END IF;
  IF worker_claimed AND NEW.status='BROKER_ORDER_ACTIVE' AND OLD.status IS DISTINCT FROM 'BROKER_ORDER_ACTIVE' AND NOT EXISTS (SELECT 1 FROM "BrokerOrder" bo WHERE bo."orderIntentId"=NEW."orderIntentId") THEN RAISE EXCEPTION 'TradingView broker-active exposure requires broker order evidence'; END IF;
  IF worker_claimed AND NEW.status='POSITION_OPEN' AND OLD.status IS DISTINCT FROM 'POSITION_OPEN' AND NEW."trackedPositionId" IS NULL THEN RAISE EXCEPTION 'TradingView open exposure requires an attached position'; END IF;
  RETURN NEW;
END $$;

-- Canonical terminal contract: 'blocked' and 'failed' are both final for a marked intent. Neither can
-- become the other or become executable, and the status, reason and risk evidence that made it
-- terminal are not rewritten, whether or not a worker claim or not-sent event exists.
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
    IF OLD.status IN ('blocked','failed') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW."blockReason" IS DISTINCT FROM OLD."blockReason" OR NEW."rawRequestJson" IS DISTINCT FROM OLD."rawRequestJson") THEN
      RAISE EXCEPTION 'terminal TradingView intent and its evidence are immutable';
    END IF;
    IF paired_consumption THEN
      IF NEW.status IS DISTINCT FROM OLD.status OR NEW."blockReason" IS DISTINCT FROM OLD."blockReason" THEN RAISE EXCEPTION 'consumed TradingView dispatch lifecycle is quarantined pending C3 validated broker evidence'; END IF;
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
    ELSIF NEW.status IS DISTINCT FROM OLD.status AND NOT (NOT worker_claimed AND NEW.status IN ('received','pending','blocked','failed')) THEN
      RAISE EXCEPTION 'marked external signal dispatch is quarantined in Phase 4A.2C2'; END IF;
    IF NEW."trackedPositionId" IS DISTINCT FROM OLD."trackedPositionId" OR NEW."lastSubmittedOrderSyncAt" IS DISTINCT FROM OLD."lastSubmittedOrderSyncAt" THEN RAISE EXCEPTION 'marked external signal broker progress is quarantined'; END IF;
  END IF;
  RETURN NEW;
END $$;
