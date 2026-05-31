# AI Trader Backend

Backend service for the n8n AI Trader system.

This project is the broker/control layer between the AI Trader workflow, the admin UI, and Alpaca paper trading. n8n handles strategy signal generation. This backend handles broker communication, subscription resolution, risk-gate enforcement, order intent logging, broker order submission, position tracking, exit evaluation, account snapshots, broker activity imports, runtime trading configuration, admin controls, and audit logging.

The design goal is that automation clients such as n8n do **not** talk directly to Alpaca. n8n decides what it wants to do. The backend decides whether that request is allowed, records the intent, submits approved orders to Alpaca, tracks the resulting position, imports broker-confirmed activity, and records the account/audit trail.

---

## 🔹 Overview

AI Trader Backend is an event-driven trading engine that:

- Accepts external trade signals from n8n or API clients
- Resolves those signals through configured subscriptions
- Enforces runtime safety and entry-risk rules
- Executes approved trades through Alpaca
- Tracks broker positions internally
- Automatically manages exits based on configurable exit profiles
- Imports broker-confirmed fill activity
- Records account snapshots and internal system events
- Provides an admin UI for monitoring, configuration, and production readiness checks

Current stack:

- Node.js
- TypeScript
- Express
- PostgreSQL
- Prisma
- Docker Compose
- Alpaca Trading API
- React / Vite admin UI
- TanStack Query

---

## 💡 Big Picture Architecture

Original algo trading stack:

```text
TradingView strategies → TradersPost → E*TRADE
```

Current backend-driven AI Trader stack:

```text
n8n
  → POST /api/signals/entry
  → Subscription resolution
  → Risk Gate / Kill Switch / Entry Limits
  → OrderIntent
  → Async Order Worker
  → BrokerOrder / Alpaca
  → BrokerActivity fill import
  → TrackedPosition
  → ExitProfile-driven exit evaluation
  → AccountSnapshot / SystemEvent audit trail
```

The backend resolves the subscription, validates runtime config and entry-risk rules, determines sizing, logs the order intent, submits approved orders to Alpaca, tracks the resulting position, imports broker-confirmed fills, records account snapshots, and manages exits.

---

## ⚒️ Core Responsibilities

The backend currently handles:

- Fetching Alpaca account details
- Fetching open positions
- Fetching open orders
- Returning combined bootstrap/status payloads for the admin UI
- Accepting n8n entry signals
- Resolving subscription-driven trade requests
- Enforcing symbol, subscription, strategy, exit profile, and runtime risk controls
- Enforcing `tradingEnabled`
- Enforcing `killSwitchEnabled`
- Enforcing daily/order/exposure risk limits
- Logging order intents before broker submission
- Submitting approved orders to Alpaca asynchronously
- Logging broker order responses
- Importing broker-confirmed `FILL` activities from Alpaca
- Tracking positions internally
- Evaluating exits using linked exit profiles
- Recording account snapshots
- Recording internal system events
- Providing admin authentication and admin UI controls

Key features:

- Subscription-driven order execution
- Strategy + exit profile bound at entry
- Securities registry with symbol-level trading enable/disable controls
- Centralized entry risk gate
- Runtime kill switch for entry-only pauses
- Account snapshot audit trail
- Broker activity/fill ledger
- System Status card for production readiness checks
- Curated Dashboard activity feed separate from the full audit log

---

## ⚒️ Core Data Flow

The system is structured around **subscription-driven trading**.

### Entry Flow

1. n8n sends a signal to `POST /api/signals/entry`.
2. The backend resolves the signal through a `Subscription`.
3. The subscription links the request to:
   - Security
   - Strategy
   - ExitProfile
   - Sizing rule
   - Broker/broker mode
4. The risk gate validates whether the entry is allowed.
5. The backend creates an `OrderIntent`.
6. The async order worker atomically claims the pending intent.
7. The worker submits the order to Alpaca using the stable `clientOrderId` stored on the `OrderIntent`.
8. The broker order response is stored as `BrokerOrder`.
9. Broker/order sync updates status transitions.
10. Broker activity sync imports Alpaca `FILL` activity.
11. Position sync creates or updates `TrackedPosition`.
12. Account snapshots and system events record the lifecycle.

### Position Tracking Flow

1. Positions are pulled from Alpaca.
2. The sync service matches the latest filled `OrderIntent` when possible.
3. The position is stored as `TrackedPosition` with:
   - security link
   - subscription link
   - quantity
   - average entry price
   - current price
   - market value
   - cost basis
   - unrealized P/L
   - status
   - raw broker position JSON
4. Reads include linked subscription, strategy, and exit profile context.

### Position Lifecycle Management

Open positions are tracked in the internal `TrackedPosition` table. The sync worker mirrors broker positions and uses guarded state transitions so lifecycle events are not emitted twice when worker ticks overlap.

Relevant routes:

```http
GET /api/tracked-positions
GET /api/tracked-positions/open
DELETE /api/positions/:symbol
```

`DELETE /api/positions/:symbol` requests a broker close. The sync loop confirms the position is closed and emits `position.closed` only after the tracked position successfully transitions from `open` or `closing` to `closed`.

---

## 🛡 Production Safety Layer

The backend includes a centralized entry-risk gate that sits between signal/order creation and broker submission.

The risk gate answers one question:

```text
Even if this signal is valid, is the system allowed to enter this trade right now?
```

Entry orders are blocked when any of the following conditions apply:

- Global automated trading is disabled.
- Kill switch is active.
- Broker account is trading blocked.
- Runtime broker mode does not match the connected Alpaca mode.
- Security is disabled.
- Subscription is disabled.
- Strategy is disabled.
- Exit profile is disabled.
- Symbol already has an open or closing tracked position.
- Daily entry order limit has been reached.
- Daily entry notional limit would be exceeded.
- Maximum open position count would be exceeded.
- Total open notional limit would be exceeded.
- Per-symbol exposure limit would be exceeded.
- Per-subscription exposure limit would be exceeded.

### Trading Enabled vs Kill Switch

`tradingEnabled` is the global master switch for automated order submission.

When `tradingEnabled = false`, the backend broadly rejects automated trading requests even if securities, subscriptions, strategies, and exit profiles are enabled.

`killSwitchEnabled` is an entry-only pause.

When `killSwitchEnabled = true`, the system stays online for monitoring, syncing, position tracking, exit workflows, reports, and admin visibility, but new buy-side entries are blocked.

