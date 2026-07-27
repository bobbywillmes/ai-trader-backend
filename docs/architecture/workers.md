# Worker Health

The backend monitors every recurring background operation as an independent worker, even when several operations share one timer.

## Inventory

| Key | Display name | Cadence | Criticality | Notes |
| --- | --- | ---: | --- | --- |
| `pending_order_processing` | Pending order processing | 2s | critical | Claims pending `OrderIntent` rows and submits eligible broker orders. |
| `submitted_order_sync` | Submitted order sync | 2s scheduler | critical | Adaptive Alpaca open-order read; keeps submitted order status fresh without polling every heartbeat. |
| `tracked_position_sync` | Tracked position sync | 2s scheduler | critical | Adaptive Alpaca positions read; mirrors broker positions into `TrackedPosition` lifecycle state. |
| `exit_evaluation` | Exit evaluation | 2s | critical | Evaluates open positions against configured exit profiles. |
| `account_snapshot_scheduler` | Account snapshot scheduler | 60s | important | Checks whether scheduled account snapshot checkpoints are due. |
| `broker_activity_sync` | Broker activity sync | 60s | critical | Imports broker-confirmed fill activities into `BrokerActivity`. |
| `scheduled_reconciliation` | Scheduled reconciliation | 60s scheduler | important | Checks runtime settings and runs reconciliation when enabled and due. |
| `alpaca_api_usage_persistence` | Alpaca API usage persistence | 30s | informational | Flushes in-memory Alpaca REST API usage buckets to `AlpacaApiUsageBucket`. |

The centralized definitions live in `src/workers/worker-health.definitions.ts`. The scheduler and System Status use these same definitions so displayed cadence does not drift from real timer cadence.

## Architecture

`src/services/worker-health.service.ts` owns the current-process in-memory registry. It generates a unique `processInstanceId` at startup and tracks raw runtime state for each worker.

The scheduler uses a monitored wrapper around each operation:

```text
begin tick
-> run worker operation
-> record success, idle, skipped, or failed outcome
-> derive current status
-> mark state dirty for bounded persistence
```

The in-memory registry is authoritative for coordinator health in the running
process. The `WorkerHealthState` database table stores one latest global row per
worker key for production diagnostics and external monitoring. It is not a tick
history table.

Account-scoped workflows also persist `TradingAccountWorkerHealthState`, with
one current row per `tradingAccountId` and `workerKey`. This account state is
separate from coordinator health and records applicability or dormancy,
successes and failures, freshness, current runs, persistent backoff, lock
contention, and interrupted prior-process runs.

## Tick Versus Work

Worker health measures scheduler liveness, not whether useful business work happened.

Healthy outcomes include:

- `success`: the worker ran and completed its responsibility.
- `idle`: the worker ran and found no work.
- `skipped` with `not_due`: the scheduler checked and the operation was intentionally not due.

`lastWorkSucceededAt` is updated only when the worker actually created, updated, imported, or found meaningful business work. A worker can be healthy even when `lastWorkSucceededAt` is null.

`already_running` skips do not refresh `lastSucceededAt`; the original run age determines whether the worker becomes delayed or stale.

## Adaptive Broker Reads

`submitted_order_sync` and `tracked_position_sync` enter the worker-health wrapper every two-second trading scheduler heartbeat, but their Alpaca REST reads are gated by the adaptive polling coordinator.

Worker-health `expectedIntervalMs` remains two seconds for both workers because that field represents scheduler liveness. The effective Alpaca polling interval is exposed separately in `systemStatus.adaptivePolling`.

Normal adaptive skips are healthy `skipped` + `not_due` outcomes. They do not count as worker failures and do not update `lastWorkSucceededAt`.

Important distinctions:

