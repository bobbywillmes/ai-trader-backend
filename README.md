# AI Trader Backend

Backend service for the AI Trader system.

This project is the control layer between the n8n market scanner and Alpaca broker. n8n is responsible for market scanning and signal generation. The backend is responsible for risk-gate enforcement, signal/subscription/order resolution, order intent logging, broker submission, tracked position lifecycle management, exit evaluation, account snapshots, broker activity imports, runtime trading controls, and production audit visibility.

The design goal is simple:
- n8n watches the market and decides when to buy
- The backend decides whether it is allowed, and how much to buy
- Alpaca executes approved broker orders
- The backend records the full position lifecycle


## 🧭 System Overview

Current backend-driven AI Trader flow:

```text
n8n:
→ POST to /api/signals/entry
Backend:
→ Receive signal from n8n (Subscription resolution)
→ Risk Gate / Kill Switch / Entry Limits
→ OrderIntent
→ Async Order Worker
→ BrokerOrder / Alpaca
→ BrokerActivity fill import
→ TrackedPosition
→ ExitProfile-driven exit evaluation
→ AccountSnapshot / SystemEvent audit trail
```

The backend is designed so n8n does not talk directly to Alpaca. n8n watches the market & sends signals at the right time. The backend handles all of the heavy-lifting, business/broker logic.

## ⚒️ Core Responsibilities

The backend currently handles:
- Signal ingestion from n8n
- Subscription-driven order resolution
- Centralized entry risk-gate enforcement
- Runtime trading controls
- Paper/live broker mode validation
- Alpaca order submission
- Internal tracked position lifecycle management
- Exit profile evaluation
- Broker-confirmed fill imports
- Account snapshot history
- System event audit logging
- Admin UI authentication and controls
- Production readiness checks

## 🧱 Tech Stack
- Node.js
- TypeScript
- Express
- PostgreSQL
- Prisma
- Docker Compose
- Alpaca Trading API
- React / Vite admin UI
- Mantine
- TanStack Query

## 📁 Project Structure
```
apps/
  admin-ui/               React admin UI

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

Start the admin UI:

```bash
cd apps/admin-ui
npm install
npm run dev
```

## ✅ Common Validation Commands

From the repo root:

```bash
npm run check
npm run build
```
Build the admin UI:

```bash
cd apps/admin-ui
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
→ verify admin UI
→ verify n8n behavior
```
For more about production workflow, see:
[Production Workflow](docs/production/production-workflow.md)

## 📚 Documentation

### Start here:

[docs/README.md](docs/readme.md)

### Architecture:

- [Risk & Safety](docs/architecture/risk-and-safety.md)
- [Trading Lifecycle](docs/architecture/trading-lifecycle.md)

### Integrations:

- [n8n Integration](docs/integrations/n8n.md)

### Production:

- [Production Deployment](docs/production/deployment.md)
- [Production Workflow](docs/production/production-workflow.md)
- [Database Migrations](docs/production/database-migrations.md)
- [Troubleshooting](docs/production/troubleshooting.md)


## 🔌 Key API Areas

Primary API areas include:

- signal ingestion
- tracked positions
- subscriptions
- securities
- strategies
- exit profiles
- settings
- system status
- market diary
- account snapshots
- broker activity
- system events

Detailed API notes should live in /docs/api as the project grows.

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
- admin UI status
- n8n dry-run behavior
- risk settings
- open/closing tracked positions
- pending/submitting order counts

## 🗺️ Roadmap

The backend is currently focused on hosted paper-production testing, operational safety, and improving confidence in the full signal → order → tracked position → exit lifecycle.

### 🔜 Next Backend Enhancements

- Add more precise close-fill linking between close orders and broker activities.
- Add order/position reconciliation checks.
- Add historical performance reports by:
  - strategy
  - subscription
  - exit profile
  - security
- Add account equity/exposure trend charts from `AccountSnapshot`.
- Add broker activity drill-down pages.

### 🧭 Longer-Term

- Replace more Google Sheet state with database-backed market memory.
- Expand Market Diary analytics and decision-review workflows.
- Add websocket trade update listener.
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