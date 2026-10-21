# Market-Policy Broker-Time Enforcement (Phase 3C.3)

Phase 3C.3 adds the second authoritative Market Intelligence enforcement boundary:
immediately before a genuinely new Alpaca BUY entry POST. Phase 3C.2 decides whether
an enforced PAPER entry may become an `OrderIntent` and freezes an obligation with it.
Phase 3C.3 consumes that obligation. It is not a TradingView integration (4A/4B), it
grants no LIVE authority, and it never gates exits.

Acceptance contract: for an enforced PAPER OrderIntent with a frozen obligation, no
genuinely new broker BUY POST can occur without a fresh, authoritative ALLOWED
broker-time decision on the exact frozen policy revision, using sufficiently current
evidence and the required authorization state. Already-delivered broker orders stay
recoverable and managed despite later market or authorization changes.

A frozen ALLOWED admission is historical authorization evidence. It is not a
permanent broker submission permit.

## 1. Where the guard runs

`submitOrderToBroker` (`src/services/place-order.service.ts`) is the only entry BUY
broker boundary, and the only caller of `prepareEntryBrokerDispatch`
(`src/services/market-policy-broker-dispatch.service.ts`). An architecture test
enforces this. The order is:

1. `requireExecutableEntryExposureClaim`: the exact active claim, intent, account,
   Security, symbol, side and stable client order ID.
2. Stable client-order-ID lookup (`getAlpacaOrderByClientOrderId`).
3. **Existing order found:** account (per-account credentials), client order ID,
   canonical symbol and side are verified. The order is recovered and materialized
   by the existing worker path. There is no market-policy re-gating, no decision and
   no second POST. A mismatch is never guessed: it raises
   `EXISTING_BROKER_ORDER_IDENTITY_MISMATCH` and stays delivery-uncertain.
4. **Confirmed absence:** the boundary also requires that no local dispatch evidence
   exists (a consumed dispatch authorization, a final un-enforced dispatch
   authorization, adapter-dispatch, response, rejection or uncertainty events, or a
   BrokerOrder). A lookup miss alone is never proof that an earlier uncertain
   submission did not reach Alpaca.
5. `prepareEntryBrokerDispatch`: the broker-time decision (section 3). It commits
   before any broker I/O.
6. Best-effort compare-only opportunity capture (unchanged, non-authoritative).
7. `authorizeDispatch`, the last step before the adapter. A frozen obligation
   consumes its ALLOWED decision with a fresh PostgreSQL clock (section 5). An
   un-obligated PAPER entry records its final serialized non-enforced authorization or
   is quarantined (section 5a). LIVE keeps its own write controls in the adapter.
8. Adapter POST.

Stale-submission recovery (`recoverStaleSubmittingIntentsForAccount`) applies the same
exact identity verification before materializing an order it finds by client order ID.
It never consults market policy: delivered orders, fills, positions and protective
exits continue even after the authorization was revoked.

Stable client-order-ID construction is unchanged.

## 2. Delivery classification

`submitOrderToBroker` advances an `EntryBrokerSubmissionBoundary` that the worker
passes in, replacing the old blanket `brokerBoundaryStarted` flag:

| Phase | Meaning | Worker treatment of a failure |
|---|---|---|
| `UNCLASSIFIED` | Claim check, lookup in flight or failed, or prior dispatch evidence | Proven pre-dispatch non-delivery only from durable evidence (below); otherwise the conservative path: `DELIVERY_UNCERTAIN`, claim `UNRESOLVED` |
| `NOT_DISPATCHED` | Absence confirmed, no local dispatch evidence, final authorization not committed | **Definite non-send**: never-submitted checks release the claim; a refusal is recorded, never swallowed |
| `EXISTING_ORDER_FOUND` | An exact broker order exists | Delivered; recovery, never re-sent |
| `DISPATCH_STARTED` | Dispatch record committed (consumption or un-enforced authorization); the adapter may have reached Alpaca | Outcome recorded on the claim, which moves to `UNRESOLVED`; release only by evidence-based recovery (section 5b) |
| `BROKER_RESPONDED` | Alpaca confirmed the order | Existing materialization |

**Pre-dispatch failures in `UNCLASSIFIED`.** The adapter is invoked only after
`DISPATCH_STARTED`, so a failure before the stable-ID lookup and local dispatch checks
complete (an idempotency GET 429/5xx or network failure, or a database failure verifying
the executable claim or dispatch evidence) sent nothing in this attempt. The in-memory
phase only nominates such a failure. Inside the same transaction that persists the
failure, before any write, `proveWorkerPreDispatchNonDelivery` inspects the durable
evidence and proves non-delivery only when all of these hold:

- the claim is unreleased, `ENTRY_SUBMITTING`, unattached to a position and owned by the
  intent's account, and the intent is still `submitting` with no block reason from an
  earlier attempt;
