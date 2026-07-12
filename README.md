# AI Trader Backend

AI Trader Backend is the broker/control layer between the n8n AI Trader workflows, the web UI, and Alpaca paper/live brokerage accounts.

n8n decides what it wants to do. The backend decides whether that request is allowed, records the intent, submits approved orders to Alpaca, tracks the resulting position, imports broker-confirmed activity, evaluates exits, and records a durable audit trail.

## 🧭 System Overview

Current backend-driven AI Trader flow:

```text
n8n:
→ POST to /api/signals/entry-decisions
→ POST to /api/signals/entry
Backend:
→ Receive signal from n8n (Subscription resolution)
→ Risk Gate / Kill Switch / Entry Limits
→ OrderIntent
→ Async Order Worker
→ BrokerOrder / Alpaca
→ BrokerActivity fill import
→ TrackedPosition trade cycle
→ ExitProfile-driven exit evaluation
→ AccountSnapshot / SystemEvent audit trail
→ TradeHistory / Performance review
```

The backend is designed so n8n does not talk directly to Alpaca. n8n watches the market & sends signals at the right time. The backend handles all of the heavy-lifting, business/broker logic.

## ⚒️ Core Responsibilities

The backend currently handles:
- Signal ingestion from n8n
- Entry decision snapshot ingestion and review
- Subscription-driven order resolution
- Centralized entry risk-gate enforcement
- Runtime trading controls
- Paper/live broker mode validation
- Alpaca order submission
- Alpaca API usage and rate-limit observability
- Adaptive Alpaca REST polling for order and position synchronization
- Internal tracked position lifecycle management
- Exit profile evaluation
- Broker-confirmed fill imports
- Runtime worker health and stale-worker visibility
- Canonical trade-cycle lifecycle review APIs
- Historical config snapshots for tracked trade cycles
- Account snapshot history
- Performance reporting from closed trade cycles
- System event audit logging
- Web UI authentication and controls
- Production readiness checks

## 🔐 Access control

AI Trader separates machine access from human access.

### Machine access

n8n uses the signal API key and is limited to signal/client workflows. It should not use the admin API key, broker credentials, or human User session tokens.

```text
AI_TRADER_SIGNAL_API_KEY -> n8n / automation routes
```

### Human access

Human users log in through the web UI and receive a User session bearer token.

```text
SYSTEM_OWNER -> full admin console with unrestricted Trading Account scope
OPERATOR     -> permission-driven admin console with membership-scoped accounts
ACCOUNT_USER -> read-only Account Portal with membership-scoped accounts
```

Owners can invite users from **System → Users & Access**. Invite links are one-time setup links. Until email delivery exists, owners copy setup links manually.

For the full model, see [Access Control & RBAC](docs/security/README.md).


## 🖥️ Web UI experiences

The React UI now has two role-based experiences.

### Admin Console

System owners can access the full operational console. Operators see the subset allowed by their Platform Permissions:

- Dashboard
- Trading Accounts
- Entry Decisions
- Momentum Scanner research dashboard, candidate/catalyst browsing, symbol research,
  research-universe management, and manual pipeline inspection
- Strategies
- Subscriptions
- Exit Profiles
- Reports
- Market Diary
- System Events
- Reconciliation
- Securities
- Settings
- Users & Access

### Account Portal

Account Users are routed to `/portal` and can only see read-only data for Trading Accounts assigned through explicit memberships:

- Dashboard
- Accounts
- Positions
- Orders
- Trade History

Account Users cannot change settings, manage users, place orders, cancel orders, close positions, trigger broker syncs, or access Admin Console routes.

## 🧯 Production safety layer

The backend includes a centralized entry-risk gate that sits between signal/order creation and broker submission. It answers one question:

```text
Even if this signal is valid, is the system allowed to enter this trade right now?
```

Entry orders are blocked when runtime safety, account, subscription, symbol, strategy, exit-profile, exposure, or session checks fail.

Important production controls:

```text
tradingEnabled=false  -> broad automated trading shutdown
killSwitchEnabled=true -> entry-only pause while monitoring/syncing continues
paperMode=true         -> paper-mode runtime posture
```

For trading safety design, see [Risk & Safety](docs/architecture/risk-and-safety.md).

## 🧱 Tech Stack
- Node.js
- TypeScript
- Express
- PostgreSQL
- Prisma
- Docker Compose
- Alpaca Trading API
- React / Vite web UI
- Mantine
- TanStack Query

## 📁 Project Structure
```
apps/
  web/                    React web app

src/
  app.ts                  Express app setup
  server.ts               HTTP server + worker startup
  config/                 Environment and runtime config
  controllers/            Request/response handlers
  integrations/           External service adapters
  middleware/             Auth, logging, errors
  routes/                 API route definitions
  services/               Business logic
  validators/             Zod schemas
  workers/                Background workers

prisma/
  migrations/             Prisma migrations
  schema.prisma           Database schema

docs/
  api/                    Backend API notes
  architecture/           System design docs
  integrations/           External workflow docs
  production/             Production runbooks
```

## 🚀 Quick Start

Install dependencies:

```bash
npm install
```
Start the local development database:

```bash
docker compose up -d postgres
```

Run Prisma migrations:

```bash
npx prisma migrate dev
```

Start the backend:

```bash
npm run dev
```

Start the web UI:

```bash
cd apps/web
npm install
npm run dev
```

## ✅ Common Validation Commands

From the repo root:

```bash
npm run check
npm run build
```
Build the web app:

```bash
cd apps/web
npm run build
cd ../..
```

## 🔒 Production Safety Model

The backend uses a centralized entry-risk gate between signal creation and broker submission.

Entry orders can be blocked by:

