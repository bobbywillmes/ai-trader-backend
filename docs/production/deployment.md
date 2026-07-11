# Production Deployment Checklist

This doc covers the production launch and routine production update flow for the AI Trader backend and admin UI.

The goal is to make production startup conservative, repeatable, and easy to verify before n8n is connected to the production backend or before paper-order workflows are enabled.

---

## 1. Production Launch Philosophy

The AI Trader backend is the broker/control layer between n8n, the admin UI, and Alpaca.

Production launch should follow this order:

```text
Deploy safely
Apply database migrations
Verify health
Verify config
Verify broker mode
Verify risk gate
Verify audit layer
Only then connect n8n signals or enable automated trading
```

The first production deployment should start in a safe state:

```text
tradingEnabled=false
paperMode=true
killSwitchEnabled=false
ALLOW_LIVE_TRADING=false
ALLOW_TRADING_ENABLED_ON_START=false
```

For routine production updates, the safest deploy posture is:

```text
tradingEnabled=false
paperMode=true
killSwitchEnabled=true or false, depending on the current operating plan
ALLOW_LIVE_TRADING=false
ALLOW_TRADING_ENABLED_ON_START=false
```

Runtime trading settings such as `tradingEnabled`, `paperMode`, and `killSwitchEnabled` are database-backed `Setting` values, not `.env` values.

---

## 2. Required Environment Files

### Backend `.env`

Create a production `.env` file from:

```text
.env.example
```

Required production values:

```env
PORT=3000
NODE_ENV=production

DATABASE_URL=

ALPACA_API_KEY=
ALPACA_API_SECRET=
ALPACA_BASE_URL=https://paper-api.alpaca.markets
DEFAULT_TRADING_ACCOUNT_ID=1
TRADING_CREDENTIAL_ENCRYPTION_KEY=
TRADING_CREDENTIAL_ENCRYPTION_KEY_ID=prod-v1

AI_TRADER_SIGNAL_API_KEY=
AI_TRADER_ADMIN_API_KEY=

ALLOW_LIVE_TRADING=false
ALLOW_TRADING_ENABLED_ON_START=false

CORS_ALLOWED_ORIGINS=https://your-admin-ui-domain.com
```

### Backend Environment Notes

`ALPACA_BASE_URL` should point to the paper API for the first production launch:

```env
ALPACA_BASE_URL=https://paper-api.alpaca.markets
```

The current single-account runtime should keep `DEFAULT_TRADING_ACCOUNT_ID=1`
for the Bobby Paper `TradingAccount`. Alpaca runtime calls resolve credentials
through the account-scoped resolver. If an ACTIVE `TradingAccountCredential`
exists for the account, it is used. If no account credential exists for Bobby
Paper, the runtime falls back to the legacy `ALPACA_API_KEY`,
`ALPACA_API_SECRET`, and `ALPACA_BASE_URL` env vars. Non-default accounts
require an ACTIVE `TradingAccountCredential` before broker runtime calls can
use them.

`TRADING_CREDENTIAL_ENCRYPTION_KEY` encrypts account-scoped broker API
credentials before they are stored in the database. Generate it once per
environment with:

```bash
openssl rand -base64 32
```

Keep the value only in the environment, never in Git. Do not rotate or remove
it casually: existing encrypted credential rows need the same key material to
decrypt until a deliberate key-rotation workflow exists.
`TRADING_CREDENTIAL_ENCRYPTION_KEY_ID` is a non-secret identifier stored with
encrypted payloads for future rotation support.

Admin and signal API keys must be different.

```text
AI_TRADER_SIGNAL_API_KEY
  Used by trusted automation clients such as n8n.

AI_TRADER_ADMIN_API_KEY
  Used for admin/maintenance access and can also access signal routes.
```

`CORS_ALLOWED_ORIGINS` must be explicit in production. Do not use `*`, `localhost`, or `127.0.0.1` for production.

### Admin UI `.env`

Create:

```text
apps/admin-ui/.env
```

From:

