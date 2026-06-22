# Production Troubleshooting

This doc covers post-deploy verification steps and common production issues: 502 errors, blocked startup due to trading state, migration mismatches, and non-critical build warnings.

---

## ✅ Post-Deploy Verification

After each production deploy, verify the public health endpoint:

```bash
curl -s https://srv1700402.hstgr.cloud/health
```

Expected result:

```json
{
  "ok": true,
  "service": "ai-trader-backend",
  "environment": "production",
  "database": {
    "ok": true,
    "message": "Database reachable."
  }
}
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

```text
environment=production
database reachable
broker mode=paper
tradingEnabled=false unless deliberately enabled
paperMode=true
killSwitchEnabled=false unless deliberately enabled
readiness.serviceHealthy=true
readiness.workersHealthy=true after startup grace
workers.health.summary.processInstanceId is current
pendingOrderCount=0
submittingOrderCount=0
submittedOrderCount=0
alpacaApiUsage.status is normal or explainable
alpacaApiUsage.persistence.lastFlushSucceededAt is recent after startup
adaptivePolling.status is normal or explainable
adaptivePolling.marketState matches the current market session or is degraded with a clear sanitized error
```

Also verify from the browser:

```text
Admin UI loads
Login works
Dashboard loads
Settings → System Status is healthy
Settings -> System Status -> Alpaca API Usage is visible
Settings -> System Status -> Adaptive Polling is visible
Open Orders is empty unless expected
Recently changed feature works in production
```

For adaptive Alpaca polling rollouts, also confirm:

```text
no Prisma migration is required
all workers become healthy after startup grace
closed-market active cadence is selected when positions are open
submitted-order sync reports idle and makes no broker request when no submitted intents exist
Alpaca API Usage shows lower submitted_order_sync and tracked_position_sync request counts after rollout
a successful paper order during regular market hours forces prompt order and position synchronization
order, fill, tracked-position, and exit lifecycle behavior remains intact
simulated market-clock failure selects unknown/degraded conservative polling in local tests
rate-limit deferral remains covered by deterministic local tests
at least one open/closed or closed/open market transition is observed when practical
```

Rollback is application-only. No database rollback should be necessary because adaptive polling state is process-local and no migration is created.

---

## ⚠️ 502 Bad Gateway

If `/health` returns `502 Bad Gateway`, Caddy is reachable but the backend is probably not running or is crash-looping.

Check:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=100 backend
```

---

## ⚠️ Blocked Startup: Trading Already Enabled

If the database has `tradingEnabled=true` and production env has `ALLOW_TRADING_ENABLED_ON_START=false`, startup will fail. This is intentional — it prevents an accidental production restart into an already-trading state.

Preferred recovery flow:

1. Keep `ALLOW_TRADING_ENABLED_ON_START=false`.
2. Update the production database setting directly to `tradingEnabled=false`.
3. Restart the backend.
4. Verify `/health` and the Admin UI.
5. Re-enable trading manually from Settings only when ready.

Check the runtime settings directly in production Postgres:

```bash
docker compose -f docker-compose.prod.yml exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT key, value FROM \"Setting\" WHERE key IN ('\''tradingEnabled'\'', '\''paperMode'\'', '\''killSwitchEnabled'\'') ORDER BY key;"'
```

Disable trading:

```bash
docker compose -f docker-compose.prod.yml exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "UPDATE \"Setting\" SET value = '\''false'\'', \"updatedAt\" = now() WHERE key = '\''tradingEnabled'\'';"'
```

Restart the backend:

```bash
docker compose -f docker-compose.prod.yml up -d backend
```

---

## ⚠️ Migration Mismatch

See [database-migrations.md](database-migrations.md) for migration mismatch symptoms and fix commands.

Lifecycle-review deployments are especially sensitive to missing-column mismatches because Trade History, Reports, and broker-activity ingestion now rely on newer ownership and snapshot fields such as:

```text
trackedPositionId
trackedPositionLinkSource
configSnapshotJson
configSnapshotCapturedAt
```

If the admin UI loads but lifecycle fields are unexpectedly blank for new trades, first confirm the related migration was deployed before investigating the application logic.

---

## ⚠️ Trade History or Reports Missing Expected Data

If Trade History or Reports load but a recently closed trade is missing key data:

Check:

```text
the cycle actually reached status=closed
the close fill was imported into BrokerActivity
the close fill was linked to the expected tracked-position cycle
the production database and development observer database are not being confused
```

