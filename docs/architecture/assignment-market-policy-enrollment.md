# Assignment Market-Policy Enrollment (Phase 3A)

Phase 3A adds explicit, PAPER-only enrollment configuration for one exact
`TradingAccountSubscription`. It does not change trading behavior.

## Authority boundary

Every API projection reports `authority: CONFIGURATION_ONLY` and
`enforcementEnabled: false`. `PREPARED` and `ACTIVE` describe configuration
lifecycle only. They do not authorize order evaluation or execution.

Each generation has nullable `enforcementAuthorityVersion` and
`enforcementAuthorizedAt` fields. PostgreSQL requires both to remain null in
Phase 3A. A later enforcement phase must remove that constraint deliberately
and add a separate, explicit owner authorization workflow. It must never infer
enforcement authority from an existing `ACTIVE` configuration. There is no
default-on enforcement flag.

## Identity and lifecycle

`AssignmentMarketPolicyEnrollment` is the stable aggregate and is unique by
`TradingAccountSubscription.id`. Backend-assigned generations bind the exact
account, assignment, Strategy, active Strategy-owned policy revision, account
holder, and configuration fingerprint.

The lifecycle is `PREPARED -> ACTIVE -> DISABLED` or `PREPARED -> DISABLED`.
`DISABLED` is terminal. Re-enrollment creates the next generation and never
rewrites history. Preparation and activation require an enabled SYSTEM_OWNER;
account membership alone is insufficient. Account operational posture and the
current shadow market outcome do not gate activation. Ownership changes and
policy revision replacement make a retained generation not ready without
rewriting it.

PostgreSQL triggers independently reject mismatched assignment/policy identity,
non-PAPER preparation or activation, illegal lifecycle changes, mutation of
transition history, and PAPER-to-LIVE changes while a PREPARED or ACTIVE
generation remains. Partial indexes limit each aggregate to one PREPARED and
one ACTIVE generation.

## Read-only preview

Preview GETs only read assignment, policy, enrollment, and the latest persisted
shadow eligibility decision. They do not invoke the publishing evaluator and
therefore do not create decisions, audit records, or System Events. The result
separates configuration readiness from current market eligibility and reports
absence of persisted evaluation as a technical `NOT_EVALUATED` state.
`BLOCKED` and `INSUFFICIENT_EVIDENCE` are informational business outcomes and
do not prevent configuration activation.

## OrderIntent coverage boundary

Phase 3B.1 adds only exception-contained, compare-only identity coverage beside an
applicable OrderIntent. It does not add authorization obligations, synchronous
eligibility evaluation, broker-stage decisions, or trading-path enforcement. See
`docs/architecture/order-intent-market-policy-coverage.md`.

A future enforcement milestone must preserve this contract:

- Unenrolled requests retain existing behavior.
- A policy-blocked pre-intent request records immutable authorization-attempt
  evidence and creates no OrderIntent.
- A successfully authorized enrolled request atomically freezes its exact
  enrollment obligation with the OrderIntent.
- Broker-stage failures keep that intent and move it to the existing terminal
  blocked or failed status.
- Disabling enrollment does not release a frozen intent obligation.
- Existing broker-order recovery and stable client-order ID behavior remain
  authoritative.

Broker-stage locking and the minimum evidence lifetime remain deferred.
