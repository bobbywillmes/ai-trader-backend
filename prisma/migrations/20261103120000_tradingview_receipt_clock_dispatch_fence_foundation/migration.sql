-- Phase 4A.2C3B.2-1: receipt clock and dispatch-fence foundation (database safety infrastructure only).
--
-- This migration is INERT SAFETY INFRASTRUCTURE. It adds no production writer of TradingView paired
-- consumption, no broker-send permit, no scheduler entry and no broker capability. Every new trigger is
-- inert for unmarked (PAPER/LIVE) records and fails closed for marked TradingView records.
-- Design: docs/architecture/tradingview-c3b2-final-dispatch-transaction.md (revision 5, sections 3.4, 3.5, 5.3, 6.9, 12.4).
--
-- Do NOT add an explicit BEGIN/COMMIT: Prisma applies this multi-statement script as one implicit transaction
-- (independently tested), so any failure leaves no table, column, trigger, function replacement or row behind.
-- Operators must drain ingestion, routing, admission and workers first (docs/production/tradingview-c3b2-1-migration-runbook.md).
--
-- ---------------------------------------------------------------------------------------------------------------
-- 0. Locks, taken ONCE, strongest first, in a fixed documented order. Nothing below upgrades a lock.
-- ---------------------------------------------------------------------------------------------------------------
-- (a) ACCESS EXCLUSIVE, because ALTER TABLE ... ADD COLUMN needs it: "Signal", then
--     "ExternalSignalBrokerDispatchConsumption". Taken at the very beginning so no weaker lock is ever upgraded halfway.
-- (b) SHARE ROW EXCLUSIVE (what CREATE TRIGGER / CREATE INDEX / the fence foreign key need, and enough to stop every
--     writer so the backfill is exact), in one statement, in this order:
--       OrderIntent, EntryExposureClaim, EntryExposureClaimEvent, ExternalSignalBrokerWorkerClaim,
--       MarketPolicyBrokerDispatchDecision, MarketPolicyBrokerUnenforcedDispatch, OrderIntentBrokerOpportunityEvent,
--       BrokerOrder, BrokerActivity, MarketPolicyBrokerDispatchConsumption, ExternalSignalTradeCycleAccount,
--       ExternalSignalEntryExecutionObligation.
-- A missed drain becomes a bounded wait (lock_timeout) or a clean failure, never a missing fence.
SET LOCAL lock_timeout = '15s';
LOCK TABLE "Signal" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ExternalSignalBrokerDispatchConsumption" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "OrderIntent", "EntryExposureClaim", "EntryExposureClaimEvent", "ExternalSignalBrokerWorkerClaim",
  "MarketPolicyBrokerDispatchDecision", "MarketPolicyBrokerUnenforcedDispatch", "OrderIntentBrokerOpportunityEvent",
  "BrokerOrder", "BrokerActivity", "MarketPolicyBrokerDispatchConsumption", "ExternalSignalTradeCycleAccount",
  "ExternalSignalEntryExecutionObligation"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('public."ExternalSignalDispatchFence"') IS NOT NULL THEN
    RAISE EXCEPTION 'C3B.2-1 precondition: the dispatch fence table already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Signal' AND column_name = 'receivedAt') THEN
    RAISE EXCEPTION 'C3B.2-1 precondition: Signal.receivedAt already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption")
     OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchConsumption" m JOIN "OrderIntent" i ON i.id = m."orderIntentId" WHERE i."externalSignalAccountCycleId" IS NOT NULL) THEN
    RAISE EXCEPTION 'C3B.2-1 precondition: no TradingView consumption pair may exist (the consumption table gains NOT NULL columns)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Dispatch fence: one row per marked TradingView OrderIntent
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ExternalSignalDispatchFence" (
  "orderIntentId" INTEGER NOT NULL,
  "version" BIGINT NOT NULL,
  CONSTRAINT "ExternalSignalDispatchFence_pkey" PRIMARY KEY ("orderIntentId"),
  CONSTRAINT "ExternalSignalDispatchFence_version_check" CHECK ("version" >= 1)
);
ALTER TABLE "ExternalSignalDispatchFence" ADD CONSTRAINT "ExternalSignalDispatchFence_orderIntentId_fkey"
  FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- INSERT: only from trigger context (depth >= 2: the marked-intent creation trigger), only version 1, only for an existing
-- marked intent. UPDATE: only trigger-issued strictly +1. DELETE and TRUNCATE: never.
CREATE FUNCTION external_signal_dispatch_fence_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() < 2 THEN RAISE EXCEPTION 'dispatch fence rows are created only by the marked-intent creation trigger'; END IF;
    IF NEW."version" IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'dispatch fence must be created at version 1 (supplied %)', NEW."version"; END IF;
    IF NOT EXISTS (SELECT 1 FROM "OrderIntent" i WHERE i.id = NEW."orderIntentId" AND i."externalSignalAccountCycleId" IS NOT NULL) THEN
      RAISE EXCEPTION 'dispatch fence requires an existing marked intent';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() < 2 OR NEW."orderIntentId" IS DISTINCT FROM OLD."orderIntentId" OR NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
      RAISE EXCEPTION 'dispatch fence accepts only trigger-issued +1 increments';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'dispatch fence rows are never deleted or truncated';
END $$;

-- BACKFILL. No guard trigger exists on the fence yet and the table is invisible to every other session until COMMIT, so this
-- statement is the migration's own, un-spoofable creation context. Version 1 for every historical marked intent, none for
-- unmarked intents. Claims, evidence, positions, signals and terminal states are not read for writing and not touched. The
-- bump triggers do not exist yet, so historical fences are exactly version 1. No Signal receipt is created.
INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", "version")
  SELECT id, 1 FROM "OrderIntent" WHERE "externalSignalAccountCycleId" IS NOT NULL ORDER BY id;

CREATE TRIGGER "ExternalSignalDispatchFence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalDispatchFence"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_guard();
CREATE TRIGGER "ExternalSignalDispatchFence_truncate_guard" BEFORE TRUNCATE ON "ExternalSignalDispatchFence"
  FOR EACH STATEMENT EXECUTE FUNCTION external_signal_dispatch_fence_guard();

-- Creation for every marked intent inserted after this migration commits. `externalSignalAccountCycleId` is insert-only and
-- immutable (OrderIntent_external_signal_origin_immutable), so an UPDATE can never promote an unmarked intent.
CREATE FUNCTION external_signal_dispatch_fence_create() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."externalSignalAccountCycleId" IS NOT NULL THEN
    INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", "version") VALUES (NEW.id, 1);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "OrderIntent_dispatch_fence_create" AFTER INSERT ON "OrderIntent"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_create();

CREATE FUNCTION external_signal_marked_intent(p_intent_id integer) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "OrderIntent" WHERE id = p_intent_id AND "externalSignalAccountCycleId" IS NOT NULL)
$$;