```text
apps/admin-ui/.env.example
```

Example:

```env
VITE_API_BASE_URL=https://your-backend-domain.com
```

The admin UI does not need broker secrets or backend API keys. It authenticates through the backend login/session flow.

---

## 3. Local Pre-Deploy Validation

Before pushing production updates, validate locally from the project root:

```bash
npm run check
npm run build

cd apps/admin-ui
npm run build
cd ../..
```

If the update includes Prisma schema changes, make sure the migration folder was generated locally and committed:

```bash
ls prisma/migrations
git status
```

Production uses committed migration files. Production does not generate migrations.

Commit and push:

```bash
git add .
git commit -m "feat(scope): describe change"
git push origin main
```

Use conventional commit-style prefixes where practical:

```text
feat(admin-ui): ...
feat(api): ...
fix(worker): ...
refactor(db): ...
docs: ...
chore(deploy): ...
```

---

## 4. Routine Production Update Flow

Use this flow for normal production updates, especially when the update includes backend code, admin UI changes, Prisma schema changes, or new Prisma migrations.

SSH into the AI Trader VPS:

```bash
ssh root@srv1700402.hstgr.cloud
```

Go to the deployed app directory:

```bash
cd /opt/ai-trader
```

Pull the latest code:

```bash
git pull origin main
```

If the release includes Prisma schema changes or new migration directories, rebuild the backend image before checking migration status. The production migration commands run inside the backend image and will only see migration files that were included in that image build.

Check for pending Prisma migrations:

```bash
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate status
```

Apply pending migrations:

```bash
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
```

For changes that touch both backend and admin UI, rebuild both runtime images:

```bash
docker compose -f docker-compose.prod.yml build backend caddy
docker compose -f docker-compose.prod.yml up -d
```

For backend-only changes:

```bash
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml up -d backend
```

For admin UI-only changes, rebuild Caddy because the React static build is bundled into the Caddy image:

```bash
docker compose -f docker-compose.prod.yml build caddy
docker compose -f docker-compose.prod.yml up -d caddy
```

Check container status:

```bash
docker compose -f docker-compose.prod.yml ps
```

Check recent logs:

```bash
docker compose -f docker-compose.prod.yml logs --tail=100 backend
docker compose -f docker-compose.prod.yml logs --tail=100 caddy
```

Verify the public health endpoint:

```bash
curl -s https://srv1700402.hstgr.cloud/health
```

Expected result:

```text
ok=true
environment=production
database reachable
```

---

## 5. Database Migration Flow

Production should use Prisma migration deploy, not migration dev.

In Docker Compose production, use:

```bash
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate status
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
```

Do not use development migration commands in production:

```bash
npx prisma migrate dev
npx prisma migrate reset
```

Production data should be treated as durable, even while using Alpaca paper trading.

### Migration Mismatch Symptoms

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

### Useful Migration Troubleshooting Commands

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

## 6. Seed / Bootstrap Expectations

Production seed behavior should be conservative.

The default production runtime state should be:

```text
tradingEnabled=false
paperMode=true
killSwitchEnabled=false
```

Before connecting n8n or enabling order-entry workflows, verify runtime settings from the admin UI:

```text
Settings → Trading Controls
```

Or from the API:

```http
GET /api/config
```

Expected first-launch shape:

```json
{
  "tradingEnabled": false,
  "paperMode": true,
  "killSwitchEnabled": false
}
```

If production startup is blocked because the database already has `tradingEnabled=true`, use the recovery workflow below.

---

## 7. Production Startup Guards

Production startup checks run before workers start.

The backend checks:

- database reachability
- runtime trading config loading
- admin/signal API key separation
- paper/live broker URL alignment
- production live-trading override
- production trading-enabled-on-start override
- CORS origin safety

### Safe Production Startup

Expected safe production env:

```env
NODE_ENV=production
ALLOW_LIVE_TRADING=false
ALLOW_TRADING_ENABLED_ON_START=false
```

With database settings:

