# Production Database Migrations

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

---

## 🔃 Routine Migration Flow

Check for pending migrations before rebuilding containers:

```bash
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

Fix:

```bash
cd /opt/ai-trader

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
```

### Security

Canonical symbol registry for tradable instruments. A security stores the symbol, display name, enabled state, asset type, and optional classification metadata.

Linked to:

- `Subscription`
- `TrackedPosition`
- `BrokerOrder`

### OrderIntent

Logs every order request received by the backend before broker submission. This includes blocked and rejected requests.

### BrokerOrder

Logs broker order responses from Alpaca.

### BrokerActivity

Stores broker-confirmed Alpaca account activities.

Currently used for `FILL` activity imports. These records are separate from `SystemEvent` because they represent broker-confirmed execution history rather than internal app state transitions.

### AccountSnapshot

Stores account-level audit snapshots from Alpaca account state.

Used for scheduled checkpoints, manual snapshots, and position lifecycle snapshots.

### TrackedPosition

Stores the current known state of broker positions, plus historical closed records.

### SystemEvent

Stores internal state transition events for audit and UI activity feeds.

### Strategy

Top-level/reusable trading logic identity, such as Dip N Ride, Momentum, or quick test strategies.

### ExitProfile

Configurable exit rules attached to subscriptions.

### Subscription

Symbol-specific deployment of a strategy and exit profile with sizing and enable/disable state.