This gives two levels of production control:

```text
Trading Enabled Off
  = broad automated trading shutdown

Kill Switch On
  = stop opening new positions, but keep the system awake
```

### Entry Risk Settings

Runtime risk settings are stored in the `Setting` table and managed from the admin UI Settings page.

Current runtime risk settings:

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

---

## ⚙️ Background Workers

The system runs several background workers to keep broker state, internal state, and audit records synchronized.

### Trading Worker Loop

Runs approximately every 2 seconds.

This loop is guarded to prevent overlapping worker ticks.

It performs:

1. Pending order processing
2. Submitted order synchronization
3. Tracked position synchronization
4. Exit evaluation

The order worker uses an atomic `pending → submitting` claim step before calling Alpaca. This prevents overlapping worker ticks from submitting the same `OrderIntent` more than once.

The position sync worker uses guarded state transitions so lifecycle events such as `position.opened` and `position.closed` are emitted only when the worker successfully transitions the tracked position state.

### Account Snapshot Worker

Runs on a slower checkpoint schedule.

Scheduled snapshots are recorded around major trading-day checkpoints:

```text
scheduled_morning
scheduled_midday
scheduled_after_close
```

Account snapshots are also recorded after meaningful lifecycle events:

```text
position_opened
position_closed
manual
```

Scheduled snapshots are skipped when the account state has not changed. Event/manual snapshots can be forced because they represent meaningful trading context.

### Broker Activity Worker

Runs separately from the fast trading loop.

It imports broker-confirmed Alpaca account activities, starting with `FILL` events. Imported broker activities are stored idempotently by Alpaca activity ID.

This creates a durable broker-confirmed ledger separate from internal app events.

---

## ⚙️ Exit Evaluation Engine

The backend includes a real-time exit evaluation system that continuously monitors open positions and executes exits based on configured rules.

### How It Works

1. Background loop fetches all open tracked positions.
2. Each position is joined with its subscription, strategy, and exit profile.
3. Exit conditions are evaluated.
4. If an exit is triggered, the backend requests a broker close and emits audit events.
5. Position sync confirms the close and records final lifecycle activity.

Supported exit modes include:

- Fixed target
- Fixed target + fixed stop
- Trailing stop after target
- Max hold days
- Reserved AI-assisted exit profile

Example flow:

```text
Position Opened → Market Moves → Exit Condition Hit → Close Requested → Position Closed
```

Key file:

```txt
src/services/exit-evaluator.service.ts
```

---

## ⚙️ Production Audit Layer

The backend separates audit records into distinct models with different responsibilities.

### OrderIntent

Represents what the app intended to do.

Every accepted or blocked order request creates an `OrderIntent` before broker submission.

### BrokerOrder

Represents the broker order created by Alpaca.

Broker orders are linked back to `OrderIntent` and `Security`.

### BrokerActivity

Represents what Alpaca says actually happened.

The first supported activity type is Alpaca `FILL`.

Broker activities are imported from Alpaca and stored idempotently by Alpaca activity ID. This makes the broker activity table the durable broker-confirmed execution ledger.

### AccountSnapshot

Represents what the account looked like at a point in time.

Snapshots include:

- cash
- buying power
- equity
- portfolio value
- day P/L
- broker mode
- account status
- trading blocked status
- reason
- changed flag
- snapshot hash

Common reasons:

```text
manual
scheduled_morning
scheduled_midday
scheduled_after_close
position_opened
position_closed
```

### SystemEvent

Represents significant internal state transitions.

Examples:

```text
order.new
order.filled
position.opened
position.close_requested
position.closed
risk_gate.blocked
broker_activity.synced
subscription.enabled
subscription.disabled
```

System Events are the full internal audit log.

### Dashboard vs Reports vs System Events

The admin UI intentionally separates these views:

```text
Dashboard
  Curated operational summary

Reports
  Account snapshots and broker-confirmed activity ledger

System Events
  Full internal audit log
```

The dashboard hides noisy/internal events such as broker activity syncs and low-level order status transitions. Reports and System Events remain complete audit views.

---

## 📂 Project Structure

```txt
src/
  app/
    app.ts
    server.ts
  config/
  controllers/
  db/
  errors/
  integrations/
    alpaca/
  middleware/
  routes/
  services/
  types/
  validators/
  workers/

apps/
  admin-ui/

prisma/
  migrations/
  schema.prisma
  securities.json
```

Relevant data files:

```txt
prisma/securities.json
```

Static seed data for the tradable security universe.

```txt
src/types/securities.ts
```

Shared TypeScript types for imported security seed data.

---

## ➡️ Request Flow

The Express app follows this general pattern:

```text
server.ts → app.ts → routes → controllers → services → database and/or Alpaca integration adapters
```

### `server.ts`

`server.ts` creates the Express app, starts the HTTP server, and starts background workers.

### `app.ts`

`app.ts` builds the main Express application. It wires in:

- security middleware
- JSON parsing
- request logging
- top-level routes
- 404 handler
- central error handler

Example route mounting:

```ts
app.use('/health', healthRoutes);
app.use('/api/bootstrap', requireAdminAccess, bootstrapRoutes);
app.use('/api/system-status', requireAdminAccess, systemStatusRoutes);
app.use('/api/account', requireAdminAccess, accountRoutes);
app.use('/api/orders', requireAdminAccess, ordersRoutes);
```

### Controllers

Controllers handle the HTTP request/response layer. They parse params/body, call services, and return JSON responses. Controllers should not contain broker logic or database-heavy business logic.

### Services

Services hold the business logic.

Examples:

- `place-order.service.ts` resolves and creates order intents.
- `risk-gate.service.ts` enforces entry safety rules.
- `order.worker.ts` submits pending orders and syncs order status.
- `position-tracking.service.ts` syncs broker positions into tracked positions.
- `account-snapshot.service.ts` records account snapshots.
- `broker-activity.service.ts` imports Alpaca fill activity.
- `config.service.ts` loads runtime settings from PostgreSQL.
- `bootstrap.service.ts` gathers account, positions, open orders, config, and risk state.
- `system-status.service.ts` gathers production readiness status.

### Integrations

The `src/integrations/alpaca` folder isolates Alpaca-specific code. The backend normalizes Alpaca responses before returning them to n8n, the admin UI, or future clients.

---

## 🔐 API Authentication

The backend supports two broad access paths:

1. Signal API key access for automation clients such as n8n.
2. Admin access through either an admin API key or admin login/session bearer token.