- `submitted_order_sync` with no local submitted intents is healthy idle/skipped behavior and makes no Alpaca open-orders request.
- `tracked_position_sync` continues idle polling on a slower cadence so externally created broker positions can be discovered.
- actual broker read failures still fail only the relevant worker tick and use bounded adaptive retry.
- rate-limit deferrals remain healthy `not_due` skips and preserve the forced state until a later broker read succeeds.

Effective broker-read cadences are documented in [Alpaca Integration](../integrations/alpaca.md).

Submitted-order and position ticks are multi-account coordinators. They
enumerate workflow-eligible accounts in stable ID order, run sequentially, and
isolate failures. Adaptive due/backoff state and caches are account-keyed, so
one account cannot suppress another account's work. Broker activity and
scheduled snapshots use the same coordinator pattern.
Exit/protective evaluation and scheduled reconciliation also use this pattern.
Item-level failures remain visible in account summaries and cannot be hidden
inside `PROCESSED`.

Credentialless dormant accounts are skipped before any broker request.
Credentialless accounts with lifecycle exposure return a critical structured
result while retaining local state. Global `WorkerHealthState` rows describe
coordinator health, while `TradingAccountWorkerHealthState` preserves the
result and freshness of each applicable account workflow.

Coordinators finish processing every eligible account before reporting health.
Any `FAILED` account or `CREDENTIALS_UNAVAILABLE` account with lifecycle work
causes the coordinator-level tick to fail with a sanitized aggregate message.
A successful account plus a failed account is therefore visible as a worker
failure rather than success. Dormant credentialless accounts with no work
remain normal skips.

Adaptive worker state, market-session evaluation, recovery history, failure
counts, and broker-write force signals are keyed by `tradingAccountId`. A
successful Live clock lookup cannot clear Paper degradation, and a broker write
forces follow-up polling only for the owning account.

## Account Workflow Locking

Each account workflow acquires a PostgreSQL advisory lock through a dedicated
`pg` session. The session and lock are held for the entire account workflow,
including broker calls and final health persistence.

Important guarantees:

- scheduled and manual operations share the appropriate lock family when they
  must not overlap;
- account health and persistent backoff are finalized before the lock is
  released;
- lock contention cannot overwrite the active owner's current-run marker;
- an interrupted prior-process run remains visible and is recovered or
  superseded deliberately by a later owning run;
- one account's lock contention does not prevent later eligible accounts from
  being processed by the coordinator.

The advisory lock prevents concurrent ownership across backend processes. Local
in-process guards still prevent duplicate timer overlap inside one process.

## Statuses

Status is derived from raw state at evaluation time with this priority:

1. `disabled`
2. `failing`
3. `stale`
4. `delayed`
5. `degraded`
6. `starting`
7. `healthy`

Definitions:

- `disabled`: intentionally disabled by runtime configuration.
- `starting`: registered but not yet successful and within startup grace.
- `healthy`: recent successful, idle, or not-due scheduler tick.
- `degraded`: one or two consecutive top-level failures.
- `delayed`: last successful scheduler tick is older than `delayedAfterMs`.
- `stale`: heartbeat is overdue, the worker never succeeded after startup grace plus stale threshold, or a current run exceeded `maxRunDurationMs`.
- `failing`: at least three consecutive top-level failures.

Threshold defaults are derived from each cadence:

```text
startupGraceMs = max(expectedIntervalMs * 3, 15 seconds)
delayedAfterMs = max(expectedIntervalMs * 2.5, 15 seconds)
staleAfterMs = max(expectedIntervalMs * 5, 60 seconds)
```

`maxRunDurationMs` is set per worker definition because reconciliation and broker sync may legitimately take longer than lightweight polling.

## Failure Semantics

Only top-level inability to perform a worker responsibility counts as worker failure.

Examples that count:

- database query failure that prevents the tick
- broker request failure that prevents synchronization
- unexpected uncaught exception
- malformed top-level integration response
- a failed exit or reconciliation account outcome
- unavailable credentials while an account owns exposure or unresolved orders
- an isolated exit/protective item reported as failed
- a run exceeding `maxRunDurationMs`

