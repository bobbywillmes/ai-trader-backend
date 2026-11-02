-- DESIGN PROBE OVERLAY for docs/architecture/tradingview-c3b2-final-dispatch-transaction.md (revision 5).
-- DISPOSABLE DATABASES ONLY. This is NOT a migration. It is the PROPOSED C3B.2 migration body in its corrected statement order,
-- applied by the r5 probes on top of the fully migrated real schema (C3B.1 included). It is one script on purpose: it runs as ONE
-- transaction (a multi-statement simple query), exactly as the Prisma migration runner would apply it. Nothing here is approved for
-- implementation until Hermes accepts revision 5. It supersedes c3b2-r4-overlay.sql (kept unchanged as the revision-4 evidence).
--
-- Revision 5 changes against revision 4:
--   [R5-1] maintenance-window table locks, existing marked-intent fence backfill, fence INSERT guard, post-condition assertions
--   [R5-2] the COMPLETE replaced consumption guard (canonical lock order, shared account-scoped evidence check, claim/MI/fence revalidation)
--   [R5-3] account-scoped broker-evidence identity key (including BrokerActivity.brokerOrderRecordId) and the quarantine built on it
--   [R5-4] receipt-based eligibility function and database-stamped CANDIDATE timestamps (the epoch columns are already DB-stamped by C1)
-- ---------------------------------------------------------------------------------------------------------------
-- 0. Maintenance-window locks and preconditions
-- ---------------------------------------------------------------------------------------------------------------
-- SHARE ROW EXCLUSIVE conflicts with ROW EXCLUSIVE (every INSERT/UPDATE/DELETE) and with itself, but permits reads. All the tables
-- below are locked in ONE statement (a fixed order), held to COMMIT. Consequently, from the first statement until commit no marked
-- OrderIntent can be created, changed or deleted, no fenced row can be written, and every transaction that already wrote one has
-- committed or finished before the backfill snapshot is taken. The operational procedure still drains the workers first; the lock
-- turns a missed drain into a bounded wait (lock_timeout) or a clean failure, never into a missing fence.
SET LOCAL lock_timeout = '15s';
LOCK TABLE "OrderIntent", "EntryExposureClaim", "EntryExposureClaimEvent", "ExternalSignalBrokerWorkerClaim",
  "MarketPolicyBrokerDispatchDecision", "MarketPolicyBrokerUnenforcedDispatch", "OrderIntentBrokerOpportunityEvent",
  "BrokerOrder", "BrokerActivity", "ExternalSignalBrokerDispatchConsumption", "MarketPolicyBrokerDispatchConsumption", "Signal"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF to_regclass('public."ExternalSignalDispatchFence"') IS NOT NULL THEN RAISE EXCEPTION 'C3B.2 migration precondition: fence table already exists'; END IF;
  IF EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption")
     OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerDispatchConsumption" m JOIN "OrderIntent" i ON i.id = m."orderIntentId" WHERE i."externalSignalAccountCycleId" IS NOT NULL) THEN
    RAISE EXCEPTION 'C3B.2 migration precondition: no TradingView consumption pair may exist (the table gains NOT NULL columns)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- A. Dispatch fence
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "ExternalSignalDispatchFence" (
  "orderIntentId" integer PRIMARY KEY REFERENCES "OrderIntent"(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version >= 1)
);

-- [R5-1] BEFORE INSERT/UPDATE/DELETE guard. INSERT: only from trigger context (depth >= 2: the marked-intent creation trigger), only
-- version 1, only for an existing marked intent. UPDATE: only trigger-issued strictly +1. DELETE/TRUNCATE: never.
CREATE FUNCTION external_signal_dispatch_fence_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() < 2 THEN RAISE EXCEPTION 'dispatch fence rows are created only by the marked-intent creation trigger'; END IF;
    IF NEW.version IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'dispatch fence must be created at version 1 (supplied %)', NEW.version; END IF;
    IF NOT EXISTS (SELECT 1 FROM "OrderIntent" i WHERE i.id = NEW."orderIntentId" AND i."externalSignalAccountCycleId" IS NOT NULL) THEN
      RAISE EXCEPTION 'dispatch fence requires an existing marked intent';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() < 2 OR NEW."orderIntentId" IS DISTINCT FROM OLD."orderIntentId" OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'dispatch fence accepts only trigger-issued +1 increments';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'dispatch fence rows are never deleted or truncated';
END $$;