### Signal API Key

The signal key is intended for automation clients such as n8n.

This key can:

- Submit entry signals
- Read current open tracked positions

This key cannot:

- Modify runtime config/settings
- Modify securities
- Create or edit strategies
- Create or edit subscriptions
- Create or edit exit profiles
- Place manual/admin orders
- Close positions manually
- View full admin history

### Admin Access

Admin access is intended for the web admin UI, Postman, and manual control.

Admin access can manage:

- Runtime config/settings
- Securities
- Strategies
- Exit profiles
- Subscriptions
- Manual order placement
- Position close actions
- Full position history
- Order intent history
- System event history
- Account snapshots
- Broker activity sync
- System status

### Admin Authentication & Sessions

The backend supports admin login sessions for the web admin UI.

Admin authentication is separate from the signal API key system:

- n8n uses the signal API key.
- Admin tools may use an admin API key or an admin session token.
- The web admin UI uses admin login sessions.

Admin users are stored in `AdminUser`. Admin sessions are stored in `AdminSession`. Passwords are stored as hashes, not plaintext.

#### First Admin Bootstrap

```http
POST /api/admin-auth/bootstrap
```

Creates the first admin account. Once an admin user exists, bootstrap is blocked.

#### Login

```http
POST /api/admin-auth/login
```

Successful login returns a bearer token that the admin UI stores locally and sends through:

```http
Authorization: Bearer <token>
```

#### Current Admin Session

```http
GET /api/admin-auth/me
```

Returns the current admin user and session when the token is valid.

#### Logout

```http
POST /api/admin-auth/logout
```

Revokes the active admin session.

---

## 💻 Admin UI

The admin UI provides a browser-based control panel for monitoring and managing the AI Trader backend.

Current admin sections include:

- Dashboard
- Open Positions
- Open Orders
- Subscriptions
- Exit Profiles
- Securities
- Reports
- System Events
- Settings
- Legacy Admin

### Dashboard

The Dashboard provides a curated live overview:

- portfolio value
- day P/L
- cash
- buying power
- open positions
- open orders
- curated recent activity

Recent Activity is intentionally not a raw mirror of System Events. It focuses on meaningful operational events such as:

- position opened
- position closed
- close requested
- risk/order blocks
- subscription enabled/disabled

### Reports

The Reports page provides production audit visibility:

- latest account snapshot summary
- account snapshot history
- broker activity / fills table
- manual account snapshot button
- manual broker fill sync button

### Settings

The Settings page manages runtime trading configuration and production status.

It includes:

- System Status card
- Trading Controls
- Entry Risk Limits
- Admin password management

The System Status card shows:

- app/database health
- broker mode alignment
- worker/order counts
- open/closing position counts
- environment/config readiness checks
- latest account snapshot
- latest broker activity

Trading Controls include:

- Automated Trading
- Kill Switch
- Paper Trading Mode

Entry Risk Limits include:

- max daily entry orders
- max daily entry notional
- max open positions
- max total open notional
- max symbol open notional
- max subscription open notional

Changed risk settings are visually highlighted before save, and the Save button is enabled only when there are unsaved changes.

### Securities Control Panel

The Securities section manages the full symbol registry used by the trading system.

The registry currently supports 500+ securities and is designed to act as the main control panel for expanding, configuring, and disabling securities for trading.

The Securities list includes:

- server-side pagination
- configurable rows per page
- server-side search by symbol or company name
- server-side filtering by asset type, sector, industry, security status, and subscription configuration status
- connected Sector → Industry filtering
- server-side sorting
- URL-persisted table state
- summary dashboard cards
- subscription count column
- security detail pages

Each security has a detail page at:

```txt
/securities/:symbol
```

The security detail page includes:

- Security metadata
- Security-level trading enable/disable control
- Related subscriptions
- Subscription creation modal
- Subscription editing modal
- Subscription enable/disable controls
- Toast notifications
- Recent activity timeline based on system events

The security-level enable/disable control acts as a master trading lockout for that symbol. When a security is disabled, new buy/order-entry flow is blocked for that symbol. This does not prevent order cancellation or future sell/close-position behavior.

---

## 🏗 Production Deployment Workflow

The hosted production-like environment runs on Hostinger VPS using Docker Compose.

Current production stack:

```text
Hostinger VPS
  → Caddy reverse proxy / HTTPS
  → React admin UI static build
  → Node/Express backend
  → PostgreSQL
  → Prisma migrations
  → Alpaca paper trading integration
  → background workers
```
Current production URL pattern:

```http
https://srv1700402.hstgr.cloud/        → Admin UI
https://srv1700402.hstgr.cloud/health  → Public health check
https://srv1700402.hstgr.cloud/api/*   → Backend API
```

The production environment is designed to support true hosted paper-production dry runs:

```text
Hosted n8n workflow
  → hosted AI Trader backend
  → hosted PostgreSQL
  → Alpaca paper account
  → Market Diary / System Events / Reports
  → hosted Admin UI visibility
```

### Production Safety Baseline
The first production startup should remain conservative:

```text
NODE_ENV=production
ALLOW_LIVE_TRADING=false
ALLOW_TRADING_ENABLED_ON_START=false
ALPACA_BASE_URL=https://paper-api.alpaca.markets
```
Runtime database settings should also remain conservative unless deliberately changed from the admin UI:

```text
tradingEnabled=false
paperMode=true
killSwitchEnabled=false
```

This means the backend can run in production, sync account state, read Alpaca paper positions, receive n8n dry-run context requests, and write Market Diary events without accepting automated order-entry activity.

### Local Development Workflow
Make changes locally first.

Recommended local validation before committing:
```bash
npm run check
npm run build

cd apps/admin-ui
npm run build
cd ../..
```

Then commit and push:
```bash
git add .
git commit -m "feat(scope): describe change"
git push origin main
```
Use conventional commit-style prefixes where practical:

```
feat(admin-ui): ...
feat(api): ...
fix(worker): ...
refactor(db): ...
docs: ...
chore(deploy): ...
```

### Production Deployment Workflow
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

Run Prisma migrations safely:
```bash
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
```

For backend-only changes, rebuild the backend:
```bash
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml up -d backend
```

For admin UI changes, rebuild Caddy because the React static build is bundled into the Caddy image:
```bash
docker compose -f docker-compose.prod.yml build caddy
docker compose -f docker-compose.prod.yml up -d caddy
```

