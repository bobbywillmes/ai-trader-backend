# AI Trader Backend
Backend service for the n8n AI Trader system.

This project is the broker/control layer between the AI Trader workflow and Alpaca paper trading. n8n handles strategy logic and sends trade requests. This backend handles broker communication, account/position/order retrieval, validation, order submission, cancellation, runtime trading config, allowed tickers, and audit logging.

## 🔹 Overview

AI Trader Backend is an event-driven trading engine that:

- Accepts external trade signals (via n8n or API)
- Executes trades through a broker (Alpaca)
- Tracks all positions internally
- Automatically manages exits based on configurable strategies

It is designed to be:
- Fully automated
- State-aware
- Extensible for advanced strategy logic

Current stack:

- Node.js
- TypeScript
- Express
- PostgreSQL
- Prisma
- Docker Compose
- Alpaca Trading API

---
## 💡 Big Picture Architecture

Original algo trading stack:
```
TradingView strategies → TradersPost → E*TRADE
```

Current backend-driven AI Trader stack:
```text
n8n
  → POST (to backend) /api/signals/entry
node/express backend
  → Subscription
  → OrderIntent
      → BrokerOrder / Alpaca
  → TrackedPosition
  → ExitProfile-driven exit evaluation
```
n8n sends strategy signals. The backend resolves the subscription, validates risk/config rules, determines sizing, logs the order intent, submits approved orders to Alpaca, tracks the resulting position, and manages exits.

The design goal is that n8n does **not** talk directly to Alpaca.

n8n decides what it wants to do.
The backend decides whether that request is allowed, logs the intent, sends approved orders to Alpaca, and records the broker response.

----------

## ⚒️ Core Responsibilities

The backend currently handles:

-   Fetching Alpaca account details
-   Fetching open positions
-   Fetching open orders
-   Returning a combined bootstrap payload for n8n
-   Submitting paper trading orders
-   Canceling one open order
-   Canceling all open orders
-   Validating allowed tickers
-   Enforcing `tradingEnabled`
-   Loading runtime config from PostgreSQL
-   Logging order intents before broker submission
-   Logging broker order responses after Alpaca accepts/rejects orders

Key features:

- Subscription-driven order execution (strategy + exit profile bound at entry)
- OrderIntent stores `subscriptionId` and `subscriptionKey` for full traceability
- Positions are linked to subscriptions, enabling strategy-aware tracking
- Positions include embedded strategy + exit profile context


## ⚒️ Core Data Flow

The system is now structured around **subscription-driven trading**.

### Entry Flow
1. n8n sends signal:
   - `subscriptionKey` (e.g. "dip_n_ride_spy")
   - `signalType` (e.g. "entry")

2. Backend resolves:
   - Subscription
   - Strategy
   - ExitProfile
   - Position sizing

3. Backend creates `OrderIntent`:
   - Stores:
     - symbol
     - side
     - qty / notional
     - `subscriptionId`
     - `subscriptionKey`
     - `clientOrderId`: A timestamped unique identifier, sent to Alpaca as primary key for order.

4. Order is submitted to Alpaca

---

### Position Tracking Flow
1. Positions are pulled from broker
2. System finds matching `OrderIntent` (latest filled)
3. Position is stored as `TrackedPosition` with:
   - `subscriptionId`
4. Subscription is included on reads:
   - Strategy
   - ExitProfile

---

### Result
Every open position now has:
- Strategy context
- Exit rules attached
- Full traceability from signal → execution → position

### Position Lifecycle Management

- **Open Positions Tracking**
  - Internal `tracked_positions` table mirrors broker positions
  - Sync runs continuously via background worker
  - Includes real-time PnL, cost basis, and position metadata

- **Get Open Positions**
  - `GET /api/tracked-positions/open`
  - Returns only active positions (filters out closed history)
  - Includes linked `subscription`, `strategy`, and `exitProfile`

- **Close Position (by Ticker)**
  - `DELETE /api/positions/:symbol`
  - Closes position at broker (Alpaca)
  - Automatically updates internal state via sync loop
  - Emits system events:
    - `position.close_requested`
    - `position.closed`