```text
tradingEnabled=false
paperMode=true
```

Expected result:

```text
server starts
workers start
health endpoint passes
system status endpoint passes
```

### Blocked Startup: Trading Already Enabled

If the database has:

```text
tradingEnabled=true
```

and production env has:

```env
ALLOW_TRADING_ENABLED_ON_START=false
```

startup should fail.

This is intentional. It prevents an accidental production restart into an already-trading state.

Preferred recovery flow:

1. Keep `ALLOW_TRADING_ENABLED_ON_START=false`.
2. Update the production database setting directly to `tradingEnabled=false`.
3. Restart the backend.
4. Verify `/health` and the Admin UI.
5. Re-enable trading manually from Settings only when ready.

Check the runtime settings directly in production Postgres:

```bash
docker compose -f docker-compose.prod.yml exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT key, value FROM \"Setting\" WHERE key IN ('\''tradingEnabled'\'', '\''paperMode'\'', '\''killSwitchEnabled'\'') ORDER BY key;"'
```

Disable trading:

```bash
docker compose -f docker-compose.prod.yml exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"Setting\" SET value = '\''false'\'', \"updatedAt\" = now() WHERE key = '\''tradingEnabled'\'';"'
```

Verify the safe state:

```text
killSwitchEnabled | true or false
paperMode         | true
tradingEnabled   | false
```

Restart the backend:

```bash
docker compose -f docker-compose.prod.yml up -d backend
```

Then check health:

```bash
curl -s https://srv1700402.hstgr.cloud/health
```

### Temporary Override Recovery

A temporary override is also available:

```env
ALLOW_TRADING_ENABLED_ON_START=true
```

Use this only when intentionally restarting production with trading already enabled. Do not leave this enabled unless it is deliberately part of the operating plan.

### Live Trading Guard

For paper production, keep:

```env
ALLOW_LIVE_TRADING=false
```

Only set this to `true` when intentionally preparing for live trading.

---

## 8. Start / Restart the Backend

The production backend normally runs through Docker Compose.

Start or restart all production services:

```bash
docker compose -f docker-compose.prod.yml up -d
```

Restart only the backend:

```bash
docker compose -f docker-compose.prod.yml up -d backend
```

Expected startup behavior:

```text
startup checks pass
server listens on configured PORT
workers start after startup checks pass
```

Workers should not start if startup checks fail.

---

## 9. Verify Health

Public health check:

```bash
curl -s https://srv1700402.hstgr.cloud/health
```

Expected:

```json
{
  "ok": true,
  "service": "ai-trader-backend",
  "environment": "production",
  "database": {
    "ok": true,
    "message": "Database reachable."
  }
}
```

This endpoint is intended for deployment checks and uptime monitoring.

If `/health` returns `502 Bad Gateway`, Caddy is reachable but the backend is probably not running or is crash-looping. Check:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=100 backend
```

---

## 10. Verify System Status

Admin-protected status check:

```bash
set -a
source .env
set +a

curl -s https://srv1700402.hstgr.cloud/api/system-status \
  -H "ai-trader-api-key: $AI_TRADER_ADMIN_API_KEY"