For changes that touch both backend and admin UI:
```bash
docker compose -f docker-compose.prod.yml build backend caddy
docker compose -f docker-compose.prod.yml up -d
```

Check container status:
```bash
docker compose -f docker-compose.prod.yml ps
```

Check recent logs when needed:
```bash
docker compose -f docker-compose.prod.yml logs --tail=100 backend
docker compose -f docker-compose.prod.yml logs --tail=100 caddy
```

### Production Verification Checklist

After each production deploy, verify the public health endpoint:
```bash
curl -s https://srv1700402.hstgr.cloud/health
```
Expected result:
```text
ok=true
environment=production
database reachable
```
Then verify protected system status from the VPS:
```bash
set -a
source .env
set +a

curl -s https://srv1700402.hstgr.cloud/api/system-status \
  -H "ai-trader-api-key: $AI_TRADER_ADMIN_API_KEY"
```

Confirm:
```
environment=production
database reachable
broker mode=paper
tradingEnabled=false unless deliberately enabled
paperMode=true
killSwitchEnabled=false unless deliberately enabled
pendingOrderCount=0
submittingOrderCount=0
submittedOrderCount=0
```

Also verify from the browser:
```
Admin UI loads
Login works
Dashboard loads
Settings → System Status is healthy
Open Orders is empty unless expected
Market Diary loads
Recently changed feature works in production
```

### n8n Production Dry-Run Workflow

The hosted n8n workflow should use the production backend base URL:
```
https://srv1700402.hstgr.cloud
```

n8n should use the signal API key only:
```
ai-trader-api-key: AI_TRADER_SIGNAL_API_KEY
```

n8n should not use the admin API key.

The lean ETF watcher production dry-run should remain configured as:
```
DRY_RUN=true
FORCE_MARKET_OPEN_FOR_TESTING=false
```

Expected dry-run behavior:
```
n8n gets ETF watch context from backend
n8n pulls ETF snapshots
n8n decision engine evaluates candidates
n8n posts diary events to backend
backend stores Market Diary events
admin UI displays Market Diary results
no live order is submitted
```

Before enabling any real paper-order workflow, confirm the dry-run system has behaved correctly across multiple market sessions.

### Migration Notes

Use Prisma migration deploy in production:
```bash
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
```
Do not use development migration commands in production, such as:
```bash
npx prisma migrate dev
npx prisma migrate reset
```
Production data should be treated as durable, even while using Alpaca paper trading.

### Environment and Secrets

The production .env file lives only on the VPS:
```
/opt/ai-trader/.env
```
It should not be committed to GitHub.

Important production secrets include:
```
POSTGRES_PASSWORD
ALPACA_API_KEY
ALPACA_API_SECRET
AI_TRADER_SIGNAL_API_KEY
AI_TRADER_ADMIN_API_KEY
```
Generate strong random values for internal secrets, for example:
```bash
openssl rand -hex 32
```
The signal API key is for n8n and automation clients.

The admin API key is for protected admin HTTP requests and operational checks.

The admin UI login uses an admin email/password account created through:
```
POST /api/admin-auth/bootstrap
```
These are separate authentication paths.

### Production Operating Rule

The default production rule is:
```text
Deploy safely.
Verify health.
Verify system status.
Keep automated trading disabled.
Let n8n run dry.
Only enable paper trading deliberately.
```

---

## 🔌 n8n Integration Proof of Concept

The backend has been successfully tested with a small n8n proof-of-concept workflow that sends trading signals into the Node API and reads current open positions back from the backend.

This confirms that n8n can communicate with the local development backend through a public ngrok tunnel, using signal-level authentication that will later be used in production.

### What Was Tested

The proof-of-concept workflow includes:

1. Manual trigger node
2. Setup node storing backend URL and API key
3. Code node building a sample entry signal payload
4. HTTP Request node sending the signal to `POST /api/signals/entry`
5. Response parser node normalizing success/failure responses
6. HTTP Request node reading open tracked positions from `GET /api/tracked-positions/open`
7. Response parser node for open position results

### Local Development Tunnel

During local development, the backend can be exposed to n8n through ngrok.

Required environment variables:

```env
NGROK_AUTHTOKEN=your_ngrok_authtoken_here
NGROK_DOMAIN=your_ngrok_dev_domain_here
```

Start the tunnel:

```bash
npm run dev:tunnel
```

A normal local development session often uses two terminals:

```bash
npm run dev
npm run dev:tunnel
```

The ngrok URL is then used by n8n as the backend base URL.

### Signal-Level API Access

The n8n workflow uses the signal-level API key. This allows n8n to perform only signal/client-level actions, such as sending entry signals and reading current open positions.

Admin-level actions remain protected and are not exposed to the n8n signal workflow.

---

## 📈 Security Master / Symbol Registry

The backend uses `Security` as the canonical symbol registry.

A `Security` represents a tradable symbol known to the system, such as a stock, ETF, index, fund, or other instrument. This replaces the older `AllowedTicker` model.

Core fields:

- `symbol` — unique trading symbol, such as SPY, QQQ, AAPL
- `name` — display name / company or fund name
- `enabled` — controls whether the symbol is currently allowed for trading
- `assetType` — STOCK, ETF, INDEX, FUND, or OTHER
- `sector` — optional sector metadata
- `industry` — optional industry metadata

`Security` is linked to:

- `Subscription`
- `TrackedPosition`
- `BrokerOrder`

This allows the backend and admin UI to treat symbols as first-class records instead of loose string values.

---

## 💼 Asset-Class Trading Policy

The backend treats ETF and stock behavior separately. Asset type is stored on the `Security` model and is used to determine which strategy families are appropriate for a security.

### ETF Policy

ETFs are treated primarily as broad-market, index, or sector exposure trades.

Allowed ETF strategies:

- `dip_n_ride_etf`
- `momentum_etf`
- `quick_test_momentum`

ETF dip strategies can be more mechanical than single-stock dip strategies because ETFs do not carry the same company-specific earnings/news risk as individual stocks.

AI-confirmed dip subscriptions are not seeded for ETFs.

### Stock Policy

Stocks are treated as single-company trades and carry more company-specific risk.

Allowed stock strategies:

- `dip_n_ride_stock`
- `momentum_stock`
- `ai_confirmed_dip_stock`
- `quick_test_momentum`

Single-stock dip trades should account for:

- company-specific news
- earnings
- guidance changes
- analyst downgrades
- regulatory issues
- sector weakness
- broad-market weakness

