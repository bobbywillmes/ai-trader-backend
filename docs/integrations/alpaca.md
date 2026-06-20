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
