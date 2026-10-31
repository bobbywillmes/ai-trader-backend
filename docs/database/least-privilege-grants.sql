-- Phase 4A.2C3A least-privilege design for the application database role. NOT APPLIED BY MIGRATIONS.
-- See "Database least-privilege design" in docs/architecture/tradingview-paper-execution-authority.md
-- for the cutover and rollback procedure. Run as the migration identity that owns the schema, after
-- creating both roles:
--
--   CREATE ROLE ai_trader_migrator LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '...';
--   CREATE ROLE ai_trader_app      LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '...';
--
-- The application needs DML, sequences and PUBLIC function execution. Trigger functions run as the
-- invoker, so it needs read access to every table they consult. It must never own a table: an owner
-- can disable or drop the triggers this system relies on.

GRANT USAGE ON SCHEMA public TO ai_trader_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ai_trader_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_trader_app;
REVOKE ALL ON TABLE public."_prisma_migrations" FROM ai_trader_app;

-- Objects created by later migrations follow the same rule without a manual step.
ALTER DEFAULT PRIVILEGES FOR ROLE ai_trader_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_trader_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_trader_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_trader_app;