The `ai_confirmed_dip_stock` strategy is an entry filter only. It does not mean the AI controls the exit.

### Policy Enforcement

The seed file validates that each seeded subscription uses a strategy allowed for that security's asset type.

Examples:

- ETFs may use `dip_n_ride_etf`.
- Stocks may use `dip_n_ride_stock`.
- Stocks may use `ai_confirmed_dip_stock`.
- ETFs may not use `ai_confirmed_dip_stock`.

---

## ❎ Exit Profile Hierarchy

Exit profiles define how a position is managed after entry.

They do not define:

- symbol
- broker
- account mode
- sizing
- entry thesis

Those concerns belong to securities, subscriptions, and strategies.

### ETF Dip Exits

- `exit_etf_dip_core_target` — Core ETF dip exit using a fixed recovery target.
- `exit_etf_dip_conservative_bracket` — Conservative ETF dip exit with fixed target and fixed stop.
- `exit_etf_dip_aggressive_trailing` — Aggressive ETF dip exit that allows trailing upside after the target behavior is satisfied.

### Target Unlocks Trailing Stop

Target-unlocks-trailing-stop profiles are ETF exit profiles where the initial profit target acts as an unlock threshold instead of a sell trigger.

For fixed-target exits:

```text
targetPct = close the position when this profit target is reached
```

For target-unlocks-trailing exits:

```text
targetPct = unlock threshold
trailingStopPct = native Alpaca trailing-stop percentage
```

The backend handles the unlock decision, then hands the trailing-stop order to Alpaca:

```text
Position opened
→ backend watches current P/L against targetPct
→ targetPct reached
→ backend marks the tracked position as trailingUnlocked
→ backend submits a native Alpaca trailing_stop sell order
→ Alpaca manages the high-water mark and stop price
→ backend syncs broker-reported trailing-stop status, HWM, and stop price
→ broker fill / position sync confirms the final close
```

This keeps the target-unlock decision inside the backend while letting the broker manage the active trailing stop after handoff. The backend stores the handoff and broker-sync state on `TrackedPosition`, including fields such as:

```text
trailingUnlocked
trailingUnlockedAt
trailingUnlockedPrice
trailingStopOrderId
trailingStopStatus
trailingStopTrailPercent
trailingStopHwm
trailingStopStopPrice
trailingStopLastSyncedAt
```

Current ETF target-unlock profiles include:

- `exit_etf_unlock_0_5_trail_0_25` — Unlock after +0.5%, then submit a 0.25% native trailing stop.
- `exit_etf_unlock_0_5_trail_0_5` — Unlock after +0.5%, then submit a 0.5% native trailing stop.
- `exit_etf_unlock_1_0_trail_0_5` — Unlock after +1.0%, then submit a 0.5% native trailing stop.
- `exit_etf_unlock_1_0_trail_0_75` — Unlock after +1.0%, then submit a 0.75% native trailing stop.
- `exit_etf_unlock_quick_test` — Non-production paper-test profile that unlocks after a tiny gain so the trailing-stop handoff can be validated quickly.

These profiles are intended to support the Dip N Ride idea more directly than a fixed target: recover from the dip, unlock broker-managed trailing protection, then allow the position to keep running until the trailing stop is hit.

### Stock Dip Exits

- `exit_stock_dip_core_target` — Core stock dip exit using a fixed recovery target.
- `exit_stock_dip_conservative_bracket` — Conservative stock dip exit with fixed target and fixed stop.
- `exit_stock_dip_aggressive_trailing` — Aggressive stock dip exit that allows trailing upside after the target behavior is satisfied.

### Momentum Exits

Momentum exits are production-intended, but momentum subscriptions are not enabled by default yet.

- `exit_etf_momentum_bracket`
- `exit_etf_momentum_trailing`
- `exit_stock_momentum_fail_fast`
- `exit_stock_momentum_trailing`

Failed momentum trades should not be averaged down.

### AI-Assisted Exit

- `exit_ai_assisted`

This profile is reserved for future AI-assisted exit decisions and is disabled by default. Current AI usage is limited to `ai_confirmed_dip_stock`, which is an entry-confirmation strategy, not an AI-managed exit.

### System Test Exit

- `exit_quick_test`

This is a non-production exit profile used to validate the full signal → order → position → exit lifecycle.

---

## ⚙️ Current API Endpoints

### Health

```http
GET /health
```

Public lightweight health check.

Returns:

- service name
- environment
- uptime
- database reachability
- timestamp

This endpoint is intended for deployment checks.

### System Status

```http
GET /api/system-status
```

Admin-protected production readiness endpoint.

Returns:

- health status
- environment/config readiness
- runtime trading config
- risk status
- worker counts
- open/closing tracked position counts
- latest account snapshot
- latest broker activity

This endpoint powers the Settings → System Status card.

### Bootstrap

```http
GET /api/bootstrap
```

Returns the main admin/dashboard bootstrap payload.

Includes:

- account summary
- positions
- open orders
- runtime config
- risk status

Example shape:

```json
{
  "account": {},
  "positions": [],
  "openOrders": [],
  "config": {
    "tradingEnabled": true,
    "paperMode": true,
    "killSwitchEnabled": false,
    "maxDailyEntryOrders": 5,
    "maxDailyEntryNotional": 5000,
    "maxOpenPositions": 5,
    "maxTotalOpenNotional": 10000,
    "maxSymbolOpenNotional": 5000,
    "maxSubscriptionOpenNotional": 5000
  },
  "risk": {
    "canEnter": true,
    "reasons": [],
    "broker": {
      "name": "alpaca",
      "mode": "paper",
      "expectedMode": "paper",
      "tradingBlocked": false
    },
    "limits": {},
    "usage": {}
  }
}
```

### Account

```http
GET /api/account
```

Fetches normalized Alpaca account details.

Important fields include:

- cash
- buying power
- equity
- portfolio value
- day P/L
- trading blocked status
- paper/live mode

### Account Snapshots

```http
GET /api/account-snapshots
GET /api/account-snapshots/latest
POST /api/account-snapshots/manual
```

Admin-protected account audit endpoints.

Account snapshots record account-level state such as cash, buying power, equity, portfolio value, day P/L, broker mode, and snapshot reason.

Manual snapshots are useful for debugging and production checkpoints.

### Broker Activities

```http
GET /api/broker-activities
GET /api/broker-activities/latest
POST /api/broker-activities/sync
```

