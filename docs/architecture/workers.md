# Worker Health

The backend monitors every recurring background operation as an independent worker, even when several operations share one timer.

## Inventory

| Key | Display name | Cadence | Criticality | Notes |
| --- | --- | ---: | --- | --- |
| `pending_order_processing` | Pending order processing | 2s | critical | Claims pending `OrderIntent` rows and submits eligible broker orders. |
| `submitted_order_sync` | Submitted order sync | 2s | critical | Refreshes submitted order status from broker open orders. |
| `tracked_position_sync` | Tracked position sync | 2s | critical | Mirrors broker positions into `TrackedPosition` lifecycle state. |
| `exit_evaluation` | Exit evaluation | 2s | critical | Evaluates open positions against configured exit profiles. |
| `account_snapshot_scheduler` | Account snapshot scheduler | 60s | important | Checks whether scheduled account snapshot checkpoints are due. |
| `broker_activity_sync` | Broker activity sync | 60s | critical | Imports broker-confirmed fill activities into `BrokerActivity`. |
| `scheduled_reconciliation` | Scheduled reconciliation | 60s scheduler | important | Checks runtime settings and runs reconciliation when enabled and due. |

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

The in-memory registry is authoritative for the running process. The `WorkerHealthState` database table stores one latest row per worker key for production diagnostics and external monitoring. It is not a tick history table.

## Tick Versus Work

Worker health measures scheduler liveness, not whether useful business work happened.

Healthy outcomes include:

- `success`: the worker ran and completed its responsibility.
- `idle`: the worker ran and found no work.
- `skipped` with `not_due`: the scheduler checked and the operation was intentionally not due.

`lastWorkSucceededAt` is updated only when the worker actually created, updated, imported, or found meaningful business work. A worker can be healthy even when `lastWorkSucceededAt` is null.

`already_running` skips do not refresh `lastSucceededAt`; the original run age determines whether the worker becomes delayed or stale.

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
- a run exceeding `maxRunDurationMs`

Examples that do not count:

- policy-blocked entries
- individual broker order rejection handled for that record
- isolated malformed records when processing continues
- reconciliation findings
- no pending work

## Persistence

The registry marks worker rows dirty after state changes. A background flush writes dirty rows approximately every 30 seconds.

Failures and meaningful status transitions are marked for prompt persistence. Persistence failures are logged with throttling and never mark the business worker failed.

Shutdown stops the persistence timer and performs a bounded best-effort flush.

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

`workersHealthy` means all enabled critical workers are healthy. `tradingReady` combines service health, worker health, and the existing risk-gate `canEnter` value.

Worker health does not automatically enable the kill switch, disable trading, reject signals, restart workers, or restart the process. This branch is diagnostic.

## Troubleshooting

For delayed, stale, failing, or stuck workers:

1. Check `processInstanceId` to confirm the row belongs to the current process.
2. Compare `lastSucceededAt`, `lastFailedAt`, `currentRunStartedAt`, and `lastError`.
3. Check backend container logs around the same timestamp.
4. Inspect related `SystemEvent` rows.
5. Distinguish disabled workers from stale workers.
6. Distinguish no work from no heartbeat.
7. Restart only after identifying whether the cause is configuration, integration failure, database failure, or a stuck run.
