# Operational attention foundation

`SystemEvent` and `OperationalAttention` answer different questions.
`SystemEvent` is append-only evidence of what happened at a particular time.
Its persisted `severity` is immutable and is never inferred from the event type.
The legacy `processed` column is deprecated and unused; it is retained only for
schema compatibility. A future event consumer must use per-consumer delivery
state instead of that shared Boolean.

`OperationalAttention` is mutable current state for a condition that still
requires awareness or action. Every episode belongs to one TradingAccount and
may reference one primary TrackedPosition, OrderIntent, and BrokerOrder. The
service validates that all linked records belong to the same account. Attention
details are sanitized snapshots; credentials, tokens, authorization values,
passwords, and API secrets are redacted.

## Episode lifecycle

Episodes move from `OPEN` to `ACKNOWLEDGED` or `RESOLVED`.
Acknowledgement records who saw the condition but keeps its active identity and
does not dismiss it. Resolution releases the nullable unique `activeKey`.
`AUTHORITATIVE_ONLY` episodes require authoritative evidence;
`MANUAL_ALLOWED` episodes may also be resolved by an operator with a nonblank
reason. Resolved episodes are terminal.

`fingerprint` permanently identifies the condition class and affected context.
While unresolved, `activeKey` equals the fingerprint. Repeated observation
refreshes the same row, increments its occurrence count, updates current
sanitized details, and may escalate severity. Severity never silently decreases.
After resolution, a recurrence creates a new episode with the same fingerprint
and a new ID.

Opening, escalation, acknowledgement, and resolution create immutable
SystemEvents in the same transaction. `OperationalAttentionSystemEvent` links
those events to the episode. Identical repeated observations do not emit event
spam. Database constraints enforce active/resolved key consistency and manual
resolution evidence.

## Compatibility and access

The existing `PositionExitState.attention*` fields remain the position-exit
domain projection. This foundation does not migrate, replace, clear, or dual-write
them. Reconciliation integration belongs to a later branch.

RBAC reserves four permissions. System Owners receive read, acknowledge,
resolve, and manual-resolve permissions. Operators receive read and acknowledge
permissions and must remain account-membership scoped when routes are added.
Account Users receive none. This branch provides no attention routes or UI.

## Deferred operational work

The planned Dashboard will show unresolved attention and offer **Review & close**
only where the backend derives an available corrective action. It will open the
correct account-scoped position context and label the action **Close remaining
broker position**, never **Resolve attention**. Confirmation will use a
server-derived preview and final execution will reverify Alpaca immediately
before submission. Only authoritative broker/lifecycle evidence resolves the
episode; removing exposure may instead downgrade it to lifecycle review when the
accounting remains unexplained.

No corrective action is persisted as a potentially stale database flag. Future
actions are derived from attention code, state, authority, role, and fresh
evidence. Broker-facing work remains System Owner only initially and retains all
production-executor, risk-reducing approval, locking, idempotency, recovery, and
evidence controls.

Automatic exit-quantity clamping remains deferred. Current trade-cycle and fill
attribution semantics can misstate quantity and realized P&L when a smaller
broker quantity is exited. This foundation changes no exit evaluation, order
submission, position close, reconciliation attention, or broker behavior.

## SystemEvent severity policy

Every production event producer assigns severity intentionally. Routine audit
helpers deliberately default to `INFO`; failure and safety-sensitive domains
derive severity from structured state rather than event-name text.

- `INFO` records expected success, normal lifecycle transitions, and successful
  deterministic recovery. Recovery payloads retain stable client-order and
  broker-order identity so they can later provide resolution evidence.
- `WARNING` records bounded degradation where a safety control worked, including
  policy blocks, lock contention, approval invalidation, and global Alpaca API
  volume or rate-limit thresholds.
- `ERROR` records known-contained failures such as definite rejection, Paper
  delivery uncertainty, failed credential verification, and close-fill
  attribution ambiguity after exposure is authoritatively zero.
- `CRITICAL` is reserved for potentially unmanaged or unverifiable Live exposure,
  including Live delivery uncertainty, unattributed authoritative Live positions,
  and stale exposure-critical account workers in the production executor.

Context-derived decisions use persisted account environment, deployment role,
delivery classification, attribution provenance, worker responsibility, and
local exposure/order evidence already available at the producer. They do not add
broker calls. Global worker and Alpaca API events are never promoted to critical
without account and exposure scope; the account-scoped consequence carries that
severity instead.

A critical SystemEvent remains immutable evidence, not current attention.
Automatic creation or resolution of OperationalAttention from these events is
deferred to the integration phase.