-- [R5-1] BACKFILL. No guard trigger exists yet and the table is invisible to every other session until COMMIT, so this statement is the
-- migration's own, un-spoofable creation context. Version 1 for every existing marked intent, none for unmarked intents. Worker
-- claims, evidence, positions and terminal states are not touched. The backfill does NOT create or alter any Signal receipt.
INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version)
  SELECT id, 1 FROM "OrderIntent" WHERE "externalSignalAccountCycleId" IS NOT NULL ORDER BY id;

CREATE TRIGGER "ExternalSignalDispatchFence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ExternalSignalDispatchFence"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_guard();
CREATE TRIGGER "ExternalSignalDispatchFence_truncate_guard" BEFORE TRUNCATE ON "ExternalSignalDispatchFence"
  FOR EACH STATEMENT EXECUTE FUNCTION external_signal_dispatch_fence_guard();

-- Creation for every marked intent inserted after this migration commits. (`externalSignalAccountCycleId` is insert-only and immutable,
-- trigger OrderIntent_external_signal_origin_immutable, so an UPDATE can never promote an unmarked intent: probe U9.)
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

CREATE FUNCTION external_signal_marked_intent(p_intent_id integer) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "OrderIntent" WHERE id = p_intent_id AND "externalSignalAccountCycleId" IS NOT NULL)
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- B. ACCOUNT-SCOPED broker-evidence identity key [R5-3]
-- ---------------------------------------------------------------------------------------------------------------
-- A broker row belongs to a marked intent only when the row's trading account IS the marked intent's trading account AND any of:
--   * its orderIntentId names the intent;
--   * its clientOrderId equals the intent's frozen ExternalSignalEntryExecutionObligation.clientOrderId;
--   * its brokerOrderId equals the brokerOrderId of a BrokerOrder OF THE SAME ACCOUNT that belongs to the intent (by orderIntentId
--     or by clientOrderId);
--   * its brokerOrderRecordId names a BrokerOrder OF THE SAME ACCOUNT that belongs to the intent (by orderIntentId or clientOrderId).
-- A NULL account never matches (it cannot be "the same account"); the quarantine below rejects such rows when they reach for a marked
-- intent, so the exclusion cannot hide evidence. Unmarked rows resolve to the empty set (the triggers are inert).
CREATE FUNCTION external_signal_broker_evidence_marked_intents(p_intent_id integer, p_client_order_id text, p_broker_order_id text, p_account_id integer, p_broker_order_record_id integer DEFAULT NULL)
RETURNS SETOF integer LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT i.id FROM "OrderIntent" i
  WHERE p_account_id IS NOT NULL AND i."externalSignalAccountCycleId" IS NOT NULL AND i."tradingAccountId" = p_account_id AND (
    i.id = p_intent_id
    OR i.id IN (SELECT o."orderIntentId" FROM "ExternalSignalEntryExecutionObligation" o WHERE p_client_order_id IS NOT NULL AND o."clientOrderId" = p_client_order_id)
    OR i.id IN (SELECT b."orderIntentId" FROM "BrokerOrder" b WHERE p_broker_order_id IS NOT NULL AND b."brokerOrderId" = p_broker_order_id AND b."tradingAccountId" = p_account_id)
    OR i.id IN (SELECT o."orderIntentId" FROM "BrokerOrder" b JOIN "ExternalSignalEntryExecutionObligation" o ON o."clientOrderId" = b."clientOrderId"
                WHERE p_broker_order_id IS NOT NULL AND b."brokerOrderId" = p_broker_order_id AND b."tradingAccountId" = p_account_id)
    OR i.id IN (SELECT b."orderIntentId" FROM "BrokerOrder" b WHERE p_broker_order_record_id IS NOT NULL AND b.id = p_broker_order_record_id AND b."tradingAccountId" = p_account_id)
    OR i.id IN (SELECT o."orderIntentId" FROM "BrokerOrder" b JOIN "ExternalSignalEntryExecutionObligation" o ON o."clientOrderId" = b."clientOrderId"
                WHERE p_broker_order_record_id IS NOT NULL AND b.id = p_broker_order_record_id AND b."tradingAccountId" = p_account_id))
  ORDER BY i.id
$$;

