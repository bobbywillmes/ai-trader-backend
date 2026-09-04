# Lifecycle Repair Workbench

The Lifecycle Repair Workbench is the System Owner surface for evidence-driven,
typed recovery of incomplete local trading lifecycle state. It is not a generic
database editor. Phase 1 registers only `RESOLVE_POSITION_ATTRIBUTION` and marks
that handler `LOCAL_ONLY` with no broker write methods.

## Immutable diagnosis and execution

Diagnosis creates an immutable, numbered `LifecycleRepairCase` generation that
expires after ten minutes. The case freezes target identity, sanitized evidence, candidates and
rejections, before state, exact proposed mutations, configuration and local
lifecycle fingerprints, confidence, provenance, and broker impact. Refreshing
diagnosis creates a new case and supersedes older cases for the same target.

An unchanged usable generation is returned idempotently. Expired or failed
generations are replaced by a freshly built case linked through
`supersedesCaseId`. Refused evidence remains immutable and Preview cannot bypass
it; Reconsider is the only unchanged-evidence renewal path. Only eligible PAPER
actions can be applied. LIVE diagnosis is read-only.

## Historical filled-entry lifecycle repair

`REPAIR_HISTORICAL_ENTRY_LIFECYCLE` handles a historical BUY whose directly
owned local fill stream proves completion while local statuses or position
ownership remain incomplete. Reconciliation projects one
`HISTORICAL_ENTRY_LIFECYCLE_INCOMPLETE` attention episode per account and local
BrokerOrder. Its identity remains stable when terminalization removes
`STALE_ORDER_STATUS` and leaves `MISSING_POSITION_LINK`.

The terminal-order invariant classifies ownership across OrderIntent,
BrokerOrder, and every owned entry FILL as all missing, partial, consistent, or
conflicting. Partial and conflicting states remain visible after terminalization
and are non-executable; the initial link action is limited to all-missing state.

Full-fill evidence requires exact account, BrokerOrder, OrderIntent, and
BrokerActivity ownership; cumulative FILL quantity equal to ordered quantity;
zero leaves; and no identity, terminal-marker, priced-quantity, or missing-price
contradiction. Terminalization changes only local statuses. Position linking is
independent and changes only backend-proposed relationships and link provenance.
Neither action changes broker payloads, fill facts, financial values, exposure,
or timestamps, and neither calls the broker.

A unique closed candidate rejected only by the strict price predicate is
`OPERATOR_CONFIRMATION_REQUIRED`. Broker-average arithmetic is shown only as
non-authoritative corroboration. Refusal is immutable for the action fingerprint
and leaves attention unresolved. Explicit reconsideration requires a reason,
rebuilds evidence, and creates a new generation linked by `supersedesActionId`.

All routes are SYSTEM_OWNER-only. Preview supports PAPER and LIVE; Apply rejects
LIVE. Position sync, activity ingestion, reconciliation, and repair share the
account-level `lifecycle-mutation` advisory barrier. Repair also locks the case,
action, attention, lifecycle rows, activities, and candidate position. Apply
uses count-checked conditional updates, attempt-key idempotency, before/after
audit, and structural validation. Applying one action
supersedes sibling proposals and requires a fresh preview for the next stage.
Authoritative reconciliation resolves attention only after every invariant is
complete. Unchanged observations update occurrence count and `lastObservedAt`
without another event; a material evidence change emits one transition event.
A committed local mutation is `APPLIED`, not `VERIFIED`. Subsequent
authoritative reconciliation independently proves terminal status or complete
position ownership, stores verification evidence, and emits one verified event.
Terminalization may verify while link-only attention remains active. A typed
`operationalAttentionId` relationship connects every historical case to its
episode.

Manual BrokerActivity synchronization acquires the lifecycle barrier. Scheduled
BrokerActivity and position workflows call explicitly named unlocked operations
only below their outer barrier. Submitted-order workflows use the same barrier,
and Live-entry verification acquires it once around order, activity, position,
and reconciliation observations. One account-level lock avoids nested
non-reentrant acquisition and cross-family ordering cycles. Repair additionally
uses a serializable transaction and row locks to detect membership changes at
the transaction boundary.

The July `historical-order-lifecycle` script remains available for read-only
diagnosis. Script Apply mode is deprecated; removal is deferred until the
Workbench demonstrates parity and the real case completes production review.
Apply requires a reason, the typed confirmation
`APPLY POSITION ATTRIBUTION REPAIR`, and a unique attempt key. Executions are
append-only and preserve before/after state, validation, failure evidence, and
actor identity. A partial unique index permits only one successful execution per
case.

## Attribution evidence

The shared resolver supports `LOCAL_ONLY` and `ALLOW_EXACT_ORDER_ID_READ`.
Initial observation may use the exact read policy; later retries use local-only
evidence so deployment cannot silently repair existing unresolved positions.

For an unlinked fill, the exact path is:

```text
BrokerActivity.orderId
-> GET /v2/orders/:orderId
-> strict ai-entry-tas<ID>-<64 lowercase hex> parsing
-> TradingAccountSubscription/account/catalog validation
-> side, timing, fill quantity, and weighted-price corroboration
```

Failures and contradictions stop resolution. They do not fall through to the
symbol-only observer fallback.

## Apply safety

Apply revalidates the frozen broker evidence and configuration under the
account exit-evaluation advisory lock, locks the target row, and performs one
database transaction. It refuses non-null conflicting attribution and refuses
to overwrite meaningful PositionExitState progress. A pristine exit state is
hydrated from the resolved ExitProfile; missing OrderIntent and BrokerOrder rows
are not synthesized.

The exact frozen config snapshot is written during Apply. The same transaction
writes the successful execution and sanitized SystemEvent and runs structural
post-repair validation. Any failure rolls back the local mutation.

The repair itself submits, cancels, or changes no broker order or position.
After commit, ordinary PAPER lifecycle workers may resume and independently
take broker action if configured exit conditions are satisfied.

## Reconciliation and UI

Scheduled reconciliation detects `position_attribution_missing` from local
state only and returns `RESOLVE_POSITION_ATTRIBUTION` deep-link metadata. It
does not diagnose, call the exact broker-order endpoint, create a repair case,
or execute a repair.

The owner-only UI lives at **System -> Lifecycle Repairs**. Operators choose an
explicit TradingAccount and TrackedPosition, diagnose, review evidence and the
exact mutation, and Apply eligible PAPER cases. Ambiguous, strong,
insufficient, expired, superseded, executed, and LIVE states remain visibly
non-executable.
