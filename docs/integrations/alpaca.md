# Alpaca Integration

The backend is the only system that should talk directly to Alpaca. n8n sends signals to the backend, and the backend owns broker mode validation, risk checks, idempotent order submission, broker state sync, account snapshots, broker activity ingestion, and API usage observability.

## Request Instrumentation

All Alpaca REST calls go through the shared Alpaca client wrapper in `src/integrations/alpaca/client.ts`.

Each call must provide request metadata:

```text
operation
endpoint
method
```

This metadata is used for logs, rate-limit handling, usage aggregation, and the Settings -> System Status UI. New Alpaca adapter calls should use the existing operation naming style rather than free-form ad hoc labels.

## API Usage Tracking

`src/services/alpaca-api-usage.service.ts` tracks Alpaca REST request activity for the running backend process.

It records:

- request counts
- success and failure counts
- network error counts
- 429 rate-limit counts
- request duration summaries
- top operations and endpoints
- active and peak concurrent requests
- latest known Alpaca rate-limit headers
- active backoff state after 429 responses

The goal is operational visibility. The backend needs to know whether normal workers are producing unexpected broker traffic, whether Alpaca is rate-limiting requests, and whether nonessential polling should be deferred during an active rate-limit incident.

## Rate-Limit Behavior

When Alpaca returns `429`, the usage registry records a rate-limit incident and activates a bounded backoff window. During active backoff, safe nonessential read polling can be deferred so the backend does not keep hammering Alpaca while the limit is recovering.

Critical write paths, including broker order submission, keep their existing behavior. The observability layer should not silently drop broker-facing trading actions.

Worker integrations translate intentional rate-limit deferrals into healthy `not_due` skips rather than worker failures. This keeps worker health focused on scheduler liveness while still exposing the rate-limit state through System Status.

## Adaptive REST Polling

The backend intentionally keeps Alpaca synchronization on REST polling. WebSockets are not required for the current trading lifecycle because the app does not need millisecond broker-state updates; it needs reliable, idempotent order submission and prompt enough state convergence for operational review and exit management.

Adaptive polling applies only to:

- `submitted_order_sync`
- `tracked_position_sync`

The shared two-second trading scheduler remains in place. Pending order processing, exit evaluation, broker activity sync, account snapshots, scheduled reconciliation, risk-gate account checks, API usage persistence, and critical Alpaca writes keep their existing cadence and behavior.

The process-local coordinator lives in `src/services/adaptive-polling.service.ts`. It owns temporary state for:

- market state and polling mode
- local lifecycle activity counts
- effective broker-read intervals
- last attempt and last successful actual broker sync
- next due time
- forced synchronization state and reason
- market-session degradation and recovery details

No database table, Prisma migration, runtime setting row, or per-decision history is created. After restart, both adaptive workers register normally and begin with startup force state.

### Modes And Cadences

Submitted-order synchronization:

| Local submitted work | Market state | Cadence |
| --- | --- | ---: |
| yes | open | 10s |
| yes | closed | 60s |
| yes | unknown | 10s |
| no | any | no Alpaca open-orders request |

Tracked-position synchronization:

| Local lifecycle activity | Market state | Cadence |
| --- | --- | ---: |
| yes | open | 15s |
| yes | closed | 120s |
| yes | unknown | 15s |
| no | open | 60s |
| no | closed | 300s |
| no | unknown | 60s |

Tracked-position idle polling remains scheduled so externally or observer-created broker positions can still be discovered.

### Local Activity

The coordinator classifies local activity from efficient database counts, not from Alpaca reads. Activity includes submitted/submitting intents, nonterminal broker orders, open or closing tracked positions, active exit state, and active protective/trailing-stop order state.

Submitted-order sync is active only when local submitted intents exist. If none exist, it returns healthy idle without calling Alpaca open orders.

### Market Session Source

The coordinator reuses `getAlpacaMarketSessionSnapshot()` from `src/integrations/alpaca/market-session.adapter.ts`. It does not call `/v2/clock` directly, create a second clock cache, hardcode market holidays, calculate market hours independently, or call the calendar endpoint for cadence decisions.

The existing adapter remains the single source of broker market-open state. Its memory cache, persisted usable clock behavior, and in-flight request deduplication continue to apply.

### Transitions And Failure Fallback

Both adaptive workers are forced when:

- market changes open/closed
- trading date changes
- market-session data recovers after being unavailable
- a relevant broker write succeeds

If market-session lookup fails, adaptive polling treats the market as `unknown`, uses conservative open-market cadence, keeps broker synchronization running, and exposes degraded state in System Status. This does not activate the kill switch, change `risk.canEnter`, block critical writes, or fail the basic health endpoint.

### Forced Sync After Writes

Successful Alpaca writes notify the coordinator instead of launching ad hoc sync calls:

- entry order submission forces submitted-order and tracked-position reads
- close-position requests force submitted-order and tracked-position reads
- protective/trailing-stop order creation forces submitted-order and tracked-position reads
- single order cancellation and cancel-all force submitted-order reads

Idempotency lookups, already-recovered existing broker orders, failed writes, policy-blocked orders, and local-only state changes do not force synchronization.

Forced reads run through the normal scheduler and remain subject to active 429 backoff.

### System Status And Admin UI

`GET /api/system-status` includes `adaptivePolling` with status, market state, mode, market-session cache/degradation details, local activity counts, and per-worker snapshots.

The Admin UI renders this under:

```text
Settings -> System Status -> Adaptive Polling
```

Refreshing System Status reads current in-memory state. It should not create a new Alpaca request merely to render the panel.

## Persistence

`src/services/alpaca-api-usage-persistence.service.ts` periodically flushes in-memory usage buckets to the `AlpacaApiUsageBucket` table.

The persistence worker is registered as:

```text
alpaca_api_usage_persistence
```

This worker is informational. If it becomes delayed, stale, degraded, or failing, System Status marks Alpaca API usage as `degraded` because live counters may still exist but durable usage history is no longer being saved reliably.

Usage bucket retention is controlled by:

```text
ALPACA_API_USAGE_RETENTION_DAYS
```

The warning threshold for request volume is controlled by:

```text
ALPACA_API_USAGE_WARNING_REQUESTS_PER_MINUTE
```

## Admin UI

The Admin UI shows live Alpaca usage in:

```text
Settings -> System Status -> Alpaca API Usage
```

The panel shows:

- overall usage status
- requests in the last 1 minute and last 5 minutes
- failed requests
- rate-limited requests
- active backoff state
- latest known Alpaca limit, remaining calls, and reset time
- usage persistence status
- top operations and endpoints

This first UI surface is intentionally live-status focused. Historical charts can be added later from `AlpacaApiUsageBucket` if the live panel is not enough.

## Operational Checks

After deploys that touch Alpaca integrations, check:

```text
Settings -> System Status is healthy
Alpaca API Usage status is normal or expected
rate-limited request counts are zero or explainable
Saved Usage Data shows a recent database save
top operations and endpoints match expected worker activity
```

If request counts are unexpectedly high, compare top operations with worker health and backend logs before changing polling cadences.
