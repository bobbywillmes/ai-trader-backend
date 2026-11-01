-- DESIGN PROBE OVERLAY for docs/architecture/tradingview-c3b2-final-dispatch-transaction.md (revision 4).
-- DISPOSABLE DATABASES ONLY. This is NOT a migration. It is applied by c3b2-r4-real-schema-probes.ts on top of the
-- fully migrated real schema (C3B.1 included) so that the revised contracts can be exercised against the real triggers,
-- constraints and fixtures. Nothing here is approved for implementation until Hermes accepts revision 4.

-- ---------------------------------------------------------------------------------------------------------------
-- A. Dispatch fence (revision 4 protocol)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ExternalSignalDispatchFence" (
  "orderIntentId" integer PRIMARY KEY REFERENCES "OrderIntent"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version >= 1)
);

CREATE FUNCTION external_signal_dispatch_fence_create() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."externalSignalAccountCycleId" IS NOT NULL THEN
    INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES (NEW.id, 1);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "OrderIntent_dispatch_fence_create" AFTER INSERT ON "OrderIntent"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_create();

-- Only trigger-issued, strictly +1 updates; never deleted or truncated.
CREATE FUNCTION external_signal_dispatch_fence_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() < 2 OR NEW."orderIntentId" IS DISTINCT FROM OLD."orderIntentId" OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'dispatch fence accepts only trigger-issued +1 increments';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'dispatch fence rows are never deleted or truncated';
END $$;
CREATE TRIGGER "ExternalSignalDispatchFence_guard" BEFORE UPDATE OR DELETE ON "ExternalSignalDispatchFence"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_guard();
CREATE TRIGGER "ExternalSignalDispatchFence_truncate_guard" BEFORE TRUNCATE ON "ExternalSignalDispatchFence"
  FOR EACH STATEMENT EXECUTE FUNCTION external_signal_dispatch_fence_guard();

CREATE FUNCTION external_signal_marked_intent(p_intent_id integer) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "OrderIntent" WHERE id = p_intent_id AND "externalSignalAccountCycleId" IS NOT NULL)
$$;

-- D4: ONE identity key shared by the fence triggers and the finalization absence check. A broker row belongs to a
-- marked intent when ANY of these hold: its orderIntentId; its clientOrderId equals the frozen obligation's; for
-- activity, its orderId equals a BrokerOrder.brokerOrderId (same account) that belongs to the intent by orderIntentId
-- or clientOrderId. Unmarked rows resolve to the empty set (the trigger is inert).
CREATE FUNCTION external_signal_broker_evidence_marked_intents(p_intent_id integer, p_client_order_id text, p_broker_order_id text, p_account_id integer)
RETURNS SETOF integer LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT i.id FROM "OrderIntent" i
  WHERE i."externalSignalAccountCycleId" IS NOT NULL AND (
    i.id = p_intent_id
    OR i.id IN (SELECT o."orderIntentId" FROM "ExternalSignalEntryExecutionObligation" o WHERE p_client_order_id IS NOT NULL AND o."clientOrderId" = p_client_order_id)
    OR i.id IN (SELECT b."orderIntentId" FROM "BrokerOrder" b WHERE p_broker_order_id IS NOT NULL AND b."brokerOrderId" = p_broker_order_id AND b."tradingAccountId" IS NOT DISTINCT FROM p_account_id AND b."orderIntentId" IS NOT NULL)
    OR i.id IN (SELECT o."orderIntentId" FROM "BrokerOrder" b JOIN "ExternalSignalEntryExecutionObligation" o ON o."clientOrderId" = b."clientOrderId"
                WHERE p_broker_order_id IS NOT NULL AND b."brokerOrderId" = p_broker_order_id AND b."tradingAccountId" IS NOT DISTINCT FROM p_account_id))
  ORDER BY i.id
$$;

