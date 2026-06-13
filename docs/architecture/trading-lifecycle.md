# Trading Lifecycle

This doc covers how a trade moves through the system — from entry signal to broker submission, position tracking, exit evaluation, and the audit trail. It also describes the background workers that keep everything synchronized and the async order processing architecture.

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
GET /api/trade-cycles
GET /api/trade-cycles/:id
```

`DELETE /api/positions/:symbol` requests a broker close. The sync loop confirms the position is closed and emits `position.closed` only after the tracked position successfully transitions from `open` or `closing` to `closed`.

`GET /api/trade-cycles` and `GET /api/trade-cycles/:id` are the canonical
backend lifecycle review endpoints. They treat a `TrackedPosition` row as one
trade cycle and assemble linked subscription, strategy, exit profile, order
intents, broker orders, broker activities, system events, computed close-fill
summary, and a chronological timeline server-side. Admin UI trade-history views
should use these endpoints instead of independently joining raw order, position,
activity, and event endpoints.

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

Broker activities can now be linked directly to a tracked-position cycle through
`trackedPositionId`. Deterministic links are preferred:

- Alpaca activity `order_id` -> local `BrokerOrder.brokerOrderId`
- local `BrokerOrder.trackedPositionId`
- trailing-stop `PositionExitState.trailBrokerOrderId`

If a local development database is only observing the same Alpaca paper account
that production is trading, the local database may not have production-created
`OrderIntent` or `BrokerOrder` rows. In that case, close-fill attribution may use
the `reconciliation_discovered_close` source only when one local tracked-position
cycle is eligible, the fill side is the close side, the fill occurs after the
local cycle opened, the quantity is consistent with closing the tracked quantity,
and no newer active same-symbol cycle exists. Ambiguous fills remain unlinked and
are surfaced through a system event instead of being attached by symbol alone.

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