```

Verify:

```text
health.ok=true
database reachable
broker mode matches runtime mode
API key separation passes
CORS origins are production domains
pendingOrderCount=0
submittingOrderCount=0
```

In the admin UI, verify:

```text
Settings → System Status
```

Check:

- App / DB
- Broker Mode
- Workers
- Positions
- Environment
- Audit Freshness

---

## 11. Verify Runtime Trading Controls

In the admin UI:

```text
Settings → Trading Controls
```

Verify:

```text
Automated Trading: Off for first production launch or deploy restart
Kill Switch: On or Off intentionally
Paper Trading Mode: Paper
```

For a paper-trading smoke test, turn on Automated Trading only after all status checks pass.

---

## 12. Verify Entry Risk Limits

In the admin UI:

```text
Settings → Entry Risk Limits
```

Verify conservative initial limits, such as:

```text
maxDailyEntryOrders=5
maxDailyEntryNotional=5000
maxOpenPositions=5
maxTotalOpenNotional=10000
maxSymbolOpenNotional=5000
maxSubscriptionOpenNotional=5000
```

Adjust these based on the production paper test plan.

---

## 13. Verify Admin UI

Open the deployed admin UI:

```text
https://srv1700402.hstgr.cloud/login
```

Verify:

```text
Dashboard loads
Settings loads
System Status loads
Reports loads
System Events loads
Open Positions loads
Open Orders loads
Subscriptions load
Securities load
Exit Profiles load
```

Confirm the browser is calling the production backend URL from:

```env
VITE_API_BASE_URL
```

After UI changes, verify the recently changed feature directly. For example, after exit-profile or position-tracking changes, confirm Open Positions renders expected columns such as:

```text
Exit Strategy
Exit Target
Trailing State
Trail %
Trail HWM
Stop Price
```

---

## 14. Verify Audit Layer

Before enabling n8n signals, verify audit endpoints.

### Account snapshots

```http
POST /api/account-snapshots/manual
GET /api/account-snapshots/latest
GET /api/account-snapshots?limit=20
GET /api/account-snapshots/trends?mode=paper&dateFrom=2026-06-01T00:00:00.000Z&limit=200
```

Expected:

```text
manual snapshot creates a row
latest snapshot returns account state
Reports page shows snapshot history and account equity/exposure trends
```

`mode` can be `paper` or `live`. Trend data is returned chronologically for
chart rendering, while the snapshot table remains newest-first. Older snapshots
may show unavailable exposure values because long and short market values were
added after the original account snapshot table.

Also verify:

```text
Trade History page loads
Reports page loads including Trade Performance
```

### Broker activities

```http
POST /api/broker-activities/sync
GET /api/broker-activities?limit=20
```

Expected:

```text
sync completes
existing fills import idempotently
Reports page shows broker activity
```

---

## 15. Connect n8n

Only connect n8n after:

```text
/health passes
/api/system-status passes
admin UI loads
risk limits are reviewed
audit layer is verified
paper mode is confirmed
```

n8n should call the signal endpoint with the signal API key:

```http
POST /api/signals/entry
signal-key: AI_TRADER_SIGNAL_API_KEY
```

Use:

```text
AI_TRADER_SIGNAL_API_KEY
```

Do not use broker credentials in n8n.

n8n should not talk directly to Alpaca.

The hosted n8n workflow should use the production backend base URL:

```text
https://srv1700402.hstgr.cloud
```

The lean ETF watcher production dry-run should remain configured as:

```text
DRY_RUN=true
FORCE_MARKET_OPEN_FOR_TESTING=false
```

Expected dry-run behavior:

```text
n8n gets ETF watch context from backend
n8n pulls ETF snapshots
n8n decision engine evaluates candidates
n8n records durable entry decision snapshots for meaningful evaluations
n8n posts diary events to backend
backend stores Market Diary events
admin UI displays Entry Decisions results
admin UI displays Market Diary results
no live order is submitted
```

---

## 16. Paper-Trading Smoke Test

Recommended first smoke test:

1. Confirm Alpaca paper account is selected.
2. Confirm backend `paperMode=true`.
3. Confirm `ALPACA_BASE_URL=https://paper-api.alpaca.markets`.
4. Confirm Automated Trading is enabled only when ready.
5. Enable one conservative subscription.
6. Record one entry decision snapshot with a stable `decisionKey`.
7. Send one small test entry signal using that `decisionKey`.
8. Confirm one `OrderIntent`.
9. Confirm the entry decision is linked to that `OrderIntent`.
10. Confirm one `BrokerOrder`.
11. Confirm one Alpaca order.
12. Confirm one broker `FILL` activity.
13. Confirm one `TrackedPosition`.
14. Confirm the entry decision is linked through the tracked position/trade cycle.
15. Confirm one `position.opened` SystemEvent.
16. Confirm account snapshot reason `position_opened`.
17. Close the position.
18. Confirm one close fill.
19. Confirm one `position.closed` SystemEvent.
20. Confirm account snapshot reason `position_closed`.
21. Confirm the close fill is linked to the correct tracked-position cycle.
22. Confirm the cycle has `avgExitPrice`, `realizedPnl`, and `returnPct`.
23. Confirm the cycle captured configuration snapshot context once subscription context is known.
24. Confirm the Entry Decisions page shows the decision and lifecycle links.
25. Confirm the Trade History page renders the cycle timeline correctly.
26. Confirm the Reports page includes the closed cycle in Trade Performance and entry-decision grouping.