-- Indexes that keep the evidence key off sequential scans (measured: docs/architecture/tradingview-c3b2-1-performance-pg16.json).
--   * the frozen clientOrderId branch;
--   * BrokerOrder.orderIntentId, a foreign-key column that had no index (the absence check and the bump resolve orders by intent);
--   * BrokerOrder (tradingAccountId, brokerOrderId): the existing account-scoped unique index has "broker" as its middle column, so a lookup
--     by account and broker order id alone walked the whole account range (measured: 84 buffers for one probe);
--   * a small PARTIAL index of marked intents per account: an account with no marked intent (every LIVE account, every PAPER account without
--     TradingView traffic) cannot own broker evidence of a marked intent, so the key returns after one index probe for all of its traffic.
CREATE INDEX "ExternalSignalEntryExecutionObligation_clientOrderId_idx" ON "ExternalSignalEntryExecutionObligation"("clientOrderId");
CREATE INDEX "BrokerOrder_orderIntentId_idx" ON "BrokerOrder"("orderIntentId");
CREATE INDEX "BrokerOrder_tradingAccountId_brokerOrderId_idx" ON "BrokerOrder"("tradingAccountId", "brokerOrderId");
CREATE INDEX "OrderIntent_marked_account_idx" ON "OrderIntent"("tradingAccountId") WHERE "externalSignalAccountCycleId" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Account-scoped broker-evidence identity (shared by the fence bumps, the quarantine and the consumption guard)
-- ---------------------------------------------------------------------------------------------------------------
-- A broker row belongs to a marked intent only when the row's trading account IS the marked intent's trading account AND any of:
--   * its orderIntentId names the intent;
--   * its clientOrderId equals the intent's frozen ExternalSignalEntryExecutionObligation.clientOrderId;
--   * its brokerOrderId equals the brokerOrderId of a BrokerOrder OF THE SAME ACCOUNT that belongs to the intent
--     (by orderIntentId or by the frozen clientOrderId);
--   * its brokerOrderRecordId names a BrokerOrder OF THE SAME ACCOUNT that belongs to the intent (by either route).
-- A NULL account never matches. Unmarked rows resolve to the empty set. Candidates come from indexed lookups first (a short array); the
-- final predicate then enforces "marked" and "same account" by primary key, so no branch can bypass either. PL/pgSQL on purpose: its plans
-- are cached across the very frequent calls of unmarked broker traffic.
CREATE FUNCTION external_signal_broker_evidence_marked_intents(
  p_intent_id integer, p_client_order_id text, p_broker_order_id text, p_account_id integer, p_broker_order_record_id integer DEFAULT NULL)
RETURNS SETOF integer LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE candidates integer[];
BEGIN
  IF p_account_id IS NULL OR NOT EXISTS (SELECT 1 FROM "OrderIntent" i WHERE i."tradingAccountId" = p_account_id AND i."externalSignalAccountCycleId" IS NOT NULL) THEN
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT c.id) INTO candidates FROM (
    SELECT p_intent_id AS id WHERE p_intent_id IS NOT NULL
    UNION
    SELECT o."orderIntentId" FROM "ExternalSignalEntryExecutionObligation" o WHERE p_client_order_id IS NOT NULL AND o."clientOrderId" = p_client_order_id
    UNION
    SELECT b."orderIntentId" FROM "BrokerOrder" b WHERE p_broker_order_id IS NOT NULL AND b."brokerOrderId" = p_broker_order_id AND b."tradingAccountId" = p_account_id
    UNION
    SELECT o."orderIntentId" FROM "BrokerOrder" b JOIN "ExternalSignalEntryExecutionObligation" o ON o."clientOrderId" = b."clientOrderId"
      WHERE p_broker_order_id IS NOT NULL AND b."brokerOrderId" = p_broker_order_id AND b."tradingAccountId" = p_account_id
    UNION
    SELECT b."orderIntentId" FROM "BrokerOrder" b WHERE p_broker_order_record_id IS NOT NULL AND b.id = p_broker_order_record_id AND b."tradingAccountId" = p_account_id
    UNION
    SELECT o."orderIntentId" FROM "BrokerOrder" b JOIN "ExternalSignalEntryExecutionObligation" o ON o."clientOrderId" = b."clientOrderId"
      WHERE p_broker_order_record_id IS NOT NULL AND b.id = p_broker_order_record_id AND b."tradingAccountId" = p_account_id
  ) c WHERE c.id IS NOT NULL;
  IF candidates IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT i.id FROM "OrderIntent" i
    WHERE i.id = ANY (candidates) AND i."externalSignalAccountCycleId" IS NOT NULL AND i."tradingAccountId" = p_account_id ORDER BY i.id;
END $$;

-- The SAME key, evaluated in reverse for one intent: every BrokerOrder / BrokerActivity row the key maps to the intent. The candidate
-- predicates only narrow the scan to indexed columns; membership is decided by the shared function above, never re-implemented.
CREATE FUNCTION external_signal_marked_intent_broker_evidence(p_intent_id integer)
RETURNS TABLE (kind text, id integer) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE account_id integer; client_order_id text; order_ids integer[]; order_broker_ids text[];
BEGIN
  SELECT i."tradingAccountId", o."clientOrderId" INTO account_id, client_order_id
    FROM "OrderIntent" i LEFT JOIN "ExternalSignalEntryExecutionObligation" o ON o."orderIntentId" = i.id
    WHERE i.id = p_intent_id AND i."externalSignalAccountCycleId" IS NOT NULL;
  IF NOT FOUND OR account_id IS NULL THEN RETURN; END IF;
  SELECT coalesce(array_agg(b.id), ARRAY[]::integer[]), coalesce(array_agg(b."brokerOrderId"), ARRAY[]::text[]) INTO order_ids, order_broker_ids
    FROM "BrokerOrder" b WHERE b."tradingAccountId" = account_id AND (b."orderIntentId" = p_intent_id OR (client_order_id IS NOT NULL AND b."clientOrderId" = client_order_id));
  RETURN QUERY
    SELECT 'BrokerOrder'::text, b.id FROM "BrokerOrder" b
     WHERE b."tradingAccountId" = account_id AND (b.id = ANY (order_ids) OR b."brokerOrderId" = ANY (order_broker_ids))
       AND EXISTS (SELECT 1 FROM external_signal_broker_evidence_marked_intents(b."orderIntentId", b."clientOrderId", b."brokerOrderId", b."tradingAccountId") m(v) WHERE m.v = p_intent_id)
    UNION ALL
    SELECT 'BrokerActivity'::text, a.id FROM "BrokerActivity" a
     WHERE a."tradingAccountId" = account_id AND (a."orderIntentId" = p_intent_id OR a."orderId" = ANY (order_broker_ids) OR a."brokerOrderRecordId" = ANY (order_ids))
       AND EXISTS (SELECT 1 FROM external_signal_broker_evidence_marked_intents(a."orderIntentId", NULL, a."orderId", a."tradingAccountId", a."brokerOrderRecordId") m(v) WHERE m.v = p_intent_id);
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Fence bumps. Strictly increasing, trigger-issued, inert for unmarked records, ascending intent order.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION external_signal_dispatch_fence_advance(p_intent_ids integer[]) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE one integer;
BEGIN
  FOR one IN SELECT DISTINCT u.x FROM unnest(p_intent_ids) AS u(x) WHERE u.x IS NOT NULL ORDER BY u.x LOOP
    UPDATE "ExternalSignalDispatchFence" SET "version" = "version" + 1 WHERE "orderIntentId" = one;
    IF NOT FOUND AND external_signal_marked_intent(one) THEN
      RAISE EXCEPTION 'marked intent % has no dispatch fence', one;
    END IF;
  END LOOP;