- **Full Position History**
  - `GET /api/tracked-positions`
  - Returns all positions (open + closed)

----------

## Background Workers

The system runs multiple continuous loops to maintain synchronization and automate trading behavior:

- **Order Processing Worker**
  - Handles pending order intents

- **Order Sync Worker**
  - Syncs submitted orders with broker status

- **Position Sync Worker**
  - Syncs broker positions → internal database

- **Exit Evaluation Worker**
  - Monitors open positions and triggers exits

All loops run independently at short intervals (~2 seconds), enabling near real-time behavior.

----------

## ⚙️ Exit Evaluation Engine

The backend includes a real-time exit evaluation system that continuously monitors open positions and executes exits based on configured rules.

### How it Works

1. Background loop runs every ~2 seconds
2. Fetches all open tracked positions
3. Joins each position with its:
   - Subscription
   - Strategy
   - Exit Profile
4. Evaluates exit conditions:
   - Target profit reached
   - Stop loss triggered
5. If triggered:
   - Sends close request to broker
   - Updates position state
   - Emits system events

### Supported Exit Modes

- **Fixed Target**
- **Trailing Stop (after target)**
- **Fixed Stop + Target**
- **(Future) AI-assisted exits**

### Example Flow

```text
Position Opened → Market Moves → Exit Condition Hit → Close Requested → Position Closed
```
Key File:
`src/services/exit-evaluator.service.ts`

----------

## 📂 Project Structure
```
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
```
## ➡️ Request Flow

The Express app follows this general pattern:
```
server.ts
  → app.ts
    → routes
      → controllers
        → services
          → database and/or Alpaca integration adapters
```
### `server.ts`

`server.ts` is the entry point. It creates the Express app and starts listening on the configured port.

### `app.ts`

`app.ts` builds the main Express application.

It wires in:
-   security middleware
-   JSON parsing
-   request logging
-   top-level routes
-   404 handler
-   central error handler

Example route mounting:
```
app.use('/api/account', accountRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/bootstrap', bootstrapRoutes);
```
### Routes

Route files define endpoint paths and connect them to controllers.

Example:
```
router.get('/open', openOrdersController);
router.post('/', placeOrderController);
router.delete('/', cancelAllOrdersController);
router.delete('/:orderId', cancelOrderController);
```

### Controllers

Controllers handle the HTTP request/response layer.

They parse request params/body, call services, and return JSON responses.

Controllers should not contain broker logic or database-heavy business logic.

### Services

Services hold the business logic.

Examples:

-   `place-order.service.ts` validates runtime config, checks allowed tickers, creates order intents, submits to Alpaca, and records broker orders.
-   `bootstrap.service.ts` gathers account, positions, open orders, and runtime config into one payload.
-   `config.service.ts` loads allowed tickers and settings from PostgreSQL.
-   `order-audit.service.ts` handles order intent and broker order logging.

### Integrations

The `integrations/alpaca` folder isolates Alpaca-specific code.

This keeps the rest of the backend from depending directly on Alpaca’s raw response shape.

The backend normalizes Alpaca responses before returning them to n8n or future UI clients.

## 🔐 API Authentication

All protected API routes require an API key sent through a single shared header:

```http
ai-trader-api-key: <your_api_key>
```
The backend supports two API key roles:

Signal API Key
The signal key is intended for automation clients such as n8n.

This key can:
- Submit entry signals
- Read current open tracked positions

This key cannot:
- Modify config/settings
- Modify allowed tickers
- Create or edit strategies
- Create or edit subscriptions
- Create or edit exit profiles
- Place manual/admin orders
- Close positions manually
- View full admin history


Admin API Key
The admin key is intended for manual control, Postman, and the future web dashboard.

This key can access everything the signal key can access, plus:
- Runtime config/settings
- Allowed ticker management
- Strategy management
- Exit profile management
- Subscription management
- Manual order placement
- Position close actions
- Full position history
- Order intent history
- System event history
- Environment Variables

API keys are configured in .env:
```
AI_TRADER_SIGNAL_API_KEY=your_signal_key_here
AI_TRADER_ADMIN_API_KEY=your_admin_key_here
```

