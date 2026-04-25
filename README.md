# AI Trader Backend  

Backend service for the n8n AI Trader system.

This project is the broker/control layer between the AI Trader workflow and Alpaca paper trading. n8n handles strategy logic and sends trade requests. This backend handles broker communication, account/position/order retrieval, validation, order submission, cancellation, runtime trading config, allowed tickers, and audit logging.

Current stack:

- Node.js
- TypeScript
- Express
- PostgreSQL
- Prisma
- Docker Compose
- Alpaca Trading API

---

## Big Picture Architecture

Original algo trading stack:

```
TradingView strategies → TradersPost → E*TRADE
```

Current backend-driven AI Trader stack:
```
n8n AI Trader → Node/Express AI Trader Backend → Alpaca Trading API
```
The design goal is that n8n does **not** talk directly to Alpaca.

n8n decides what it wants to do.
The backend decides whether that request is allowed, logs the intent, sends approved orders to Alpaca, and records the broker response.

----------

## Core Responsibilities

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

----------

## Project Structure
```
src/
   app/
      server.ts
      app.ts

   config/
      env.ts
      logger.ts
      trading.ts

   controllers/
      account.controller.ts
      bootstrap.controller.ts
      health.controller.ts
      order-intents.controller.ts
      orders.controller.ts
      positions.controller.ts

   db/
      prisma.ts
      seed.ts

   errors/
      alpaca-api-error.ts
      http-error.ts

   integrations/
      alpaca/
         account.adapter.ts
         alpaca.types.ts
         client.ts
         normalizers.ts
         orders.adapter.ts
         positions.adapter.ts

   middleware/
      error-handler.ts
      not-found.ts

   routes/
      account.routes.ts
      bootstrap.routes.ts
      health.routes.ts
      order-intents.routes.ts
      orders.routes.ts
      positions.routes.ts

   services/
      account.service.ts
      bootstrap.service.ts
      cancel-all-orders.service.ts
      cancel-order.service.ts
      config.service.ts
      order-audit.service.ts
      orders.service.ts
      place-order.service.ts
      positions.service.ts

   types/
      broker.ts
      express.d.ts

   validators/
      cancel-order.schema.ts
      place-order.schema.ts
```
## Request Flow

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

## Current API Endpoints

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
```
GET /api/positions
```
Fetches normalized open Alpaca positions.

----------

### Open Orders
```
GET /api/orders/open
```
Fetches normalized open Alpaca orders.

### Place Order
```
POST /api/orders
```
Submits a paper order through Alpaca after backend validation.

Supported v1 order types:

-   `market`
-   `limit`

Supported v1 time-in-force values:

-   `day`
-   `gtc`

The request must include either `qty` or `notional`, but not both.

Example market order:
```
{
 "symbol": "SPY",
 "side": "buy",
 "orderType": "market",
 "timeInForce": "day",
 "qty": 1,
 "clientOrderId": "test-spy-buy-001"
}
```
Example limit order:
```
{  
 "symbol": "AAPL",
 "side": "buy",
 "orderType": "limit",
 "timeInForce": "day",
 "qty": 1,
 "limitPrice": 150,
 "extendedHours": true,
 "clientOrderId": "test-aapl-limit-001"
}
```
Backend validation currently checks:

-   trading is enabled
-   ticker is allowed
-   account is not trading-blocked
-   order request schema is valid
-   duplicate `clientOrderId` is detected before submitting

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

A submitted order also creates a linked `BrokerOrder` record.

----------

## Database

PostgreSQL runs locally through Docker Compose.

Current Prisma models:

-   `Setting`
-   `AllowedTicker`
-   `OrderIntent`
-   `BrokerOrder`

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

----------

## Environment Variables

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

## Local Setup

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
### 5. Seed default settings and tickers
```
npx tsx src/db/seed.ts
```
### 6. Start the backend
```
npm run dev
```
Default local URL:

http://localhost:3000

----------

## Useful Commands

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

## Development Notes

The backend intentionally uses normalized response shapes.

Alpaca returns many numeric fields as strings. The backend converts key values to numbers before returning them to n8n or future UI clients.

This protects the rest of the AI Trader system from depending on raw Alpaca response formats.

----------

## Current Safety Controls

The backend currently protects order submission with:

-   ticker allowlist
-   trading enabled setting
-   paper/live mode setting
-   Alpaca account `tradingBlocked` check
-   schema validation with Zod
-   duplicate `clientOrderId` check
-   order intent audit logging

Before deploying publicly, the backend still needs API authentication so only trusted clients, such as n8n, can call protected endpoints.

----------

## Roadmap

Near-term:

-   Add backend API authentication
-   Add admin endpoints for settings and allowed tickers
-   Add order fill/status syncing
-   Add account snapshot logging
-   Add broker activity/fill endpoint
-   Add basic dashboard UI
-   Deploy to Hostinger
-   Connect n8n AI Trader to `/api/bootstrap`
-   Connect n8n order execution to `POST /api/orders`

Longer-term:

-   Replace more Google Sheet state with database tables
-   Add Market Diary persistence
-   Add strategy/risk configuration tables
-   Add per-ticker budget rules
-   Add max daily orders and max exposure rules
-   Add kill switch
-   Add websocket trade update listener
-   Add historical audit dashboard