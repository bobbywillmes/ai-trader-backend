# Trading Account Worker Coordination

Coordinator `WorkerHealthState` remains process-wide. `TradingAccountWorkerHealthState`
adds one durable row per account/workflow and records applicability, freshness,
failures, contention, and retry state without storing credentials or broker payloads.
Dormant/non-applicable workflows do not become stale. Backoff and contention never
clear an earlier operational failure.

## Advisory lock families

Locks use a dedicated `pg` session retained for the complete account operation.
The stable scope is `ai-trader:<family>:<tradingAccountId>` and its PostgreSQL
`bigint` key is the first signed 64 bits of SHA-256. Unlock and client release occur
in `finally`; connection loss releases the PostgreSQL session lock.

| Family | Intended workflows | Expected maximum | Contention |
| --- | --- | --- | --- |
| `order-lifecycle` | stale intent recovery, pending submission, submitted sync | 45 seconds | normal skip; stale if freshness is lost |
| `broker-activity` | activity import/materialization | 90 seconds | normal skip |
| `position-sync` | broker-to-local position synchronization | 45 seconds | normal skip |
| `exit-evaluation` | exit and protective evaluation | 30 seconds | attention-worthy when exposure freshness is lost |
| `reconciliation` | scheduled and manual account reconciliation | 120 seconds | normal skip; manual caller receives conflict |
| `account-snapshot` | scheduled and manual snapshot capture | 30 seconds | normal skip |

Emergency close is intentionally excluded: its durable position close claim is the
more precise exclusion boundary.

## LIVE policy

`LIFECYCLE_READ` needs usable account credentials and no write flag.
`RISK_REDUCING_WRITE` additionally needs
`ALLOW_LIVE_RISK_REDUCING_WRITES=true`. `ENTRY_WRITE` needs both that flag and
`ALLOW_LIVE_TRADING=true`. Both default false, so Bobby Live remains read-only and
dormant. Cancellation metadata must reflect the actual risk effect; cancelling a
protective order is not automatically risk-reducing.

## Deployment

1. Take and verify a database backup.
2. Run the duplicate-active-cycle query from the migration/diagnostic.
3. Build backend and web images.
4. Quiesce old workers for the migration boundary.
5. Run `prisma migrate deploy`.
6. Restart the application.
7. Verify advisory locks and coordinator/account health.
8. Confirm Bobby Live is dormant and both LIVE flags remain false.
9. Run `npm run diagnose:account-worker-health`.

The new table is additive, but old code does not understand the new partial unique
index and can surface uniqueness errors during overlap. Use a brief maintenance
window rather than mixed-version worker execution.