Admin-protected broker activity endpoints.

The first supported broker activity type is Alpaca `FILL`.

Broker activities are used as the broker-confirmed execution ledger and can be filtered by symbol and activity type.

Example:

```http
GET /api/broker-activities?symbol=SPY&activityType=FILL&limit=20
```

### Securities

```http
GET /api/securities
GET /api/securities/:symbol
POST /api/securities
PATCH /api/securities/:symbol
```

The backend uses the `Security` model as the canonical symbol registry.

The primary securities list endpoint supports server-side pagination, filtering, sorting, and subscription counts.

Supported query params:

- `page`
- `pageSize`
- `search`
- `assetType`
- `sector`
- `industry`
- `enabled`
- `subscriptionStatus`
- `sortBy`
- `sortDirection`

Example:

```http
GET /api/securities?page=1&pageSize=50&sector=Information%20Technology&subscriptionStatus=configured&sortBy=subscriptionCount&sortDirection=desc
```

### Positions

```http
GET /api/tracked-positions
GET /api/tracked-positions/open
DELETE /api/positions/:symbol
```

- `GET /api/tracked-positions` returns all positions, including history.
- `GET /api/tracked-positions/open` returns active positions only.
- `DELETE /api/positions/:symbol` requests a broker close for the symbol.

### Open Orders

```http
GET /api/orders/open
```

Fetches normalized open Alpaca orders.

### Signals

```http
POST /api/signals/entry
```

Primary endpoint for n8n-driven entry signals.

Instead of n8n sending full order instructions, it sends a subscription key and signal metadata. The backend resolves the subscription, validates the request, determines sizing, creates an order intent, and submits the order asynchronously.

Example request:

```json
{
  "subscriptionKey": "spy_dip_core",
  "reason": "SPY dip signal triggered",
  "source": "n8n-ai-trader",
  "confidence": "high",
  "runId": "n8n-run-001",
  "metadata": {
    "macroRegime": "risk_on",
    "trigger": "dip_bounce"
  }
}
```

Example response:

```json
{
  "ok": true,
  "signal": {
    "subscriptionKey": "spy_dip_core",
    "signalType": "entry",
    "source": "n8n-ai-trader"
  },
  "order": {
    "ok": true,
    "intentId": 25,
    "status": "pending"
  }
}
```

Entry signals are blocked if:

- automated trading is disabled
- kill switch is active
- subscription is disabled
- subscription strategy is disabled
- subscription exit profile is disabled
- security is disabled
- broker account is trading-blocked
- runtime broker mode does not match connected broker mode
- symbol already has an open or closing tracked position
- daily entry order limit is reached
- daily entry notional limit would be exceeded
- max open position limit would be exceeded
- total open exposure limit would be exceeded
- per-symbol exposure limit would be exceeded
- per-subscription exposure limit would be exceeded

### Strategies

```http
GET /api/strategies
```

Returns configured strategy records. Strategies are high-level reporting and grouping categories such as Dip N Ride, Momentum, or quick test strategies.

### Exit Profiles

```http
GET /api/exit-profiles
POST /api/exit-profiles
PATCH /api/exit-profiles/:id
```

Exit profiles define how positions should be closed once opened.

Current fields include:

- key
- name
- description
- targetPct
- stopLossPct
- trailingStopPct
- maxHoldDays
- exitMode
- takeProfitBehavior
- enabled

### Subscriptions

```http
GET /api/subscriptions
GET /api/subscriptions/:key
POST /api/subscriptions
PATCH /api/subscriptions/:id
```

Subscriptions are the main deployment object for strategy execution.

A subscription connects:

- security/symbol
- broker
- broker mode
- position sizing
- strategy
- exit profile
- enabled/disabled state

Example subscription:

```json
{
  "key": "spy_dip_core",
  "name": "SPY Dip Core",
  "symbol": "SPY",
  "broker": "alpaca",
  "brokerMode": "paper",
  "sizingType": "fixed_qty",
  "sizingValue": 1,
  "strategyKey": "dip_n_ride_etf",
  "exitProfileKey": "exit_etf_dip_core_target",
  "enabled": true
}
```

Multiple enabled subscriptions are supported when they represent distinct strategy/exit configurations. The risk gate still prevents a symbol from opening multiple active tracked positions at the same time.

### Place Order

```http
POST /api/orders
```

Manual/admin order placement endpoint. This route is primarily intended for admin use, testing, and fallback manual actions.

Preferred n8n automation path:

```json
{
  "subscriptionKey": "spy_dip_core",
  "signalType": "entry"
}
```

Direct/manual market order example:

```json
{
  "symbol": "SPY",
  "side": "buy",
  "orderType": "market",
  "timeInForce": "day",
  "qty": 1
}
```

Response:

```json
{
  "ok": true,
  "intentId": 11,
  "status": "pending"
}
```

Notes:

- Order execution is asynchronous.
- Use `/api/order-intents/:id` to track status.
- Final execution status is determined by worker + broker sync.
- `clientOrderId` generation is handled by the backend.

### Cancel Orders

```http
DELETE /api/orders/:orderId
DELETE /api/orders
```

- `DELETE /api/orders/:orderId` cancels a single open Alpaca order by broker order ID.
- `DELETE /api/orders` requests cancellation of all open Alpaca orders.

### Order Intents

```http
GET /api/order-intents
GET /api/order-intents/:id
```

Returns order intent audit records.

Possible statuses include:

- `received`
- `pending`
- `submitting`
- `submitted`
- `filled`
- `blocked`
- `failed`
- `rejected`
- `duplicate`

## 📡 System Events

```http
GET /api/system-events
GET /api/system-events/security-activity/:symbol?limit=10
```

System Events form the full internal audit log.

Example events:

- `order.new`
- `order.filled`
- `position.opened`
- `position.close_requested`
- `position.closed`
- `exit.triggered`
- `risk_gate.blocked`
- `broker_activity.synced`
- `subscription.enabled`
- `subscription.disabled`

Example event shape:

```json
{
  "id": 1,
  "type": "order.filled",
  "entityType": "orderIntent",
  "entityId": "11",
  "payloadJson": {
    "symbol": "QQQ",
    "side": "buy",
    "previousStatus": "submitted",
    "nextStatus": "filled"
  },
  "processed": false,
  "createdAt": "..."
}
```

---

## ⚙️ Order Processing Architecture (Async)

Orders are processed asynchronously using a two-phase system.

### 1. Intent Creation