Expected result:

```text
one signal
one entry decision snapshot
one intent
one broker order
one broker fill
one tracked position lifecycle
one clean audit trail
one reviewable trade cycle
one performance-reportable closed trade
```

### Target Unlocks Trailing Stop Smoke Test

For target-unlocks-trailing-stop exits, use a dedicated paper-test subscription and a quick-test exit profile before switching core ETF subscriptions.

Expected flow:

```text
Paper position opens
Open Positions shows Target Unlocks Trail
Position reaches targetPct unlock threshold
Backend marks trailingUnlocked=true
Backend submits native Alpaca trailing_stop sell order
Open Orders shows broker trailing-stop sell order
Open Positions shows broker trailing state, trail %, HWM, and stop price
Broker fill / position sync eventually confirms position close
```

Important checks:

```text
subscription enabled=true
exitProfile enabled=true
tradingEnabled=true only when deliberately testing
paperMode=true
killSwitchEnabled=false only when deliberately allowing new entries
```

---

## 17. Emergency Controls

### Stop opening new positions

Use the Kill Switch:

```text
Settings → Trading Controls → Kill Switch On
```

This blocks new entries while keeping the system online for monitoring, syncing, position tracking, exit workflows, reports, and admin visibility.

### Stop automated trading broadly

Turn off Automated Trading:

```text
Settings → Trading Controls → Automated Trading Off
```

This broadly blocks automated order submission.

### Stop the backend

Stop the backend containers from the production host:

```bash
docker compose -f docker-compose.prod.yml down
```

Use this only if the service itself needs to be taken offline.

---

## 18. Production Go / No-Go Checklist

Before enabling n8n production signals or paper-order workflows:

```text
[ ] Backend build succeeded
[ ] Admin UI build succeeded
[ ] Prisma migrations committed
[ ] Prisma migrations deployed
[ ] .env configured
[ ] apps/admin-ui/.env configured
[ ] NODE_ENV=production
[ ] ALPACA_BASE_URL points to paper API
[ ] ALLOW_LIVE_TRADING=false
[ ] ALLOW_TRADING_ENABLED_ON_START=false
[ ] CORS_ALLOWED_ORIGINS uses production admin UI origin
[ ] /health returns ok=true
[ ] /api/system-status reviewed
[ ] Admin UI login works
[ ] Dashboard loads
[ ] Open Positions loads
[ ] Open Orders loads
[ ] Settings → System Status reviewed
[ ] Automated Trading is initially off after deploy restart
[ ] Paper Trading Mode is paper
[ ] Kill Switch behavior understood
[ ] Entry risk limits reviewed
[ ] Account snapshot manual test works
[ ] Broker activity sync works
[ ] Trade History page loads
[ ] Reports page loads
[ ] Trade Performance loads
[ ] System Events page loads
[ ] n8n signal API key configured
[ ] One paper smoke test completed successfully
[ ] One closed paper trade appears correctly in Trade History and Reports
```

---

## 19. Environment and Secrets

The production `.env` file lives only on the VPS:

```text
/opt/ai-trader/.env
```

It should not be committed to GitHub.

Important production secrets include:

```text
POSTGRES_PASSWORD
ALPACA_API_KEY
ALPACA_API_SECRET
TRADING_CREDENTIAL_ENCRYPTION_KEY
AI_TRADER_SIGNAL_API_KEY
AI_TRADER_ADMIN_API_KEY
```