-- The SAME key, evaluated in reverse for one intent: every BrokerOrder / BrokerActivity row the key maps to the intent. The candidate
-- predicates only narrow the scan to indexable columns; membership is decided by the shared function above, never re-implemented.
CREATE FUNCTION external_signal_marked_intent_broker_evidence(p_intent_id integer)
RETURNS TABLE (kind text, id integer) LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  WITH me AS (
    SELECT i.id, i."tradingAccountId" AS account_id, o."clientOrderId" AS client_order_id
    FROM "OrderIntent" i LEFT JOIN "ExternalSignalEntryExecutionObligation" o ON o."orderIntentId" = i.id
    WHERE i.id = p_intent_id AND i."externalSignalAccountCycleId" IS NOT NULL),
  scoped_orders AS (
    SELECT b.id, b."brokerOrderId" FROM "BrokerOrder" b, me
    WHERE b."tradingAccountId" = me.account_id AND (b."orderIntentId" = me.id OR b."clientOrderId" = me.client_order_id))
  SELECT 'BrokerOrder'::text, b.id FROM "BrokerOrder" b, me
   WHERE b."tradingAccountId" = me.account_id
     AND (b."orderIntentId" = me.id OR b."clientOrderId" = me.client_order_id OR b."brokerOrderId" IN (SELECT s."brokerOrderId" FROM scoped_orders s))
     AND EXISTS (SELECT 1 FROM external_signal_broker_evidence_marked_intents(b."orderIntentId", b."clientOrderId", b."brokerOrderId", b."tradingAccountId") m(v) WHERE m.v = me.id)
  UNION ALL
  SELECT 'BrokerActivity'::text, a.id FROM "BrokerActivity" a, me
   WHERE a."tradingAccountId" = me.account_id
     AND (a."orderIntentId" = me.id OR a."orderId" IN (SELECT s."brokerOrderId" FROM scoped_orders s) OR a."brokerOrderRecordId" IN (SELECT s.id FROM scoped_orders s))
     AND EXISTS (SELECT 1 FROM external_signal_broker_evidence_marked_intents(a."orderIntentId", NULL, a."orderId", a."tradingAccountId", a."brokerOrderRecordId") m(v) WHERE m.v = me.id)
$$;

-- TG_ARGV[0] = kind: direct (TG_ARGV[1] = column), claimevent, brokerorder, brokeractivity.
-- Each distinct marked intent is bumped once per row change, in ascending intent order. (The probe overlay dispatches through to_jsonb;
-- the production functions are typed and plan-checked, section 11.2.)
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
      SELECT * FROM external_signal_broker_evidence_marked_intents((n ->> 'orderIntentId')::integer, NULL, n ->> 'orderId', (n ->> 'tradingAccountId')::integer, (n ->> 'brokerOrderRecordId')::integer)
      UNION ALL SELECT * FROM external_signal_broker_evidence_marked_intents((o ->> 'orderIntentId')::integer, NULL, o ->> 'orderId', (o ->> 'tradingAccountId')::integer, (o ->> 'brokerOrderRecordId')::integer)) s(m) ORDER BY m);
  ELSE
    RAISE EXCEPTION 'unknown fence kind %', kind;
  END IF;
  FOREACH one IN ARRAY coalesce(ids, ARRAY[]::integer[]) LOOP
    UPDATE "ExternalSignalDispatchFence" SET version = version + 1 WHERE "orderIntentId" = one;
    IF NOT FOUND THEN RAISE EXCEPTION 'marked intent % has no dispatch fence', one; END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- Quarantine rebuilt on the shared key [R5-3]. C3B.2 still quarantines ALL broker evidence for a marked intent (C3C relaxes it), but
-- it no longer rejects an unrelated order of another account that merely shares a clientOrderId. It additionally rejects a
-- CONTRADICTORY direct attribution (a row naming a marked intent but carrying another or no account) and an unscoped (NULL account)
-- row that any identifier ties to a marked intent: such a row can never be treated as "not the same account" and slip through.
CREATE OR REPLACE FUNCTION external_signal_broker_evidence_quarantine() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE hit integer; direct_account integer; direct_marked boolean := false; unscoped_hit boolean := false;
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

-- The fenced set. MarketPolicyBrokerDispatchConsumption is deliberately ABSENT; the TradingView consumption's bump is the one post-pair bump.
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