- global trading disabled
- kill switch enabled
- broker account blocked
- paper/live mode mismatch
- disabled security
- disabled subscription
- disabled strategy
- disabled exit profile
- regular-session entry guard closed, buffering, or unavailable
- existing open or closing tracked position
- daily order limits
- notional exposure limits
- per-symbol exposure limits
- per-subscription exposure limits

For the full safety model, see:
[Risk and Safety](docs/architecture/risk-and-safety.md)

## 🏭 Production

Production documentation lives under:
```
docs/production/
```

Most-used production docs:

- [Production Deployment](docs/production/deployment.md)
- [Production Workflow](docs/production/production-workflow.md)
- [Database Migrations](docs/production/database-migrations.md)
- [Troubleshooting](docs/production/troubleshooting.md)


The normal production update flow is:

```
Work locally
→ validate locally
→ commit
→ push to GitHub
→ SSH into VPS
→ pull latest
→ run migrations if needed
→ rebuild/restart containers
→ verify health
→ verify web UI
→ verify n8n behavior
```
For more about production workflow, see:
[Production Workflow](docs/production/production-workflow.md)


## ⚙️ Background workers

The backend runs workers for:

- pending order processing
- broker order synchronization
- tracked-position synchronization
- exit evaluation
- account snapshots
- broker activity/fill imports
- worker health reporting

Workers are guarded to avoid overlapping ticks and duplicate lifecycle events.


## 🚀 Local validation

Before committing backend/web app changes:

```bash
npm run check
npm run build
cd apps/web
npm run lint
npm run build
cd ../..
```

If the update includes Prisma changes, generate and commit the migration locally, then deploy with `prisma migrate deploy` in production.


## 🏁 Production deployment

Production runs on a Hostinger VPS through Docker Compose:

```text
Caddy reverse proxy / HTTPS
React web UI static build
Node/Express backend
PostgreSQL
Prisma migrations
Alpaca paper/live integration
background workers
```

Routine deployment summary:

```bash
ssh root@srv1700402.hstgr.cloud
cd /opt/ai-trader
git pull origin main
docker compose -f docker-compose.prod.yml build backend caddy
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
docker compose -f docker-compose.prod.yml up -d
```

Use the detailed [Production Deployment Checklist](docs/production/deployment.md) for the full workflow and smoke tests.

---

## 🔑 Authentication summary

```text
Signal API key
  Used by n8n and automation clients.
  Limited to signal/client routes.

User session bearer token
  Used by the web UI after human login.
  Platform roles select the application surface, permissions select console features,
  and memberships determine Trading Account scope.

Static admin API key
  Owner-equivalent maintenance key for trusted admin/API operations.
  Not for n8n.
```

---

## 🧪 Production smoke-test baseline

After production deploys, verify:

```text
/health returns ok
System Owner login works
/api/auth/me returns user and access.platformRole = SYSTEM_OWNER
Users & Access loads
Create Invite opens
Account User login lands on /portal
Account User cannot access admin console pages
Dashboard / Trading Accounts / Settings load for system owner
n8n signal smoke test passes
```

Automated trading should only be enabled deliberately after production health, broker mode, runtime settings, and n8n behavior are verified.



## 📚 Documentation

### Start here:

[docs/README.md](docs/README.md)

### Architecture:

- [Risk & Safety](docs/architecture/risk-and-safety.md)
- [Trading Lifecycle](docs/architecture/trading-lifecycle.md)
- [Worker Health](docs/architecture/workers.md)

### Integrations:

- [n8n Integration](docs/integrations/n8n.md)
- [Alpaca Integration](docs/integrations/alpaca.md)

### Production:

- [Production Deployment](docs/production/deployment.md)
- [Production Workflow](docs/production/production-workflow.md)
- [Database Migrations](docs/production/database-migrations.md)
- [Troubleshooting](docs/production/troubleshooting.md)

### Access Contol / RBAC
- [Access Control & RBAC](docs/security/README.md)


## 🔌 Key API Areas

Primary API areas include:

- signal ingestion
- tracked positions
- trade cycles
- trade performance
- entry decisions
- subscriptions
- securities
- strategies
- exit profiles
- settings
- system status
- market diary
- trading accounts
- account snapshots
- broker activity
- system events

Detailed API notes live in /docs/api as the project grows.

## 🧪 Current Operating Posture

The backend is designed for hosted paper-production testing before live trading.

Default production posture should remain conservative:

- tradingEnabled=false
- paperMode=true
- killSwitchEnabled=false
- ALLOW_LIVE_TRADING=false
- ALLOW_TRADING_ENABLED_ON_START=false

Automated paper trading should only be enabled deliberately after confirming:

- backend health
- database migration status
- broker mode alignment
- web UI status
- Alpaca API Usage status
- n8n dry-run behavior
- risk settings
- open/closing tracked positions
- pending/submitting order counts

## 🗺️ Roadmap

The backend is currently focused on hosted paper-production testing, operational safety, and improving confidence in the full signal → order → tracked position → exit lifecycle.

### 🔜 Next Backend Enhancements

- (no current near term goals)

### 🧭 Longer-Term

- Replace more Google Sheet state with database-backed market memory.
- Add historical audit dashboard.
- Add AI-assisted profit-protection workflows.
- Add multi-account support.
- Add live-trading deployment checklist and approval workflow.

## 📝 Documentation Rule

This root README is the project front door.

Detailed operational instructions, troubleshooting notes, API contracts, architecture explanations, and production runbooks should live in /docs.

When adding new documentation:

- keep the root README short
- prefer task-specific docs under /docs
- avoid duplicating long command blocks
- link to the source doc instead of copying it
- use icons on ## headings for scannability
