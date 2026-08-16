# Production Database Migrations

## Account-scoped broker identity migration

`20260725120000_scope_broker_lifecycle_identity_by_account` replaces global
activity, broker-order, client-order, snapshot run-key, and Alpaca API-usage
uniqueness with partial account-scoped indexes.

Before dropping old indexes, it reports unattributed-row counts and rejects
duplicate attributed identities, snapshot or usage collisions, and activity
broker/mode values that contradict the owning Trading Account. It never
deduplicates, deletes, merges, or attributes historical rows. Investigate any
preflight exception; do not blanket-assign null rows to Bobby Paper.

This doc covers Prisma migration rules for production, the routine migration flow, how to diagnose and recover from migration mismatches, and the full database model reference.

---

## 📇 Migration Rules

Use Prisma migration deploy in production:

```bash
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
```

Do not use development migration commands in production:

```bash
npx prisma migrate dev    # development only
npx prisma migrate reset  # destructive — never in production
```

Production data should be treated as durable, even while using Alpaca paper trading.

### Trading Account operational-state migration

Migration `20260724180000_lock_trading_account_operational_state` adds:

```sql
CONSTRAINT "TradingAccount_operational_state_check"
CHECK (
  ("status" = 'ACTIVE' AND "tradingEnabled" = true AND "killSwitchEnabled" = false)
  OR
  ("status" <> 'ACTIVE' AND "tradingEnabled" = false AND "killSwitchEnabled" = true)
)
```

Migration `20260816120000_allow_active_entry_disarmed` replaces that constraint
so ACTIVE accounts may be either entry-disarmed (`false / true`) or explicitly
armed (`true / false`). Non-ACTIVE accounts remain constrained to `false / true`,
and ambiguous ACTIVE latch combinations remain invalid.

Before adding the constraint, its `DO` block counts invalid accounts and raises
an exception containing that count. It does not update or repair rows. Review
and resolve any reported inconsistency deliberately before retrying deployment.

The migration also adds nullable `SystemEvent.actorUserId`, index
`SystemEvent_actorUserId_idx`, and foreign key
`SystemEvent_actorUserId_fkey`.

---

## 🔃 Routine Migration Flow

If the release includes new migration folders, rebuild the backend image first. In this production setup, Prisma migration commands run inside the backend image, so they only see migration files that were bundled into that image build.

Check for pending migrations:

```bash
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate status
```

Apply pending migrations:

```bash
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
```

Then restart the backend:

```bash
docker compose -f docker-compose.prod.yml up -d backend
```

---

## 🔃 Migration Mismatch Symptoms

If the backend code deploys before the production database migration is applied, API routes may fail with errors like:

```text
Invalid `prisma.trackedPosition.findMany()` invocation:
The column `TrackedPosition.someNewColumn` does not exist in the current database.
```

This means the Prisma client expects a column that does not exist in production Postgres yet.

Recent lifecycle-review examples include missing columns such as:

```text
OrderIntent.trackedPositionId
BrokerOrder.trackedPositionId
BrokerActivity.trackedPositionId
BrokerActivity.trackedPositionLinkSource
TrackedPosition.configSnapshotJson
TrackedPosition.configSnapshotCapturedAt
```

Fix:

```bash
cd /opt/ai-trader

docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate status
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
docker compose -f docker-compose.prod.yml up -d backend
```

---

## ⚠️ Migration Troubleshooting Commands

Confirm a migration file exists on the VPS:

```bash
grep -R "someNewColumnName" -n prisma/schema.prisma prisma/migrations
```

Check recent applied migrations:

```bash
docker compose -f docker-compose.prod.yml exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT migration_name, finished_at FROM \"_prisma_migrations\" ORDER BY started_at DESC LIMIT 10;"'
```

Check whether a specific column exists in production:

```bash
docker compose -f docker-compose.prod.yml exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT column_name FROM information_schema.columns WHERE table_name = '\''TrackedPosition'\'' AND column_name ILIKE '\''%trailing%'\'' ORDER BY ordinal_position;"'
```

### Prisma migration history says clean, but runtime column is missing

If `prisma migrate deploy` reports no pending migrations but the app fails with a missing-column error, inspect the actual table schema. This can indicate migration drift between `_prisma_migrations` and the live database schema.

Use `information_schema.columns` to confirm whether the column exists before applying any repair SQL. Do not use `prisma migrate reset` in production.

### To fix:
(in project root)
1. Run a SQL command to check for missing columns in table

```sql
cat <<'SQL' | docker compose -f docker-compose.prod.yml run --rm backend npx prisma db execute --stdin
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'PositionExitState'
  AND lower(column_name) LIKE 'attention%'
ORDER BY column_name;
SQL
```
2. If response returns nothing, the columns were never added to table. Continue to step 3.
3. Add missing columns to table
```sql
cat <<'SQL' | docker compose -f docker-compose.prod.yml run --rm backend npx prisma db execute --stdin
ALTER TABLE "PositionExitState"
  ADD COLUMN IF NOT EXISTS "attentionRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "attentionCode" TEXT,
  ADD COLUMN IF NOT EXISTS "attentionMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "attentionAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attentionClearedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "PositionExitState_attentionRequired_idx"
  ON "PositionExitState"("attentionRequired");

CREATE INDEX IF NOT EXISTS "PositionExitState_attentionCode_idx"
  ON "PositionExitState"("attentionCode");
SQL
```
4. Restart the backend and check server logs
```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate backend
docker compose -f docker-compose.prod.yml logs --tail=10 backend
```

