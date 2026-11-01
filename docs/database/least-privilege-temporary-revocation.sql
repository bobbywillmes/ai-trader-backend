-- Phase 4A.2C3A least-privilege design: denies the runtime role the TEMPORARY database privilege.
-- NOT APPLIED BY MIGRATIONS. Part of the role-cutover design in
-- docs/architecture/tradingview-paper-execution-authority.md; not run against any persistent database yet.
--
-- WHO RUNS IT: a PostgreSQL superuser, or the owner of the target database. REVOKE ... ON DATABASE is a
-- database-level privilege change, not schema DML, so the schema migrator cannot run it unless it
-- also owns the database. Connect to the TARGET database, whose name comes from the deployment
-- environment (for example `psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>`); the script
-- uses current_database() and never names one.
--
-- WHY: PostgreSQL grants TEMPORARY on every database to PUBLIC. A role that can create temporary
-- tables can shadow application relations for any routine that does not pin its own search_path.
-- The migration pins every application function, so this is a second, independent layer.
-- The runtime issues no temporary-table DDL: it has no CREATE TEMP, and sorts and hashes spill to
-- temporary files, which need no privilege.
--
-- Only ai_trader_migrator (migrations and maintenance) is granted TEMPORARY explicitly. Any other
-- identity that legitimately needs it, such as a reporting role, must be granted it afterwards by name.
--
-- DRAINING: PostgreSQL checks TEMPORARY each time a session creates an object in its temporary schema, so
-- the REVOKE stops even already-connected sessions from creating more temporary tables. It does not drop
-- temporary tables a session already created, and those still shadow application relations for any
-- routine without a pinned path. Stop the backend before the cutover and, after this script, end any
-- leftover application sessions before restarting it:
--   SELECT pg_terminate_backend(pid) FROM pg_stat_activity
--   WHERE usename = 'ai_trader_app' AND datname = current_database() AND pid <> pg_backend_pid();
DO $$
DECLARE
  target text := current_database();
  is_super boolean;
  database_owner name;
  restored text;
  memberships text;
  app_attributes text;
BEGIN
  SELECT rolsuper INTO is_super FROM pg_roles WHERE rolname=current_user;
  SELECT pg_get_userbyid(datdba) INTO database_owner FROM pg_database WHERE datname=target;
  IF NOT is_super AND NOT pg_has_role(current_user, database_owner, 'USAGE') THEN
    RAISE EXCEPTION 'run as a superuser or the owner of database %, not as %', target, current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ai_trader_app') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ai_trader_migrator') THEN
    RAISE EXCEPTION 'create ai_trader_app and ai_trader_migrator before revoking TEMPORARY';
  END IF;

  -- The runtime role must be a plain login role with no memberships at all. Any pg_auth_members row is
  -- rejected whatever its options: a membership with INHERIT FALSE grants no privileges by itself, but
  -- with SET TRUE (the PostgreSQL 16 default for a plain GRANT of a role) the role can SET ROLE into the
  -- granted role, create temporary objects as it, then RESET ROLE, so the privilege check below would
  -- not see it. On PostgreSQL 15 and earlier membership always implies SET ROLE. Roles reached through a
  -- chain start with a direct row, so a direct-row check covers the chain. This runs before any change,
  -- so an unsafe role leaves the database exactly as it was.
  -- to_jsonb keeps this valid on every version: PostgreSQL 16 adds the inherit_option and set_option columns.
  SELECT string_agg(pg_get_userbyid(am.roleid) || ' ' || (to_jsonb(am) - 'oid' - 'roleid' - 'member' - 'grantor')::text, '; ' ORDER BY am.roleid) INTO memberships
    FROM pg_auth_members am WHERE am.member = (SELECT oid FROM pg_roles WHERE rolname='ai_trader_app');
  IF memberships IS NOT NULL THEN
    RAISE EXCEPTION 'ai_trader_app must hold no role membership, including a non-inheriting or SET-capable one; found: %. Revoke each (REVOKE <role> FROM ai_trader_app) and rerun; nothing was changed.', memberships;
  END IF;
  SELECT concat_ws(', ', CASE WHEN rolsuper THEN 'SUPERUSER' END, CASE WHEN rolcreaterole THEN 'CREATEROLE' END, CASE WHEN rolcreatedb THEN 'CREATEDB' END,
                   CASE WHEN rolreplication THEN 'REPLICATION' END, CASE WHEN rolbypassrls THEN 'BYPASSRLS' END) INTO app_attributes
    FROM pg_roles WHERE rolname='ai_trader_app';
  IF app_attributes <> '' THEN
    RAISE EXCEPTION 'ai_trader_app must be a plain role; it holds: %; nothing was changed.', app_attributes;
  END IF;

  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', target);
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM ai_trader_app', target);
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO ai_trader_migrator', target);

  -- A direct grant to the application role, or a grant to any role it belongs to, is not undone by the
  -- statements above. Fail loudly rather than leave the role able to create temporary tables.
  IF has_database_privilege('ai_trader_app', target, 'TEMPORARY') THEN
    SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, ', ') INTO restored
    FROM pg_database d, aclexplode(d.datacl) a
    WHERE d.datname=target AND a.privilege_type='TEMPORARY' AND CASE WHEN a.grantee=0 THEN true ELSE pg_has_role('ai_trader_app', a.grantee, 'USAGE') END;
    RAISE EXCEPTION 'ai_trader_app still holds TEMPORARY on % through: %; revoke that grant or the membership', target, restored;
  END IF;
  RAISE NOTICE 'TEMPORARY on % now held by: %', target,
    (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, ', ') FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname=target AND a.privilege_type='TEMPORARY');
END $$;