- its delivery evidence is exactly one `WORKER_CLAIMED_FOR_SUBMISSION` carrying
  `ADAPTER_MARKER_V1` (this attempt's claim): no `ADAPTER_INVOCATION_STARTED` marker, no
  recorded outcome or not-sent record, and no second (legacy or repeated) worker claim;
- no consumption, un-enforced dispatch record, consumed LIVE arming, dispatch telemetry,
  broker order or broker activity exists for the intent;
- the error is not itself delivery or ownership evidence: never a
  `BrokerWriteDeliveryError` (only the adapter raises one, so a failed POST is never
  reinterpreted as a failed GET), an `EXISTING_BROKER_ORDER_IDENTITY_MISMATCH`, a
  `PRIOR_ENTRY_DISPATCH_EVIDENCE` refusal, or a claim identity/state conflict.

When proven, the transaction commits the intent as `failed` with
`LOCAL_PRE_DISPATCH_FAILURE:<message>` together with `NOT_SENT_EVIDENCE_RECORDED`
(`NOT_SENT_PRE_DISPATCH`, producer `WORKER_PRE_BOUNDARY_FAILURE`, with the inspected
facts under `proof`). Only after the commit does the shared never-submitted release run
(reason `WORKER_PROVEN_PRE_DISPATCH_BOUNDARY_FAILURE`). If that release fails
transiently, the claim stays held and the terminal-claim sweep retries it
(`AUTOMATIC_NEVER_SUBMITTED_RELEASE`). When any condition fails, the existing
conservative `DELIVERY_UNCERTAIN` outcome is recorded, and its message names the
blockers (for example `MARKER_PROTOCOL_NOT_ESTABLISHED`, `DISPATCH_RECORD_PRESENT`,
`PRIOR_DELIVERY_OUTCOME_RECORDED`). If the inspection or persistence itself fails,
nothing is written or released: the intent stays `submitting`, the claim keeps ownership,
the CRITICAL `entry_exposure.delivery_evidence_unpersisted` event carries
`preDispatchProofCandidate: true`, and stale recovery decides later from the same
marker-protocol evidence. A missing marker on a claim not taken under the marker protocol
is never treated as non-delivery.

A market-policy refusal (`MarketPolicyBrokerDispatchRefusedError`) can only occur in
`NOT_DISPATCHED`, so it is always a definite non-send. Authoritative denials set the
intent to `blocked` with `MARKET_POLICY_BROKER_TIME:<OUTCOME>:DEFINITELY_NOT_SENT:<reason>:decision=<id>`
and count as healthy domain outcomes. Technical guard failures set `failed` with the
same prefix and count as failures for account health. In both cases the worker first
commits the terminal intent state together with a structured
`NOT_SENT_EVIDENCE_RECORDED` claim event (section 5c), and only then do the shared
`releaseUnsubmittedEntryExposureClaim` checks decide whether the claim is released.
Those checks treat a dispatch consumption, an un-enforced dispatch record, a consumed
one-shot LIVE arming or dispatch telemetry as broker evidence. They also refuse any
recorded `BROKER_REJECTED`, `DELIVERY_UNCERTAIN` or unknown outcome, an unclosed
adapter-invocation marker, and an `ENTRY_SUBMITTING` claim without recorded not-sent
evidence, whether or not a durable dispatch row exists. If a genuine domain evidence
conflict refuses release, the claim moves to `UNRESOLVED` with an
`UNSUBMITTED_RELEASE_REFUSED` event and a system event; the refusal is never
swallowed. A transient database/pool failure or unknown infrastructure failure keeps
the prior recoverable claim state and its recorded evidence, and records a
deduplicated `RECOVERY_ATTEMPT_FAILED` diagnostic that schedules the next attempt. A
refusal-shaped error in any other phase, or any unclassified exception, is never
treated as a definite non-send.

`EntryDispatchRecordedNotSentError` is the one `NOT_DISPATCHED` failure that leaves a
dispatch record behind: the consumption or un-enforced authorization committed, but its
acknowledgement was lost. This attempt never invoked the adapter, yet the record still
prohibits any further POST. The intent becomes `failed` with
`ENTRY_DISPATCH_RECORDED_NOT_SENT:<record>:<id>`, and the claim goes to evidence-based
recovery (section 5b).

## 3. Broker-time decision semantics

### Frozen obligations (enforced regardless of the rollout)

For an intent with an `OrderIntentMarketPolicyEnforcementObligation`, every new
dispatch opportunity requires, in order (the first failing check is the outcome):

| Check | Refusal outcome |
|---|---|
| Intent, claim and request identity equal the obligation; intent `submitting`, claim `ENTRY_SUBMITTING` | `ENTRY_IDENTITY_MISMATCH` |
| Frozen revision is still the Strategy's ACTIVE revision | `POLICY_REVISION_SUPERSEDED` |
| Frozen authorization not `REVOKED` | `AUTHORIZATION_REVOKED` |
| Frozen authorization not `INVALIDATED` (owner lapse opt-out does not apply) | `AUTHORIZATION_INVALIDATED` |
| Frozen authorization is still the assignment's latest | `AUTHORIZATION_SUPERSEDED` |
| Frozen fingerprint and authority version unchanged | `AUTHORIZATION_INEFFECTIVE` |
| Frozen enrollment generation ACTIVE | `ENROLLMENT_GENERATION_INACTIVE` |
| Locked disposition `ENFORCED` (all 3C.2 identity checks) | `AUTHORIZATION_INEFFECTIVE` |
| Current assignment binding equals the obligation | `ENTRY_IDENTITY_MISMATCH` |
| Fresh evaluation of the **frozen** revision | `ALLOWED`, `BLOCKED`, `INSUFFICIENT_EVIDENCE` |

- The `OWNER_REVOKED` and `OWNER_OPTED_OUT` "return to non-enforced behavior"
  semantics govern future admission only, never delivery of an earlier enforced
  obligation.
- A newer policy revision or authorization is never substituted. A decision always
  records the frozen revision and authorization, and PostgreSQL rejects any other.
- The runtime rollout is recorded (`rolloutEnabled`, `rolloutVersion`) but not
  consulted. Deactivation neither erases nor bypasses an obligation.

### Fresh evaluation

`evaluateMarketPolicyRevisionOnCurrentComposition` is shared with 3C.2 admission. It
evaluates the frozen revision's five REQUIRED/IGNORED rules with
`evaluateStrategyMarketEligibility` against the current committed
`MARKET_REGIME_COMPOSITION_V1` (`SUCCEEDED`, `observedAt <= evaluatedAt`, ordered by
`targetAt`, `observedAt`, `id`). It uses exact source identities and algorithm
versions, and rechecks source health and expiry at a PostgreSQL `evaluatedAt`. FAILED
and other-version compositions are never selected. There are no provider calls and
no reuse of shadow decisions, comparison attempts or the admission's ALLOWED. ALLOWED
requires a bounded future `validUntil`. A technical failure fails closed and never
falls back to the admission decision.

### Legacy queued intents (no obligation)

Existing behavior is preserved unless **all** of the following hold: the PAPER
rollout is active, the intent has no obligation, and the assignment's current
disposition requires enforcement (`ENFORCED`, `AUTHORIZATION_INEFFECTIVE` or
`LAPSED`). The intent is then quarantined with an immutable
`LEGACY_UNOBLIGATED_QUARANTINED` decision and set to `blocked`. Its claim is released
only through the never-submitted checks. No ALLOWED admission is invented, and
nothing is deleted. This covers entries queued while the rollout was inactive,
entries queued under `NEVER_AUTHORIZED` before a grant, and entries admitted
concurrently with activation or a grant. A new grant therefore never makes a
previously queued, ungated BUY executable. Never-authorized, owner-revoked and
owner-opted-out assignments keep existing behavior.

This early check runs at preparation, before opportunity capture. It is advisory: the
authoritative decision is the final authorization immediately before the adapter
(section 5a), which re-decides the same disposition under locks.

Delivery-uncertain and already-delivered intents never reach the guard; they stay in
the existing recovery pathway. LIVE accounts are not applicable. SELL orders,
protective orders (including a short-cover BUY), close-position and recovery never
call the guard (architecture test).

## 4. Immutable decision model

`MarketPolicyBrokerDispatchDecision` (+ five `MarketPolicyBrokerDispatchGate` rows
when a composition was evaluated) is separate from the `COMPARE_ONLY` broker
opportunity and comparison evidence, which is unchanged. It records the OrderIntent
and obligation; account, assignment, Subscription, Strategy and canonical Security;
the frozen authorization ID, fingerprint, version and its status at decision time;
the frozen revision and generation; the decision version, `evaluatedAt`,
`validUntil` and `dispatchExpiresAt`; the composition, source-set fingerprint and
health; outcome and reason; the stable client order ID; a per-intent
`dispatchSequence`; the observed rollout state; and a `dispatchDisposition`
(`DISPATCH_AUTHORIZED`, `DEFINITELY_NOT_SENT`, `NOT_SENT_TECHNICAL_FAILURE`).

PostgreSQL enforces:

- Immutability of decisions, gates and consumptions. Decisions are PAPER-only and
  only for entry BUY intents (`order_intent_is_entry_buy`). The per-intent sequence
  must be contiguous.
- CHECKs: ALLOWED ⇔ `DISPATCH_AUTHORIZED`; obligation-bound outcomes carry the full
  V2 identity; ALLOWED carries composition, `validUntil > evaluatedAt`, and
  `evaluatedAt < dispatchExpiresAt <= validUntil`; only TECHNICAL_FAILURE has a
  diagnostic.
- On insert: the exact observed rollout state, evaluation inside the inserting
  transaction (`market_policy_evaluated_in_current_transaction`), and an exact mirror
  of the frozen obligation. For ALLOWED it also requires the frozen authorization
  AUTHORIZED, latest and locked `FOR SHARE`; generation and revision ACTIVE; an
  unchanged assignment binding; a committed composition observed before evaluation;
  unexpired validity; `dispatchExpiresAt = LEAST(validUntil, evaluatedAt + 30s)`; the
  executable claim; and no earlier consumption.
- Deferred, at commit: five gates per evaluated decision, the frozen revision's
  five-dimension REQUIRED/IGNORED contract (`validUntil` = earliest REQUIRED
  expiration), and an unclosed dispatch window.

Denials and quarantines commit before the worker treats the attempt as safely denied.
TECHNICAL_FAILURE decisions are recorded best-effort after the failed transaction
rolled back; losing that evidence never permits a POST. Owner reads:
`listAssignmentMarketPolicyBrokerDispatchDecisions`.

## 5. Dispatch authorization and the linearization point

`MarketPolicyBrokerDispatchConsumption` is inserted as a single-statement transaction
immediately before the adapter call. Its trigger rechecks, with `clock_timestamp()`:

- The decision is ALLOWED and is the latest decision of the intent.
- The frozen authorization (locked `FOR SHARE`) is still AUTHORIZED, latest and
  fingerprint-equal.
- The generation and revision are ACTIVE and the binding is unchanged.
- The intent is `submitting` with an `ENTRY_SUBMITTING` claim.
- The dispatch window is still open.

It then stamps `consumedAt`. Unique indexes allow one consumption per decision **and
per OrderIntent**: once dispatch has started, uncertainty is resolved only by
stable-ID recovery, never by another POST.

The **commit of the consumption is the authorization-to-dispatch linearization
point**. A revocation, invalidation, supersession or newer grant that commits before
it refuses the POST. A revocation that commits after it cannot recall the in-flight
external request. That is the documented residual race: PostgreSQL and Alpaca are not
atomic, and the order then follows normal recovery and management.

If consumption is refused (window expired, authorization changed, superseded), nothing
was sent. The guard re-evaluates exactly once with fresh evidence, appending a new
decision that also closes the refused one (superseded decisions are unconsumable). It
then consumes the fresh ALLOWED decision or refuses. A crashed or abandoned
preparation is never a reusable permission: it expires within 30 seconds, is closed by
any later decision, and is unconsumable once stale-submission recovery fails the
intent.

No transaction is held across Alpaca I/O.

A consumption is evidence that a POST **may** have started. It is never proof of broker
receipt, and it is never deleted, relaxed, cleared or reused. It prohibits another POST
for that OrderIntent permanently, including after a broker lookup miss, a process
restart, or the release of the claim.

## 5a. Final un-obligated dispatch authorization (Hermes MEDIUM-1)

An un-obligated PAPER entry (no frozen obligation) gets a real final authorization in
`authorizeDispatch`, after compare-only opportunity capture and immediately before the
adapter. One short READ COMMITTED transaction:

1. locks the runtime rollout row `FOR SHARE`;
2. resolves and locks the assignment identity and latest authorization in the
   established order (account, assignment, Subscription and Security `FOR KEY SHARE`,
   then the latest authorization `FOR SHARE`; an intent without an assignment locks its
   Security by symbol `FOR KEY SHARE`);
3. takes the `entry-exposure:<account>:<security>` advisory lock;
4. revalidates the exact intent, account, Security, stable client order ID, the
   `ENTRY_SUBMITTING` claim, the absence of an obligation, and the absence of any prior
   dispatch record;
5. re-decides the disposition. If the rollout is active and the disposition requires
   enforcement (`ENFORCED`, `AUTHORIZATION_INEFFECTIVE`, `LAPSED`), it appends a
   `LEGACY_UNOBLIGATED_QUARANTINED` decision with reason
   `UNOBLIGATED_ENTRY_UNDER_<disposition>_AT_FINAL_AUTHORIZATION` and refuses (a
   definite non-send). Otherwise it inserts the immutable
   `MarketPolicyBrokerUnenforcedDispatch` record and commits.

The record's `basis` is `RUNTIME_INACTIVE`, `NEVER_AUTHORIZED`, `OWNER_REVOKED`,
`OWNER_OPTED_OUT` or `NO_ASSIGNMENT`, with the observed rollout state and latest
authorization. Its PostgreSQL trigger re-checks everything independently: PAPER entry
BUY identity, no obligation or consumption, an executable intent and claim, the exact
rollout state (`FOR SHARE`), and the exact latest authorization (`FOR SHARE`). It
refuses the insert with `UNENFORCED_DISPATCH_ENFORCEMENT_REQUIRED` when enforcement now
applies. One record exists per OrderIntent, and records are immutable.

**Linearization point:** the commit of the final authorization. A grant, re-grant or
activation that commits before it quarantines the entry. That covers `NEVER_AUTHORIZED`
becoming `AUTHORIZED`, an inactive rollout becoming active with an effective
authorization, and `OWNER_REVOKED` or `OWNER_OPTED_OUT` followed by a new grant. Grant,
revoke and lapse resolution take the assignment `FOR UPDATE` and so wait behind the
final authorization's `KEY SHARE`; activation takes the rollout `FOR UPDATE` and waits
behind its `FOR SHARE`.

**Residual race:** a grant or activation that commits after the final authorization
cannot recall the subsequent in-flight external POST. The order is then managed
normally. PostgreSQL and Alpaca are not atomic, and no transaction is held across Alpaca
I/O.

Automatic invalidation stays fail-closed (`LAPSED` requires enforcement). Runtime
deactivation and deliberate owner opt-out apply the defined non-enforced semantics.
Already-delivered broker orders are recovered without re-gating. Frozen obligations keep
the single-use consumption. LIVE keeps its existing authorization and broker-write
behavior. Protective exits remain outside the guard.

Like a consumption, the un-enforced record is durable dispatch-start evidence. It is
never proof of receipt, and it permanently prohibits another POST for the intent.

## 5b. Claim recovery after a possible dispatch (Hermes HIGH-1)

`src/services/entry-dispatch-recovery.service.ts` owns recovery of EntryExposureClaim
ownership once the adapter may have been reached. Dispatch records are a consumption,
an un-enforced dispatch authorization, a consumed one-shot LIVE arming
(`LiveEntryArmingTermination` of type `CONSUMED` for the intent), or best-effort
dispatch telemetry. An OBSERVED post-boundary outcome (section 5c) is treated the same
way even when no dispatch record exists, which is the normal case for LIVE.
`releaseUnsubmittedEntryExposureClaim` refuses every such claim.

### Outcome recording

Every failure after the adapter may have been reached is recorded as an immutable
`DISPATCH_OUTCOME_RECORDED` claim event in the same transaction as the intent's terminal
state, and the claim moves to `UNRESOLVED`, which is non-executable and visible. A
terminal `failed` intent never hides a stuck `ENTRY_SUBMITTING` claim. The event carries
the classification, HTTP status, source, `observation` (`OBSERVED` by the worker or
`INFERRED` by recovery), `adapterInvocation`, `dispatchRecordPresent`, client order ID,
consumption, decision, un-enforced and LIVE arming record IDs, and a `deliveryProof`.
Claim events are append-only at the database boundary. Repeated observations with
unchanged evidence append nothing. The system event describes the evidence actually
present; it never claims that a dispatch record committed when none exists.

| Case | Classification | Intent | Claim | Release |
|---|---|---|---|---|
| A. Adapter-local guard before `fetch` (`NOT_SENT_BLOCKED`, `NOT_SENT_RETRYABLE`) with a dispatch record | `NOT_SENT_LOCAL_*` | `failed` | `UNRESOLVED`, then a verified release is attempted immediately | Automatic after fresh verification |
| A'. Same, with no dispatch record | `NOT_SENT_EVIDENCE_RECORDED` (`ADAPTER_LOCAL_GUARD`) | `failed` | Never-submitted release after the evidence commits | Automatic |
| B. HTTP rejection with a definitive status (400, 401, 403, 404, 422, 429), with or without a record | `BROKER_REJECTED` with status | `failed` | `UNRESOLVED` | Automatic, only after a 60 s settle window and fresh verification |
| B'. Any other 4xx (for example 408, 409), with or without a record | `BROKER_REJECTED` with status | `failed` | `UNRESOLVED` | Never on absence; operator investigation |
| C. 5xx, network, timeout, or unclassified after the boundary | `DELIVERY_UNCERTAIN` | `failed` | `UNRESOLVED` | Never on absence; operator investigation |
| D. Crash after the adapter-invocation marker or after a dispatch record (stale recovery) | `DISPATCH_OUTCOME_UNKNOWN` (`INFERRED`) | `failed` (`DISPATCH_STARTED_OUTCOME_UNKNOWN` or `STALE_SUBMISSION_OUTCOME_UNKNOWN`) | `UNRESOLVED` | Never on absence; operator investigation |
| E. Record committed, acknowledgement lost | `NOT_SENT_DISPATCH_RECORD_ACK_LOST` | `failed` (`ENTRY_DISPATCH_RECORDED_NOT_SENT`) | `UNRESOLVED`, then a verified release is attempted immediately | Automatic after fresh verification |

Every HTTP response means the request reached Alpaca. No 4xx status, by itself, proves
non-delivery, so a rejection never uses the never-submitted path. The definitive codes
only qualify the rejection for evidence-based release: 400 (malformed request), 401
(authentication), 403 (buying power, permissions, restricted account), 404 (unknown
route or asset), 422 (validation) and 429 (rate limit) are responses Alpaca returns
without accepting an order. 408 (the request may have been processed after the
timeout) and 409 (a conflict that can mean the client order ID already exists) are
delivery-uncertain, as is every other 4xx.

In every case the consumed or recorded intent is never retried as a new POST.
`assertNoLocalEntryDispatchEvidence` and the unique records block it even if an
operator requeues the intent. A record from an earlier attempt never produces a new
classification: only a failure inside this attempt's final authorization (after the
boundary confirmed no prior record) can be a lost acknowledgement.