-- TG_ARGV[0] = kind: direct (TG_ARGV[1] = column), claim (EntryExposureClaim), claimevent, brokerorder, brokeractivity.
-- Each distinct marked intent is bumped once per row change, in ascending intent order.
CREATE FUNCTION external_signal_dispatch_fence_bump() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE kind text := TG_ARGV[0]; n jsonb; o jsonb; ids integer[]; one integer;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN n := to_jsonb(NEW); END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN o := to_jsonb(OLD); END IF;
  IF kind = 'direct' THEN
    ids := ARRAY(SELECT x FROM (SELECT (n ->> TG_ARGV[1])::integer AS x UNION SELECT (o ->> TG_ARGV[1])::integer) s
                 WHERE x IS NOT NULL AND external_signal_marked_intent(x) ORDER BY x);
  ELSIF kind = 'claimevent' THEN
    ids := ARRAY(SELECT c."orderIntentId" FROM "EntryExposureClaim" c WHERE c.id = (n ->> 'claimId')::integer AND external_signal_marked_intent(c."orderIntentId"));
  ELSIF kind = 'brokerorder' THEN
    ids := ARRAY(SELECT DISTINCT m FROM (
      SELECT * FROM external_signal_broker_evidence_marked_intents((n ->> 'orderIntentId')::integer, n ->> 'clientOrderId', n ->> 'brokerOrderId', (n ->> 'tradingAccountId')::integer)
      UNION ALL SELECT * FROM external_signal_broker_evidence_marked_intents((o ->> 'orderIntentId')::integer, o ->> 'clientOrderId', o ->> 'brokerOrderId', (o ->> 'tradingAccountId')::integer)) s(m) ORDER BY m);
  ELSIF kind = 'brokeractivity' THEN
    ids := ARRAY(SELECT DISTINCT m FROM (
      SELECT * FROM external_signal_broker_evidence_marked_intents((n ->> 'orderIntentId')::integer, NULL, n ->> 'orderId', (n ->> 'tradingAccountId')::integer)
      UNION ALL SELECT * FROM external_signal_broker_evidence_marked_intents((o ->> 'orderIntentId')::integer, NULL, o ->> 'orderId', (o ->> 'tradingAccountId')::integer)) s(m) ORDER BY m);
  ELSE
    RAISE EXCEPTION 'unknown fence kind %', kind;
  END IF;
  FOREACH one IN ARRAY coalesce(ids, ARRAY[]::integer[]) LOOP
    UPDATE "ExternalSignalDispatchFence" SET version = version + 1 WHERE "orderIntentId" = one;
    IF NOT FOUND THEN RAISE EXCEPTION 'marked intent % has no dispatch fence', one; END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- The fenced set (revision 4). MarketPolicyBrokerDispatchConsumption is deliberately ABSENT (see the document, 3.4.1);
-- ExternalSignalBrokerDispatchConsumption is present and its bump is the one post-pair bump.
CREATE TRIGGER "OrderIntent_dispatch_fence_bump" AFTER UPDATE ON "OrderIntent" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('direct', 'id');
CREATE TRIGGER "EntryExposureClaim_dispatch_fence_bump" AFTER INSERT OR UPDATE OR DELETE ON "EntryExposureClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('direct', 'orderIntentId');
CREATE TRIGGER "EntryExposureClaimEvent_dispatch_fence_bump" AFTER INSERT ON "EntryExposureClaimEvent" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('claimevent');
CREATE TRIGGER "ExternalSignalBrokerWorkerClaim_dispatch_fence_bump" AFTER INSERT ON "ExternalSignalBrokerWorkerClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('direct', 'orderIntentId');
CREATE TRIGGER "MarketPolicyBrokerDispatchDecision_dispatch_fence_bump" AFTER INSERT ON "MarketPolicyBrokerDispatchDecision" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('direct', 'orderIntentId');
CREATE TRIGGER "MarketPolicyBrokerUnenforcedDispatch_dispatch_fence_bump" AFTER INSERT ON "MarketPolicyBrokerUnenforcedDispatch" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('direct', 'orderIntentId');
CREATE TRIGGER "OrderIntentBrokerOpportunityEvent_dispatch_fence_bump" AFTER INSERT ON "OrderIntentBrokerOpportunityEvent" FOR EACH ROW
  WHEN (NEW."eventType" NOT IN ('OPPORTUNITY_CAPTURED','DEFERRED','MISSING_OBSERVATION')) EXECUTE FUNCTION external_signal_dispatch_fence_bump('direct', 'orderIntentId');
