-- Phase 4A.2C3B.1: a TradingView-marked EntryExposureClaim can never be deleted. Forward-only; adds one
-- trigger function and trigger, no table, column or broker capability. The applied C3A migration is unchanged.
--
-- Before this, only a claim that already had events was protected, by the event table's RESTRICT foreign
-- key. A claim with no events (for example an unclaimed ENTRY_PENDING one) could be deleted by any role
-- with DELETE, which freed the symbol's one-position-per-symbol exposure slot while the marked
-- OrderIntent survived without exposure ownership. Marked claims now end only by status transition
-- (release or terminalization, each already guarded by the C2/C3A guard); the row itself is permanent.
--
-- Marked means the claim's OrderIntent carries externalSignalAccountCycleId. That marker is insert-only
-- (external_signal_order_intent_dispatch_quarantine) and a claim cannot move onto or off a marked intent
-- (external_signal_exposure_claim_c2_guard), so deciding without a lock has no time-of-check gap. Unmarked
-- PAPER/LIVE claims keep their prior behavior. There is deliberately no bypass setting, role exemption or
-- recovery switch: a genuinely erroneous marked claim is corrected by a reviewed forward migration.
-- The partial unique index that enforces one unreleased claim per account and Security is not touched.
CREATE FUNCTION external_signal_exposure_claim_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."orderIntentId" IS NOT NULL AND EXISTS (SELECT 1 FROM "OrderIntent" i WHERE i.id=OLD."orderIntentId" AND i."externalSignalAccountCycleId" IS NOT NULL) THEN
    RAISE EXCEPTION 'TradingView exposure claim % cannot be deleted; marked exposure ownership is permanent', OLD.id USING ERRCODE='P0001';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "EntryExposureClaim_external_signal_delete_guard" BEFORE DELETE ON "EntryExposureClaim" FOR EACH ROW EXECUTE FUNCTION external_signal_exposure_claim_delete_guard();

-- Restated trusted function-level search_path (see the C3A hardening migration): the new function must carry
-- it, and the same audit confirms no application function is left unpinned.
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