Cases A and E rely on in-process knowledge that this attempt never sent the request: the
adapter threw before `fetch`, or the record insert never returned. A 4xx is a broker
response, not an adapter-local non-send. It qualifies for release only with a definitive
status, after the settle window, and with full verification, because a 4xx alone does
not prove that no order exists (a duplicate client-order-ID rejection, for example,
implies that one does). The settle window is a minimum before verification counts. It is
never a timeout after which ownership disappears.

### Evidence standard for release

`releaseVerifiedEntryExposureClaim` (formerly `releaseDispatchedEntryExposureClaim`,
which remains an alias) releases only when all of the following hold:

- **Identity:** the claim, OrderIntent, account, canonical Security and stable client
  order ID match each other, the consumption and its decision, the un-enforced record
  and the LIVE arming record.
- **Recorded basis:** every recorded outcome and not-sent record is a definite local
  non-send or a definitive, settled rejection, and every adapter-invocation marker is
  closed by one of them. Any uncertain or inferred-unknown outcome makes absence
  ambiguous, whatever a later lookup returns. A claim with no delivery evidence at all
  (`NO_DELIVERY_EVIDENCE`) is never released.
- **Fresh broker verification:** the exact stable client-order-ID lookup finds no order,
  the complete paginated open-BUY inventory for the account and Security is empty
  (incomplete or inconsistent pagination fails), and there is no broker position. An
  order found by client ID routes to the existing terminal broker-order remediation
  (`releaseConfirmedTerminalEntryClaim`), which performs replacement-chain and fill
  reconciliation.
