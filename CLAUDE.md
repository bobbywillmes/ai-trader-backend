# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Backend (root):**
```bash
npm run dev          # Start backend with tsx watch (hot reload)
npm run build        # Compile TypeScript to dist/
npm run check        # Type-check without emitting
npm run start        # Run compiled production server
npm run dev:tunnel   # Start ngrok tunnel for local n8n access
```

**Admin UI (`apps/admin-ui/`):**
```bash
npm run dev          # Vite dev server on port 5173
npm run build        # Production build
npm run lint         # ESLint
```

**Database:**
```bash
docker compose up -d              # Start PostgreSQL (required before dev)
npx prisma migrate dev            # Apply migrations
npx prisma generate               # Regenerate Prisma client after schema changes
npx tsx src/db/seed.ts            # Seed initial data
```

There are no automated tests in this repository.

## Architecture

### Overview

This is a Node.js/Express backend that bridges automation signals (from n8n) to the Alpaca brokerage API. It manages the full order lifecycle: receiving signals → creating order intents → submitting to Alpaca → tracking positions → evaluating exit conditions.

The Admin UI (`apps/admin-ui/`) is a separate React/Vite app that communicates with the backend over HTTP using an admin bearer token session.

### Authentication (Dual-Key System)

Two API keys control access:
- **Signal Key** (`AI_TRADER_SIGNAL_API_KEY`): For automation clients (n8n). Can submit entry signals and read open positions only.
- **Admin Key** (`AI_TRADER_ADMIN_API_KEY`): Full access. Also used to bootstrap and authenticate admin UI sessions.

Middleware lives in `src/middleware/`. Admin UI sessions use bearer tokens stored in `AdminSession`.

### Order Lifecycle (Async Two-Phase)

1. **API phase**: `POST /api/signals/entry` or `POST /api/orders` creates an `OrderIntent` with status `pending` and returns immediately.
2. **Worker phase**: `src/workers/order.worker.ts` polls every 2 seconds, picks up `pending` intents, submits to Alpaca, creates a `BrokerOrder`, and advances status to `submitted`.
3. **Sync phase**: Same worker syncs `submitted` orders against Alpaca and advances to `filled`, `cancelled`, etc.
4. **Exit phase**: `src/services/exit-evaluator.service.ts` polls every 2 seconds, evaluates open positions against their `ExitProfile`, and auto-closes when conditions are met.

Order statuses: `received → pending → submitted → filled` (or `blocked` / `duplicate` / `rejected`).

### Subscription Model

A `Subscription` links a `Strategy` + `ExitProfile` + ticker symbol together with sizing rules. Entry signals reference a subscription key — the backend resolves the strategy, sizing, and exit rules from there. This is the central domain model; most business logic routes through it.

### Key Service Boundaries

| Layer | Location | Purpose |
|---|---|---|
| Routes | `src/routes/` | Express routers, one file per resource |
| Controllers | `src/controllers/` | Request parsing, response shaping |
| Services | `src/services/` | All business logic |
| Integrations | `src/integrations/alpaca/` | Alpaca HTTP client + normalizers |
| Workers | `src/workers/` | Background polling loops |

Services are the authoritative layer. Controllers should stay thin.

### Background Workers

Four continuous 2-second loops run on server startup:
1. Order processing (intent → Alpaca submission)
2. Order sync (Alpaca status → intent status)
3. Position tracking (`src/services/position-tracking.service.ts` — syncs Alpaca positions to `TrackedPosition`)
4. Exit evaluation (`src/services/exit-evaluator.service.ts` — evaluates open positions against exit profiles)

### System Events

All significant state transitions are written to `SystemEvent` via `src/services/system-event.service.ts`. This is the audit log — use it for debugging and tracing order/position lifecycle.

### Admin UI

React 19 + Vite at `apps/admin-ui/`. Uses TanStack Query for all server state. Feature code lives under `src/features/` organized by domain (subscriptions, exitProfiles, etc.). The app connects to the backend on port 3000; the session token is persisted in localStorage.

### Environment

Key `.env` variables:
```
DATABASE_URL=postgresql://trader:traderpass@localhost:5432/ai_trader
ALPACA_BASE_URL=https://paper-api.alpaca.markets  # or live URL
ALPACA_API_KEY / ALPACA_API_SECRET
AI_TRADER_SIGNAL_API_KEY
AI_TRADER_ADMIN_API_KEY
```

The Prisma schema is the source of truth for the database model (`prisma/schema.prisma`). Always run `npx prisma generate` after schema changes.
