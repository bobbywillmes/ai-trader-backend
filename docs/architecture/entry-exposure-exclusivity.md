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

The claim advances monotonically through pending, submitting, broker-active,
partially-filled, filled-awaiting-position, position-open/closing, unresolved,
and released states. A terminal order observation is not itself a release event.
`filled` preserves ownership as `FILLED_AWAITING_POSITION` until position
materialization attaches the claim; delayed order observations cannot downgrade
`POSITION_OPEN`. Partial fills retain ownership while any remaining BUY can execute.
`UNRESOLVED` cannot return to an executable state through ordinary observation;
`RELEASED` is terminal. Repeated unchanged observations do not append events.
Broker timeouts retain ownership.

Position observation never fails merely because claim evidence conflicts. The
real broker exposure is persisted as a backend-managed `TrackedPosition`; the old
claim remains active and becomes `UNRESOLVED`, with both position identities in
its event and Operational Attention evidence. It is not attached to the unrelated
position, and its active uniqueness continues to block additional buying.

Release requires fresh exact originating-order and bounded replacement-chain
observations, a complete paginated open BUY-order view filtered by canonical
symbol, and position-by-symbol evidence outside the transaction, followed by an
account/Security advisory lock and local revalidation. The final order must be
conclusively non-executable (`filled`, `canceled`, `expired`, or `rejected`),
cumulative fills across the chain must be locally accounted, no broker position
or executable symbol BUY may remain, and no local active position or executable
BUY may have appeared. `done_for_day`, `calculated`, and an unverified `replaced`
order do not establish release eligibility. Provider failure, rate limiting,
malformed data, incomplete pagination, or incomplete fills append retryable
diagnostics and retain the current ownership state; identity contradictions use
`UNRESOLVED` and require explicit remediation.

The broker snapshot and final database lock cannot serialize a manual order
created directly in Alpaca between those two moments. This residual external race
is explicit: AI Trader serializes all of its own admissions, fails closed on every
known broker order, and reconciliation will detect later external exposure, but
operators must prohibit/manual-coordinate direct Alpaca BUY creation during claim
release and rollout operations.

The broker BUY adapter boundary independently verifies intent ID, account,
canonical Security/symbol, BUY side, stable client-order ID, submitting intent,
`ENTRY_SUBMITTING` claim, and account environment. This
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

Readiness has two explicit layers. `databaseReady` covers local ownership and
lifecycle integrity. `brokerVerifiedReady` requires fresh account-scoped Alpaca
positions and a complete bounded open-BUY view, and rejects broker-only exposure,
local-only active positions, or unavailable/incomplete evidence. `ready` is true
only when both layers are true and `assessment` is `BROKER_VERIFIED_READY`.
Apply may add protection or dispose of a provably-never-submitted intent, but it
cannot make broker evidence optional and never grants execution authority.

Dry-run is mandatory. Apply records even single-candidate adoption as
`UNRESOLVED`; adoption is not trusted attribution. Active broker BUYs, unresolved
and stranded claims, ambiguous groups, missing Securities, and unclaimed active
positions/intents all keep readiness false. Pending legacy intents without a
claim fail closed at the worker and broker boundary and are never made executable
by absence lookup alone.
Reconciliation reports missing or unresolved claims through `SystemEvent` and
Operational Attention. Its existing lifecycle pass also retries non-UNRESOLVED
claims attached to closed positions in bounded oldest-first batches; failures are
rotated so one bad claim cannot starve later claims. `UNRESOLVED` is never
automatically released by a later observation.

Rollback may revert application code while retaining the additive tables. Do not
drop claim data during rollback. Re-enabling old code weakens the exclusivity
guarantee, so disable new entries first and retain position-management workers.
See `docs/production/entry-exposure-rollout.md` for the deployment checklist.

## Market-policy admission (Phase 3C.2)

Claim acquisition is now invoked only through `admitEntryOrderIntent`, the shared
pre-intent admission boundary used by `submitOrder`. While the PAPER market-policy
runtime rollout is inactive, or for an assignment that is not enforced, admission is
exactly the claim admission described above. For an enforced PAPER assignment, the
market-policy decision is made under row locks before the claim. Only an ALLOWED
decision acquires the claim, and it freezes its obligation in the same transaction.
A rejected decision acquires no claim. See
`docs/architecture/market-policy-pre-intent-enforcement.md`.

## Broker-time enforcement (Phase 3C.3)

A broker-time market-policy refusal happens after the confirmed-absence lookup and
before any dispatch, so it is a definite non-send. The claim is released only through
`releaseUnsubmittedEntryExposureClaim`, which also treats a consumed broker dispatch
authorization (`MarketPolicyBrokerDispatchConsumption`) and a final un-enforced dispatch
authorization (`MarketPolicyBrokerUnenforcedDispatch`) as broker evidence. If it refuses,
the claim becomes `UNRESOLVED` with an `UNSUBMITTED_RELEASE_REFUSED` event; a refusal is
never swallowed. The shared boundary also rejects uncertain, broker-rejected, unknown
or contradictory delivery evidence when no durable dispatch row exists; terminal
status and missing rows are not proof of non-delivery. Transient database failures keep
the prior recoverable state for a bounded scheduler retry. Failures before the lookup
completes keep the existing uncertainty handling.

The account/Security exclusivity invariant lives in the shared release, not in any one
caller. `releaseUnsubmittedEntryExposureClaim` decides and compare-and-sets under the
`entry-exposure:<account>:<security>` advisory lock. It releases an `ENTRY_SUBMITTING`
claim only with a recorded `NOT_SENT_EVIDENCE_RECORDED` event, and an
`ENTRY_PENDING`/`ADMISSION_BLOCKED` claim only because such a claim cannot cross the
broker boundary. It refuses a consumed one-shot LIVE arming, any recorded rejection
(including every 4xx), uncertain or unknown outcome, and an unclosed
`ADAPTER_INVOCATION_STARTED` marker. Every caller (admission, worker, stale recovery,
terminal sweep, deactivation and disarm) persists the delivery classification before it
asks for a release. A failed persistence leaves the claim held, so a second
same-account/Security BUY is refused (`ENTRY_ALREADY_PENDING` or
`ENTRY_EXPOSURE_UNRESOLVED`) for as long as broker exposure is possible. See section 5c
of `docs/architecture/market-policy-broker-time-enforcement.md`.

A failure after a dispatch record committed (a rejection, a local adapter guard, a lost
record acknowledgement, uncertain delivery, or a crash before the adapter) records an
immutable `DISPATCH_OUTCOME_RECORDED` event and holds the claim as `UNRESOLVED`. Only the
evidence-based recovery in `entry-dispatch-recovery.service.ts`, automatically or through
fingerprinted SYSTEM_OWNER remediation, can release it, and never on a lookup miss after
uncertain delivery. Claim events are append-only at the database boundary. Terminal
intents with held claims are reported by readiness as
`terminalIntentsWithUnreleasedClaims`. See section 5b of
`docs/architecture/market-policy-broker-time-enforcement.md`.
