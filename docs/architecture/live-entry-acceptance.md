# Live-entry acceptance workflow

The Live-entry acceptance workflow coordinates the first controlled production
canary. It does not create a second entry mechanism. Execution creates one
`OrderIntent` through `submitOrder`, the order worker uses the normal risk
recheck and broker adapter, and the final `NEW_POSITION_ENTRY` boundary retains
independent authority validation and transactional one-shot arming consumption.

## Durable run and bindings

`LiveEntryAcceptanceRun` is the historical ceremony record. Each run is bound
to one Live account, account subscription assignment, subscription, and
security. PostgreSQL permits at most one run with `terminalAt IS NULL` per
account. Terminal runs are never reset or reused.

An acceptance run has at most one `LiveEntryArming` and one `OrderIntent` via
unique optional foreign keys on those records. If an active arming is bound to
an acceptance run, the final broker boundary requires the consuming intent to
name the same run.

Stored terminal outcomes are:

- `CANARY_COMPLETE`
- `FAILED_SAFE`
- `OPERATOR_ABORTED`

`ACTION_REQUIRED` is deliberately not terminal. It is derived from durable
execution uncertainty while `terminalAt` remains null, so the active-run
constraint continues blocking a replacement ceremony. Read-only broker
observation, lifecycle synchronization, and reconciliation may later prove the
run complete or failed safe.

## Preview and execution

The server resolves the exact BUY symbol, quantity, market order type, DAY TIF,
reference price, estimated notional, assignment, arming expiration, approval
revisions, readiness identity, and fingerprints. The browser supplies none of
the material order fields.

Before execution the current preview may be replaced and its revision
incremented. Execute supplies the reviewed revision and SHA-256 fingerprint.
The service locks the run, re-resolves canonical sizing and risk, revalidates
the full active arming authority, and atomically claims execution while creating
the uniquely linked intent. A database trigger makes the executed preview
immutable after `executionClaimedAt` is set.

The client order ID is deterministic for the run and preview revision. Duplicate
or concurrent execute requests therefore converge on zero or one intent and
zero or one broker submission.

## Prerequisite graph

The ceremony is not a simple account-status wizard. A safely PAUSED account may
own the durable run, but activation depends on risk-reducing authority:

```text
PAUSED / entry-disarmed
-> LIVE_ACTIVATION evidence for RISK_REDUCING grant
-> effective RISK_REDUCING approval
-> fresh passing LIVE_ACTIVATION readiness
-> ACTIVE / entry-disarmed
-> stage the bound canary assignment
-> LIVE_ENTRY_ARMING evidence for ENTRY grant
-> effective session-bounded ENTRY approval
-> fresh passing LIVE_ENTRY_ARMING readiness
-> run-bound one-shot arming
-> preview and execute
```

The high-level run phase remains derived from authoritative evidence. Detailed
guidance may therefore expose prerequisites within Setup rather than pretending
that approval, readiness, and activation are independent linear wizard steps.
Observation-only deployments can inspect this evidence and create the durable
run, but cannot advance Live-write prerequisites.

## Uncertain delivery

Acceptance-linked intents never use ordinary stale-entry requeue after
execution begins. A deterministic broker lookup may materialize a found order.
If lookup is absent, unavailable, or otherwise inconclusive, the intent remains
claimed and the run derives `ACTION_REQUIRED`; it is never moved back to
`pending`.

Explicit broker rejection or provable pre-send failure can become
`FAILED_SAFE` only after the account, active arming, kill switch, assignment
entries, and relevant reconciliation evidence prove fail-closed cleanup.

## Verification

Verification reuses authoritative `OrderIntent`, `BrokerOrder`,
`BrokerActivity`, `TrackedPosition`, `PositionExitState`, arming termination,
account latch, assignment, and reconciliation evidence. It performs broker
reads and local lifecycle synchronization but never submits or retries an
entry.

`CANARY_COMPLETE` requires a filled broker order, correctly attributed tracked
position, consumed arming, no active arming, disabled account trading, enabled
kill switch, disabled entry assignments, healthy exit lifecycle, and no
relevant reconciliation finding.