Both keys use the same request header:
```
ai-trader-api-key: your_key_here
```
The backend decides access level by comparing the provided key against the signal/admin keys configured in the environment.

### Roles

The system supports two levels of access:

#### 1. Signal-Level Access (Automation / n8n)

- Submit trade signals
- Read positions
- Cannot modify system configuration

#### 2. Admin-Level Access

- Full system control:
  - Strategies
  - Subscriptions
  - Exit Profiles
  - Settings

### Enforcement

- Global middleware validates API key
- Admin routes require elevated permissions

### Design Principle

This separation ensures:
- Automation cannot accidentally modify system behavior
- Manual control remains safe and intentional

## 🔌 n8n Integration Proof of Concept
The backend has been successfully tested with a small n8n proof-of-concept workflow that sends trading signals into the Node API and reads current open positions back from the backend.
This confirms that n8n can communicate with the local development backend through a public ngrok tunnel, using the same API key authentication model that will later be used in production.

### What was tested
The proof-of-concept n8n workflow includes:
1. A manual trigger node.
2. A setup node that stores the backend URL and API key.
3. A code node that builds a sample entry signal payload.
4. An HTTP Request node that sends the signal to:
```http
POST /api/signals/entry
```
5. A response parser node that normalizes both successful and failed responses.
6. A second HTTP Request node that reads open tracked positions from:
```http
GET /api/tracked-positions/open
```
7. A response parser node for open position results.

### Local development tunnel
During local development, the backend can be exposed to n8n through ngrok.
ngrok is installed as a development dependency and needs two environment variables to be set.
```
NGROK_AUTHTOKEN=auto generated token from ngrok
NGROK_DOMAIN=unique url that exposes localhost
```

The project includes a development tunnel script:
```bash
npm run dev:tunnel
```
This starts an ngrok tunnel that forwards traffic to the local backend server:
```http
https://<ngrok-url> -> http://localhost:3000
```

A normal local development session now typically uses two terminals:
```bash
npm run dev
npm run dev:tunnel
```

The ngrok URL is then used by n8n as the backend base URL.

#### Signal-level API access
The n8n workflow uses the signal-level API key and sends it in the shared API header:
```http
ai-trader-api-key: <signal-api-key>
```
This allows n8n to perform only signal/client-level actions, such as:
- Sending entry signals.
- Reading current open positions.

Admin-level actions remain protected by the admin API key and are not exposed to the n8n signal workflow.

#### Error handling
The n8n HTTP Request nodes are configured to continue on error so the workflow can inspect backend responses instead of failing immediately.
This allows the workflow to handle expected backend responses such as:
```http
201 Created
```
for accepted entry signals, and:
```http
409 Conflict
```
for safely blocked signals, such as when a ticker already has an open or closing tracked position.

The proof-of-concept confirmed that 409 responses from the backend can be parsed into a clean object containing:
```json
{
  "ok": false,
  "status": 409,
  "error": "HttpError",
  "message": "Entry signal blocked because SPY already has an open or closing tracked position.",
  "details": null
}
```

## ⚙️ Current API Endpoints

### Health
```
GET /health
```
Returns a simple service health response.

----------

### Bootstrap
```
GET /api/bootstrap
```
Returns the main startup payload for n8n.

Includes:

-   account summary
-   positions
-   open orders
-   runtime config
-   risk status

Example shape:
```
{
 "account": {},
 "positions": [],
 "openOrders": [],
 "config": {
 "tradingEnabled": true,
 "paperMode": true,
 "allowedTickers": ["SPY", "QQQ", "DIA"]
 },
 "risk": {
 "canTrade": true,
 "reason": null
 }
}
```
----------

### Account
```
GET /api/account
```
Fetches normalized Alpaca account details.

Important fields include:

-   cash
-   buying power
-   equity
-   portfolio value
-   day P/L
-   trading blocked status

----------

### Positions

- `GET /api/tracked-positions` → All positions (history)
- `GET /api/tracked-positions/open` → Open positions only
- `DELETE /api/positions/:symbol` → Close position

