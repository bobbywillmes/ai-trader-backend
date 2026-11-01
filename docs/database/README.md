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

```text
npm run db:security-preflight -- --mode broker-enabled
npm run db:security-preflight -- --mode development-observation
npm run db:security-preflight -- --mode admin-diagnostic --runtime-role ai_trader_app
```

An explicit `--mode` is **required**; `--mode=value` and `--mode value` are equivalent. An unknown or misspelled
mode, an unrecognized or malformed option, a missing value, a duplicate option or an unexpected positional
argument exits **64**, prints `Invalid arguments: ...` to stderr and prints no report, so a typo can never
downgrade a broker-enabled request to observation. The assessment is **read-only**
(`src/services/database-security-readiness.service.ts`): it reads only catalogs and never writes. Credentials and
connection strings are never printed.

| Mode | Connection | Meaning |
|---|---|---|
| `broker-enabled` | `DATABASE_URL`, the backend's own connection. No alternate URL is accepted: `SECURITY_PREFLIGHT_DATABASE_URL` set with this mode is an error. | Fail closed. The connection must **be** the restricted runtime identity: `session_user = current_user =` the expected role (`ai_trader_app`, or `--runtime-role`), the connected database equals the one named in `DATABASE_URL`, and the active schema matches. Any mismatch or unreadable evidence is a finding. |
| `development-observation` | `DATABASE_URL` | Reports outstanding hardening; exit 0 when it ran. The backend runs this at startup and is never blocked by it. |
| `admin-diagnostic` | `SECURITY_PREFLIGHT_DATABASE_URL`, falling back to `DATABASE_URL` | An administrator inspects `--runtime-role`. Labeled `DIAGNOSTIC ONLY` on stderr; the report always has `startupAllowed: false` and `brokerReadinessAuthorized: false`. It can never authorize broker readiness. |

Exit codes: `0` allowed in the chosen mode, `1` findings forbid it, `2` the check could not run (for example it
could not connect), `64` invalid arguments.

Checks, all through effective privileges and the catalogs:

* **Identity**: `session_user`, `current_user`, database and active schema against the configured runtime identity.
* **Runtime role**: not a superuser, no `CREATEROLE`/`CREATEDB`/`REPLICATION`/`BYPASSRLS`, owns no schema object,
  cannot `SET session_replication_role`, holds **no role membership of any kind**, no `TEMPORARY`, and no access to
  or ownership of `_prisma_migrations`.
* **Dangerous privileges** (also reached through PUBLIC or inheritance): `TRUNCATE` on any application table
  (it bypasses row-level delete guards), `TRIGGER` on any relation, `CREATE` on any non-system schema, and
  database-level `CREATE`. Normal `SELECT`/`INSERT`/`UPDATE`/`DELETE` and sequence use are unaffected.
* **Pinned functions**: every application function pins `search_path=pg_catalog, <schema>, pg_temp` and none is
  `SECURITY DEFINER`.
* **Critical triggers** exist, bind their function and fire for ordinary sessions.
* **Integrity against the reviewed manifest** (`src/services/database-security-manifest.ts`): every trigger's
  timing, events, row/statement scope, `WHEN` expression, columns, arguments, enabled state and bound function;
  and every application function's language, volatility, result and **body digest**. A function or trigger that is
  new, changed or missing relative to the manifest is a finding. The manifest is code-controlled and reviewed; it
  is never derived from the database being assessed. A **reviewed trigger that is missing** from the database is
  a `PROTECTED_TRIGGER_MISSING` finding (all 140 reviewed triggers, in addition to the 27 critical-trigger
  checks). Function-body digests treat only **CRLF** as a line ending (it becomes LF, so a Windows checkout and a
  Linux checkout agree); a **standalone carriage return is preserved**, because inside a string literal it is part
  of the function's behavior. After a migration adds or replaces a function or trigger,
  regenerate it from a freshly migrated **disposable** database and commit the diff with the migration:
  `npx tsx scripts/generate-database-security-manifest.ts --from <disposable database url>`. An integration test
  fails when the manifest and a fresh migration disagree.

`least-privilege-temporary-revocation.sql` rejects, before changing anything, a runtime role that holds any
`pg_auth_members` row (including `INHERIT FALSE`/`SET TRUE`, which still permits `SET ROLE` and temporary
objects) or a privileged role attribute. It is safe to rerun and is **not** applied by any migration. Role cutover
order, including draining existing sessions before reconnecting as the final identity and running the
broker-enabled preflight before restoring broker-capable operations, is in
`docs/architecture/tradingview-paper-execution-authority.md` ("Database least-privilege design").

**Schema boundary.** The backend's database adapter (`src/db/prisma.ts`, `PrismaPg` built from the connection
string alone) always runs in `public`; `node-postgres` ignores a `?schema=` URL parameter. The preflight therefore
assesses `public` and **rejects** (exit 64, nothing printed to stdout) a `DATABASE_URL` that names any other schema,
instead of assessing a schema the backend does not use. There is no configurable production schema.

Migrations that replace a function must restate the trusted `search_path` (repeat the audit block from
`20261031120000_tradingview_dispatch_safety_hardening`); a static test enforces it for every migration from that
one onward.
