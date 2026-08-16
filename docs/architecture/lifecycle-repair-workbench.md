# Lifecycle Repair Workbench

The Lifecycle Repair Workbench is the System Owner surface for evidence-driven,
typed recovery of incomplete local trading lifecycle state. It is not a generic
database editor. Phase 1 registers only `RESOLVE_POSITION_ATTRIBUTION` and marks
that handler `LOCAL_ONLY` with no broker write methods.

## Immutable diagnosis and execution

Diagnosis creates an immutable `LifecycleRepairCase` that expires after ten
minutes. The case freezes target identity, sanitized evidence, candidates and
rejections, before state, exact proposed mutations, configuration and local
lifecycle fingerprints, confidence, provenance, and broker impact. Refreshing
diagnosis creates a new case and supersedes older cases for the same target.

Only `DETERMINISTIC` PAPER cases can be applied. LIVE diagnosis is read-only.
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