-- [R5-1] Post-conditions, still inside the migration transaction. Any failure rolls the whole migration back.
DO $$
DECLARE missing integer; extra integer;
BEGIN
  SELECT count(*) INTO missing FROM "OrderIntent" i WHERE i."externalSignalAccountCycleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ExternalSignalDispatchFence" f WHERE f."orderIntentId" = i.id);
  SELECT count(*) INTO extra FROM "ExternalSignalDispatchFence" f WHERE NOT EXISTS (SELECT 1 FROM "OrderIntent" i WHERE i.id = f."orderIntentId" AND i."externalSignalAccountCycleId" IS NOT NULL);
  IF missing <> 0 OR extra <> 0 OR EXISTS (SELECT 1 FROM "ExternalSignalDispatchFence" WHERE version <> 1) THEN
    RAISE EXCEPTION 'dispatch fence backfill post-condition failed (missing %, extra %)', missing, extra;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- C. Database-owned receipt clock and database-stamped activation epochs [R5-4]
-- ---------------------------------------------------------------------------------------------------------------
-- No DEFAULT and no backfill: historical signals keep receivedAt NULL forever (the immutability guard forbids filling it in).
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

CREATE FUNCTION external_signal_signal_receipt_remaining(p_signal_id integer) RETURNS interval LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s."receivedAt" + make_interval(secs => 120) - clock_timestamp() FROM "Signal" s WHERE s.id = p_signal_id
$$;
CREATE FUNCTION external_signal_signal_receipt_open(p_signal_id integer, p_minimum_remaining interval DEFAULT interval '0') RETURNS boolean LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(external_signal_signal_receipt_remaining(p_signal_id) > p_minimum_remaining, false)
$$;

-- Activation-epoch comparison, timestamptz to timestamptz, NULL receipt = not eligible (fail closed). This replaces every
-- `sig."createdAt" >= <epoch>` comparison (admission, claim, authorization-generation, correlation, finalization).
CREATE FUNCTION external_signal_signal_received_since(p_signal_id integer, p_epoch timestamptz) RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((SELECT s."receivedAt" >= p_epoch FROM "Signal" s WHERE s.id = p_signal_id), false)
$$;

-- EPOCH SIDE (audited, section 3.5.5): the activation epoch columns are ALREADY database-stamped by accepted C1 guards
-- (ExternalSignalEntryExecutionAuthorization_guard sets authorizedAt := statement_timestamp(); both activation guards set createdAt :=
-- statement_timestamp(), which becomes the state's activatedAt), so no epoch trigger is added for them (probe T3 measures it with a
-- deliberately wrong application clock). The CANDIDATE side is what still carries an application clock and needs the same treatment:
--   * ExternalSignalTradeCycleAccount.createdAt (timestamptz, Prisma @default(now()) = application clock) is compared with the epochs;
--   * OrderIntent.createdAt (naive UTC wall time, application clock) is compared with the dispatch epoch by the worker-claim guard.
-- Both are overwritten at INSERT with the database clock (the stamp is clock_timestamp(): never earlier than the transaction that
-- stamped the signal, so a skewed application clock can only shrink eligibility). The value is OVERWRITTEN, not rejected, because
-- Prisma always supplies one. Historical rows are untouched. Names sort before every existing BEFORE INSERT guard of the table.
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

-- ---------------------------------------------------------------------------------------------------------------
-- D. Consumption columns, the COMPLETE replaced guard, and the post-pair bump / verify [R5-2]
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "ExternalSignalBrokerDispatchConsumption"
  ADD COLUMN "authorizedAt" timestamptz NOT NULL,
  ADD COLUMN "authorizationDeadlineAt" timestamptz NOT NULL,
  ADD COLUMN "fenceVersion" bigint NOT NULL;

-- THE canonical lock prelude (section 6.5, rows 1 to 23), as a database function so correctness never depends on the caller having
-- pre-locked. It is called by the TradingView consumption guard AND by a BEFORE INSERT trigger on the Market Intelligence consumption
-- (marked intents only): the MI consumption trigger takes the MI authorization lock (row 19) before the TradingView guard would otherwise
-- reach the identity rows (10 to 16), and probe O2 reproduced a 40P01 against the real MI revoke when a caller skipped the pre-locks.
-- Re-entrant: a caller that already took the same locks in the same modes (F step 1) blocks on nothing. Plain reads are used for the
-- immutable evidence graph; every mutable row is then locked in order.
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
-- Sorts before BrokerDispatchConsumption_validate (alphabetical trigger order); inert for unmarked intents.
CREATE TRIGGER "BrokerDispatchConsumption_a_lock_prelude" BEFORE INSERT ON "MarketPolicyBrokerDispatchConsumption" FOR EACH ROW EXECUTE FUNCTION external_signal_mi_consumption_lock_prelude();

