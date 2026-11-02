-- Phase 4A.2C3B.2-0: canonical lock-order corrections for the accepted TradingView C1/C2 guards.
--
-- Function replacements only: no table, column, trigger, privilege or signature changes, and no new dispatch
-- or broker capability. Each guard is rewritten from its currently installed definition so everything other
-- than the row-lock clause is preserved byte for byte, and each rewrite is asserted.
--
-- The mutable identity rows (TradingAccount, TradingAccountSubscription, Subscription, Security, User) only
-- need to be fenced against their writers: a pause, kill switch, disablement or status change is a non-key
-- UPDATE, which conflicts with FOR SHARE. FOR SHARE is compatible with Market Intelligence's own FOR SHARE
-- requests on the same rows, so TradingView can no longer close a cycle with an MI grant, revoke or lapse.
-- FOR UPDATE is retained for source, binding, revision, rollout generation, cycles, authorization,
-- intent and exposure claim.

-- 1. Worker-claim guard: identity rows FOR SHARE.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('external_signal_broker_worker_claim_guard()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec;%' THEN
    RAISE EXCEPTION 'unexpected TradingView worker-claim lock clause';
  END IF;
  definition := replace(definition, 'FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec;', 'FOR UPDATE OF i,ac,c,auth,gen,src,b,rev,ec FOR SHARE OF ta,tas,sub,sec;');
  IF definition NOT LIKE '%FOR UPDATE OF i,ac,c,auth,gen,src,b,rev,ec FOR SHARE OF ta,tas,sub,sec;%' THEN
    RAISE EXCEPTION 'unable to apply the TradingView worker-claim lock correction';
  END IF;
  EXECUTE definition;
END $$;

-- 2. Authorization guard: the late User FOR UPDATE becomes FOR SHARE, taken first by the grant service.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('external_signal_entry_authorization_guard()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%FOR UPDATE OF tas,ta,s,src,b,r,u;%' THEN
    RAISE EXCEPTION 'unexpected TradingView authorization lock clause';
  END IF;
  definition := replace(definition, 'FOR UPDATE OF tas,ta,s,src,b,r,u;', 'FOR UPDATE OF src,b,r FOR SHARE OF tas,ta,s,u;');
  IF definition NOT LIKE '%FOR UPDATE OF src,b,r FOR SHARE OF tas,ta,s,u;%' THEN
    RAISE EXCEPTION 'unable to apply the TradingView authorization lock correction';
  END IF;
  EXECUTE definition;
END $$;

-- 3. Obligation guard: it runs inside admission after the identity rows are held FOR SHARE. Left at FOR UPDATE
-- it would upgrade them there, so two admissions for different assignments of one account could deadlock.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('external_signal_entry_obligation_guard()'::regprocedure) INTO definition;
  IF definition NOT LIKE '%FOR UPDATE OF oi,ac,c,sig,sr,rr,auth,gen,ta,tas,sub,sec,src,b,rev;%' THEN
    RAISE EXCEPTION 'unexpected TradingView obligation lock clause';
  END IF;
  definition := replace(definition, 'FOR UPDATE OF oi,ac,c,sig,sr,rr,auth,gen,ta,tas,sub,sec,src,b,rev;', 'FOR UPDATE OF oi,ac,c,sig,sr,rr,auth,gen,src,b,rev FOR SHARE OF ta,tas,sub,sec;');
  IF definition NOT LIKE '%FOR UPDATE OF oi,ac,c,sig,sr,rr,auth,gen,src,b,rev FOR SHARE OF ta,tas,sub,sec;%' THEN
    RAISE EXCEPTION 'unable to apply the TradingView obligation lock correction';
  END IF;
  EXECUTE definition;
END $$;

-- Restated trusted function-level search_path (see the C3A hardening migration): every replaced function keeps
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
