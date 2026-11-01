# Database Visualization

The AI Trader Backend database schema can be visualized using [dbdiagram.io](https://dbdiagram.io).

The Prisma schema is the source of truth:

```text
prisma/schema.prisma
```

A generated DBML file is kept here for documentation and easy import into dbdiagram:
```
docs/database/ai-trader.dbml
```
Regenerating the DBML

After changing prisma/schema.prisma, regenerate the DBML file:
```
npm run prisma:generate
```

The DBML generator is configured in prisma/schema.prisma using prisma-dbml-generator.

The dbml file is built with prisma-dbml-generator (installed as a devDependency)

## Importing into dbdiagram.io

Open dbdiagram.io.

1. Create or open the AI Trader Backend diagram.

2. Copy the contents of:
```
docs/database/ai-trader.dbml
```
3. Paste it into the DBML editor.
4. Reorganize tables visually as needed.

## Important Notes
- Do not manually edit ai-trader.dbml.
- Update prisma/schema.prisma instead, then regenerate the DBML.
- The DBML file represents schema structure only.
- Manual dbdiagram layout changes are managed inside dbdiagram.io and may not be preserved by regenerating DBML.
- Do not connect dbdiagram directly to the production database.

## Database security readiness (Phase 4A.2C3B.1)

`npm run db:security-preflight -- [--mode=development|broker-enabled] [--runtime-role=ai_trader_app]` runs a
**read-only** catalog assessment (`src/services/database-security-readiness.service.ts`). It reads only
`pg_proc`, `pg_trigger`, `pg_roles`, `pg_auth_members`, `pg_class` and `pg_database`; it never reads
`_prisma_migrations` and never writes. Connect as the role to assess, or as an administrator with
`--runtime-role`. Set `SECURITY_PREFLIGHT_DATABASE_URL` to use a different connection than `DATABASE_URL`.

Checks: every application function pins `search_path=pg_catalog, <schema>, pg_temp` and none is `SECURITY
DEFINER` (a `CREATE OR REPLACE` that drops the pin is therefore detected); every critical TradingView/exposure
trigger exists, binds its function and fires for ordinary sessions; the runtime role is not a superuser,
owns no schema objects, has no `CREATEROLE`/`CREATEDB`/`REPLICATION`/`BYPASSRLS`, cannot `SET
session_replication_role`, has no `TEMPORARY` privilege, holds **no role membership of any kind**, and has no
access to or ownership of the migration history table.

* `development` (default): findings are reported as outstanding hardening; exit code 0. The backend logs the
  same report at startup and is never blocked by it.
* `broker-enabled`: any finding, including a check that could not run, fails closed with exit code 1.

Exit code 2 means the preflight itself could not connect.

`least-privilege-temporary-revocation.sql` now rejects, before changing anything, a runtime role that holds any
`pg_auth_members` row (including `INHERIT FALSE`/`SET TRUE`, which still permits `SET ROLE` and temporary
objects) or a privileged role attribute. It is safe to rerun and is **not** applied by any migration.

Migrations that replace a function must restate the trusted `search_path` (repeat the audit block from
`20261031120000_tradingview_dispatch_safety_hardening`); a static test enforces it for every migration from that
one onward.