-- One guard, one canonical lock order, every check after the locks that protect it; valid under READ COMMITTED and SERIALIZABLE direct
-- SQL and when the caller already holds the same locks (every mode equals the pre-lock mode: no upgrades). It replaces
-- external_signal_broker_consumption_guard under the SAME trigger name, so the reviewed-trigger binding is unchanged.
CREATE OR REPLACE FUNCTION external_signal_broker_consumption_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o "ExternalSignalEntryExecutionObligation"%ROWTYPE; c "ExternalSignalBrokerWorkerClaim"%ROWTYPE; mi "MarketPolicyBrokerDispatchConsumption"%ROWTYPE;
  auth "ExternalSignalEntryExecutionAuthorization"%ROWTYPE; ds "ExternalSignalBrokerDispatchState"%ROWTYPE; i "OrderIntent"%ROWTYPE;
  claim "EntryExposureClaim"%ROWTYPE; d "MarketPolicyBrokerDispatchDecision"%ROWTYPE; mo "OrderIntentMarketPolicyEnforcementObligation"%ROWTYPE;
  sig "Signal"%ROWTYPE; ac "ExternalSignalTradeCycleAccount"%ROWTYPE; ta "TradingAccount"%ROWTYPE; tas "TradingAccountSubscription"%ROWTYPE;
  sub "Subscription"%ROWTYPE; fence_v bigint; flag boolean; stamp timestamptz := clock_timestamp(); receipt timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'TradingView broker dispatch consumption is immutable'; END IF;
  IF NEW."authorizedAt" IS NOT NULL OR NEW."authorizationDeadlineAt" IS NOT NULL THEN
    RAISE EXCEPTION 'authorizedAt and authorizationDeadlineAt are database-stamped and cannot be supplied';
  END IF;

  -- rows 1 to 23: the canonical prelude, then the fence (24) and the remaining shared rows (25 to 27). After this every read below is of
  -- a locked row (READ COMMITTED: fresh; SERIALIZABLE: a row changed after the snapshot would have raised 40001 at its lock, so the
  -- snapshot value is the latest committed one).
  SELECT * INTO mi FROM "MarketPolicyBrokerDispatchConsumption" WHERE id = NEW."marketPolicyDispatchConsumptionId";
  IF mi.id IS NULL THEN RAISE EXCEPTION 'TradingView final dispatch evidence graph is inconsistent (missing row)'; END IF;
  PERFORM external_signal_lock_dispatch_graph(NEW."orderIntentId", mi."decisionId");
  SELECT version INTO fence_v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = NEW."orderIntentId" FOR UPDATE;       -- 24
  SELECT * INTO c FROM "ExternalSignalBrokerWorkerClaim" WHERE id = NEW."workerClaimId" FOR SHARE;                           -- 25
  SELECT * INTO o FROM "ExternalSignalEntryExecutionObligation" WHERE id = NEW."executionObligationId" FOR SHARE;            -- 26
  SELECT * INTO mo FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId" = NEW."orderIntentId" FOR SHARE; -- 27

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

  -- ===== every check below reads rows that are now locked (READ COMMITTED: fresh; SERIALIZABLE: protected by the fence) =====
  -- fence equality (item 11)
  IF fence_v IS NULL OR NEW."fenceVersion" IS NULL OR NEW."fenceVersion" <> fence_v THEN
    RAISE EXCEPTION 'TradingView dispatch fence version is stale or missing (supplied %, current %)', NEW."fenceVersion", fence_v;
  END IF;

  -- scope (item 2): PAPER BUY TradingView
  IF i."externalSignalAccountCycleId" IS DISTINCT FROM o."accountCycleId" OR i.side <> 'buy' OR i.source <> 'tradingview' OR ta.environment <> 'PAPER' THEN
    RAISE EXCEPTION 'TRADINGVIEW_ENTRY_SCOPE_VIOLATION: only PAPER BUY entries are authorizable';
  END IF;
  -- exact worker claim, intent and exposure state
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
  -- no contradictory lifecycle evidence
  IF EXISTS (SELECT 1 FROM "EntryExposureClaimEvent" e WHERE e."claimId" = claim.id AND e."eventType" IN ('NOT_SENT_EVIDENCE_RECORDED','ADAPTER_INVOCATION_STARTED','DISPATCH_OUTCOME_RECORDED','BROKER_DELIVERY_UNCERTAIN')) THEN
    RAISE EXCEPTION 'TRADINGVIEW_CONTRADICTORY_EVIDENCE: a delivery or not-sent event already exists for this claim';
  END IF;
  IF EXISTS (SELECT 1 FROM "ExternalSignalBrokerDispatchConsumption" t WHERE t."orderIntentId" = NEW."orderIntentId")
     OR (SELECT count(*) FROM "MarketPolicyBrokerDispatchConsumption" m WHERE m."orderIntentId" = NEW."orderIntentId") <> 1
     OR EXISTS (SELECT 1 FROM "MarketPolicyBrokerUnenforcedDispatch" u WHERE u."orderIntentId" = NEW."orderIntentId")
     OR EXISTS (SELECT 1 FROM "OrderIntentBrokerOpportunityEvent" oe WHERE oe."orderIntentId" = NEW."orderIntentId" AND oe."eventType" NOT IN ('OPPORTUNITY_CAPTURED','DEFERRED','MISSING_OBSERVATION')) THEN
    RAISE EXCEPTION 'TRADINGVIEW_CONTRADICTORY_EVIDENCE: an earlier consumption, unenforced dispatch or opportunity event exists';
  END IF;
  -- THE broker-evidence absence check (item 2.2 / 3): the shared account-scoped key, evaluated for this intent
  IF EXISTS (SELECT 1 FROM external_signal_marked_intent_broker_evidence(NEW."orderIntentId")) THEN
    RAISE EXCEPTION 'TRADINGVIEW_BROKER_EVIDENCE_EXISTS: a BrokerOrder or BrokerActivity already belongs to this intent';
  END IF;

  -- authorization, generation, dispatch state
  IF auth.id IS NULL OR auth.status <> 'AUTHORIZED' OR auth.id <> o."authorizationId" OR auth."authorizationFingerprint" IS DISTINCT FROM o."authorizationFingerprint" OR auth."rolloutGenerationId" <> NEW."rolloutGenerationId" THEN
    RAISE EXCEPTION 'TRADINGVIEW_AUTHORIZATION_NOT_EFFECTIVE';
  END IF;
  IF ds."activeRolloutGenerationId" IS DISTINCT FROM NEW."rolloutGenerationId" OR ds."activatedAt" IS NULL OR ds.version <> NEW."dispatchStateVersion" THEN
    RAISE EXCEPTION 'TRADINGVIEW_DISPATCH_STATE_CHANGED';
  END IF;
  IF ROW(NEW."orderIntentId", NEW."rolloutGenerationId", NEW."executionAuthorizationId", NEW."clientOrderId") IS DISTINCT FROM ROW(o."orderIntentId", o."rolloutGenerationId", o."authorizationId", o."clientOrderId") THEN
    RAISE EXCEPTION 'TradingView final dispatch evidence graph is inconsistent (obligation identity)';
  END IF;

  -- live eligibility (item 2.3 / 2.5): account, assignment, EXIT, positions
  IF ta.status <> 'ACTIVE' OR NOT ta."tradingEnabled" OR ta."killSwitchEnabled" OR ta."tradingBlocked" THEN RAISE EXCEPTION 'TRADINGVIEW_ACCOUNT_NOT_ELIGIBLE'; END IF;
  IF NOT (tas.enabled AND tas."entriesEnabled") OR NOT sub.enabled THEN RAISE EXCEPTION 'TRADINGVIEW_ASSIGNMENT_NOT_ELIGIBLE'; END IF;
  IF EXISTS (SELECT 1 FROM "Signal" x WHERE x."externalSignalTradeCycleId" = o."sourceCycleId" AND x.event = 'EXIT_LONG') OR ac."pendingExitAcceptedAt" IS NOT NULL OR ac."terminalAt" IS NOT NULL THEN
    RAISE EXCEPTION 'TRADINGVIEW_EXIT_ACCEPTED';
  END IF;
  IF EXISTS (SELECT 1 FROM "TrackedPosition" p WHERE p."tradingAccountId" = i."tradingAccountId" AND p."securityId" = sub."securityId" AND p.status = 'open') THEN
    RAISE EXCEPTION 'TRADINGVIEW_OPEN_POSITION_EXISTS';
  END IF;

  -- Market Intelligence decision, obligation and consumption (item 2.4 / 10)
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

  -- freshness and activation epochs (item 4): receivedAt is the database-owned instant; NULL fails closed
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

CREATE TRIGGER "ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump" AFTER INSERT ON "ExternalSignalBrokerDispatchConsumption"
  FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('direct', 'orderIntentId');

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
