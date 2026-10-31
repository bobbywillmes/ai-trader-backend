-- Phase 4A.2C3A design: transfers an existing database's application schema from the bootstrap
-- superuser to ai_trader_migrator. NOT APPLIED BY MIGRATIONS. Run once, as a superuser, in one
-- transaction during the maintenance window described in
-- docs/architecture/tradingview-paper-execution-authority.md. REASSIGN OWNED cannot be used: the
-- bootstrap superuser also owns the system catalogs.
BEGIN;
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT format('ALTER %s %I.%I OWNER TO ai_trader_migrator',
      CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, n.nspname, c.relname) AS statement
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_depend d ON d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i','e')
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') AND d.objid IS NULL
    UNION ALL
    SELECT format('ALTER %s %s OWNER TO ai_trader_migrator', CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, p.oid::regprocedure)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    LEFT JOIN pg_depend d ON d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e'
    WHERE n.nspname='public' AND d.objid IS NULL
    UNION ALL
    SELECT format('ALTER TYPE %I.%I OWNER TO ai_trader_migrator', n.nspname, t.typname)
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    LEFT JOIN pg_depend d ON d.objid=t.oid AND d.classid='pg_type'::regclass AND d.deptype='e'
    WHERE n.nspname='public' AND t.typtype IN ('e','d') AND d.objid IS NULL
  LOOP
    EXECUTE item.statement;
  END LOOP;
END $$;
GRANT CREATE, USAGE ON SCHEMA public TO ai_trader_migrator;
DO $$ BEGIN
  -- Lets the migrator create the trusted extensions the migration history already uses.
  EXECUTE format('GRANT CREATE, CONNECT, TEMPORARY ON DATABASE %I TO ai_trader_migrator', current_database());
END $$;
COMMIT;