### Prisma says no pending migrations to deploy / already up to date

Confirm you rebuilt the backend image after pulling code that added the migration files. If the host working tree contains the new migration directories but the backend image was not rebuilt, Prisma inside the container can still report the old migration count.



---

## 💽 Database Models

PostgreSQL runs locally through Docker Compose. The Prisma schema (`prisma/schema.prisma`) is the source of truth.

Current Prisma models include:

- `Setting`
- `AdminUser`
- `AdminSession`
- `Security`
- `Strategy`
- `ExitProfile`
- `Subscription`
- `OrderIntent`
- `BrokerOrder`
- `BrokerActivity`
- `TrackedPosition`
- `AccountSnapshot`
- `SystemEvent`

### Setting

Stores runtime trading and risk settings.

Current keys:

```text
tradingEnabled
paperMode
killSwitchEnabled
maxDailyEntryOrders
maxDailyEntryNotional
maxOpenPositions
maxTotalOpenNotional
maxSymbolOpenNotional
maxSubscriptionOpenNotional
entrySessionGuardEnabled
entryStartMinutesAfterOpen
entryCutoffMinutesBeforeClose
failClosedOnMarketClockError
alpacaMarketClockCache
```

### Security

Canonical symbol registry for tradable instruments. A security stores the symbol, display name, enabled state, asset type, and optional classification metadata.

Linked to:

- `Subscription`
- `TrackedPosition`
- `BrokerOrder`

### OrderIntent

Logs every order request received by the backend before broker submission. This includes blocked and rejected requests.

Lifecycle-review additions:

- nullable `trackedPositionId` for trade-cycle ownership

### BrokerOrder

Logs broker order responses from Alpaca.

Lifecycle-review additions:

- nullable `trackedPositionId` for trade-cycle ownership

### BrokerActivity

Stores broker-confirmed Alpaca account activities.

Currently used for `FILL` activity imports. These records are separate from `SystemEvent` because they represent broker-confirmed execution history rather than internal app state transitions.

Lifecycle-review additions:

- nullable `trackedPositionId`
- `trackedPositionLinkSource`
- `trackedPositionLinkedAt`

### AccountSnapshot

Stores account-level audit snapshots from Alpaca account state.

Used for scheduled checkpoints, manual snapshots, and position lifecycle snapshots.

Exposure-trend additions:

- nullable `longMarketValue`
- nullable `shortMarketValue`

These fields preserve historical rows without estimated backfills. Derived gross,
net, and percentage exposure metrics are calculated from these stored values in
the account snapshot reporting service.

### AlpacaApiUsageBucket

Stores aggregated Alpaca REST API usage by time bucket, operation, endpoint, method, and HTTP status code.

Used for broker API observability and rate-limit diagnostics. The live Admin UI panel is backed by the current process snapshot, while this table preserves recent usage aggregates for operational review and future historical reporting.

### TrackedPosition

Stores the current known state of broker positions, plus historical closed records.

Lifecycle-review additions:

- `configSnapshotJson`
- `configSnapshotCapturedAt`

`TrackedPosition` now acts as the canonical trade-cycle anchor for lifecycle review and performance reporting.

### SystemEvent

Stores internal state transition events for audit and UI activity feeds.

### Strategy

Top-level/reusable trading logic identity, such as Dip N Ride, Momentum, or quick test strategies.

### ExitProfile

Configurable exit rules attached to subscriptions.

### Subscription

Symbol-specific deployment of a strategy and exit profile with sizing and enable/disable state.

## Subscription catalog destructive-migration preflight

Before deploying the migration that removes legacy `Subscription` deployment
columns, run the authoritative diagnostic against production while those
columns still exist:

```powershell
npx tsx scripts/diagnose-subscription-catalog-migration.ts
```

Archive the complete JSON output with the deployment record. The command exits
successfully only when all of these independent conclusions are true:

- `initialBootstrapFidelityValid`: exact enablement and sizing parity at the
  immediate post-bootstrap point in time. Preserve that output immutably.
- `legacyMigrationProvenanceValid`: later parity differences are completely
  classified, current states are writer-valid, and no unexplained or malformed
  divergence remains.
- `schemaDropSafe`: mapping, routing, lifecycle, conversion, and durable
  provenance are safe for legacy-column removal.
- `productionBaselineValid`: Bobby Paper has the exact authoritative curated
  catalog key set, Bobby Live has no assignments, and both accounts are
  discovered unambiguously.
- `runtimeEntryReady`: all currently active entry-capable assignments have
  complete valid account risk, allocation, reservation, sizing, and capacity
  configuration.

One conclusion cannot substitute for another. In particular,
`schemaDropSafe=true` does not mean trading is ready, and
`runtimeEntryReady=true` does not prove legacy migration fidelity. Do not run
`prisma migrate deploy` for the legacy-column removal unless
`overallDiagnosticPassed=true` and the diagnostic process exits zero.

Editable `TradingAccountSubscription` configuration may legitimately diverge
from stale legacy values after bootstrap. Exact parity remains reported as
evidence but is not a permanent schema-drop requirement when chronology and
writer-valid state classify the difference. Historical assignment changes lack
dedicated actor-level `SystemEvent` records, so retain the restored-backup
diagnostic JSON and reviewed row-level provenance report with the deployment.

Running the command against a database where the legacy columns were already
removed produces a structured `LEGACY_SOURCE_UNAVAILABLE` failure. This is not
a repair request and must not be bypassed: use retained pre-migration evidence
or a verified pre-migration backup to establish legacy migration fidelity.