Examples that do not count:

- policy-blocked entries
- individual broker order rejection handled for that record
- isolated malformed records when processing continues
- reconciliation findings
- no pending work

## Persistence

The coordinator registry marks `WorkerHealthState` rows dirty after state
changes. A background flush writes dirty rows approximately every 30 seconds.

Account workflows persist `TradingAccountWorkerHealthState` at workflow
boundaries. Current-run ownership is recorded after lock acquisition, and the
final outcome, freshness, counters, and backoff are persisted before the
advisory lock is released.

Failures and meaningful status transitions are marked for prompt persistence.
Persistence failures are logged with throttling and never mark an unrelated
business worker failed.

Shutdown stops the coordinator persistence timer and performs a bounded
best-effort flush. Persisted account state allows the next process to identify
an interrupted prior-process run rather than treating it as a clean idle state.

## Transition Events

The registry creates `SystemEvent` records only for meaningful transitions:

- healthy, degraded, or delayed -> stale
- any non-failing state -> failing
- stale or failing -> healthy

It does not create an event every tick, every System Status request, or for the initial starting -> healthy transition.

## System Status

`GET /api/system-status` includes:

- `readiness.serviceHealthy`
- `readiness.workersHealthy`
- `readiness.canEnter`
- `readiness.tradingReady`
- `readiness.needsAttention`
- `workers.health.summary`
- `workers.health.items`

`workersHealthy` means all enabled critical coordinator workers are healthy.
`tradingReady` combines service health, coordinator health, and the existing
risk-gate `canEnter` value.

RBAC-protected Trading Account APIs and the Trading Account UI expose
account-level worker health and readiness separately. A healthy coordinator does
not hide a failed, stale, backed-off, locked, or inapplicable account workflow.

Worker health does not automatically enable the kill switch, disable trading,
reject signals, restart workers, or restart the process. It remains diagnostic
and contributes explicit blockers to readiness.

## Alpaca API Usage

System Status also includes `alpacaApiUsage`, which is separate from worker health but uses worker health as one input.

The Alpaca usage snapshot tracks live broker REST traffic, rate-limit incidents, active backoff state, request durations, top operations, top endpoints, and usage persistence state. The Admin UI renders this under Settings -> System Status -> Alpaca API Usage.

If the `alpaca_api_usage_persistence` worker becomes delayed, stale, degraded, or failing, `alpacaApiUsage.status` is reported as `degraded`. This means live request counters may still be available in memory, but durable bucket persistence is unhealthy.

See [Alpaca Integration](../integrations/alpaca.md) for request metadata, rate-limit, and persistence details.

## Adaptive Polling Status

System Status includes `adaptivePolling` for the process-local broker-read coordinator. This section shows:

- normal or degraded coordinator status
- market state and mode
- cached market-session metadata and sanitized error details
- local lifecycle activity counts
- per-worker effective interval, force state, last attempt, last successful actual broker sync, and next due time

Adaptive market-session degradation is visible here but does not directly change `readiness.serviceHealthy`, `readiness.workersHealthy`, `readiness.canEnter`, or `readiness.tradingReady`.

## Troubleshooting

For delayed, stale, failing, or stuck workers:

1. Check global `WorkerHealthState` to determine whether the coordinator itself
   is unhealthy.
2. Inspect the affected account's `TradingAccountWorkerHealthState`, including
   applicability, last outcome, freshness, current-run owner, backoff, and lock
   contention.
3. Compare `processInstanceId`, `lastSucceededAt`, `lastFailedAt`,
   `currentRunStartedAt`, and `lastError`.
4. Check backend container logs around the same timestamp.
5. Inspect related `SystemEvent` rows.
6. Distinguish dormancy or no work from a missing heartbeat.
7. Determine whether another process or manual operation owns the advisory lock.
8. Restart only after identifying whether the cause is configuration,
   integration failure, database failure, lock ownership, or an interrupted run.