- **Local verification:** the intent is terminal. There is no BrokerOrder or
  BrokerActivity for the intent, no attached or active TrackedPosition, no local
  executable BUY for the account and Security, and no unattributed BUY fill for the
  Security since dispatch started.
- **Final revalidation** under the `entry-exposure:<account>:<security>` advisory lock:
  claim status, intent status, local exposure, the dispatch records and the recorded
  delivery evidence are unchanged. The release is then a compare-and-set from the
  assessed claim status to `RELEASED` with reason
  `VERIFIED_DISPATCH_NO_EXPOSURE:<basis>` (or
  `VERIFIED_NO_DISPATCH_RECORD_NO_EXPOSURE:<basis>` when no dispatch record exists),
  plus an immutable `RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE` event carrying the full
  evidence and its fingerprint.

Dispatch records are retained unchanged. A release only lets a later, genuinely new
admission with a new client order ID pass normal entry controls. The original
OrderIntent is never reactivated or resent.

Where the APIs cannot conclusively establish absence after a possibly delivered order
(cases B', C and D), the claim is retained and absence never authorizes a release.
The only positive evidence that does is the exact order itself. Once the stable client
order ID resolves at Alpaca to a terminal order whose fills are fully accounted, with no
position or executable BUY, the terminal broker-order disposition releases it. A live
order is managed as exposure. Remediation reports `AMBIGUOUS_ABSENCE` with
`releaseRequires: POSITIVE_BROKER_ORDER_EVIDENCE` and investigation guidance. There is
no force release, no direct-SQL workaround, and no time-based expiry of ownership.

### Recovery sweep and its single recovery-state definition

`classifyTerminalEntryClaim` is the one definition of terminal-claim recovery work. The
sweep (`recoverTerminalEntryClaimsForAccount`), account enumeration
(`summarizeTerminalClaimRecoveryByAccount`) and readiness
(`describeUnreleasedTerminalEntryClaims`) all use it, over unreleased claims of terminal
intents:

| State | When | Action |
|---|---|---|
| `AUTOMATIC_NEVER_SUBMITTED_RELEASE` | No dispatch record or outcome, and non-dispatch is proven by recorded not-sent evidence or by a claim that never reached `ENTRY_SUBMITTING` | Retry the never-submitted release |
| `AUTOMATIC_NOT_SENT_EVIDENCE_RECORDING` | Legacy claim proven not sent by the adapter-marker protocol, a code-written local classification (`LOCAL_PRE_DISPATCH_FAILURE`, `MARKET_POLICY_BROKER_TIME:…:DEFINITELY_NOT_SENT`, `BROKER_WRITE_DELIVERY:NOT_SENT_*`) or the structured worker risk evaluation | Record `NOT_SENT_EVIDENCE_RECORDED` under the lock, then release |
| `AUTOMATIC_OUTCOME_RECORDING` | A dispatch record without a recorded outcome, or no evidence either way | Record the outcome (`INFERRED`; unknown when nothing proves it) and move to `UNRESOLVED` |
| `AUTOMATIC_VERIFIED_RELEASE` | `UNRESOLVED` with a conclusive or settling basis | Evidence-verified release |
| `OPERATOR_INVESTIGATION` | Uncertain, non-definitive, inferred-unknown or no evidence | None; operator-only |
| `PROTECTED_EXPOSURE` | A local broker order or attached position | Order sync and terminal broker-order remediation own it |

Free text is never inferred either way: an unrecognized block reason without
structured evidence becomes an explicit, retained unknown outcome. A missing dispatch
record is never treated as proof that no POST occurred.

Each tick the sweep takes at most three actionable, due claims (`lastDiagnosedAt` null
or at least 60 seconds old), oldest attempt first. It leases each claim by advancing
`lastDiagnosedAt` with a compare-and-set before attempting it, so every attempt,
whatever its result, waits at least 60 seconds for the next one, and persistently
failing claims rotate instead of starving others. A claim whose lease cannot be written
(for example, during a database outage) is not attempted and is not reported as
attempted. Diagnostics are deduplicated by stable evidence (`failureClass`,
`errorCode`, source; no raw message or clock), so a persistent failure appends one
event, not one per tick. Recovery-attempt results (`DISPATCH_RECOVERY_RELEASE_BLOCKED`,
`DISPATCH_RECOVERY_REVALIDATION_BLOCKED`, `DISPATCH_RECOVERY_ERROR`,
`RECOVERY_ATTEMPT_FAILED`, `UNSUBMITTED_RELEASE_REFUSED`,
`PRE_BOUNDARY_FAILURE_WITH_PRIOR_DISPATCH_RECORD`, `DISPATCH_RECOVERY_ATTEMPT_RESULT`)
are deduplicated consecutively across all of these types: a result is skipped only when
the newest attempt result is the identical event. A repeated result separated by a
different one (for example `TECHNICAL_FAILURE`, then `BLOCKED_BY_EVIDENCE`, then the same
`TECHNICAL_FAILURE`) is recorded again. When an attempt writes no result of its own and
the newest one describes a different result, the sweep appends one
`DISPATCH_RECOVERY_ATTEMPT_RESULT {result, reason, recoveryState}`. Readiness therefore
reports the newest attempt's result in `lastRecoveryResult` (`at`/`firstObservedAt` is
when that result was first observed; `lastAttemptAt` is the newest attempt). A result
appends only when it changes, at most once per 60-second lease per claim.