END $$;

-- OrderIntent UPDATE. Lock order is claim THEN fence everywhere (a claim mutation already holds the claim row when its own bump reaches the
-- fence): a marked intent therefore takes its EntryExposureClaim FOR NO KEY UPDATE before the fence advance. Nothing is created here; a
-- missing claim locks nothing and a missing fence still fails closed in the advance.
CREATE FUNCTION external_signal_dispatch_fence_bump_intent() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."externalSignalAccountCycleId" IS NOT NULL OR OLD."externalSignalAccountCycleId" IS NOT NULL THEN
    PERFORM 1 FROM "EntryExposureClaim" c WHERE c."orderIntentId" = NEW.id FOR NO KEY UPDATE;
  END IF;
  PERFORM external_signal_dispatch_fence_advance(ARRAY[NEW.id]);
  RETURN NULL;
END $$;

-- INSERT-only tables that carry "orderIntentId": worker claim, decision, unenforced dispatch, non-compare opportunity event,
-- and the TradingView consumption (the single post-pair bump).
CREATE FUNCTION external_signal_dispatch_fence_bump_order_ref() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM external_signal_dispatch_fence_advance(ARRAY[NEW."orderIntentId"]);
  RETURN NULL;
END $$;

-- EntryExposureClaim INSERT / UPDATE / DELETE (old and new intent).
CREATE FUNCTION external_signal_dispatch_fence_bump_exposure_claim() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM external_signal_dispatch_fence_advance(ARRAY[OLD."orderIntentId"]);
  ELSIF TG_OP = 'INSERT' THEN PERFORM external_signal_dispatch_fence_advance(ARRAY[NEW."orderIntentId"]);
  ELSE PERFORM external_signal_dispatch_fence_advance(ARRAY[NEW."orderIntentId", OLD."orderIntentId"]);
  END IF;
  RETURN NULL;
END $$;

-- EntryExposureClaimEvent INSERT (every type). The claim of a marked intent is locked FOR NO KEY UPDATE before the fence (claim, then fence).
CREATE FUNCTION external_signal_dispatch_fence_bump_claim_event() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE marked_intent integer;
BEGIN
  SELECT c."orderIntentId" INTO marked_intent FROM "EntryExposureClaim" c JOIN "OrderIntent" i ON i.id = c."orderIntentId"
    WHERE c.id = NEW."claimId" AND i."externalSignalAccountCycleId" IS NOT NULL FOR NO KEY UPDATE OF c;
  PERFORM external_signal_dispatch_fence_advance(ARRAY[marked_intent]);
  RETURN NULL;
END $$;

-- BrokerOrder INSERT / UPDATE / DELETE: both the old and the new values are resolved through the shared account-scoped key.
CREATE FUNCTION external_signal_dispatch_fence_bump_broker_order() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ids integer[] := ARRAY[]::integer[];
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    ids := ids || ARRAY(SELECT m FROM external_signal_broker_evidence_marked_intents(NEW."orderIntentId", NEW."clientOrderId", NEW."brokerOrderId", NEW."tradingAccountId") m);
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND ROW(NEW."orderIntentId", NEW."clientOrderId", NEW."brokerOrderId", NEW."tradingAccountId")
       IS DISTINCT FROM ROW(OLD."orderIntentId", OLD."clientOrderId", OLD."brokerOrderId", OLD."tradingAccountId")) THEN
    ids := ids || ARRAY(SELECT m FROM external_signal_broker_evidence_marked_intents(OLD."orderIntentId", OLD."clientOrderId", OLD."brokerOrderId", OLD."tradingAccountId") m);
  END IF;
  PERFORM external_signal_dispatch_fence_advance(ids);
  RETURN NULL;
END $$;

-- BrokerActivity INSERT / UPDATE / DELETE, including the brokerOrderRecordId association.
CREATE FUNCTION external_signal_dispatch_fence_bump_broker_activity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE ids integer[] := ARRAY[]::integer[];
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    ids := ids || ARRAY(SELECT m FROM external_signal_broker_evidence_marked_intents(NEW."orderIntentId", NULL, NEW."orderId", NEW."tradingAccountId", NEW."brokerOrderRecordId") m);
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND ROW(NEW."orderIntentId", NEW."orderId", NEW."tradingAccountId", NEW."brokerOrderRecordId")
       IS DISTINCT FROM ROW(OLD."orderIntentId", OLD."orderId", OLD."tradingAccountId", OLD."brokerOrderRecordId")) THEN
    ids := ids || ARRAY(SELECT m FROM external_signal_broker_evidence_marked_intents(OLD."orderIntentId", NULL, OLD."orderId", OLD."tradingAccountId", OLD."brokerOrderRecordId") m);
  END IF;
  PERFORM external_signal_dispatch_fence_advance(ids);
  RETURN NULL;
END $$;