CREATE TRIGGER "BrokerOrder_dispatch_fence_bump" AFTER INSERT OR UPDATE OR DELETE ON "BrokerOrder" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('brokerorder');
CREATE TRIGGER "BrokerActivity_dispatch_fence_bump" AFTER INSERT OR UPDATE OR DELETE ON "BrokerActivity" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('brokeractivity');

-- TradingView consumption: fenceVersion is the STABLE PRE-CONSUMPTION version F validated.
ALTER TABLE "ExternalSignalBrokerDispatchConsumption" ADD COLUMN "fenceVersion" bigint;

-- BEFORE INSERT. Name sorts after the existing guard so the fence is taken last (lock-order row 24).
CREATE FUNCTION external_signal_dispatch_fence_consumption_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v bigint;
BEGIN
  SELECT version INTO v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = NEW."orderIntentId" FOR UPDATE;
  IF v IS NULL OR NEW."fenceVersion" IS NULL OR NEW."fenceVersion" <> v THEN
    RAISE EXCEPTION 'TradingView dispatch fence version is stale or missing (supplied %, current %)', NEW."fenceVersion", v;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalBrokerDispatchConsumption_zz_fence_guard" BEFORE INSERT ON "ExternalSignalBrokerDispatchConsumption"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_consumption_guard();

CREATE TRIGGER "ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump" AFTER INSERT ON "ExternalSignalBrokerDispatchConsumption"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('direct', 'orderIntentId');

-- AFTER INSERT, fires after the bump (name order). Exactly one bump, the consumption's own, may separate the validated
-- version from the stored one; anything else means an unexpected fenced write inside F and fails closed.
CREATE FUNCTION external_signal_dispatch_fence_consumption_verify() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v bigint;
BEGIN
  SELECT version INTO v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = NEW."orderIntentId";
  IF v IS DISTINCT FROM NEW."fenceVersion" + 1 THEN
    RAISE EXCEPTION 'TradingView dispatch fence did not advance exactly once for the pair (stored %, current %)', NEW."fenceVersion", v;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "ExternalSignalBrokerDispatchConsumption_zz_b_fence_verify" AFTER INSERT ON "ExternalSignalBrokerDispatchConsumption"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_consumption_verify();

-- ---------------------------------------------------------------------------------------------------------------
-- B. Database-owned signal receipt timestamp (revision 4 design)
-- ---------------------------------------------------------------------------------------------------------------
-- No DEFAULT: ADD COLUMN ... DEFAULT now() would stamp every historical signal with the migration time and make old
-- signals look fresh. Historical rows stay NULL forever (the immutability guard forbids filling them in).
ALTER TABLE "Signal" ADD COLUMN "receivedAt" timestamptz;

CREATE FUNCTION external_signal_signal_received_at_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."receivedAt" IS NOT NULL THEN RAISE EXCEPTION 'Signal.receivedAt is database-owned and cannot be supplied'; END IF;
    NEW."receivedAt" := transaction_timestamp();
    RETURN NEW;
  END IF;
  IF NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN RAISE EXCEPTION 'Signal.receivedAt is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Signal_received_at_guard" BEFORE INSERT OR UPDATE ON "Signal" FOR EACH ROW EXECUTE FUNCTION external_signal_signal_received_at_guard();

-- Remaining receipt life. NULL when the signal or its receipt does not exist (fail closed for every caller).
-- timestamptz arithmetic with a seconds-only interval is absolute: no TimeZone, DST or calendar dependence.
CREATE FUNCTION external_signal_signal_receipt_remaining(p_signal_id integer) RETURNS interval LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s."receivedAt" + make_interval(secs => 120) - clock_timestamp() FROM "Signal" s WHERE s.id = p_signal_id
$$;
CREATE FUNCTION external_signal_signal_receipt_open(p_signal_id integer, p_minimum_remaining interval DEFAULT interval '0') RETURNS boolean LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(external_signal_signal_receipt_remaining(p_signal_id) > p_minimum_remaining, false)
$$;