Important distinction:

```text
older legacy cycles may still show null fields because they predate lifecycle attribution or config snapshots
newly closed trades in this branch should populate close-fill and reporting fields when attribution succeeds
```

---

## ⚠️ Admin UI Bundle Warning

The admin UI build may show a Vite warning about chunks larger than 500 kB. This is currently treated as a non-blocking performance warning.

The admin UI is an internal control panel, and the build completes successfully.

---

## ℹ️ Alpaca Response Normalization

The backend intentionally uses normalized response shapes.

Alpaca returns many numeric fields as strings. The backend converts key values to numbers before returning them to n8n, the admin UI, or future clients. This protects the rest of the AI Trader system from depending on raw Alpaca response formats.

---

## ℹ️ Worker Health Delayed, Stale, or Failing

Worker health is surfaced in Settings -> System Status and in the protected `/api/system-status` response.

Check:

```text
workers.health.summary.processInstanceId
workers.health.summary.processStartedAt
the affected worker lastSucceededAt
the affected worker lastFailedAt
the affected worker currentRunStartedAt
the affected worker lastError
related worker_health.* SystemEvents
backend container logs around the same timestamps
```

Important distinctions:

```text
disabled = intentionally off and not unhealthy
idle or not_due = healthy scheduler heartbeat with no business work
delayed = heartbeat older than the delay threshold
stale = heartbeat overdue, never succeeded after grace, or run timeout
failing = at least three consecutive top-level failures
```

Do not restart immediately just because a worker is stale. First identify whether the cause is runtime configuration, Alpaca integration failure, database failure, or a stuck run.

Worker health is diagnostic only. It does not automatically enable the kill switch, disable trading, reject signals, or restart containers.

See [Worker Health](../architecture/workers.md) for full status semantics.

---

## Alpaca API Usage Warnings or Rate Limits

Alpaca API usage is surfaced in Settings -> System Status -> Alpaca API Usage and in the protected `/api/system-status` response as `alpacaApiUsage`.

Use it when production appears healthy but broker polling or Alpaca calls are heavier than expected.

Check:

```text
alpacaApiUsage.status
alpacaApiUsage.warning.active
alpacaApiUsage.rateLimit.active
alpacaApiUsage.rateLimit.backoffUntil
alpacaApiUsage.rateLimit.latestKnownRemaining
alpacaApiUsage.persistence.lastFlushSucceededAt
alpacaApiUsage.persistence.pendingAggregateCount
top operations
top endpoints
```

Status meanings:

```text
normal = request volume and persistence look healthy
elevated = request volume crossed ALPACA_API_USAGE_WARNING_REQUESTS_PER_MINUTE
rate_limited = Alpaca returned 429 and the backend is in backoff
degraded = usage persistence worker is unhealthy
```

During active rate-limit backoff, nonessential safe read polling may be deferred and reported as healthy `not_due` worker skips. Critical broker write paths keep their existing behavior.

If request counts look unexpectedly high:

1. Compare top operations and endpoints with worker health.
2. Check backend logs around the same timestamps.
3. Confirm there are no overlapping local/dev backends polling the same Alpaca account.
4. Review recent code changes before adjusting worker cadences.

See [Alpaca Integration](../integrations/alpaca.md) for the full request instrumentation and persistence model.

---

## Adaptive Polling Degraded Or Unexpected Cadence

Adaptive polling is surfaced in Settings -> System Status -> Adaptive Polling and in `/api/system-status` as `adaptivePolling`.

Check:

```text
adaptivePolling.status
adaptivePolling.marketState
adaptivePolling.mode
adaptivePolling.marketSession.consecutiveFailures
adaptivePolling.marketSession.lastError
adaptivePolling.localActivity
adaptivePolling.workers.submittedOrderSync
adaptivePolling.workers.trackedPositionSync
alpacaApiUsage.rateLimit.active
```

Expected behavior:

```text
normal adaptive skips are healthy not_due worker ticks
market closed is not an attention state by itself
unknown market state uses conservative cadence
submitted-order sync is not scheduled when there are no submitted intents
tracked-position sync remains scheduled even when local lifecycle is idle
forced state clears only after the relevant broker read succeeds
active 429 backoff can defer forced reads
```

If the panel is degraded because Alpaca market session cannot be read, inspect backend logs and Alpaca API Usage before changing trading settings. The degraded polling state does not activate the kill switch, block critical writes, or directly change `risk.canEnter`.