-- Quarantine rebuilt on the shared key. C3B.2-1 still quarantines ALL broker evidence for a marked intent (C3C relaxes it), but it no
-- longer rejects an unrelated order of another account that merely shares a clientOrderId. It additionally rejects
--   * a CONTRADICTORY direct attribution (a row naming a marked intent but carrying another or no account);
--   * a NULL-account row that any identifier ties to a marked intent (unattributable);
--   * a BrokerActivity whose brokerOrderRecordId names a BrokerOrder of a DIFFERENT trading account (both known and different, or the
--     order is marked TradingView evidence), so a cross-account link can neither bridge into another account's evidence nor hide.
CREATE OR REPLACE FUNCTION external_signal_broker_evidence_quarantine() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE hit integer; direct_account integer; direct_marked boolean := false; unscoped_hit boolean := false;
        linked_account integer; linked_intent integer; linked_client text; linked_found boolean := false; linked_marked boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'BrokerOrder' THEN
    SELECT m INTO hit FROM external_signal_broker_evidence_marked_intents(NEW."orderIntentId", NEW."clientOrderId", NEW."brokerOrderId", NEW."tradingAccountId") m LIMIT 1;
  ELSE
    SELECT m INTO hit FROM external_signal_broker_evidence_marked_intents(NEW."orderIntentId", NULL, NEW."orderId", NEW."tradingAccountId", NEW."brokerOrderRecordId") m LIMIT 1;
  END IF;
  IF hit IS NOT NULL THEN RAISE EXCEPTION 'marked external signal broker evidence is quarantined in Phase 4A.2C1'; END IF;
  IF NEW."orderIntentId" IS NOT NULL THEN
    SELECT i."tradingAccountId", true INTO direct_account, direct_marked FROM "OrderIntent" i WHERE i.id = NEW."orderIntentId" AND i."externalSignalAccountCycleId" IS NOT NULL;
    IF coalesce(direct_marked, false) AND NEW."tradingAccountId" IS DISTINCT FROM direct_account THEN
      RAISE EXCEPTION 'broker evidence names a marked TradingView intent but carries a different or unknown trading account';
    END IF;
  END IF;
  -- Nested IFs on purpose: PL/pgSQL resolves NEW.<field> when it plans an expression, and "brokerOrderRecordId" exists only on BrokerActivity.
  IF TG_TABLE_NAME = 'BrokerActivity' THEN
    IF NEW."brokerOrderRecordId" IS NOT NULL THEN
      SELECT true, b."tradingAccountId", b."orderIntentId", b."clientOrderId" INTO linked_found, linked_account, linked_intent, linked_client
        FROM "BrokerOrder" b WHERE b.id = NEW."brokerOrderRecordId";
      IF coalesce(linked_found, false) AND linked_account IS DISTINCT FROM NEW."tradingAccountId" THEN
        linked_marked := EXISTS (SELECT 1 FROM "OrderIntent" i WHERE i.id = linked_intent AND i."externalSignalAccountCycleId" IS NOT NULL)
                      OR EXISTS (SELECT 1 FROM "ExternalSignalEntryExecutionObligation" o WHERE o."clientOrderId" = linked_client);
        IF linked_marked OR (linked_account IS NOT NULL AND NEW."tradingAccountId" IS NOT NULL) THEN
          RAISE EXCEPTION 'BrokerActivity references a BrokerOrder that belongs to a different trading account';
        END IF;
      END IF;
    END IF;
  END IF;
  IF NEW."tradingAccountId" IS NULL THEN
    -- The same identifiers, ignoring the account, per marked intent: any hit means an unattributable row reaches for a marked intent.
    IF TG_TABLE_NAME = 'BrokerOrder' THEN
      unscoped_hit := EXISTS (SELECT 1 FROM "ExternalSignalEntryExecutionObligation" o WHERE o."clientOrderId" = NEW."clientOrderId")
        OR EXISTS (SELECT 1 FROM "BrokerOrder" b JOIN "ExternalSignalEntryExecutionObligation" o ON o."orderIntentId" = b."orderIntentId" WHERE b."brokerOrderId" = NEW."brokerOrderId");
    ELSE
      unscoped_hit := EXISTS (SELECT 1 FROM "BrokerOrder" b JOIN "ExternalSignalEntryExecutionObligation" o ON o."orderIntentId" = b."orderIntentId"
                              WHERE (NEW."orderId" IS NOT NULL AND b."brokerOrderId" = NEW."orderId") OR (NEW."brokerOrderRecordId" IS NOT NULL AND b.id = NEW."brokerOrderRecordId"));
    END IF;
    IF unscoped_hit THEN RAISE EXCEPTION 'unattributable broker evidence (no trading account) is tied to a marked TradingView intent'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- The fenced set. MarketPolicyBrokerDispatchConsumption is deliberately ABSENT: the TradingView consumption's bump is the one
-- post-pair bump, and a Market Intelligence consumption of a marked intent cannot commit without it (deferred pair check).
CREATE TRIGGER "OrderIntent_dispatch_fence_bump" AFTER UPDATE ON "OrderIntent" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_intent();
CREATE TRIGGER "EntryExposureClaim_dispatch_fence_bump" AFTER INSERT OR UPDATE OR DELETE ON "EntryExposureClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_exposure_claim();
CREATE TRIGGER "EntryExposureClaimEvent_dispatch_fence_bump" AFTER INSERT ON "EntryExposureClaimEvent" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_claim_event();
CREATE TRIGGER "ExternalSignalBrokerWorkerClaim_dispatch_fence_bump" AFTER INSERT ON "ExternalSignalBrokerWorkerClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_order_ref();
CREATE TRIGGER "MarketPolicyBrokerDispatchDecision_dispatch_fence_bump" AFTER INSERT ON "MarketPolicyBrokerDispatchDecision" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_order_ref();
CREATE TRIGGER "MarketPolicyBrokerUnenforcedDispatch_dispatch_fence_bump" AFTER INSERT ON "MarketPolicyBrokerUnenforcedDispatch" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_order_ref();
CREATE TRIGGER "OrderIntentBrokerOpportunityEvent_dispatch_fence_bump" AFTER INSERT ON "OrderIntentBrokerOpportunityEvent" FOR EACH ROW
  WHEN (NEW."eventType" NOT IN ('OPPORTUNITY_CAPTURED','DEFERRED','MISSING_OBSERVATION')) EXECUTE FUNCTION external_signal_dispatch_fence_bump_order_ref();
CREATE TRIGGER "BrokerOrder_dispatch_fence_bump" AFTER INSERT OR UPDATE OR DELETE ON "BrokerOrder" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_broker_order();
CREATE TRIGGER "BrokerActivity_dispatch_fence_bump" AFTER INSERT OR UPDATE OR DELETE ON "BrokerActivity" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_broker_activity();

-- Post-conditions, still inside the migration transaction. Any failure rolls the whole migration back.
DO $$
DECLARE missing integer; extra integer;
BEGIN
  SELECT count(*) INTO missing FROM "OrderIntent" i WHERE i."externalSignalAccountCycleId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "ExternalSignalDispatchFence" f WHERE f."orderIntentId" = i.id);
  SELECT count(*) INTO extra FROM "ExternalSignalDispatchFence" f
    WHERE NOT EXISTS (SELECT 1 FROM "OrderIntent" i WHERE i.id = f."orderIntentId" AND i."externalSignalAccountCycleId" IS NOT NULL);
  IF missing <> 0 OR extra <> 0 OR EXISTS (SELECT 1 FROM "ExternalSignalDispatchFence" WHERE "version" <> 1) THEN
    RAISE EXCEPTION 'dispatch fence backfill post-condition failed (missing %, unexpected %)', missing, extra;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Database-owned receipt clock; database-stamped candidate timestamps
-- ---------------------------------------------------------------------------------------------------------------
-- No DEFAULT and no backfill: historical signals keep receivedAt NULL forever (the guard forbids filling it in), so a historical
-- signal can never become newly eligible for broker dispatch.
ALTER TABLE "Signal" ADD COLUMN "receivedAt" TIMESTAMPTZ;

CREATE FUNCTION external_signal_signal_received_at_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."receivedAt" IS NOT NULL THEN RAISE EXCEPTION 'Signal.receivedAt is database-owned and cannot be supplied'; END IF;
    -- The start of the ingestion transaction: a stall before the insert makes the receipt earlier, never later.
    NEW."receivedAt" := transaction_timestamp();
    RETURN NEW;
  END IF;
  IF NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN RAISE EXCEPTION 'Signal.receivedAt is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Signal_received_at_guard" BEFORE INSERT OR UPDATE ON "Signal" FOR EACH ROW EXECUTE FUNCTION external_signal_signal_received_at_guard();

-- The 120-second window is always make_interval(secs => 120), compared timestamptz to timestamptz with the database clock, so
-- neither the session TimeZone nor the application clock can extend it. A NULL receipt is never open.
CREATE FUNCTION external_signal_signal_receipt_remaining(p_signal_id integer) RETURNS interval LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s."receivedAt" + make_interval(secs => 120) - clock_timestamp() FROM "Signal" s WHERE s.id = p_signal_id
$$;
CREATE FUNCTION external_signal_signal_receipt_open(p_signal_id integer, p_minimum_remaining interval DEFAULT interval '0') RETURNS boolean LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(external_signal_signal_receipt_remaining(p_signal_id) > p_minimum_remaining, false)
$$;
-- Activation-epoch comparison, timestamptz to timestamptz; a NULL receipt is never eligible. Replaces every `Signal.createdAt >= <epoch>`.
CREATE FUNCTION external_signal_signal_received_since(p_signal_id integer, p_epoch timestamptz) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT s."receivedAt" >= p_epoch FROM "Signal" s WHERE s.id = p_signal_id), false)
$$;