When a client submits an order:

- A new `OrderIntent` is created.
- The backend generates a unique, stable `clientOrderId`.
- The intent is marked `pending`.
- The API immediately returns the intent ID.

### 2. Worker Processing

The order worker:

- Finds pending intents.
- Atomically claims each intent with `pending → submitting`.
- Submits the order to Alpaca using the existing `OrderIntent.clientOrderId`.
- Stores the resulting `BrokerOrder`.
- Updates the intent status to `submitted`.

### 3. Status Synchronization

The sync worker:

- Fetches broker order updates.
- Matches them to `BrokerOrder` records.
- Updates intent/broker order statuses.
- Emits system events for status transitions.

Status updates are guarded so duplicate worker ticks do not emit duplicate lifecycle events.

---

## 🆔 Client Order ID Strategy

The backend generates unique `clientOrderId` values:

```text
ai-{timestamp}-{symbol}-{side}-{orderType}-{random}
```

Example:

```text
ai-20260427T155054-QQQ-buy-market-1c277020
```

Why this matters:

- Prevents duplicate order submission.
- Survives fast worker polling.
- Enables reliable broker matching.
- Gives Alpaca a stable idempotency key.

The order worker must reuse the `clientOrderId` stored on the `OrderIntent`. It should not generate a fresh client order ID during broker submission.

---

## 📇 Database

PostgreSQL runs locally through Docker Compose.

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

---

## 🌱 Seed Data

The project uses Prisma seed data to populate required reference/configuration tables for local development and production setup.

Seeded data currently includes:

- Settings
- Strategies
- Exit Profiles
- Securities
- Subscriptions

### Securities

Tradable securities are seeded from:

```txt
prisma/securities.json
```

This file contains the full tradable security universe for the AI Trader.

The current list includes:

- Core ETFs used by the strategy engine: SPY, QQQ, DIA, IWM, RSP
- S&P 500 constituents
- Nasdaq-100 additions not already included in the S&P 500
- Dow components included through index overlap

Each security includes:

- symbol
- name
- assetType
- sector
- industry

The TypeScript shape for this seed data is defined in:

```txt
src/types/securities.ts
```

### Subscriptions

Subscriptions are strategy-specific trading configurations attached to securities.

The full security universe is seeded into the `Security` table, but subscriptions are intentionally seeded only for a curated list of actively tested symbols by default. This prevents the seed process from automatically creating thousands of strategy subscriptions before the system is ready to manage them at scale.

By default, the curated subscription list includes:

- SPY
- QQQ
- DIA
- IWM
- RSP
- AAPL
- AMZN
- GOOG
- META
- MSFT
- NVDA
- TSLA
- AMD

### Subscription Templates

Subscriptions are generated from asset-class-aware templates during seeding.

A subscription defines:

- symbol
- broker
- broker mode
- sizing type
- sizing value
- strategy
- exit profile
- enabled/disabled state

A subscription does not define the strategy thesis itself or the exit mechanics directly. It links a security to a strategy and an exit profile.

#### ETF Seeded Subscriptions

ETFs receive:

- `{symbol}_dip_core`
- `{symbol}_dip_conservative`
- `{symbol}_dip_aggressive`
- `{symbol}_momentum_conservative`
- `{symbol}_momentum_core`
- `{symbol}_test_momentum`

#### Stock Seeded Subscriptions

Stocks receive:

- `{symbol}_dip_core`
- `{symbol}_dip_conservative`
- `{symbol}_dip_aggressive`
- `{symbol}_momentum_conservative`
- `{symbol}_momentum_core`
- `{symbol}_ai_confirmed_dip`
- `{symbol}_test_momentum`

#### Default Enabled State

Only `dip_core` subscriptions are enabled by default.

All other subscription variants are seeded but disabled:

- conservative dip
- aggressive dip
- momentum conservative
- momentum core
- AI-confirmed dip
- quick test momentum

This allows the admin UI to show the intended production structure while keeping the initial paper-trading launch conservative.

### Seed Environment Variables

#### `SEED_ALL_SECURITY_SUBSCRIPTIONS`

Controls whether Prisma seed creates subscriptions for every security in `prisma/securities.json`.

Default behavior:

```env
SEED_ALL_SECURITY_SUBSCRIPTIONS=false
```

When unset or set to anything other than `true`, the seed process creates subscriptions only for the curated active/testing universe.

To create subscriptions for every seeded security:

```env
SEED_ALL_SECURITY_SUBSCRIPTIONS=true
```

Use this carefully. Enabling this creates multiple subscriptions per security and can significantly increase the size of the `Subscription` table.

---

## 🗝 Environment Variables

Create a `.env` file in the project root.

Use `.env.example` as the template.

```env
PORT=3000
NODE_ENV=development

DATABASE_URL=postgresql://trader:traderpass@localhost:5432/ai_trader

ALPACA_API_KEY=
ALPACA_API_SECRET=
ALPACA_BASE_URL=https://paper-api.alpaca.markets

AI_TRADER_SIGNAL_API_KEY=
AI_TRADER_ADMIN_API_KEY=

# Development tunnel only
NGROK_AUTHTOKEN=
NGROK_DOMAIN=
```

Never commit `.env`.

### Admin UI Environment

Create:

```txt
apps/admin-ui/.env
```

Example:

```env
VITE_API_BASE_URL=http://localhost:3000
```

The admin UI does not need broker secrets. It authenticates through the backend login/session flow and sends the returned bearer token to protected admin routes.

---

## 💻 Local Setup

### 1. Install Backend Dependencies

```bash
npm install
```

### 2. Start Postgres

```bash
docker compose up -d
```

### 3. Run Prisma Migrations

```bash
npx prisma migrate dev
```

### 4. Generate Prisma Client

```bash
npx prisma generate
```

### 5. Seed Default Settings, Securities, Strategies, Exit Profiles, and Subscriptions

```bash
npx tsx src/db/seed.ts
```

### 6. Start Backend

```bash
npm run dev
```

Default local backend URL:

```text
http://localhost:3000
```

### 7. Install Admin UI Dependencies

```bash
cd apps/admin-ui
npm install
```

### 8. Start Admin UI

```bash
npm run dev
```

Default local admin UI URL:

```text
http://localhost:5173
```

---

## ⌨️ Useful Commands

Start backend in dev mode:

```bash
npm run dev
```

Start admin UI in dev mode:

```bash
cd apps/admin-ui
npm run dev
```

