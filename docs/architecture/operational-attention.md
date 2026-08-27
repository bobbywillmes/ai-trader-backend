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
