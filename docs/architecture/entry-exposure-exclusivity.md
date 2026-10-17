# Durable entry exposure exclusivity

Phase 3C.0 enforces one entry lifecycle per `TradingAccount` and canonical
`Security`. It does not grant Market Intelligence or external-signal execution
authority and does not change sizing.

## Decision

`EntryExposureClaim` is append-preserving ownership evidence. PostgreSQL's
`EntryExposureClaim_active_account_security_key` partial unique index permits
only one row with `releasedAt IS NULL` for an account/security pair. `Security`
is used instead of a free-form symbol; the existing unique `Security.symbol`
constraint remains the canonical normalization boundary.

An `OrderIntent` cannot itself provide the constraint because retry/history rows
are legitimate and it does not span broker uncertainty through position closure.
The active-position partial unique index starts too late. Account advisory locks
serialize workers but disappear on process exit and are not an ownership record.

The claim is retained when a `TrackedPosition` is attached. There is no transfer
or deletion gap, and the position remains the source of truth for quantity and
position state. `EntryExposureClaimEvent` records ownership transitions.

## Lifecycle

Admission creates the `OrderIntent` and claim in one transaction. A retry with
the same stable owner key returns the original intent. Another strategy,
subscription, signal source, or request receives a 409 with a machine code such
as `ENTRY_ALREADY_PENDING`, `ALREADY_IN_POSITION`, `POSITION_CLOSING`, or
`ENTRY_EXPOSURE_UNRESOLVED`.

The claim advances through pending, submitting, broker-active, filled-awaiting-
position, position-open, and unresolved states. Broker timeouts retain ownership.
Position observation attaches the claim transactionally. Confirmed disappearance
from the authoritative broker position snapshot closes the tracked position and
then releases ownership. Admission- or worker-risk blocks may release only before
broker/position evidence exists. A rejected, canceled, or expired broker order may
release only after zero fills and zero active position are established.

The broker BUY adapter boundary independently requires an active claim. This
prevents legacy or future callers from bypassing admission.

## Producers

The direct orders API, n8n subscription signals, targeted account-assignment
signals, Momentum handoffs, PAPER lifecycle exercises, and LIVE acceptance all
converge on `submitOrder`. Worker retries use the same `OrderIntent` and stable
client-order ID. Exit services create sell intents through separate verified
position boundaries and do not acquire entry claims.

## Rollout and recovery

The migration creates schema and constraints only. It does not infer ownership
from historical symbols. Before runtime deployment, run:

```bash
npm run entry-exposure:readiness
npm run entry-exposure:readiness -- --apply
```

Dry-run is mandatory. Apply adopts only a single unambiguous active position, or
a single unresolved entry lifecycle, for an account/security pair. Ambiguous
groups and missing Securities exit nonzero and require operator review. Pending
legacy intents without a claim fail closed at the worker and broker boundary.
Reconciliation reports missing, unresolved, or stranded claims through
`SystemEvent` and Operational Attention. It never clears them automatically.

Rollback may revert application code while retaining the additive tables. Do not
drop claim data during rollback. Re-enabling old code weakens the exclusivity
guarantee, so disable new entries first and retain position-management workers.
See `docs/production/entry-exposure-rollout.md` for the deployment checklist.
