# Trading lifecycle exercises

Trading lifecycle exercises are the primary human-operated surface for proving
the account-specific trading lifecycle without replacing n8n signal routes.
The initial implementation is deliberately **Paper-only**.

## Selection and preview

`SUBSCRIPTION_ENTRY` is the durable exercise type currently supported. The
legacy workflow records `SELECTED_USERS` or `ALL_ELIGIBLE`; the explicit
Subscription-entry workflow records `EXPLICIT_ASSIGNMENTS`. The legacy
`requestedUserIdsJson` remains available but never identifies explicit targets.
`containsLiveTargets` is false for every current workflow.

A System Owner may encounter legacy exercises created by selecting specific
account holder Users or Everyone eligible. Those backend and historical
semantics remain unchanged: selection follows
`TradingAccount.accountHolderUserId`; memberships never create a target. Every
matching `TradingAccountSubscription` becomes one frozen target, ordered by
Trading Account ID and assignment ID. Previews are limited to 25 targets and
record disabled, missing, duplicate, and otherwise unresolved User selections.

The Subscription-entry workflow instead accepts an explicit, unique list of up
to 25 `TradingAccountSubscription` IDs for one Subscription. It validates every
requested assignment identity before creating the exercise, then freezes
exactly those assignments. It does not expand through Users, memberships,
account holders, sibling assignments, or other accounts on the Subscription.
Missing assignments, assignments from another Subscription, and LIVE
assignments reject the entire request before persistence. A valid selected
PAPER assignment that is currently blocked by configuration, sizing, session,
account state, or risk is preserved as a blocked preview target.

Preview reuses existing sizing and entry-risk services. It creates no
`OrderIntent` and performs no broker write. Evidence covers account,
credentials, allocation, assignment, catalog, sizing, exposure, risk, and entry
session checks.

The configuration fingerprint covers selection, frozen assignments, account and
risk configuration, allocations, assignment sizing and enablement, and catalog
Security, Strategy, Subscription, and ExitProfile configuration. Market prices
are excluded. A preview expires after five minutes.

Explicit-assignment previews use fingerprint version 2 and include exercise
type, selection mode, deterministically ordered frozen assignment IDs,
Subscription identity, environment, target identity, and existing configuration
evidence. Legacy version 1 User-selection fingerprints remain valid and
historical fingerprints are not rewritten.

The Subscription-entry candidate list reads only actual assignment rows for the
requested Subscription. It returns assignment, account-holder/access,
allocation, sizing, credential-status, and static configuration summaries in a
stable account/assignment order. It does not synthesize unassigned accounts or
perform broker calls or full risk evaluation. PAPER rows are selectable only
when static exercise requirements pass. LIVE rows may be returned for operator
context, but are always unavailable with `LIVE_EXERCISES_NOT_SUPPORTED`.

## Operator UI workflow

Lifecycle Exercises remains the canonical operator surface. New exercises are
created only by choosing a Subscription and selecting exact TradingAccount
deployments (`TradingAccountSubscription` records). The responsive
picker shows account holder, account/environment, assignment controls,
allocation, sizing, credentials, and explicit static unavailability reasons.
LIVE deployments remain visible but disabled. A refresh preserves only selected
IDs that still exist and remain selectable; it never selects newly eligible
deployments automatically. User selection is no longer offered during creation;
`SELECTED_USERS` and `ALL_ELIGIBLE` remain supported by the backend and UI
history/detail views without rewriting historical meaning.

Candidate availability is a static configuration check, not a promise that an
entry can run. Preview independently evaluates every selected account without
placing orders and is authoritative for current sizing, session, capacity,
exposure, and risk. It freezes every selected target, including blocked targets,
for five minutes. The review separates “selected target” from current preview
eligibility, shows sizing/notional, blockers, and warnings, and requires starting
over rather than editing a frozen target set.

Subscription-entry preview diagnostics do not stop at a temporal entry-session
block. When the market is closed, an entry buffer is active, or the session clock
is unavailable, preview runs a second session-independent risk evaluation for
the same frozen assignment and sizing. It records the session blocker together
with any downstream risk blocker and preserves account position-slot and
exposure evidence. This diagnostic continuation is preview-only: it creates no
intent, performs no broker write, and does not change the fail-fast risk gate
used by launch, signal processing, or the order worker. Checks whose own
prerequisites cannot be resolved remain explicitly unevaluated rather than
being guessed.

Account position-slot evidence distinguishes open tracked positions,
pending or unresolved entry intents that have not materialized into tracked
positions, and the proposed exercise entry. Pending or unresolved intents are
conservatively reserved even when no broker order appears on the Open Orders
screen, preventing lifecycle lag or ambiguous attribution from understating
account capacity.

Launch uses only the persisted exercise ID, revalidates every frozen target
against current state, and sends only eligible targets through the normal entry
pipeline. Blocked targets stay recorded, so mixed results are expected and
supported. The detail page keeps immutable preview evidence
visually separate from launch outcome/code/message/evidence and links into the
existing lifecycle records. When the server projects a stale dispatch as
recoverable, the System Owner can confirm dispatch recovery. Recovery checks for
an existing exact-scope intent before redispatch and retains ambiguous matches
as attention-required. The UI does not calculate staleness or expose a generic
retry action.

## Launch and idempotency

