# AI Trader Production Deployment Checklist

This document describes the production launch flow for the AI Trader backend and admin UI.

The goal is to make production startup conservative, repeatable, and easy to verify before n8n is connected to the production backend.

---

## 1. Production Launch Philosophy

The AI Trader backend is the broker/control layer between n8n, the admin UI, and Alpaca.

Production launch should follow this order:

```text
Deploy safely
Verify health
Verify config
Verify broker mode
Verify risk gate
Verify audit layer
Only then connect n8n signals
```

The first production deployment should start in a safe state:

```text
tradingEnabled=false
paperMode=true
killSwitchEnabled=false
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

## 3. Production Build Commands

From the project root:

```bash
npm run build
```

For the admin UI:

```bash
cd apps/admin-ui
npm run build
```

Both builds should complete successfully before deployment.

---

## 4. Database Migration Flow

Production should use Prisma migration deploy, not migration dev.

From the backend project root:

```bash
npx prisma migrate deploy
```

Then generate Prisma client if needed:

```bash
npx prisma generate
```

Do not run destructive reset commands in production.

Avoid:

```bash
npx prisma migrate reset
```

---

## 5. Seed / Bootstrap Expectations

Production seed behavior should be conservative.

The default production runtime state should be:

```text
tradingEnabled=false
paperMode=true
killSwitchEnabled=false
```

Before connecting n8n, verify:

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

## 6. Production Startup Guards

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

Expected safe first launch:

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

This is intentional.

Recovery flow:

1. Temporarily set:

```env
ALLOW_TRADING_ENABLED_ON_START=true
```

2. Start the server.
3. Patch runtime config:

```http
PATCH /api/config/settings
```

```json
{
  "tradingEnabled": false,
  "paperMode": true
}
```

4. Stop the server.
5. Reset:

```env
ALLOW_TRADING_ENABLED_ON_START=false
```

6. Restart the server.

### Live Trading Guard

For paper production, keep:

```env
ALLOW_LIVE_TRADING=false
```

Only set this to `true` when intentionally preparing for live trading.

---

## 7. Start the Backend

After environment, build, and migrations are complete:

```bash
npm run start
```

Expected startup behavior:

```text
startup checks pass
server listens on configured PORT
workers start after startup checks pass
```

Workers should not start if startup checks fail.

---

## 8. Verify Health

Public health check:

```http
GET /health
```

Expected:

```json
{
  "ok": true,
  "service": "ai-trader-backend",
  "database": {
    "ok": true
  }
}
```

This endpoint is intended for deployment checks and uptime monitoring.

---

## 9. Verify System Status

Admin-protected status check:

```http
GET /api/system-status
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

## 10. Verify Runtime Trading Controls

In the admin UI:

```text
Settings → Trading Controls
```

Verify:

```text
Automated Trading: Off for first production launch
Kill Switch: Off
Paper Trading Mode: Paper
```

For a paper-trading smoke test, turn on Automated Trading only after all status checks pass.

---

## 11. Verify Entry Risk Limits

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

## 12. Verify Admin UI

Open the deployed admin UI.

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

---

## 13. Verify Audit Layer

Before enabling n8n signals, verify audit endpoints.

### Account snapshots

```http
POST /api/account-snapshots/manual
GET /api/account-snapshots/latest
GET /api/account-snapshots?limit=20
```

Expected:

```text
manual snapshot creates a row
latest snapshot returns account state
Reports page shows snapshot history
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

## 14. Connect n8n

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
```

Use:

```text
AI_TRADER_SIGNAL_API_KEY
```

Do not use broker credentials in n8n.

n8n should not talk directly to Alpaca.

---

## 15. Paper-Trading Smoke Test

Recommended first smoke test:

1. Confirm Alpaca paper account is selected.
2. Confirm backend `paperMode=true`.
3. Confirm `ALPACA_BASE_URL=https://paper-api.alpaca.markets`.
4. Confirm Automated Trading is enabled only when ready.
5. Enable one conservative subscription.
6. Send one small test entry signal.
7. Confirm one `OrderIntent`.
8. Confirm one `BrokerOrder`.
9. Confirm one Alpaca order.
10. Confirm one broker `FILL` activity.
11. Confirm one `TrackedPosition`.
12. Confirm one `position.opened` SystemEvent.
13. Confirm account snapshot reason `position_opened`.
14. Close the position.
15. Confirm one close fill.
16. Confirm one `position.closed` SystemEvent.
17. Confirm account snapshot reason `position_closed`.

Expected result:

```text
one signal
one intent
one broker order
one broker fill
one tracked position lifecycle
one clean audit trail
```

---

## 16. Emergency Controls

### Stop opening new positions

Use the Kill Switch:

```text
Settings → Trading Controls → Kill Switch On
```

This blocks new entries while keeping the system online for monitoring, syncing, and exit workflows.

### Stop automated trading broadly

Turn off Automated Trading:

```text
Settings → Trading Controls → Automated Trading Off
```

This broadly blocks automated order submission.

### Stop the backend

Stop the backend process from the production host.

Use this if the service itself needs to be taken offline.

---

## 17. Production Recovery Notes

If production starts in an unsafe database state, such as:

```text
tradingEnabled=true
```

and startup is blocked, use the temporary override recovery flow:

```env
ALLOW_TRADING_ENABLED_ON_START=true
```

Start the server, patch settings to a safe state, then reset the override to:

```env
ALLOW_TRADING_ENABLED_ON_START=false
```

Do not leave production override flags enabled unless intentionally needed.

---

## 18. Production Go / No-Go Checklist

Before enabling n8n production signals:

```text
[ ] Backend build succeeded
[ ] Admin UI build succeeded
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
[ ] Settings → System Status reviewed
[ ] Automated Trading is initially off
[ ] Paper Trading Mode is paper
[ ] Kill Switch behavior understood
[ ] Entry risk limits reviewed
[ ] Account snapshot manual test works
[ ] Broker activity sync works
[ ] Reports page loads
[ ] System Events page loads
[ ] n8n signal API key configured
[ ] One paper smoke test completed successfully
```

---

## 19. Live Trading Checklist

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