Type-check backend:

```bash
npm run check
```

Build backend:

```bash
npm run build
```

Build admin UI:

```bash
cd apps/admin-ui
npm run build
```

Start Postgres:

```bash
docker compose up -d
```

Stop Postgres:

```bash
docker compose down
```

Run migrations:

```bash
npx prisma migrate dev
```

Open Prisma Studio:

```bash
npx prisma studio
```

Seed database:

```bash
npx tsx src/db/seed.ts
```

Run local ngrok tunnel:

```bash
npm run dev:tunnel
```

---

## 📄 Development Notes

The backend intentionally uses normalized response shapes.

Alpaca returns many numeric fields as strings. The backend converts key values to numbers before returning them to n8n, the admin UI, or future clients. This protects the rest of the AI Trader system from depending on raw Alpaca response formats.

### Admin UI Bundle Warning

The admin UI build may show a Vite warning about chunks larger than 500 kB. This is currently treated as a non-blocking performance warning.

The admin UI is an internal control panel, and the build completes successfully.

Potential future optimization:

- Route-level lazy loading for admin UI pages
- Code splitting for heavier feature areas
- Bundle analysis if first-load performance becomes a problem

---

## 🛡 Current Safety Controls

The backend currently protects trading and configuration changes with:

- API key authentication
- Admin login sessions
- Separate signal-level and admin-level access
- Runtime `tradingEnabled` setting
- Runtime `killSwitchEnabled` setting
- Paper/live mode setting
- Alpaca account `tradingBlocked` check
- Broker mode matching
- Zod schema validation
- Security enable/disable checks
- Subscription enable/disable checks
- Strategy enable/disable checks
- Exit profile enable/disable checks
- Daily entry order limit
- Daily entry notional limit
- Max open position limit
- Total open notional limit
- Per-symbol exposure limit
- Per-subscription exposure limit
- Backend-generated stable `clientOrderId`
- Atomic order worker claim: `pending → submitting`
- Duplicate broker order protection
- Open/closing position guard for entry signals
- Atomic tracked-position lifecycle transitions
- Order intent audit logging
- Broker order audit logging
- Broker activity/fill import
- Account snapshot audit logging
- System event logging

The intended production separation is:

```text
n8n / automation
  → signal API key
  → signal routes only

Admin UI / Postman
  → admin login session or admin API key
  → full management routes
```

This prevents automation clients from accidentally changing strategy configuration, subscription sizing, exit rules, or global trading settings.

---

## 🧭 Roadmap

### Recently Completed

Production-readiness foundation:

- Centralized entry risk gate
- Kill switch
- Runtime entry risk settings
- Risk controls in Settings UI
- Account snapshots
- Broker activity / fill import
- Reports UI for account snapshots and broker activity
- Worker idempotency fixes
- Duplicate broker submission prevention
- Duplicate position lifecycle event prevention
- Curated dashboard Recent Activity feed
- Health endpoint
- Admin-protected system status endpoint
- System Status card in Settings
- Hostinger VPS production-style deployment workflow
- Docker Compose production stack with Caddy, backend, admin UI, and PostgreSQL

Exit profile and trailing-stop work:

- Exit profile hierarchy for fixed target, fixed bracket, hybrid, and unlock-trailing-stop exits
- ETF target-unlocks-trailing-stop profiles seeded for paper testing and future rollout
- `TrackedPosition` trailing-unlock and broker-sync state fields
- Native Alpaca `trailing_stop` submission service
- Exit evaluator support for `unlock_trailing_stop` profiles
- Broker sync for native trailing-stop status, high-water mark, stop price, and trail percent
- Open Positions UI columns for Exit Strategy, Exit Target, Trailing State, Trail %, Trail HWM, and Stop Price
- Quick-test paper profile and subscription path for validating the target-unlock → broker trailing-stop handoff

### Active Paper Validation

The target-unlocks-trailing-stop feature is code-complete but still in paper validation.

Current validation focus:

- Confirm a test position can open from a subscription using `exit_etf_unlock_quick_test`
- Confirm the position appears with `Exit Strategy = Target Unlocks Trail`
- Confirm the initial target is treated as an unlock threshold, not a sell trigger
- Confirm the backend submits one native Alpaca `trailing_stop` sell order after unlock
- Confirm duplicate trailing-stop submissions are prevented by the stored client order ID and tracked-position state
- Confirm Open Positions displays broker-reported trailing-stop status, trail percent, HWM, and stop price
- Confirm Open Orders / Alpaca paper dashboard show the active trailing-stop sell order
- Confirm System Events clearly show unlock, handoff, sync, and any error states
- Confirm final broker fill and position sync close the tracked position cleanly

While this validation is in progress, quick-test profiles and subscriptions should be treated as temporary paper-test tooling, not production strategy configuration.

### Near-Term Strategy Rollout

After active fixed-target ETF positions finish their current cycles, ETF subscriptions can be moved gradually to the new target-unlocks-trailing-stop profiles.

Planned rollout approach:

- Let existing fixed-target SPY, QQQ, and DIA positions close under their original exit profile
- Switch future ETF subscriptions to selected unlock-trailing-stop profiles only after the paper validation path is confirmed
- Keep unused unlock-trailing profiles disabled until they are intentionally tested
- Start with conservative paper settings before considering broader production-paper use
- Monitor Open Positions, Open Orders, System Events, Broker Activity, and Alpaca paper activity during the first several cycles
- Compare fixed-target outcomes against target-unlock trailing-stop outcomes by subscription and exit profile

### Next Backend Enhancements

- Add broker activity support beyond `FILL` if useful
- Add more precise close-fill linking between close orders and broker activities
- Add order/position reconciliation checks
- Add explicit attention states for missing, canceled, rejected, or expired protective trailing-stop orders
- Add tests around unlock-trailing-stop behavior:
  - target not reached
  - target reached
  - duplicate worker tick protection
  - broker order recovery by client order ID
  - rejected trailing-stop order
- Add historical performance reports by:
  - strategy
  - subscription
  - exit profile
  - security
- Add account equity/exposure trend charts from `AccountSnapshot`
- Add broker activity drill-down pages

### Longer-Term

- Replace more Google Sheet state with database-backed market memory
- Expand Market Diary analytics and decision-review workflows
- Add websocket trade update listener
- Add historical audit dashboard
- Add AI-assisted profit-protection workflows
- Add multi-account support
- Add live-trading deployment checklist and approval workflow