Stale recovery never releases on one lookup miss. A `submitting` entry whose claim never
reached `ENTRY_SUBMITTING`, or whose marker-protocol claim has no adapter-invocation
marker, is proven not sent and recorded as such before the release. Anything else (a
dispatch record, an entered adapter, or no evidence) records `DISPATCH_OUTCOME_UNKNOWN`
and retains the claim. A stronger existing delivery classification in the block reason
is never replaced by weaker later text.

Account enumeration schedules `submitted_orders` work only for actionable, due claims
(`terminalEntryClaimsDue`). Operator-only, waiting and protected claims do not schedule
the sweep, but they count as held exposure (`terminalEntryClaimsHeld`), so an account
without usable credentials still reports `credentials_unavailable_with_exposure`.

Every lifecycle workflow's enumeration loads the unreleased terminal claims with their
delivery-evidence events (and one small query for abandoned admissions) to classify
them. This is one indexed read per enumeration, proportional to held claims (single
digits in practice), not to claim history. Narrowing it to the `submitted_orders`
workflow would change `hasLifecycleWork` (and therefore reconciliation and broker-activity
eligibility for non-operational accounts), so it is deferred as a follow-up to be
revisited if held-claim volume grows.

**Abandoned admissions.** An admission that created its intent and claim, failed, and
whose cleanup transaction also failed leaves a `received` intent with an `ENTRY_PENDING`
claim that neither the worker (`pending` only) nor the terminal sweep (terminal intents
only) selects. `recoverStaleAdmissionClaimsForAccount` runs on the same stale-recovery
tick under the account lifecycle-mutation lock. It selects only claims whose intent has
been `received` and unchanged for 15 minutes (`STALE_ADMISSION_THRESHOLD_MS`), at most
three per tick, leased like the sweep. Under the entry-exposure lock it re-verifies the
claim (`ENTRY_PENDING`, never worker-claimed), the intent (`received`, BUY, same
account, not a LIVE acceptance execution) and the absence of any adapter marker,
recorded outcome, dispatch record, dispatch telemetry, consumed LIVE arming, broker order
or broker activity. Only then does it fail the intent by compare-and-set
(`STALE_ADMISSION_NEVER_DISPATCHED`) together with `NOT_SENT_EVIDENCE_RECORDED`
(producer `STALE_ADMISSION_NEVER_EXECUTABLE`), and after commit runs the shared
never-submitted release (`STALE_ADMISSION_NEVER_SUBMITTED`). Incomplete or
contradictory evidence retains the claim with a deduplicated
`STALE_ADMISSION_RECOVERY_BLOCKED {blockers}` diagnostic, and readiness lists it under
`staleAdmissionClaims` (by the intent's own age) as `OPERATOR_INVESTIGATION`. A `pending`
intent is never selected, however old. Admission's own `received` to `pending`/`blocked`
transitions are compare-and-set, so an admission that resumes after recovery can never
make the failed intent executable (`ENTRY_ADMISSION_ABANDONED`). Enumeration reports
`staleAdmissionClaimsDue` (schedules `submitted_orders`) and `staleAdmissionClaimsHeld`
(held exposure, including for credential-unavailable accounts).

### 5c. Delivery-evidence ordering invariant (Phase 3C.3 final closure)

No claim-release decision runs before the delivery classification it depends on is
durable, and no broker-exposed or delivery-uncertain claim uses the never-submitted path.

- **Worker failures.** The worker classifies the failure, then commits in one transaction
  the intent's terminal status and block reason (and any LIVE acceptance-run update)
  together with either `NOT_SENT_EVIDENCE_RECORDED` (proven not sent) or
  `DISPATCH_OUTCOME_RECORDED` (`OBSERVED`, claim `UNRESOLVED`). Only after that commit
  does it decide on release. If the transaction fails, nothing is released: the claim
  keeps ownership, a CRITICAL `entry_exposure.delivery_evidence_unpersisted` system event
  is attempted, and stale recovery reviews the intent later.
- **Risk rejection.** The worker-time risk block commits `blocked` together with
  `NOT_SENT_EVIDENCE_RECORDED` (`WORKER_RISK_RECHECK`) before its release.
- **Adapter-marker protocol.** The worker claims an entry with
  `WORKER_CLAIMED_FOR_SUBMISSION {markerProtocol: ADAPTER_MARKER_V1}`.
  `submitOrderToBroker` appends `ADAPTER_INVOCATION_STARTED` after the final dispatch
  authorization and immediately before the adapter call. If that write fails, the phase
  is still `NOT_DISPATCHED` and nothing is sent. A marker-protocol claim without a marker
  never invoked the adapter. A marker without a later outcome or not-sent record is an
  unknown outcome.
- **Shared release.** `releaseUnsubmittedEntryExposureClaim` decides and
  compare-and-sets under the `entry-exposure:<account>:<security>` advisory lock (inside
  the caller's transaction or its own). It releases an `ENTRY_SUBMITTING` claim only with
  recorded not-sent evidence, and an `ENTRY_PENDING`/`ADMISSION_BLOCKED` claim only
  because such a claim can never cross the broker boundary. Release results report what
  actually committed: a compare-and-set miss or a release by another path is
  `ALREADY_RELEASED`/`NOT_RELEASED`, never `released: true`.

Known non-dispatch producers are structured: `WORKER_RISK_RECHECK`,
`WORKER_PRE_BOUNDARY_FAILURE` (before the boundary, or inside it in `UNCLASSIFIED` with
the marker-protocol proof above), `STALE_ADMISSION_NEVER_EXECUTABLE`,
`BROKER_BOUNDARY_NOT_DISPATCHED`,
`BROKER_TIME_MARKET_POLICY_REFUSAL`, `ADAPTER_LOCAL_GUARD`,
`STALE_RECOVERY_ADAPTER_NOT_INVOKED`, and the sweep's legacy producers.

## 6. Lock ordering

Preparation uses the 3C.2 admission order in one short READ COMMITTED transaction:

1. `MarketPolicyEnforcementRuntimeRollout` `FOR SHARE` (recorded, not authoritative for obligations)
2. `TradingAccount`, `TradingAccountSubscription`, `Subscription`, `Security` `FOR KEY SHARE`
3. Latest authorization `FOR SHARE`
4. `entry-exposure:<account>:<security>` transaction advisory lock
5. Reads and decision/gate inserts; commit

Revoke, grant, lapse resolution and enrollment disable take the assignment `FOR UPDATE`
first and wait. Revision supersession and the identity triggers update the
authorization and wait at step 3. Rollout changes wait at step 1. Consumption takes only
the authorization `FOR SHARE`, so it cannot invert against these writers. The final
un-obligated authorization uses the same order as preparation. Evidence-based release
takes only the advisory lock, after its broker reads. The account lifecycle-mutation
workflow lock still wraps the whole worker tick.

## 7. Pre-activation inventory and lapse report

`assessMarketPolicyBrokerEnforcementReadiness`
(`src/services/market-policy-broker-readiness.service.ts`) is read-only. It is
available as `npm run market-policy:broker-readiness` (exit code 2 when review is
required) and as `GET /api/market-policy-enforcement/broker-time-readiness`
(SYSTEM_OWNER). It lists every PAPER entry BUY in received, pending, submitting,
broker-active or uncertain states with:

- account, assignment, stable client order ID and status;
- obligation presence and assignment disposition;
- broker delivery classification (`NOT_DISPATCHED`,
  `DISPATCH_IN_PROGRESS_OR_UNCERTAIN`, `DELIVERY_UNCERTAIN`,
  `BROKER_ORDER_DELIVERED`);
- the broker-time treatment it will receive.

It also lists unresolved lapses (Hermes L5), flagging V1 grants invalidated with
`AUTHORITY_BINDING_REAPPROVAL_REQUIRED`. `activationGuard` summarizes what the owner
must review. Liquidation of existing positions is never required.

Terminal intents (`failed`, `blocked`, and similar) whose claims remain unreleased are
always inventoried, with `terminalWithUnreleasedClaim` and the claim, consumption,
decision and un-enforced record IDs. They add the activation reason
`TERMINAL_ENTRIES_WITH_UNRELEASED_CLAIMS`.

The entry-exposure readiness report (`assessEntryExposureReadiness`,
`npm run entry-exposure:readiness`) carries the fail-closed database blocker
`terminalIntentsWithUnreleasedClaims`. Each item lists the account and canonical
Security; the intent and claim IDs and statuses; the consumption ID and dispatch
decision; the stable client order ID; the recorded delivery classification and
`deliveryEvidence` (`DISPATCH_RECORD`, `STRUCTURED_NOT_SENT`,
`OUTCOME_WITHOUT_DISPATCH_RECORD` or `NONE`); the release basis and conclusiveness; and
the claim's `recoveryState` with `automaticRecoveryPossible`. It also reports whether the
workflow has actually attempted the claim (`recoveryAttempted`, `lastAttemptAt`), the
last attempt's real result (`BLOCKED_BY_EVIDENCE`, `TECHNICAL_FAILURE` or `REFUSED`),
`nextAttemptDueAt` for automatic states, and `systemRecovery`:
`AWAITING_FIRST_ATTEMPT`, `RETRY_SCHEDULED`, `TECHNICAL_FAILURE_RETRY_SCHEDULED`,
`OPERATOR_INVESTIGATION_REQUIRED` or `PROTECTED_BY_EXPOSURE_WORKFLOW`. Nothing is ever
reported as processed on the strength of a diagnostic-error event. Operator remediation
eligibility is `ELIGIBLE_AFTER_FRESH_VERIFICATION`, `PENDING` (automatic recovery
first), `INVESTIGATION_REQUIRED` (release only on positive broker order evidence) or
`BLOCKED`, with the blocker reason. A terminal intent with a held claim, including one
attached to a position, never drops out of operator attention.

## 7a. Operator remediation of a dispatched entry

`npm run entry-exposure:remediate -- --claim <id> --actor-user-id <owner>` uses
`src/services/entry-exposure-remediation.service.ts`. A claim whose intent has a dispatch
record and no broker order gets the disposition `DISPATCHED_ENTRY_VERIFIED_NO_EXPOSURE`
instead of the old `BROKER_ORDER_NOT_ESTABLISHED` blocker. A claim with recorded
delivery evidence but no dispatch record, including any no-record `UNRESOLVED` claim,
gets `NO_DISPATCH_RECORD_VERIFIED_NO_EXPOSURE` instead of `UNSUPPORTED`. It is eligible
only with a basis from structured evidence: recorded not-sent evidence, or an OBSERVED
definitive rejection after its settle window. An inferred unknown or an uncertain
outcome stays `AMBIGUOUS_ABSENCE`, and the missing dispatch record never counts as
proof. The preview shows the exact
intent, claim, consumption, decision and un-enforced record identities; the recorded
classification; the local and broker evidence; the conclusiveness (`CONCLUSIVE`,
`PENDING`, `AMBIGUOUS_ABSENCE` or `CONTRADICTED`); every blocker; and investigation
guidance when the evidence is not conclusive.

`--apply --confirm <fingerprint>` requires an enabled SYSTEM_OWNER. It re-runs the fresh
broker verification, requires the exact fingerprint (any change in evidence refuses),
revalidates under the lock, and appends immutable `OPERATOR_REMEDIATION_AUTHORIZED` and
`RELEASED_VERIFIED_DISPATCH_NO_EXPOSURE` events. It applies the same evidence standard as
the automatic sweep, and refuses on any broker position, executable BUY, unaccounted
fill, incomplete pagination, identity mismatch or ambiguous absence.

The existing terminal broker-order and closed adopted-position dispositions are
unchanged, except that the terminal disposition now also refuses a broker order whose
client order ID, symbol or side contradicts the claim. Remediation never places, cancels
or requeues an order, and creates no execution authority.

## 8. Phase 3C.2 follow-up corrections

- **L1:** the deferred admission verify rejects an admitted ALLOWED attempt whose
  `validUntil` passed before commit.
- **L2:** `evaluatedAt` (milliseconds) is compared with
  `date_trunc('milliseconds', transaction_timestamp())` via
  `market_policy_evaluated_in_current_transaction`.
- **L3:** the deferred backstop classifies entries with `order_intent_is_entry_buy`. A
  BUY bound to a tracked position and not declared an entry (protective short cover) is
  exempt; every other BUY still needs an obligation.
- **L4:** `ALLOWED`, `orderIntentCreated = false` evidence is preserved but can never
  back an obligation, and broker-time authority derives only from obligations.
- **L5:** the readiness report's `unresolvedLapses`.
- **L6:** deterministic tests for invalidation before locking, grant versus a legacy
  admission, activation and deactivation versus admission, AUTHORIZATION_INEFFECTIVE,
  BLOCKED signal entries, and FAILED, wrong-version and superseded compositions. An
  admission whose disposition is lapsed or ineffective now records that durable
  rejection even when the request symbol also drifted, instead of a technical failure.

## 9. Tests

`src/db/__tests__/market-policy-broker-time-enforcement.integration.test.ts`
(`RUN_DATABASE_INTEGRITY_TESTS=1`) replays the real migration chain, including a
pre-existing V1 grant, and drives the real order worker into `submitOrderToBroker`
with Alpaca stubbed at the adapter. Its correction block covers the final un-obligated
authorization races (grant, activation, re-grant after revocation or opt-out, and the
post-commit residual race under real lock contention) and post-consumption outcomes
(definitive and non-definitive 4xx, local non-send, uncertain delivery, crash before the
adapter, lost consumption acknowledgement, readiness, fingerprinted remediation and its
refusals, and a new admission after release). The final-closure block exercises the
real LIVE worker path with no dispatch record: 408 and 409 independently (one POST, claim
retained, accurate classification, second entry refused, no second POST); the same with
the classification persistence failing (PostgreSQL trigger injection); every definitive
4xx through settle and fresh verification; an unknown adapter error released only on
positive broker evidence; and genuine pre-dispatch failures. It also covers MEDIUM-1:
risk rejection, admission and stale-recovery producers with injected transient failures;
legacy free text versus structured risk evidence; and no-record `UNRESOLVED` operator
remediation. LOW-2 is a controlled-clock test (three persistently failing claims and a
fourth). LOW-3/LOW-4 cover enumeration, sweep and readiness parity. The suite verifies
its disposable database identity, binds Prisma to it, and fails if any real network
request is attempted. Unit coverage lives in `place-order.service.test.ts` (phase
ordering, marker and refusal), `order.worker.test.ts` (classification, persistence
ordering and recovery routing), `entry-exposure-claim.service.test.ts` (the shared
release invariant), `entry-delivery-evidence.service.test.ts` (evidence model and
recovery classification), `lifecycle-account-eligibility.service.test.ts`, and
`market-policy-broker-dispatch.architecture.test.ts`.