Generate strong random values for internal secrets, for example:

```bash
openssl rand -hex 32
```

The signal API key is for n8n and automation clients.

The admin API key is for protected admin HTTP requests and operational checks.

The Admin UI login uses a User email/password account. Initial bootstrap uses:

```http
POST /api/auth/bootstrap
```

These are separate authentication paths.

---

## 20. Live Trading Checklist

Live trading is not part of the first production launch.

Before live trading, create a separate live-trading checklist and approval workflow.

At minimum, live trading should require:

```text
[ ] Paper production has run successfully for an extended period
[ ] Risk limits reviewed and reduced if needed
[ ] Emergency controls tested
[ ] Account/broker mode confirmed
[ ] ALPACA_BASE_URL changed intentionally
[ ] paperMode=false set intentionally
[ ] ALLOW_LIVE_TRADING=true set intentionally
[ ] Live order smoke test defined
[ ] Rollback plan documented
```

## 21. One-time trading account bootstrap

After the trading account schema foundation migration has been applied, run the one-time default trading account bootstrap script.

This script creates the initial legacy single-account trading account, establishes its enabled User as both account holder and explicit member, and backfills existing single-account trading records with the new `tradingAccountId`.

The script is intentionally not added to `package.json` because it should only be run manually when bootstrapping an environment.

Run from the project root:

```bash
DEFAULT_TRADING_ACCOUNT_HOLDER_EMAIL="your-user-email@example.com" \
DEFAULT_TRADING_ACCOUNT_DISPLAY_NAME="Bobby Paper" \
DEFAULT_TRADING_ACCOUNT_CAPITAL="10000" \
DEFAULT_TRADING_ACCOUNT_ENVIRONMENT="PAPER" \
npx tsx scripts/bootstrap-default-trading-account.ts
```

## 22. One-time trading account subscription bootstrap

After applying the account subscription sizing foundation migration, run the one-time bootstrap script to create `TradingAccountSubscription` rows for the default account and backfill lifecycle records.

```bash
DEFAULT_TRADING_ACCOUNT_ID=1 npx tsx scripts/bootstrap-trading-account-subscriptions.ts
```

## 23. One-time trading account risk settings bootstrap

After applying the account risk settings migration, run the one-time bootstrap script to create or update the default account's `TradingAccountRiskSettings` row.

This copies the current global entry risk limits into the Bobby Paper trading account so the account-level caps preserve current behavior while global settings continue to act as backend-wide emergency caps.

Run locally or from a source checkout with:

```bash
DEFAULT_TRADING_ACCOUNT_ID=1 npx tsx scripts/bootstrap-trading-account-risk-settings.ts
```

In production Docker, confirm the `scripts/` directory exists inside the backend image before running the command. If the image does not include one-off scripts, copy the script into the backend container or run it from a checked-out project directory with the production `DATABASE_URL` available, then remove any temporary copied file after the bootstrap completes.

## 24. User access model migration

The User access refactor is delivered through the committed Prisma migration. Do not update historical user-access rows manually unless a reviewed recovery procedure explicitly requires it.

After pulling the release, apply the production migrations with the production compose file, rebuild the backend and Admin UI, and verify the access-control checklist below. The canonical models are `User`, `UserSession`, `UserSetupToken`, and `TradingAccountMembership`; the platform role field is `platformRole`.

## 25. Verify Access Control

After auth/RBAC/onboarding changes:

- System Owner can sign in and enters the Admin Console.
- `/api/auth/me` returns `user`, `access`, and `session`, with `access.platformRole = "SYSTEM_OWNER"`.
- Users & Access loads.
- Create Invite panel opens.
- Operator enters the Admin Console and sees only permission-authorized features.
- Account User lands on `/portal` and sees only membership-scoped Trading Accounts.
- Account User cannot access `/users`, `/settings`, or other Admin Console routes.
- Membership replacement does not show or submit account roles or capability flags.
- n8n smoke test still passes.
