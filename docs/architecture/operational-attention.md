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
domain compatibility projection. Reconciliation continues to update qualifying
exit-state findings while current operator surfaces use `OperationalAttention`.

RBAC reserves four permissions. System Owners receive read, acknowledge,
resolve, and manual-resolve permissions. Operators receive read and acknowledge
permissions and must remain account-membership scoped when routes are added.
Account Users receive none. Membership-scoped routes and operator UI enforce
these permissions.

## Deferred operational work

The Dashboard shows unresolved attention and review links only. Corrective
broker actions such as **Close remaining broker position** remain deferred to a
separately authorized workflow with fresh broker verification.

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
High-severity events do not create attention generically. Only explicit domain
producers with authoritative current-state rules may open or resolve episodes.

## Current surfacing and producers

`OperationalAttention` is now the authoritative current-state store for the
Dashboard, dedicated page, and navigation badge. `SystemEvent` remains the
immutable evidence store. `PositionExitState.attention*` remains a compatibility
projection and reconciliation continues to update it for qualifying exit-state
findings; it can be derived or removed only after its remaining consumers have
migrated.

Reconciliation uses an explicit eligibility registry rather than severity
alone. Missing authoritative lifecycle attribution, unavailable or problematic
protective trailing exits, broker/local quantity or side disagreement, and a
tracked position missing at the broker are eligible. A complete authoritative
run opens or refreshes present fingerprints and resolves only absent
reconciliation-owned fingerprints. Failed, partial, dry, and observation-only
Live runs do not resolve or create action-required local episodes. Expected
observer limitations remain visible as findings and SystemEvent evidence.

Account worker attention is also consequence-aware. A failing or stale
exposure-critical worker creates attention only when persisted local open
positions, unresolved order delivery, or pending fill attribution makes the
failure operationally relevant. Stale authoritative Live evidence is critical;
Paper and pre-stale failures are errors. Lock contention remains historical
evidence. Healthy recovery resolves only the matching account/worker episode.

Operators may read and acknowledge member-account attention; System Owners have
global scope and may manually resolve only `MANUAL_ALLOWED` episodes. Account
Users have no attention API or UI. Acknowledgement means “seen” and stays in
unresolved counts. Dashboard scope follows the selected account but unions in
accessible critical Live episodes so Paper selection cannot hide them. Failed
queries render unknown/unavailable, never the healthy empty state.

The dedicated page defaults to unresolved (`OPEN` plus `ACKNOWLEDGED`). Its
canonical mixed-history filter is `status=all`, which includes `OPEN`,
`ACKNOWLEDGED`, and `RESOLVED` in one server query. Unresolved episodes sort
before resolved history; resolved episodes sort by most recent resolution.
The navigation badge is the membership-scoped unresolved episode count, not an
unread-notification count. Acknowledgement therefore remains counted. A later
material severity escalation returns an acknowledged episode to `OPEN` and
appends immutable escalation evidence without creating another episode.

## Safe local Paper demonstration

The demo command uses the real attention service and no broker adapter. It
refuses production, production-executor authority, Live accounts, and invalid
account IDs. Replace `2` with an explicit local Paper TradingAccount ID:

```powershell
npm.cmd run demo:operational-attention -- 2 WARNING
npm.cmd run demo:operational-attention -- 2 ERROR
npm.cmd run demo:operational-attention -- 2 CRITICAL
```

The first command opens a `MANUAL_ALLOWED` demo episode. Repeating a severity
refreshes the same episode and increments occurrence count; a higher severity
escalates it. Use the printed URL to acknowledge and manually resolve it with a
reason. Run the warning command after resolution to create a new recurrence,
then verify Dashboard, badge, list, detail, evidence, System Events, and resolved
history. Historical episodes are never deleted.

This branch contains no broker corrective action or trading control. Closing
remaining broker exposure and broker quantity verification remain deferred.

## Corrective actions

Exit-verification quantity episodes may expose a read-only remaining-exposure preview. Only a System Owner may confirm it, and authoritative resolution still requires zero broker exposure plus complete attributed lifecycle closure. See [Remaining Broker Exposure Close](remaining-broker-exposure-close.md).