----------

### Exit System

- Automated via background worker (no direct endpoint)

----------

### Open Orders
```
GET /api/orders/open
```
Fetches normalized open Alpaca orders.

### Signals
```http
POST /api/signals/entry
```

Primary endpoint for n8n-driven entry signals.

This is the preferred automation entrypoint. Instead of n8n sending full order instructions, it sends a subscription key and signal metadata. The backend resolves the subscription, validates the request, determines sizing, creates an order intent, and submits the order asynchronously.

Example request:
```json
{
  "subscriptionKey": "dip_n_ride_spy_paper",
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
    "subscriptionKey": "dip_n_ride_spy_paper",
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
- The subscription is disabled
- The subscription strategy is disabled
- The subscription exit profile is disabled
- The ticker is not allowed
- Trading is disabled
- The Alpaca account is trading-blocked
- The ticker already has an open or closing tracked position

This route is available to the signal API key and the admin API key.


### Admin: Strategies

```http
GET /api/strategies
```

Returns configured strategy records.

Strategies are mostly used as high-level reporting and grouping categories. They describe the broad trading logic bucket, such as Dip N Ride, Momentum, or quick test strategies.

Admin-only route.
```js
Admin: Exit Profiles
GET   /api/exit-profiles
POST  /api/exit-profiles
PATCH /api/exit-profiles/:id
```
Exit profiles define how positions should be closed once opened.

Current exit profile fields include:
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

Exit profiles are linked to subscriptions, allowing each subscription to define its own position exit behavior.

Admin-only routes.

Admin: Subscriptions
```js
GET   /api/subscriptions
GET   /api/subscriptions/:key
POST  /api/subscriptions
PATCH /api/subscriptions/:id
```

Subscriptions are the main deployment object for strategy execution.

A subscription connects:
- Ticker
- Broker
- Broker mode
- Position sizing
- Strategy
- Exit profile
- Enabled/disabled state

Example subscription:
```json
{
  "key": "dip_n_ride_spy_paper",
  "name": "Dip N Ride - SPY Paper",
  "symbol": "SPY",
  "broker": "alpaca",
  "brokerMode": "paper",
  "sizingType": "fixed_qty",
  "sizingValue": 1,
  "strategyKey": "dip_n_ride_etf",
  "exitProfileKey": "target_2pct_trail_0_5pct",
  "enabled": true
}
```

The backend enforces that only one enabled subscription can exist for the same symbol/broker/brokerMode combination. This prevents duplicate active deployments for the same ticker in the same broker environment while still allowing disabled test subscriptions to exist.


### Place Order
```js
POST /api/orders
```
Manual/admin order placement endpoint.

This route is primarily intended for admin use, testing, and fallback manual actions. The preferred n8n automation path is:

Subscription-driven example:
```json
{
  "subscriptionKey": "dip_n_ride_spy_paper",
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
Direct/manual limit order example:
```json
{
  "symbol": "AAPL",
  "side": "buy",
  "orderType": "limit",
  "timeInForce": "day",
  "qty": 1,
  "limitPrice": 150,
  "extendedHours": true
}
```
Backend validation currently checks:

-   trading is enabled
-   ticker is allowed
-   account is not trading-blocked
-   order request schema is valid

 Note: `clientOrderId` generation is handled on the backend.
 
### Response
```
{
 "ok": true,
 "intentId": 11,
 "status": "pending"
}
```
----------

### Notes

-   Order execution is asynchronous
-   Use `/api/order-intents/:id` to track status
-   Final execution status is determined by worker + broker sync

----------

### Cancel One Order
```
DELETE /api/orders/:orderId
```
Cancels a single open Alpaca order by broker order ID.

Example:
```
DELETE /api/orders/abc-123
```
----------

### Cancel All Open Orders
```
DELETE /api/orders
```
Requests cancellation of all open Alpaca orders.

----------

### Order Intents
```
GET /api/order-intents
```
Returns recent order intent audit records.

This is the beginning of the backend audit trail.

Each order request creates an `OrderIntent` before the backend attempts to submit anything to Alpaca.

Possible statuses:

-   `received`
-   `blocked`
-   `submitted`
-   `duplicate`
-   `rejected`

### Includes

- Linked `brokerOrders`
- Current execution status
- Generated `clientOrderId`

---

### Notes

- `status` reflects latest known broker state
- May update shortly after submission due to async processing

## ⚙️ Order Processing Architecture (Async)

Orders are processed asynchronously using a two-phase system:

### 1. Intent Creation (API Layer)

When a client submits an order:

- A new `orderIntent` is created in the database
- The backend generates a unique `clientOrderId`  (combination of ticker, ordertype, timestamp & uuid)
- The order is marked as `pending`
- The API immediately returns a response

```json
{
"ok": true,
"intentId": 123,
"status": "pending"
}
```
### 2. Worker Processing (Background Loop)

A background worker runs every few seconds:

-   Picks up `pending` intents
-   Submits orders to Alpaca
-   Stores the resulting `brokerOrder`
-   Updates status → `submitted`

----------

### 3. Status Synchronization

Another loop continuously:

-   Fetches open orders from Alpaca
-   Matches them to `brokerOrders`
-   Updates intent status (`submitted → filled`, etc.)
-   Emits system events

----------

### Why this design?

-   Prevents API blocking
-   Supports retries + resilience
-   Enables event-driven strategies
-   Decouples trading logic from request timing

---
## 🔄Order Lifecycle

An order progresses through the following states:

| Status      | Description |
|------------|------------|
| `received`  | API received request |
| `pending`   | Waiting for worker processing |
| `submitted` | Sent to broker |
| `filled`    | Fully executed |
| `rejected`  | Broker rejected order |
| `blocked`   | Prevented by risk/config |
| `duplicate` | Duplicate clientOrderId detected |

---

### Example Flow
 
received → pending → submitted → filled

----------

### Notes

-   Status transitions are driven by the worker, not the API
-   `filled` is determined via Alpaca sync, not immediate response


---

## 📡 System Events  (Event Log)

All important state changes are logged as events.
```
GET /api/system-events
```

### Example Events

- `order.submitted`
- `position.opened`
- `position.close_requested`
- `position.closed`
- `exit.triggered`

These events form the foundation for:
- Logging
- Auditing
- Future analytics
- UI updates

---

### Event Structure

```json
{
 "id": 1,
 "type": "order.filled",
 "entityType": "orderIntent",
 "entityId": 11,
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

### Purpose

-   Audit trail
-   Debugging
-   Future automation triggers
-   Foundation for exit strategies

----------

## 🔁 Background Workers

The system runs continuous polling loops:

### Order Processing Worker

- Runs every ~2 seconds
- Processes `pending` intents
- Submits orders to Alpaca

---

### Sync Worker

- Runs every ~2 seconds
- Fetches broker order updates
- Updates intent statuses
- Emits system events

---

### Design Notes

- Simple polling (no queues yet)
- Eventually replaceable with:
- Redis queues
- Webhooks
- Streaming APIs


## 🆔 Client Order ID Strategy

The backend generates unique `clientOrderId` values:
```
ai-{timestamp}-{symbol}-{side}-{random}
```

### Example
```
ai-20260427T155054-QQQ-buy-market-1c277020
```

---

### Why?

- Prevents duplicate order submission
- Survives database resets
- Enables reliable broker matching

----------

## 📇 Database

PostgreSQL runs locally through Docker Compose.

Current Prisma models:

-   `Setting`
-   `AllowedTicker`
-   `OrderIntent`
-   `BrokerOrder`
-   `SystemEvent`
-   `TrackedPosition`
-   `Strategy`
-   `ExitProfile`
-   `Subscription`

### `Setting`

Stores runtime trading settings.

Current keys:
```
tradingEnabled
paperMode
```
### `AllowedTicker`

Stores the ticker allowlist used by the backend.

The backend blocks order requests for tickers not in this table.

### `OrderIntent`

Logs every order request received by the backend before broker submission.

This includes blocked and rejected requests.

### `BrokerOrder`

Logs broker responses from Alpaca for submitted or duplicate orders.

### `SystemEvent`

All state change events are logged.

### `TrackedPosition`

Current state of open positions.

### `Strategy`

Top-level/reusable trading logic identity.
e.g. Dip n Ride, Momentum.

### `ExitProfile`

Key decisions for strategy involve exit points. 
e.g. fixed target (without stop), fixed target with stop, trailing stop after fixed target is hit

### `Subscription`

Symbol-specific deployment of a strategy. Contains Symbol, position size (qty: 1), broker. It is connected to its parent strategy and an exit profile.
e.g. Dip N Ride - QQQ

----------

## 🗝 Environment Variables

Create a `.env` file in the project root.

Use `.env.example` as the template:
```
PORT=3000
NODE_ENV=development

ALPACA_API_KEY=
ALPACA_API_SECRET=
ALPACA_BASE_URL=https://paper-api.alpaca.markets

DATABASE_URL=postgresql://trader:traderpass@localhost:5432/ai_trader
```
Never commit `.env`.

----------

## 💻 Local Setup

### 1. Install dependencies
```
   npm install
```
### 2. Start Postgres
```
   docker compose up -d
```
### 3. Run Prisma migrations
```
   npx prisma migrate dev
```
### 4. Generate Prisma client
```
   npx prisma generate
```
### 5. Run Prisma client
```
   npx prisma studio
```
### 6. Seed default settings and tickers
```
   npx tsx src/db/seed.ts
```
### 7. Start the backend
```
   npm run dev
```
Default local URL:

http://localhost:3000

----------

## ⌨️ Useful Commands

Start backend in dev mode:
```
   npm run dev
```
Type-check:
```
   npm run check
```
Build:
```
   npm run build
```
Start Postgres:
```
   docker compose up -d
```
Stop Postgres:
```
   docker compose down
```
Run migrations:
```
   npx prisma migrate dev
```
Open Prisma Studio:
```
   npx prisma studio
```
Seed database:
```
   npx tsx src/db/seed.ts
```
----------

## 📄 Development Notes

The backend intentionally uses normalized response shapes.

Alpaca returns many numeric fields as strings. The backend converts key values to numbers before returning them to n8n or future UI clients.

This protects the rest of the AI Trader system from depending on raw Alpaca response formats.

----------

## 🛡 Current Safety Controls

The backend currently protects trading and configuration changes with:

- API key authentication
- Separate signal-level and admin-level access
- Single shared API key header: `ai-trader-api-key`
- Ticker allowlist
- Runtime `tradingEnabled` setting
- Paper/live mode setting
- Alpaca account `tradingBlocked` check
- Zod schema validation
- Backend-generated `clientOrderId`
- Duplicate broker order protection
- Order intent audit logging
- Broker order audit logging
- System event logging
- Open/closing position guard for entry signals
- Subscription enabled/disabled checks
- Strategy enabled/disabled checks
- Exit profile enabled/disabled checks
- One-enabled-subscription-per-symbol/broker/brokerMode guard

The intended production separation is:

```text
n8n / automation → signal API key → signal routes only
Admin dashboard / Postman → admin API key → full management routes
```
This prevents automation clients from accidentally changing strategy configuration, subscription sizing, exit rules, or global trading settings.

----------

## 🧭 Roadmap

Near-term:

- Connect n8n AI Trader to `POST /api/signals/entry`
- Connect n8n to `GET /api/tracked-positions/open`
- Build a basic admin web dashboard
- Add UI controls for subscriptions
- Add UI controls for exit profiles
- Add UI controls for runtime settings
- Add UI controls for allowed tickers
- Add account snapshot logging
- Add broker activity/fill endpoint
- Deploy backend to Hostinger
- Configure production API keys/secrets
- Add production logging/monitoring checks

Longer-term:

- Replace more Google Sheet state with database tables
- Add Market Diary persistence
- Add per-ticker budget rules
- Add max daily orders and max exposure rules
- Add kill switch
- Add websocket trade update listener
- Add historical audit dashboard
- Add richer exit modes such as AI-assisted profit protection
- Add performance reporting by strategy/subscription/exit profile