-- Candidate side of every epoch comparison (the epoch columns are already database-stamped by accepted C1 guards with
-- statement_timestamp()). OVERWRITTEN, not rejected, because Prisma always supplies createdAt. clock_timestamp() is never earlier than
-- the transaction that stamped the signal, so any application clock skew can only shrink eligibility. Historical rows are untouched;
-- OrderIntent is stamped for marked intents only. Names sort before every existing BEFORE INSERT guard of their tables.
CREATE FUNCTION external_signal_epoch_created_at_stamp() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END $$;
CREATE FUNCTION external_signal_epoch_marked_intent_created_at_stamp() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."externalSignalAccountCycleId" IS NOT NULL THEN NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExternalSignalTradeCycleAccount_a_epoch_stamp" BEFORE INSERT ON "ExternalSignalTradeCycleAccount" FOR EACH ROW EXECUTE FUNCTION external_signal_epoch_created_at_stamp();
CREATE TRIGGER "OrderIntent_a_epoch_stamp" BEFORE INSERT ON "OrderIntent" FOR EACH ROW EXECUTE FUNCTION external_signal_epoch_marked_intent_created_at_stamp();

-- Accepted C1/C2 guards that compared Signal.createdAt move to the database receipt, with an explicit IS NULL branch (a NULL
-- comparison is unknown, which a PL/pgSQL IF treats as false). Each is rewritten from its installed definition and asserted.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('external_signal_entry_obligation_guard()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%sig."createdAt" AS signal_created_at,%'
     OR definition NOT LIKE '%IF x.signal_created_at<state_row."activatedAt" OR x.signal_created_at<x."authorizedAt" OR%' THEN
    RAISE EXCEPTION 'unexpected TradingView obligation epoch comparison';
  END IF;
  definition := replace(definition, 'sig."createdAt" AS signal_created_at,', 'sig."createdAt" AS signal_created_at,sig."receivedAt" AS signal_received_at,');
  definition := replace(definition, 'IF x.signal_created_at<state_row."activatedAt" OR x.signal_created_at<x."authorizedAt" OR',
    'IF x.signal_received_at IS NULL OR x.signal_received_at<state_row."activatedAt" OR x.signal_received_at<x."authorizedAt" OR');
  IF definition NOT LIKE '%sig."receivedAt" AS signal_received_at%' OR definition NOT LIKE '%IF x.signal_received_at IS NULL OR x.signal_received_at<state_row."activatedAt"%'
     OR definition LIKE '%x.signal_created_at<%' THEN
    RAISE EXCEPTION 'unable to apply the TradingView obligation receipt correction';
  END IF;
  EXECUTE definition;
END $$;

DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('external_signal_broker_worker_claim_guard()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%s."createdAt" AS signal_created_at,%'
     OR definition NOT LIKE '%OR x.signal_created_at AT TIME ZONE ''UTC'' < ds."activatedAt" OR clock_timestamp() - (x.signal_created_at AT TIME ZONE ''UTC'') > interval ''120 seconds'' OR x.intent_created_at AT TIME ZONE ''UTC'' < ds."activatedAt"%' THEN
    RAISE EXCEPTION 'unexpected TradingView worker-claim epoch comparison';
  END IF;
  definition := replace(definition, 's."createdAt" AS signal_created_at,', 's."createdAt" AS signal_created_at,s."receivedAt" AS signal_received_at,');
  definition := replace(definition,
    'OR x.signal_created_at AT TIME ZONE ''UTC'' < ds."activatedAt" OR clock_timestamp() - (x.signal_created_at AT TIME ZONE ''UTC'') > interval ''120 seconds'' OR x.intent_created_at AT TIME ZONE ''UTC'' < ds."activatedAt"',
    'OR x.signal_received_at IS NULL OR x.signal_received_at < ds."activatedAt" OR clock_timestamp() - x.signal_received_at > make_interval(secs => 120) OR x.intent_created_at AT TIME ZONE ''UTC'' < ds."activatedAt"');
  IF definition NOT LIKE '%s."receivedAt" AS signal_received_at%' OR definition NOT LIKE '%x.signal_received_at IS NULL OR x.signal_received_at < ds."activatedAt"%'
     OR definition LIKE '%x.signal_created_at%' THEN
    RAISE EXCEPTION 'unable to apply the TradingView worker-claim receipt correction';
  END IF;
  EXECUTE definition;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Consumption columns, the canonical lock prelude, the COMPLETE guard, and the post-pair bump / verification (INERT: no writer)
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "ExternalSignalBrokerDispatchConsumption"
  ADD COLUMN "authorizedAt" TIMESTAMPTZ NOT NULL,
  ADD COLUMN "authorizationDeadlineAt" TIMESTAMPTZ NOT NULL,
  ADD COLUMN "fenceVersion" BIGINT NOT NULL;

-- THE canonical lock prelude (section 6.5, rows 1 to 23) as a database function, so correctness never depends on the caller having
-- pre-locked. Called by the TradingView consumption guard AND by a BEFORE INSERT trigger on the Market Intelligence consumption (marked
-- intents only): that trigger takes the MI authorization lock (row 19) before the TradingView guard would otherwise reach the identity
-- rows (10 to 16), which deadlocked against the real MI revoke when a caller skipped the pre-locks. Re-entrant: a caller that already
-- holds the same locks in the same modes blocks on nothing. Every mode equals the mode any caller or later trigger requests (no upgrades).
CREATE FUNCTION external_signal_lock_dispatch_graph(p_intent_id integer, p_decision_id integer) RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o "ExternalSignalEntryExecutionObligation"%ROWTYPE; sig "Signal"%ROWTYPE; i "OrderIntent"%ROWTYPE; tas "TradingAccountSubscription"%ROWTYPE;
  sub "Subscription"%ROWTYPE; mi_authorization_id integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint);   -- 1
  PERFORM 1 FROM "ExternalSignalExecutionRolloutState" WHERE id = 1 FOR UPDATE;           -- 2
  PERFORM 1 FROM "ExternalSignalBrokerDispatchState" WHERE id = 1 FOR UPDATE;             -- 3
  SELECT * INTO o FROM "ExternalSignalEntryExecutionObligation" WHERE "orderIntentId" = p_intent_id;
  IF o.id IS NULL THEN RAISE EXCEPTION 'TradingView final dispatch evidence graph is inconsistent (obligation)'; END IF;
  SELECT * INTO sig FROM "Signal" WHERE id = o."entrySignalId";
  SELECT * INTO i FROM "OrderIntent" WHERE id = p_intent_id;
  SELECT * INTO tas FROM "TradingAccountSubscription" WHERE id = i."tradingAccountSubscriptionId";
  SELECT * INTO sub FROM "Subscription" WHERE id = i."subscriptionId";
  PERFORM 1 FROM "ExternalSignalSource" WHERE id = sig."signalSourceId" FOR SHARE;                                -- 4
  PERFORM 1 FROM "StrategySignalBinding" WHERE id = sig."strategySignalBindingId" FOR SHARE;                      -- 5
  PERFORM 1 FROM "StrategySignalRevision" WHERE id = sig."strategySignalRevisionId" FOR SHARE;                    -- 6
  PERFORM 1 FROM "ExternalSignalExecutionRolloutGeneration" WHERE id = o."rolloutGenerationId" FOR SHARE;         -- 7
  PERFORM 1 FROM "ExternalSignalTradeCycle" WHERE id = o."sourceCycleId" FOR SHARE;                               -- 8
  PERFORM 1 FROM "ExternalSignalTradeCycleAccount" WHERE id = o."accountCycleId" FOR SHARE;                       -- 9
  PERFORM 1 FROM "TradingAccount" WHERE id = i."tradingAccountId" FOR SHARE;                                      -- 10
  PERFORM 1 FROM "TradingAccountSubscription" WHERE id = tas.id FOR SHARE;                                        -- 11
  PERFORM 1 FROM "Subscription" WHERE id = sub.id FOR SHARE;                                                      -- 12
  PERFORM 1 FROM "Strategy" WHERE id = sub."strategyId" FOR SHARE;                                                -- 13
  PERFORM 1 FROM "ExitProfile" WHERE id = sub."exitProfileId" FOR SHARE;                                          -- 14
  PERFORM 1 FROM "Security" WHERE id = sub."securityId" FOR SHARE;                                                -- 15
  IF tas."allocationId" IS NOT NULL THEN PERFORM 1 FROM "TradingAccountAllocation" WHERE id = tas."allocationId" FOR SHARE; END IF;   -- 16
  PERFORM 1 FROM "ExternalSignalEntryExecutionAuthorization" WHERE id = o."authorizationId" FOR UPDATE;           -- 17
  PERFORM 1 FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id = 1 FOR SHARE;                                  -- 18
  SELECT "authorizationId" INTO mi_authorization_id FROM "MarketPolicyBrokerDispatchDecision" WHERE id = p_decision_id;
  IF mi_authorization_id IS NOT NULL THEN PERFORM 1 FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id = mi_authorization_id FOR SHARE; END IF;   -- 19
  PERFORM pg_advisory_xact_lock(hashtextextended('entry-exposure:' || i."tradingAccountId" || ':' || sub."securityId", 0));   -- 21
  PERFORM 1 FROM "OrderIntent" WHERE id = p_intent_id FOR UPDATE;                                                 -- 22
  PERFORM 1 FROM "EntryExposureClaim" WHERE "orderIntentId" = p_intent_id FOR UPDATE;                             -- 23
END $$;

CREATE FUNCTION external_signal_mi_consumption_lock_prelude() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF external_signal_marked_intent(NEW."orderIntentId") THEN PERFORM external_signal_lock_dispatch_graph(NEW."orderIntentId", NEW."decisionId"); END IF;
  RETURN NEW;
END $$;
-- Sorts before BrokerDispatchConsumption_validate (trigger order is by name); inert for unmarked intents.
CREATE TRIGGER "BrokerDispatchConsumption_a_lock_prelude" BEFORE INSERT ON "MarketPolicyBrokerDispatchConsumption"
  FOR EACH ROW EXECUTE FUNCTION external_signal_mi_consumption_lock_prelude();

-- One guard, one canonical lock order, every check after the locks that protect it; valid under READ COMMITTED and SERIALIZABLE direct SQL
-- and when the caller already holds the same locks. It replaces external_signal_broker_consumption_guard under the SAME trigger name,
-- so the reviewed-trigger binding is unchanged.
CREATE OR REPLACE FUNCTION external_signal_broker_consumption_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o "ExternalSignalEntryExecutionObligation"%ROWTYPE; c "ExternalSignalBrokerWorkerClaim"%ROWTYPE; mi "MarketPolicyBrokerDispatchConsumption"%ROWTYPE;
  auth "ExternalSignalEntryExecutionAuthorization"%ROWTYPE; ds "ExternalSignalBrokerDispatchState"%ROWTYPE; i "OrderIntent"%ROWTYPE;
  claim "EntryExposureClaim"%ROWTYPE; d "MarketPolicyBrokerDispatchDecision"%ROWTYPE; mo "OrderIntentMarketPolicyEnforcementObligation"%ROWTYPE;
  sig "Signal"%ROWTYPE; ac "ExternalSignalTradeCycleAccount"%ROWTYPE; ta "TradingAccount"%ROWTYPE; tas "TradingAccountSubscription"%ROWTYPE;
  sub "Subscription"%ROWTYPE; fence_v bigint; flag boolean; stamp timestamptz; receipt timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'TradingView broker dispatch consumption is immutable'; END IF;
  IF NEW."authorizedAt" IS NOT NULL OR NEW."authorizationDeadlineAt" IS NOT NULL THEN
    RAISE EXCEPTION 'authorizedAt and authorizationDeadlineAt are database-stamped and cannot be supplied';
  END IF;

  -- rows 1 to 23: the canonical prelude, then the fence (24) and the remaining shared rows (25 to 27). After this every read below is of
  -- a locked row (READ COMMITTED: fresh; SERIALIZABLE: a row changed after the snapshot would have raised 40001 at its lock).
  SELECT * INTO mi FROM "MarketPolicyBrokerDispatchConsumption" WHERE id = NEW."marketPolicyDispatchConsumptionId";
  IF mi.id IS NULL THEN RAISE EXCEPTION 'TradingView final dispatch evidence graph is inconsistent (missing row)'; END IF;
  PERFORM external_signal_lock_dispatch_graph(NEW."orderIntentId", mi."decisionId");
  SELECT "version" INTO fence_v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = NEW."orderIntentId" FOR UPDATE;       -- 24
  SELECT * INTO c FROM "ExternalSignalBrokerWorkerClaim" WHERE id = NEW."workerClaimId" FOR SHARE;                           -- 25
  SELECT * INTO o FROM "ExternalSignalEntryExecutionObligation" WHERE id = NEW."executionObligationId" FOR SHARE;            -- 26
  SELECT * INTO mo FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId" = NEW."orderIntentId" FOR SHARE; -- 27
  -- The authorization clock is read only now: a wait on any lock above must not let an instant taken before the wait authorize.
  stamp := clock_timestamp();

  SELECT * INTO ds FROM "ExternalSignalBrokerDispatchState" WHERE id = 1;
  SELECT * INTO i FROM "OrderIntent" WHERE id = NEW."orderIntentId";
  SELECT * INTO claim FROM "EntryExposureClaim" WHERE "orderIntentId" = NEW."orderIntentId";
  SELECT * INTO d FROM "MarketPolicyBrokerDispatchDecision" WHERE id = mi."decisionId";
  SELECT * INTO auth FROM "ExternalSignalEntryExecutionAuthorization" WHERE id = NEW."executionAuthorizationId";
  IF o.id IS NULL OR o."orderIntentId" <> NEW."orderIntentId" OR i.id IS NULL OR d.id IS NULL THEN RAISE EXCEPTION 'TradingView final dispatch evidence graph is inconsistent (missing row)'; END IF;
  SELECT * INTO sig FROM "Signal" WHERE id = o."entrySignalId";
  SELECT * INTO ac FROM "ExternalSignalTradeCycleAccount" WHERE id = o."accountCycleId";
  SELECT * INTO ta FROM "TradingAccount" WHERE id = i."tradingAccountId";
  SELECT * INTO tas FROM "TradingAccountSubscription" WHERE id = i."tradingAccountSubscriptionId";
  SELECT * INTO sub FROM "Subscription" WHERE id = i."subscriptionId";
  SELECT enabled INTO flag FROM "ExternalSignalSource" WHERE id = sig."signalSourceId";
  IF NOT coalesce(flag, false) THEN RAISE EXCEPTION 'TRADINGVIEW_SOURCE_DISABLED'; END IF;
  SELECT enabled INTO flag FROM "StrategySignalBinding" WHERE id = sig."strategySignalBindingId";
  IF NOT coalesce(flag, false) THEN RAISE EXCEPTION 'TRADINGVIEW_BINDING_DISABLED'; END IF;
  SELECT (status = 'ACTIVE' AND "authorityMode" = 'TRADE_ELIGIBLE') INTO flag FROM "StrategySignalRevision" WHERE id = sig."strategySignalRevisionId";
  IF NOT coalesce(flag, false) THEN RAISE EXCEPTION 'TRADINGVIEW_REVISION_NOT_TRADE_ELIGIBLE'; END IF;
  SELECT (enabled AND direction = 'ENTRY' AND "authorityMode" = 'EXECUTE') INTO flag FROM "ExternalSignalExecutionRolloutGeneration" WHERE id = o."rolloutGenerationId";
  IF NOT coalesce(flag, false) THEN RAISE EXCEPTION 'TRADINGVIEW_GENERATION_NOT_EXECUTE'; END IF;
  SELECT enabled INTO flag FROM "Strategy" WHERE id = sub."strategyId";
  IF NOT coalesce(flag, false) THEN RAISE EXCEPTION 'TRADINGVIEW_STRATEGY_DISABLED'; END IF;
  SELECT enabled INTO flag FROM "ExitProfile" WHERE id = sub."exitProfileId";
  IF NOT coalesce(flag, false) THEN RAISE EXCEPTION 'TRADINGVIEW_EXIT_PROFILE_DISABLED'; END IF;
  SELECT enabled INTO flag FROM "Security" WHERE id = sub."securityId";
  IF NOT coalesce(flag, false) THEN RAISE EXCEPTION 'TRADINGVIEW_SECURITY_DISABLED'; END IF;
  IF tas."allocationId" IS NOT NULL THEN
    SELECT (enabled AND "tradingAccountId" = ta.id) INTO flag FROM "TradingAccountAllocation" WHERE id = tas."allocationId";
    IF NOT coalesce(flag, false) THEN RAISE EXCEPTION 'TRADINGVIEW_ALLOCATION_NOT_ELIGIBLE'; END IF;
  END IF;

  -- ===== every check below reads rows that are now locked =====
  IF fence_v IS NULL OR NEW."fenceVersion" IS NULL OR NEW."fenceVersion" <> fence_v THEN
    RAISE EXCEPTION 'TradingView dispatch fence version is stale or missing (supplied %, current %)', NEW."fenceVersion", fence_v;
  END IF;

  IF i."externalSignalAccountCycleId" IS DISTINCT FROM o."accountCycleId" OR i.side <> 'buy' OR i.source <> 'tradingview' OR ta.environment <> 'PAPER' THEN
    RAISE EXCEPTION 'TRADINGVIEW_ENTRY_SCOPE_VIOLATION: only PAPER BUY entries are authorizable';
  END IF;
  IF c.id IS NULL OR ROW(c."orderIntentId", c."executionObligationId", c."accountCycleId", c."rolloutGenerationId", c."dispatchStateVersion", c."clientOrderId")
       IS DISTINCT FROM ROW(o."orderIntentId", o.id, o."accountCycleId", o."rolloutGenerationId", NEW."dispatchStateVersion", o."clientOrderId") THEN
    RAISE EXCEPTION 'TradingView final dispatch evidence graph is inconsistent (worker claim)';
  END IF;
  IF i.status <> 'submitting' OR claim.id IS NULL OR claim.status <> 'ENTRY_SUBMITTING' OR claim."releasedAt" IS NOT NULL OR claim."trackedPositionId" IS NOT NULL OR i."clientOrderId" IS DISTINCT FROM o."clientOrderId" THEN
    RAISE EXCEPTION 'TRADINGVIEW_CLAIM_STATE: intent must be submitting with an unreleased ENTRY_SUBMITTING claim';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId" = claim.id AND e."eventType" = 'WORKER_CLAIMED_FOR_SUBMISSION' AND (e."evidenceJson" ->> 'workerClaimId')::integer = c.id) THEN
    RAISE EXCEPTION 'TRADINGVIEW_CLAIM_STATE: no WORKER_CLAIMED_FOR_SUBMISSION event cites this worker claim';
  END IF;
  IF EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId" = claim.id AND e."eventType" IN ('NOT_SENT_EVIDENCE_RECORDED','ADAPTER_INVOCATION_STARTED','DISPATCH_OUTCOME_RECORDED','BROKER_DELIVERY_UNCERTAIN')) THEN
    RAISE EXCEPTION 'TRADINGVIEW_CONTRADICTORY_EVIDENCE: a delivery or not-sent event already exists for this claim';
  END IF;
  IF EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" t WHERE t."orderIntentId" = NEW."orderIntentId")
     OR (SELECT count(*) FROM "MarketPolicyBrokerDispatchConsumption" m WHERE m."orderIntentId" = NEW."orderIntentId") <> 1
     OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerUnenforcedDispatch" u WHERE u."orderIntentId" = NEW."orderIntentId")
     OR EXISTS (SELECT 1 FROM "OrderIntentBrokerOpportunityEvent" oe WHERE oe."orderIntentId" = NEW."orderIntentId" AND oe."eventType" NOT IN ('OPPORTUNITY_CAPTURED','DEFERRED','MISSING_OBSERVATION')) THEN
    RAISE EXCEPTION 'TRADINGVIEW_CONTRADICTORY_EVIDENCE: an earlier consumption, unenforced dispatch or opportunity event exists';
  END IF;
  -- THE broker-evidence absence check: the shared account-scoped key, evaluated for this intent.
  IF EXISTS (SELECT 1 FROM external_signal_marked_intent_broker_evidence(NEW."orderIntentId")) THEN
    RAISE EXCEPTION 'TRADINGVIEW_BROKER_EVIDENCE_EXISTS: a BrokerOrder or BrokerActivity already belongs to this intent';
  END IF;

  IF auth.id IS NULL OR auth.status <> 'AUTHORIZED' OR auth.id <> o."authorizationId" OR auth."authorizationFingerprint" IS DISTINCT FROM o."authorizationFingerprint" OR auth."rolloutGenerationId" <> NEW."rolloutGenerationId" THEN
    RAISE EXCEPTION 'TRADINGVIEW_AUTHORIZATION_NOT_EFFECTIVE';
  END IF;
  IF ds."activeRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId" OR ds."activatedAt" IS NULL OR ds.version <> NEW."dispatchStateVersion" THEN
    RAISE EXCEPTION 'TRADINGVIEW_DISPATCH_STATE_CHANGED';
  END IF;
  IF ROW(NEW."orderIntentId", NEW."rolloutGenerationId", NEW."executionAuthorizationId", NEW."clientOrderId") IS DISTINCT FROM ROW(o."orderIntentId", o."rolloutGenerationId", o."authorizationId", o."clientOrderId") THEN
    RAISE EXCEPTION 'TradingView final dispatch evidence graph is inconsistent (obligation identity)';
  END IF;

  IF ta.status <> 'ACTIVE' OR NOT ta."tradingEnabled" OR ta."killSwitchEnabled" OR ta."tradingBlocked" THEN RAISE EXCEPTION 'TRADINGVIEW_ACCOUNT_NOT_ELIGIBLE'; END IF;
  IF NOT (tas.enabled AND tas."entriesEnabled") OR NOT sub.enabled THEN RAISE EXCEPTION 'TRADINGVIEW_ASSIGNMENT_NOT_ELIGIBLE'; END IF;
  IF EXISTS (SELECT 1 FROM "Signal" x WHERE x."externalSignalTradeCycleId" = o."sourceCycleId" AND x.event = 'EXIT_LONG') OR ac."pendingExitAcceptedAt" IS NOT NULL OR ac."terminalAt" IS NOT NULL THEN
    RAISE EXCEPTION 'TRADINGVIEW_EXIT_ACCEPTED';
  END IF;
  IF EXISTS (SELECT 1 FROM "TrackedPosition" p WHERE p."tradingAccountId" = i."tradingAccountId" AND p."securityId" = sub."securityId" AND p.status = 'open') THEN
    RAISE EXCEPTION 'TRADINGVIEW_OPEN_POSITION_EXISTS';
  END IF;

  IF d.id <> (SELECT x.id FROM "MarketPolicyBrokerDispatchDecision" x WHERE x."orderIntentId" = NEW."orderIntentId" ORDER BY x."dispatchSequence" DESC, x.id DESC LIMIT 1) THEN
    RAISE EXCEPTION 'TRADINGVIEW_DECISION_SUPERSEDED: the consumed decision is not the latest for the intent';
  END IF;
  IF d.outcome <> 'ALLOWED' OR d."dispatchDisposition" <> 'DISPATCH_AUTHORIZED' OR d."clientOrderId" <> o."clientOrderId" OR d."orderIntentId" <> NEW."orderIntentId"
     OR stamp >= d."dispatchExpiresAt" - interval '2 seconds' THEN
    RAISE EXCEPTION 'TRADINGVIEW_DECISION_NOT_AUTHORIZED';
  END IF;
  IF mo.id IS NULL OR d."obligationId" IS DISTINCT FROM mo.id OR mo.environment <> 'PAPER' OR mo."tradingAccountId" <> i."tradingAccountId" OR mo."accountSubscriptionId" <> tas.id
     OR mo."subscriptionId" <> sub.id OR mo."securityId" <> sub."securityId" OR mo."strategyId" <> sub."strategyId" OR mo."authorizationId" <> d."authorizationId"
     OR mo."authorizationFingerprint" <> d."authorizationFingerprint" OR mo."policyRevisionId" <> d."policyRevisionId" OR mo."enrollmentGenerationId" <> d."enrollmentGenerationId" THEN
    RAISE EXCEPTION 'TRADINGVIEW_MI_OBLIGATION_MISMATCH: the frozen Market Intelligence obligation does not match the decision and the account cycle';
  END IF;
  IF mi."orderIntentId" <> NEW."orderIntentId" OR mi."clientOrderId" <> NEW."clientOrderId" OR mi."brokerPostOpportunityId" IS DISTINCT FROM NEW."brokerPostOpportunityId" THEN
    RAISE EXCEPTION 'TradingView final dispatch evidence graph is inconsistent (MI consumption)';
  END IF;

  -- Freshness and activation epochs: receivedAt is the database-owned instant; a NULL receipt fails closed.
  receipt := sig."receivedAt";
  IF receipt IS NULL OR receipt + make_interval(secs => 120) - stamp <= interval '5 seconds' THEN RAISE EXCEPTION 'TRADINGVIEW_ENTRY_SIGNAL_EXPIRED'; END IF;
  IF receipt < ds."activatedAt" OR receipt < auth."authorizedAt" OR ac."createdAt" < ds."activatedAt" OR ac."createdAt" < auth."authorizedAt" THEN
    RAISE EXCEPTION 'TRADINGVIEW_BEFORE_ACTIVATION_EPOCH';
  END IF;

  NEW."consumedAt" := statement_timestamp();
  NEW."authorizedAt" := stamp;
  NEW."authorizationDeadlineAt" := least(receipt + make_interval(secs => 120), stamp + make_interval(secs => 30));
  RETURN NEW;
END $$;

-- The single post-pair bump (after the row's own guard) and its self-verification. The names order them: bump, then verify.
CREATE TRIGGER "ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump" AFTER INSERT ON "ExternalSignalBrokerDispatchConsumption"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump_order_ref();

CREATE FUNCTION external_signal_dispatch_fence_consumption_verify() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v bigint;
BEGIN
  SELECT "version" INTO v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = NEW."orderIntentId";
  IF v IS DISTINCT FROM NEW."fenceVersion" + 1 THEN
    RAISE EXCEPTION 'TradingView dispatch fence did not advance exactly once for the pair (stored %, current %)', NEW."fenceVersion", v;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "ExternalSignalBrokerDispatchConsumption_zz_b_fence_verify" AFTER INSERT ON "ExternalSignalBrokerDispatchConsumption"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_consumption_verify();

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Restated trusted function-level search_path (see the C3A hardening migration): every new or replaced function keeps it, and the
--    same audit confirms no application function is left unpinned.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  item record;
  trusted text := format('search_path=pg_catalog, %I, pg_temp', current_schema());
  pinned integer := 0;
  unpinned integer;
BEGIN
  FOR item IN
    SELECT p.oid::regprocedure AS signature, p.prokind,
           (SELECT c FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%') AS existing_path
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=current_schema() AND p.prokind IN ('f','p') AND l.lanname NOT IN ('c','internal')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    ORDER BY p.oid
  LOOP
    IF item.existing_path IS NOT NULL AND item.existing_path IS DISTINCT FROM trusted THEN
      RAISE EXCEPTION 'function % already pins %; review it before overriding with %', item.signature, item.existing_path, trusted;
    END IF;
    EXECUTE format('ALTER %s %s SET search_path = pg_catalog, %I, pg_temp',
      CASE item.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, item.signature, current_schema());
    pinned := pinned + 1;
  END LOOP;

  SELECT count(*) INTO unpinned
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  JOIN pg_language l ON l.oid=p.prolang
  WHERE n.nspname=current_schema() AND p.prokind IN ('f','p') AND l.lanname NOT IN ('c','internal')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    AND NOT (trusted = ANY (coalesce(p.proconfig, ARRAY[]::text[])));
  IF unpinned <> 0 THEN RAISE EXCEPTION '% application functions still lack the trusted search_path', unpinned; END IF;
  RAISE NOTICE 'pinned trusted search_path on % application functions', pinned;
END $$;