Launch requires `{ "confirmation": "LAUNCH PAPER EXERCISE" }`. An atomic
`PREVIEWED` to `LAUNCHING` claim prevents concurrent or repeated launch. Paper
identity, expiration, frozen relationships, target count, and configuration
fingerprint are revalidated before dispatch.

Ready targets run sequentially through `processEntryForAccountSubscription`
using `lifecycle-exercise:{exerciseId}:target:{targetId}`. The shared entry
service remains authoritative for sizing, risk, duplicate protection,
client-order IDs, `OrderIntent` creation, broker-write policy, and outcome
classification. Workers asynchronously handle submission, fills, positions,
exits, and synchronization.

Launch always reads assignment IDs from frozen target rows and never accepts a
replacement target list. Each target is revalidated against current state; an
assignment that changed after preview is blocked rather than replaced.

Preview blockers and readiness evidence remain immutable. Dispatch stores its
outcome, stable code, message, attempt timestamp, and evidence separately.
`orderIntentId` remains the target's lifecycle link; BrokerOrder and
TrackedPosition state continues to be derived through OrderIntent.

An owner may explicitly call
`POST /api/trading-lifecycle-exercises/:id/dispatch-recovery`. A persisted
`DISPATCHING` claim becomes stale after five minutes. Recovery projects an
already linked intent, or searches by exact client-order ID, Trading Account,
and frozen assignment. One match is linked without redispatch, multiple matches
are refused with diagnostic evidence, and no match is atomically reclaimed and
sent through the normal single-assignment path. Recent claims are untouched,
concurrent recovery cannot reclaim twice, and all recovery transitions are
audited.

The stable signal identity is
`lifecycle-exercise:{exerciseId}:target:{targetId}`; client-order identity also
contains the frozen TradingAccountSubscription ID. The intended OrderIntent
uniqueness scope is client-order ID, Trading Account, and assignment. A database
uniqueness constraint is deferred until production data has been diagnosed.

## Projection and completion

Exercise records do not implement another trading state machine. Detail
responses derive stages and timelines from `OrderIntent`, `BrokerOrder`,
`BrokerActivity`, `TrackedPosition`, `PositionExitState`, and reconciliation
evidence without fabricating timestamps.

A target is reconciled only when diagnostic reconciliation is clean and its
authoritative lifecycle is terminal. An exercise completes only after every
remaining target is reconciled or cancelled.

## Cancellation, manual close, and reconciliation

Cancellation stops undispatched work and retains evidence. It does not cancel
broker or protective orders, close positions, disable accounts, or stop
lifecycle workers. Already-dispatched work continues normally.

Manual close uses the existing account-scoped close endpoint. There is no timed
automatic close. Target reconciliation wraps existing account-scoped diagnostic
reconciliation without repair mutations and stores only a sanitized summary.

## API and access

```text
POST /api/trading-lifecycle-exercises/preview
GET  /api/trading-lifecycle-exercises/subscription-entry/candidates?subscriptionId=:id
POST /api/trading-lifecycle-exercises/subscription-entry/preview
POST /api/trading-lifecycle-exercises/:id/launch
POST /api/trading-lifecycle-exercises/:id/dispatch-recovery
POST /api/trading-lifecycle-exercises/:id/cancel
POST /api/trading-lifecycle-exercises/:exerciseId/targets/:targetId/reconciliation
GET  /api/trading-lifecycle-exercises
GET  /api/trading-lifecycle-exercises/:id
```

`tradingLifecycleExercise.read` and `tradingLifecycleExercise.write` are granted
only through the System Owner all-permissions rule in this phase.

## Future Live extension

Live targets, mixed environments, provisioning, activation, write permits, and
the first Live canary remain future work. Live support must add explicit
readiness and authorization; it must not loosen the Paper boundary.
Typed Live confirmation, fresh Live-readiness checks, and a production
OrderIntent uniqueness constraint also remain deferred.
# Position-slot visibility

Lifecycle exercise previews and target details expose the authoritative entry-risk
position-slot breakdown: the account limit, active positions, pending entry
intents, current usage, the proposed additional slot, and projected usage. The
preview reads this from the normal entry-risk evaluation and does not weaken or
independently recompute the risk gate.

## Phase 1 shared entry evaluation

Lifecycle Exercise previews and launches now meet the normal signal path at the
same single-assignment evaluation boundary. The backend resolves one explicit
`TradingAccountSubscription`, calculates its runtime sizing, evaluates current
session and risk state, and returns the evidence needed to decide whether an
intent may be created. Evaluation itself does not create an `OrderIntent`,
reserve idempotency state, or write to Alpaca. Launch remains a separate,
explicit mutation through `processEntryForAccountSubscription`. The signal
layer may calculate its deterministic identity and client order ID earlier;
that calculation is non-mutating and does not reserve state.

The order worker continues to resolve the recorded assignment and rerun the
risk gate immediately before broker submission. It uses current account,
assignment, allocation, broker, session, exposure, and risk state rather than
trusting preview or intent-creation snapshots.

LIVE entry policy is evaluated before `OrderIntent` creation and before
`submitOrder()` generates a fallback client order ID. Both
`ALLOW_LIVE_TRADING` and `ALLOW_LIVE_RISK_REDUCING_WRITES` must permit an entry;
the Alpaca client retains the same check as defense in depth. Lifecycle
Exercises remain PAPER-only in this phase.
