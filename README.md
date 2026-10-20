# AI Trader Backend

Live entry safety uses explicit revision-bound one-shot arming. An effective ENTRY approval is not armed authority, and an ACTIVE account is not necessarily entry-armed. See `docs/architecture/live-entry-arming.md`.

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
- Dedicated strategy management with owner-only enabled-state changes
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
ACCOUNT_USER -> shared role-aware web application with membership-scoped accounts
```

Owners can invite users from **System → Users & Access**. Invite links are one-time setup links. Until email delivery exists, owners copy setup links manually.

For the full model, see [Access Control & RBAC](docs/security/README.md).


## 🖥️ Web UI experiences

The React UI is one shared role-aware application for all human roles.

### Shared web application

System owners can access the full operational console. Operators see the subset allowed by their Platform Permissions:

- Dashboard
- Trading Accounts
- Entry Decisions
- Lifecycle Exercises (System Owner, Paper-only)
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

Account Users enter at `/dashboard` and use the same shell, routes, and account-facing components. Centralized role-aware policies limit their navigation to membership-scoped, read-only destinations:

- Dashboard
- My Accounts
- Positions
- Orders
- Trade History

Account Users cannot change settings, manage users, provision accounts, place orders, cancel orders, close positions, trigger broker syncs, or access unauthorized operational or administration routes.

## 🧯 Production safety layer

The backend includes a centralized entry-risk gate that sits between signal/order creation and broker submission. It answers one question:

```text
Even if this signal is valid, is the system allowed to enter this trade right now?
```

Entry orders are blocked when runtime safety, account, subscription, symbol, strategy, exit-profile, exposure, or session checks fail.

Important production controls:

```text
tradingEnabled=false                    -> account-level automated trading shutdown
killSwitchEnabled=true                  -> account-level entry pause while lifecycle work continues
ALLOW_LIVE_RISK_REDUCING_WRITES=false  -> blocks Live close/protective writes
ALLOW_LIVE_TRADING=false                -> blocks Live entry writes
LIVE_WRITE_DEPLOYMENT_ROLE=OBSERVATION_ONLY -> blocks every Live broker write
PAPER_BROKER_WRITE_DEPLOYMENT_ROLE=OBSERVATION_ONLY -> blocks every PAPER broker write
PAPER_BROKER_WRITE_AUTHORIZATIONS=[] -> exact broker-account and credential-fingerprint pairs for a PAPER_EXECUTOR
```

`TradingAccount.status=ACTIVE` means the service operationally manages the
account; it does not mean entries are armed. A Live account may be
`ACTIVE / tradingEnabled=false / killSwitchEnabled=true` while risk-reducing
authorization remains available. New Live exposure additionally requires the
deployment flags, effective account approvals, entry-enabled assignment, and
global runtime controls.

Externally supplied accepted `EntryDecision` rows are source/decision telemetry.
They are not proof that an executable Live broker entry was authorized.

Live entry writes require both Live environment permissions. This prevents the
system from opening Live exposure unless it is also authorized to reduce or
close that exposure.

For trading safety design, see [Risk & Safety](docs/architecture/risk-and-safety.md).

For strategy ownership, independent enablement controls, audit behavior, and the
controlled momentum pilot, see
[Strategy Management](docs/architecture/strategy-management.md).

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
  app/
    app.ts                Express app setup
    server.ts             HTTP server + worker startup
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
npm test
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

Production changes follow the conservative workflow and verification procedures in:

- [Production Deployment](docs/production/deployment.md)
- [Production Workflow](docs/production/production-workflow.md)
- [Database Migrations](docs/production/database-migrations.md)
- [Troubleshooting](docs/production/troubleshooting.md)


## ⚙️ Background workers

The backend runs workers for:

- pending order processing
- broker order synchronization
- tracked-position synchronization
- exit evaluation
- account snapshots
- broker activity/fill imports
- worker health reporting

Workers use multi-account coordinators that process eligible Trading Accounts in
stable ID order and isolate account failures. Account workflows persist
`TradingAccountWorkerHealthState` and use PostgreSQL advisory locks held for the
entire workflow to prevent cross-process overlap.


## 🚀 Local validation

Before committing backend/web app changes:

```bash
npm run check
npm test
npm run build
cd apps/web
npm run lint
npm test
npm run build
cd ../..
```

If the update includes Prisma changes, generate and commit the migration locally, then deploy with `prisma migrate deploy` in production.


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
Account User login lands on /dashboard
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
- [Trading Lifecycle Exercises](docs/architecture/trading-lifecycle-exercises.md)
- [Worker Health](docs/architecture/workers.md)
- [Market Data, Trend Calibration and TREND_V1 Publication](docs/architecture/market-data-trend.md)
- [Web Console Responsive Design](docs/architecture/web-console-responsive-design.md)
- [Web Console TradingAccount Scope](docs/architecture/web-console-account-scope.md)
- [Development Documentation Index](docs/development/README.md)
- [Market-Regime Research](docs/development/README.md#research-evidence) — historical calibration evidence; no runtime or trading authority.
- [TREND_V1 Production and Acceptance](docs/production/trend-v1.md)
- [VOLATILITY_V1 Production and Acceptance](docs/production/volatility-v1.md)
- [BREADTH_V1 Production and Acceptance](docs/production/breadth-v1.md)
- [PARTICIPATION_V1 Production Publication](docs/production/participation-v1.md)
- [INTRADAY_STRESS_V1 Production and Acceptance](docs/production/intraday-stress-v1.md)
- [Trading Reference-Price Operations](docs/production/trading-reference-price.md)

### Integrations:

- [n8n Integration](docs/integrations/n8n.md)
- [External Signal Ingestion, Authority and Routing (evidence only)](docs/integrations/external-signals.md)
- [Alpaca Integration](docs/integrations/alpaca.md)

### Production:

- [Production Deployment](docs/production/deployment.md)
- [Production Workflow](docs/production/production-workflow.md)
- [Database Migrations](docs/production/database-migrations.md)
- [Troubleshooting](docs/production/troubleshooting.md)

### Access Control / RBAC
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

## 🧪 Live-trading implementation status

The application implements explicit Live activation, revision-bound
`RISK_REDUCING` and `ENTRY` approvals, one-shot entry arming, durable acceptance-run
APIs, and the first-canary workflow. Implemented capability does not imply that any
particular production account is currently provisioned, activated, armed, or permitted
to trade.

Live entry remains fail-closed behind deployment permissions, current readiness
evidence, account approvals, an exact armed assignment, runtime controls, and
transactional one-shot consumption at the broker boundary. See:

- [Risk and Safety](docs/architecture/risk-and-safety.md)
- [Live Entry Arming](docs/architecture/live-entry-arming.md)
- [Live Entry Acceptance](docs/architecture/live-entry-acceptance.md)
- [Production Deployment](docs/production/deployment.md)

## 📝 Documentation Rule

This root README is the project front door.

Detailed operational instructions, troubleshooting notes, API contracts, architecture explanations, and production runbooks should live in /docs.

When adding new documentation:

- keep the root README short
- prefer task-specific docs under /docs
- avoid duplicating long command blocks
- link to the source doc instead of copying it
- use icons on ## headings for scannability
